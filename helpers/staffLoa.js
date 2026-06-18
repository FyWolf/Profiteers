// Staff LOA support.
//
// Two configured Discord roles:
//   DISCORD_STAFF_ROLE_ID      - marks who counts as "staff" (who may submit a
//                                staff LOA / see the option on the form).
//   DISCORD_STAFF_LOA_ROLE_ID  - granted to a staff member while a staff LOA is
//                                active, removed once it ends.
//
// All Discord writes no-op when DISCORD_STAFF_LOA_ROLE_ID is not configured, so
// the feature is inert until the role ids are set.
//
// The `staff_role_applied` column tracks whether *we* granted the role for a row,
// so we only ever revoke a role we ourselves applied — submitting/editing an LOA
// never strips a role the member already holds for another reason.

const db = require('../config/database');
const { addRole, removeRole, fetchMemberRoleIds, fetchAllMembers } = require('./discordRoles');

const staffRoleId    = () => process.env.DISCORD_STAFF_ROLE_ID || null;
const staffLoaRoleId = () => process.env.DISCORD_STAFF_LOA_ROLE_ID || null;

const ACTIVE_SQL = `status = 'approved' AND start_date <= UNIX_TIMESTAMP() AND end_date >= UNIX_TIMESTAMP()`;

// Live check: does this Discord user currently hold the staff marker role?
// Returns false when not configured or the lookup fails (fail-closed).
async function isStaffMember(discordId) {
    const roleId = staffRoleId();
    if (!roleId || !discordId) return false;
    const roles = await fetchMemberRoleIds(discordId);
    return Array.isArray(roles) && roles.includes(roleId);
}

// Does the user have a staff LOA that is approved and active right now?
async function hasActiveStaffLoa(userId) {
    const [rows] = await db.query(
        `SELECT 1 FROM leave_of_absence WHERE user_id = ? AND type = 'staff' AND ${ACTIVE_SQL} LIMIT 1`,
        [userId]
    );
    return rows.length > 0;
}

async function discordIdFor(userId) {
    const [[u]] = await db.query('SELECT discord_id FROM users WHERE id = ?', [userId]);
    return u ? u.discord_id : null;
}

// Submit path: grant the staff-LOA role if the user has an active staff LOA, and
// flag the active row(s) as applied. Never revokes — so creating a (future) LOA
// can't strip a role the member already holds.
async function grantIfActive(userId) {
    if (!userId) return;
    await db.query(
        `UPDATE leave_of_absence SET staff_role_applied = 1 WHERE user_id = ? AND type = 'staff' AND ${ACTIVE_SQL}`,
        [userId]
    );
    const roleId = staffLoaRoleId();
    if (!roleId) return;
    if (!(await hasActiveStaffLoa(userId))) return;
    const discordId = await discordIdFor(userId);
    if (discordId) await addRole(discordId, roleId);
}

// Full reconcile (edit / delete / cron): the role should be present iff the user
// has an active staff LOA. Only revoke when the role was one we applied
// (`staff_role_applied`), so manually-granted roles are left untouched.
// `forceWasApplied` covers deletion, where the applied row is already gone.
async function reconcile(userId, { forceWasApplied = false } = {}) {
    if (!userId) return;

    const [[agg]] = await db.query(
        `SELECT MAX(staff_role_applied) AS wasApplied FROM leave_of_absence WHERE user_id = ? AND type = 'staff'`,
        [userId]
    );
    const wasApplied = forceWasApplied || !!(agg && agg.wasApplied);

    await db.query(
        `UPDATE leave_of_absence
         SET staff_role_applied = CASE WHEN ${ACTIVE_SQL} THEN 1 ELSE 0 END
         WHERE user_id = ? AND type = 'staff'`,
        [userId]
    );

    const roleId = staffLoaRoleId();
    if (!roleId) return;
    const discordId = await discordIdFor(userId);
    if (!discordId) return;

    if (await hasActiveStaffLoa(userId)) {
        await addRole(discordId, roleId);
    } else if (wasApplied) {
        await removeRole(discordId, roleId);
    }
}

// Cron entry point: reconcile every user whose staff-LOA window has just started
// or ended since the last run (i.e. a row whose applied flag disagrees with its
// current active state). Returns the number of users reconciled.
async function reconcileAll() {
    const [users] = await db.query(
        `SELECT DISTINCT user_id FROM leave_of_absence
         WHERE type = 'staff'
           AND staff_role_applied <> (CASE WHEN ${ACTIVE_SQL} THEN 1 ELSE 0 END)`
    );
    for (const { user_id } of users) {
        await reconcile(user_id);
    }
    return users.length;
}

// Discord users who SHOULD currently hold the staff-LOA role (active staff LOA).
async function expectedStaffLoaHolders() {
    const [rows] = await db.query(`
        SELECT DISTINCT u.discord_id,
               COALESCE(rm.nickname, u.discord_global_name, u.username) AS name
        FROM leave_of_absence loa
        JOIN users u ON loa.user_id = u.id
        LEFT JOIN roster_members rm ON rm.discord_id = u.discord_id
        WHERE loa.type = 'staff' AND ${ACTIVE_SQL}
          AND u.discord_id IS NOT NULL
    `);
    const map = new Map();
    rows.forEach(r => map.set(String(r.discord_id), r.name));
    return map;
}

// Dry-run audit comparing the configured staff-LOA Discord role against who
// should have it. Returns { configured, available, okCount, missing[], extra[] }.
//   missing - should have the role but don't (would be granted by a fix)
//   extra   - hold the role but have no active staff LOA (would be revoked by a fix)
async function auditStaffLoaRoles() {
    const roleId = staffLoaRoleId();
    const result = { configured: !!roleId, available: false, okCount: 0, missing: [], extra: [] };
    if (!roleId) return result;

    const expected = await expectedStaffLoaHolders();

    const members = await fetchAllMembers();
    if (!members.length) {
        // Could not enumerate members (bot token/guild not set or API error).
        return result;
    }
    result.available = true;

    const holders = new Map(); // discord_id -> display name, among current role holders
    for (const m of members) {
        if (m.user?.bot) continue;
        if ((m.roles || []).map(String).includes(roleId)) {
            holders.set(String(m.user.id), m.nick || m.user.global_name || m.user.username);
        }
    }

    for (const [id, name] of expected) {
        if (holders.has(id)) result.okCount++;
        else result.missing.push({ discord_id: id, name });
    }
    for (const [id, name] of holders) {
        if (!expected.has(id)) result.extra.push({ discord_id: id, name });
    }
    return result;
}

// Apply the corrections from auditStaffLoaRoles(): grant the role to everyone
// missing it and revoke it from everyone holding it without an active staff LOA.
// Also resyncs the per-row applied flags. Returns counts.
async function fixStaffLoaRoles() {
    const roleId = staffLoaRoleId();
    if (!roleId) return { configured: false, added: 0, removed: 0, failed: 0 };

    const audit = await auditStaffLoaRoles();
    if (!audit.available) return { configured: true, available: false, added: 0, removed: 0, failed: 0 };

    let added = 0, removed = 0, failed = 0;
    for (const m of audit.missing) {
        const r = await addRole(m.discord_id, roleId);
        r.ok ? added++ : failed++;
    }
    for (const m of audit.extra) {
        const r = await removeRole(m.discord_id, roleId);
        r.ok ? removed++ : failed++;
    }

    // Keep the per-row applied flags in step with the live active windows.
    await db.query(
        `UPDATE leave_of_absence
         SET staff_role_applied = CASE WHEN ${ACTIVE_SQL} THEN 1 ELSE 0 END
         WHERE type = 'staff'`
    );

    return { configured: true, available: true, added, removed, failed };
}

// Grant or revoke the staff-LOA role for a single member (by discord id), and
// keep that member's per-row applied flags in step. Returns { ok, error }.
async function fixOneStaffLoaRole(discordId, action) {
    const roleId = staffLoaRoleId();
    if (!roleId) return { ok: false, error: 'DISCORD_STAFF_LOA_ROLE_ID is not configured' };
    if (!discordId) return { ok: false, error: 'Missing member' };
    if (action !== 'grant' && action !== 'revoke') return { ok: false, error: 'Invalid action' };

    const result = action === 'grant'
        ? await addRole(discordId, roleId)
        : await removeRole(discordId, roleId);

    const [[u]] = await db.query('SELECT id FROM users WHERE discord_id = ? LIMIT 1', [discordId]);
    if (u) {
        await db.query(
            `UPDATE leave_of_absence SET staff_role_applied = CASE WHEN ${ACTIVE_SQL} THEN 1 ELSE 0 END
             WHERE user_id = ? AND type = 'staff'`,
            [u.id]
        );
    }
    return result;
}

module.exports = {
    isStaffMember, hasActiveStaffLoa, grantIfActive, reconcile, reconcileAll,
    auditStaffLoaRoles, fixStaffLoaRoles, fixOneStaffLoaRole
};
