// Stock, kept as a ledger rather than a number.
//
// The tempting design is a quantity column that gets edited. It works until
// the first time it doesn't, and then nobody can answer "where did the three
// full-motion mounts go" — the only honest answer being "someone typed over
// it". Every change here is a movement with a reason, a direction and a
// timestamp, and the quantity on hand is what those movements add up to.
//
// Stock also has a place, not just a count. Mounts sit in the garage and in
// each master's van, and a single total is wrong the moment five are loaded
// into a truck: the shelf shows empty while the business has plenty. So every
// side of a movement names a holder — the business, or a particular master.

/** Where stock can sit. A master's van is as real a location as the shelf. */
export const BUSINESS = { type: 'business', id: null };

export function holderOf(user) {
  return user.role === 'master'
    ? { type: 'master', id: user.id }
    : BUSINESS;
}

function sameHolder(a, b) {
  return a.type === b.type && (a.id ?? null) === (b.id ?? null);
}

/**
 * On-hand quantities, derived from the ledger.
 * @returns {Map<number, {total:number, byHolder:Map<string,number>}>}
 */
export async function stockLevels(env) {
  const { results } = await env.DB.prepare(
    `SELECT item_id, kind, qty, from_type, from_id, to_type, to_id FROM inventory_moves`
  ).all();

  const levels = new Map();
  const bump = (itemId, holderKey, delta) => {
    let entry = levels.get(itemId);
    if (!entry) { entry = { total: 0, byHolder: new Map() }; levels.set(itemId, entry); }
    entry.byHolder.set(holderKey, (entry.byHolder.get(holderKey) || 0) + delta);
    entry.total += delta;
  };

  for (const move of results || []) {
    const qty = Number(move.qty) || 0;
    if (move.to_type) bump(move.item_id, `${move.to_type}:${move.to_id ?? ''}`, qty);
    if (move.from_type) bump(move.item_id, `${move.from_type}:${move.from_id ?? ''}`, -qty);
  }
  return levels;
}

/** Quantity a single holder has of a single item. */
export async function onHand(env, itemId, holder) {
  const row = await env.DB.prepare(
    `SELECT
       COALESCE(SUM(CASE WHEN to_type = ? AND COALESCE(to_id, -1) = COALESCE(?, -1) THEN qty ELSE 0 END), 0)
     - COALESCE(SUM(CASE WHEN from_type = ? AND COALESCE(from_id, -1) = COALESCE(?, -1) THEN qty ELSE 0 END), 0)
       AS qty
     FROM inventory_moves WHERE item_id = ?`
  ).bind(holder.type, holder.id, holder.type, holder.id, itemId).first();
  return Number(row?.qty) || 0;
}

/**
 * Records what a finished job actually consumed.
 *
 * Called when a master closes a job: every line of that job which some stock
 * item is defined as feeding becomes a movement out of that master's van. The
 * master types nothing — the job already knows what was fitted.
 *
 * Deliberately never blocks. A van that shows empty when it wasn't goes
 * negative and gets flagged; refusing to close finished work over a counting
 * disagreement is how a stock system stops being used by the end of its first
 * week.
 */
export async function consumeForBooking(env, booking, holder) {
  const { results: items } = await env.DB.prepare(
    `SELECT code FROM booking_items WHERE booking_id = ?`
  ).bind(booking.id).all();
  if (!items || !items.length) return { recorded: 0 };

  const codes = items.map((i) => i.code).filter(Boolean);
  if (!codes.length) return { recorded: 0 };

  // Already recorded? Completing a job twice must not consume the stock twice.
  const existing = await env.DB.prepare(
    `SELECT COUNT(*) AS n FROM inventory_moves WHERE booking_id = ? AND kind = 'used'`
  ).bind(booking.id).first();
  if ((existing?.n || 0) > 0) return { recorded: 0, alreadyDone: true };

  const placeholders = codes.map(() => '?').join(',');
  const { results: stockItems } = await env.DB.prepare(
    `SELECT id, consumed_by, consume_qty FROM inventory_items
     WHERE active = 1 AND consumed_by IN (${placeholders})`
  ).bind(...codes).all();
  if (!stockItems || !stockItems.length) return { recorded: 0 };

  // One line can be on a job more than once — two televisions, two mounts.
  const countByCode = {};
  for (const code of codes) countByCode[code] = (countByCode[code] || 0) + 1;

  const statements = [];
  for (const stock of stockItems) {
    const qty = (countByCode[stock.consumed_by] || 0) * (stock.consume_qty || 1);
    if (qty <= 0) continue;
    statements.push(env.DB.prepare(
      `INSERT INTO inventory_moves (item_id, kind, qty, from_type, from_id, booking_id, note)
       VALUES (?, 'used', ?, ?, ?, ?, ?)`
    ).bind(stock.id, qty, holder.type, holder.id, booking.id, `Job #${booking.id}`));
  }

  if (!statements.length) return { recorded: 0 };
  await env.DB.batch(statements);
  return { recorded: statements.length };
}

export { sameHolder };
