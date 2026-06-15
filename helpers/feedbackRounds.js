// Auto-close logic for feedback rounds: by deadline (scheduled) and on
// completion (when every assigned review has been submitted).
const db = require('../config/database');

// Closes any open round whose deadline has passed. Returns the number closed.
async function closeExpiredRounds() {
    const [result] = await db.query(`
        UPDATE feedback_cycles
        SET status = 'closed', closed_at = NOW()
        WHERE status = 'open' AND deadline IS NOT NULL AND deadline <= UNIX_TIMESTAMP()
    `);
    return result.affectedRows || 0;
}

// Closes the round if every assigned (non-ad-hoc) review has been submitted.
// Ad-hoc submissions don't count — they're extra, not part of the assigned set.
// Returns true if it closed the round.
async function closeIfAllSubmitted(cycleId) {
    const [[row]] = await db.query(`
        SELECT
            COUNT(*) AS total,
            SUM(status = 'submitted') AS done
        FROM feedback_pairs
        WHERE cycle_id = ? AND is_adhoc = 0
    `, [cycleId]);

    if (row && row.total > 0 && Number(row.done) === Number(row.total)) {
        const [result] = await db.query(
            "UPDATE feedback_cycles SET status = 'closed', closed_at = NOW() WHERE id = ? AND status = 'open'",
            [cycleId]
        );
        return (result.affectedRows || 0) > 0;
    }
    return false;
}

module.exports = { closeExpiredRounds, closeIfAllSubmitted };
