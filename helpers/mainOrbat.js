// Resolves the canonical "Main ORBAT" template — the single orbat_templates
// row flagged is_main = 1. This is the backbone the platoon economy and the
// nav/feedback defaults run off, replacing hardcoded template ids.
//
// If nothing is flagged (e.g. before an admin has picked one), we fall back to
// the most-recently-updated active template so dependent systems keep working.
//
// attachUser calls getMainOrbatId() on every request, so the result is cached
// in-process for a short TTL; the admin "Set as Main" toggle calls invalidate()
// to make the switch take effect immediately.
const db = require('../config/database');

const CACHE_TTL_MS = 60 * 1000;
let cache = { row: null, at: 0 };

async function fetchMainOrbat() {
    // Prefer an explicitly flagged, active template; otherwise fall back to the
    // most-recently-updated active one so the nav/feedback never break.
    const [rows] = await db.query(
        `SELECT id, name, is_main, is_active
           FROM orbat_templates
          WHERE is_active = 1
          ORDER BY is_main DESC, updated_at DESC, id DESC
          LIMIT 1`
    );
    return rows[0] || null;
}

async function getMainOrbat() {
    const now = Date.now();
    if (cache.row !== undefined && cache.at && (now - cache.at) < CACHE_TTL_MS) {
        return cache.row;
    }
    const row = await fetchMainOrbat();
    cache = { row, at: now };
    return row;
}

async function getMainOrbatId() {
    const row = await getMainOrbat();
    return row ? row.id : null;
}

// Clear the cache after the main template changes (admin toggle, template edit).
function invalidate() {
    cache = { row: null, at: 0 };
}

module.exports = { getMainOrbat, getMainOrbatId, invalidate };
