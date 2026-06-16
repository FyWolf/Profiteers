// Attendance-based Discord role reward engine.
//
// Rules ("after N confirmed attendances, add/remove these roles") fire ONCE per
// user when their cumulative count of orbat_attendance status='present' records
// reaches the threshold. Idempotency is tracked in attendance_reward_applications.
//
// Triggered from:
//   - routes/attendance.js  → evaluateUser() when a leader confirms present
//   - routes/admin/attendance-rewards.js → evaluateAll() on rule creation / manual re-run

const db = require('../config/database');
const { addRole, removeRole, fetchMemberRoleIds } = require('./discordRoles');
const { sendRewardCongrats } = require('../discord/rewards');

// Gentle pacing between Discord writes to stay clear of rate limits.
const WRITE_DELAY_MS = parseInt(process.env.DISCORD_RATE_DELAY_MS || '250', 10);
const sleep = ms => new Promise(r => setTimeout(r, ms));

// JSON columns come back parsed from mysql2, but tolerate a raw string too.
function parseRoleIds(value) {
    if (Array.isArray(value)) return value.map(String);
    if (typeof value === 'string' && value.trim()) {
        try { const a = JSON.parse(value); return Array.isArray(a) ? a.map(String) : []; }
        catch { return []; }
    }
    return [];
}

// Apply one rule's role changes to one member. Records the application only if
// every Discord call succeeded, so a transient failure is retried on the next
// evaluate/re-run (add/remove are idempotent on Discord's side).
//
// A congratulations message is sent only when `notify` is set AND the member is
// genuinely granted at least one role they did not already have — so someone who
// was manually given the role beforehand is not congratulated. Backfill / manual
// re-run pass notify=false to avoid spamming the channel with past milestones.
// Returns { applied: bool, errors: number, congratulated: bool }.
async function applyRuleToUser(rule, discordId, userId, { notify = false } = {}) {
    let errors = 0;
    const adds    = parseRoleIds(rule.add_role_ids);
    const removes = parseRoleIds(rule.remove_role_ids);

    // Roles the member already holds, to detect which adds are genuinely new.
    // null = couldn't determine; treat all adds as candidates (failed PUTs below
    // will then suppress the congrats via the error check).
    const current = await fetchMemberRoleIds(discordId);
    const newlyAdded = current ? adds.filter(id => !current.includes(id)) : adds.slice();

    for (const roleId of adds) {
        const r = await addRole(discordId, roleId);
        if (!r.ok) errors++;
        if (WRITE_DELAY_MS) await sleep(WRITE_DELAY_MS);
    }
    for (const roleId of removes) {
        const r = await removeRole(discordId, roleId);
        if (!r.ok) errors++;
        if (WRITE_DELAY_MS) await sleep(WRITE_DELAY_MS);
    }

    if (errors > 0) return { applied: false, errors, congratulated: false };

    await db.query(
        'INSERT IGNORE INTO attendance_reward_applications (rule_id, user_id) VALUES (?, ?)',
        [rule.id, userId]
    );

    let congratulated = false;
    if (notify && newlyAdded.length > 0) {
        await sendRewardCongrats({
            discordUserId: discordId,
            ruleName: rule.name,
            threshold: rule.threshold,
            awardedRoleIds: newlyAdded
        });
        congratulated = true;
    }

    return { applied: true, errors: 0, congratulated };
}

/**
 * Evaluate a single user after their attendance changes. Cheap in the common
 * case (no newly-crossed thresholds → no Discord calls).
 * @returns {Promise<{applied:number, errors:number, skipped?:string}>}
 */
async function evaluateUser(userId) {
    const [[user]] = await db.query(
        `SELECT u.discord_id,
                (SELECT COUNT(*) FROM orbat_attendance oa
                  WHERE oa.user_id = u.id AND oa.status = 'present') AS present_count
           FROM users u WHERE u.id = ?`,
        [userId]
    );
    if (!user) return { applied: 0, errors: 0, skipped: 'no such user' };
    if (!user.discord_id) return { applied: 0, errors: 0, skipped: 'no linked discord account' };

    // Rules reached but not yet applied, lowest threshold first so milestone
    // ordering is respected (a later rule can undo an earlier rule's role).
    const [rules] = await db.query(
        `SELECT r.id, r.name, r.threshold, r.add_role_ids, r.remove_role_ids
           FROM attendance_reward_rules r
          WHERE r.is_active = 1 AND r.threshold <= ?
            AND NOT EXISTS (SELECT 1 FROM attendance_reward_applications a
                             WHERE a.rule_id = r.id AND a.user_id = ?)
          ORDER BY r.threshold ASC, r.id ASC`,
        [user.present_count, userId]
    );

    let applied = 0, errors = 0;
    for (const rule of rules) {
        // notify=true: this is a live milestone the member just reached.
        const res = await applyRuleToUser(rule, user.discord_id, userId, { notify: true });
        if (res.applied) applied++;
        errors += res.errors;
    }
    return { applied, errors };
}

/**
 * Backfill / manual re-run: apply every active rule to every linked member who
 * already qualifies but hasn't had the rule applied. Idempotent.
 * @returns {Promise<{rules:number, applied:number, errors:number}>}
 */
async function evaluateAll() {
    const [rules] = await db.query(
        `SELECT id, name, threshold, add_role_ids, remove_role_ids
           FROM attendance_reward_rules
          WHERE is_active = 1
          ORDER BY threshold ASC, id ASC`
    );

    let applied = 0, errors = 0;
    for (const rule of rules) {
        const [users] = await db.query(
            `SELECT u.id AS user_id, u.discord_id
               FROM users u
               JOIN orbat_attendance oa ON oa.user_id = u.id AND oa.status = 'present'
              WHERE u.discord_id IS NOT NULL
                AND NOT EXISTS (SELECT 1 FROM attendance_reward_applications a
                                 WHERE a.rule_id = ? AND a.user_id = u.id)
              GROUP BY u.id, u.discord_id
             HAVING COUNT(oa.id) >= ?`,
            [rule.id, rule.threshold]
        );

        for (const u of users) {
            const res = await applyRuleToUser(rule, u.discord_id, u.user_id);
            if (res.applied) applied++;
            errors += res.errors;
        }
    }
    return { rules: rules.length, applied, errors };
}

module.exports = { evaluateUser, evaluateAll };
