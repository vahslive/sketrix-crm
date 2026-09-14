// GET  /api/inventory — admin only. Everything in stock, where it is, what it
//      cost and what is running out.
// POST /api/inventory — admin only. One of:
//      { action:'receive',  itemId, qty, totalCost, note }  bought more
//      { action:'transfer', itemId, qty, toMasterId | toBusiness:true }
//      { action:'adjust',   itemId, qty, note }             counted and it was wrong
//      { action:'createItem', name, consumedBy, reorderPoint, sku }
//      { action:'updateItem', itemId, ...same fields, active }
//
// Costs are weighted average, not lot-by-lot. Ten mounts at $48 and five at
// $52 become an average of $49.33, and that is the number a job's margin is
// worked out against. Tracking which physical box went to which house would
// be twice the work for an accuracy nobody in this business needs.
import { getUserFromRequest } from '../_lib/auth.js';
import { stockLevels, BUSINESS } from '../_lib/inventory.js';

const MAX_QTY = 999;
const MAX_COST_CENTS = 500000; // $5,000 for a single purchase line

export async function onRequestGet({ request, env }) {
  const user = await getUserFromRequest(request, env);
  if (!user || user.role !== 'admin') {
    return Response.json({ ok: false, error: 'Unauthorized' }, { status: 401 });
  }

  const { results: rows } = await env.DB.prepare(
    `SELECT * FROM inventory_items ORDER BY active DESC, name`
  ).all();

  const { results: masters } = await env.DB.prepare(
    `SELECT id, name, display_name FROM users WHERE role = 'master' AND active = 1 ORDER BY name`
  ).all();

  const levels = await stockLevels(env);

  const items = (rows || []).map((row) => {
    const level = levels.get(row.id) || { total: 0, byHolder: new Map() };
    const byHolder = [...level.byHolder.entries()]
      .filter(([, qty]) => qty !== 0)
      .map(([key, qty]) => {
        const [type, id] = key.split(':');
        const master = (masters || []).find((m) => String(m.id) === id);
        return {
          type,
          id: id ? Number(id) : null,
          name: type === 'business' ? 'Warehouse' : (master?.display_name || master?.name || `Master #${id}`),
          qty,
        };
      })
      .sort((a, b) => (a.type === 'business' ? -1 : 1) - (b.type === 'business' ? -1 : 1));

    return {
      id: row.id,
      name: row.name,
      sku: row.sku,
      consumedBy: row.consumed_by,
      consumeQty: row.consume_qty,
      reorderPoint: row.reorder_point,
      avgCost: (row.avg_cost_cents || 0) / 100,
      active: !!row.active,
      onHand: level.total,
      byHolder,
      // What is left is worth counting as money, because that is what it is:
      // cash sitting on a shelf.
      value: (level.total * (row.avg_cost_cents || 0)) / 100,
      low: row.active === 1 && level.total <= row.reorder_point,
    };
  });

  const { results: moves } = await env.DB.prepare(
    `SELECT m.*, i.name AS item_name, u.name AS by_name
     FROM inventory_moves m
     LEFT JOIN inventory_items i ON i.id = m.item_id
     LEFT JOIN users u ON u.id = m.created_by
     ORDER BY m.id DESC LIMIT 40`
  ).all();

  return Response.json({
    ok: true,
    items,
    masters: (masters || []).map((m) => ({ id: m.id, name: m.display_name || m.name })),
    moves: moves || [],
    summary: {
      lines: items.filter((i) => i.active).length,
      low: items.filter((i) => i.low).length,
      value: items.reduce((sum, i) => sum + i.value, 0),
    },
  });
}

export async function onRequestPost({ request, env }) {
  const user = await getUserFromRequest(request, env);
  if (!user || user.role !== 'admin') {
    return Response.json({ ok: false, error: 'Unauthorized' }, { status: 401 });
  }

  let body;
  try { body = await request.json(); } catch {
    return Response.json({ ok: false, error: 'Invalid JSON' }, { status: 400 });
  }

  const fail = (error, status = 400) => Response.json({ ok: false, error }, { status });

  // ---- the catalogue -------------------------------------------------
  if (body.action === 'createItem' || body.action === 'updateItem') {
    const name = String(body.name || '').trim().slice(0, 80);
    if (!name) return fail('Give the item a name.');

    const consumedBy = String(body.consumedBy || '').trim().slice(0, 60) || null;
    if (consumedBy) {
      const known = await env.DB.prepare(`SELECT code FROM service_prices WHERE code = ?`)
        .bind(consumedBy).first();
      if (!known) return fail(`No service in the price list has the code "${consumedBy}".`);
    }

    const reorder = Number(body.reorderPoint);
    if (!Number.isInteger(reorder) || reorder < 0 || reorder > MAX_QTY) {
      return fail('The reorder point has to be a whole number.');
    }
    const consumeQty = Number.isInteger(Number(body.consumeQty)) && Number(body.consumeQty) > 0
      ? Number(body.consumeQty) : 1;
    const sku = String(body.sku || '').trim().slice(0, 60) || null;

    if (body.action === 'createItem') {
      await env.DB.prepare(
        `INSERT INTO inventory_items (name, sku, consumed_by, consume_qty, reorder_point)
         VALUES (?, ?, ?, ?, ?)`
      ).bind(name, sku, consumedBy, consumeQty, reorder).run();
    } else {
      await env.DB.prepare(
        `UPDATE inventory_items
         SET name = ?, sku = ?, consumed_by = ?, consume_qty = ?, reorder_point = ?, active = ?
         WHERE id = ?`
      ).bind(name, sku, consumedBy, consumeQty, reorder,
             body.active === false ? 0 : 1, Number(body.itemId)).run();
    }
    return Response.json({ ok: true });
  }

  // ---- movements -----------------------------------------------------
  const itemId = Number(body.itemId);
  const item = await env.DB.prepare(`SELECT * FROM inventory_items WHERE id = ?`).bind(itemId).first();
  if (!item) return fail('No such item.', 404);

  const qty = Number(body.qty);
  if (!Number.isInteger(qty) || qty === 0 || Math.abs(qty) > MAX_QTY) {
    return fail(`Quantity has to be a whole number between 1 and ${MAX_QTY}.`);
  }
  const note = String(body.note || '').trim().slice(0, 200) || null;

  if (body.action === 'receive') {
    if (qty < 0) return fail('Receiving takes a positive quantity.');

    const totalCents = Math.round(Number(body.totalCost) * 100);
    if (!Number.isFinite(totalCents) || totalCents < 0 || totalCents > MAX_COST_CENTS * qty) {
      return fail('Enter what the whole delivery cost.');
    }
    const unitCents = Math.round(totalCents / qty);

    // Weighted average, recomputed against what is actually on hand rather
    // than everything ever bought — stock that has already gone into someone's
    // wall should not still be pulling the average around.
    const levels = await stockLevels(env);
    const have = levels.get(itemId)?.total || 0;
    const currentValue = have * (item.avg_cost_cents || 0);
    const newAvg = (have + qty) > 0
      ? Math.round((currentValue + totalCents) / (have + qty))
      : unitCents;

    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO inventory_moves (item_id, kind, qty, to_type, to_id, unit_cost_cents, note, created_by)
         VALUES (?, 'purchase', ?, 'business', NULL, ?, ?, ?)`
      ).bind(itemId, qty, unitCents, note, user.id),
      env.DB.prepare(`UPDATE inventory_items SET avg_cost_cents = ? WHERE id = ?`)
        .bind(newAvg, itemId),
    ]);

    // The price list carries its own copy of cost, because a job's margin is
    // worked out from the line it sold, not from today's shelf. Keeping them
    // in step here means the admin never has to type a cost twice.
    if (item.consumed_by) {
      await env.DB.prepare(
        `UPDATE service_prices SET cost = ? WHERE code = ?`
      ).bind(Math.round(newAvg / 100), item.consumed_by).run();
    }

    return Response.json({ ok: true, avgCost: newAvg / 100 });
  }

  if (body.action === 'transfer') {
    if (qty < 0) return fail('A transfer takes a positive quantity.');

    const toBusiness = body.toBusiness === true;
    const masterId = Number(body.toMasterId);
    if (!toBusiness && !Number.isInteger(masterId)) {
      return fail('Say who the stock is going to.');
    }

    const from = toBusiness ? { type: 'master', id: masterId } : BUSINESS;
    const to = toBusiness ? BUSINESS : { type: 'master', id: masterId };

    await env.DB.prepare(
      `INSERT INTO inventory_moves (item_id, kind, qty, from_type, from_id, to_type, to_id, note, created_by)
       VALUES (?, 'transfer', ?, ?, ?, ?, ?, ?, ?)`
    ).bind(itemId, qty, from.type, from.id, to.type, to.id, note, user.id).run();

    return Response.json({ ok: true });
  }

  if (body.action === 'adjust') {
    // A count that disagrees with the ledger. Positive adds to the warehouse,
    // negative writes off — breakage, a part that walked, an old miscount.
    const positive = qty > 0;
    await env.DB.prepare(
      `INSERT INTO inventory_moves (item_id, kind, qty, from_type, from_id, to_type, to_id, note, created_by)
       VALUES (?, 'adjust', ?, ?, NULL, ?, NULL, ?, ?)`
    ).bind(
      itemId, Math.abs(qty),
      positive ? null : 'business',
      positive ? 'business' : null,
      note, user.id
    ).run();
    return Response.json({ ok: true });
  }

  return fail('Unknown action.');
}
