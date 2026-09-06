// The work authorization the customer signs before any drilling starts.
//
// The wording lives in the database as a series of VERSIONS, not as one
// editable row. Editing in the admin creates a new version and makes it
// active; the old ones stay exactly as they were. That matters more here than
// anywhere else in the system: a signature is only evidence of what the person
// was actually shown, and `job_authorizations.agreement_version` points at the
// row that holds those words. Overwrite the text and every past signature
// quietly starts referring to something the customer never read.
//
// The constants below are the fallback. If the table is missing — a fresh
// database, a migration not yet run — signing still works with the wording we
// shipped, instead of failing at a customer's door.

export const FALLBACK_VERSION = '2026-09-06';

export const FALLBACK_SUMMARY =
  'Before we start, we need your go-ahead to mount to the wall. Mounting leaves permanent anchor holes, and where in-wall wiring was chosen, an opening for an outlet.';

export const FALLBACK_ACKNOWLEDGEMENTS = [
  {
    id: 'a1',
    text: 'I own this property, or I rent it and have my landlord’s permission for this work. If I rent, patching the wall when I move out is between me and the property owner.',
  },
  {
    id: 'a2',
    text: 'I authorise drilling into the walls at the agreed locations. I understand the installer scans for studs and wiring first, but that pipes, wires and ducts hidden inside a wall are not always detectable.',
  },
  {
    id: 'a3',
    text: 'I have been offered the full terms, including the one-year workmanship warranty, and I agree to them.',
  },
];

export const AGREEMENT_URL = '/install-terms.html';

/**
 * The wording currently in force.
 *
 * @returns {{version, summary, acknowledgements, fullText}}
 */
export async function activeAgreement(env) {
  try {
    const row = await env.DB.prepare(
      `SELECT version, summary, acknowledgements_json, full_text
       FROM agreement_versions WHERE active = 1
       ORDER BY id DESC LIMIT 1`
    ).first();

    if (row) {
      return {
        version: row.version,
        summary: row.summary,
        acknowledgements: JSON.parse(row.acknowledgements_json),
        fullText: row.full_text,
      };
    }
  } catch (err) {
    console.error('Could not read the agreement from the database:', err);
  }

  return {
    version: FALLBACK_VERSION,
    summary: FALLBACK_SUMMARY,
    acknowledgements: FALLBACK_ACKNOWLEDGEMENTS,
    fullText: '',
  };
}

/**
 * The exact wording a given signature was taken under. Used when showing an
 * already-signed authorization, so what is displayed is what was agreed and
 * not whatever happens to be current.
 */
export async function agreementByVersion(env, version) {
  try {
    const row = await env.DB.prepare(
      `SELECT version, summary, acknowledgements_json, full_text
       FROM agreement_versions WHERE version = ?`
    ).bind(version).first();

    if (row) {
      return {
        version: row.version,
        summary: row.summary,
        acknowledgements: JSON.parse(row.acknowledgements_json),
        fullText: row.full_text,
      };
    }
  } catch (err) {
    console.error('Could not read agreement version', version, err);
  }
  return null;
}
