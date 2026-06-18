// Staff LOA support.
//
// Two configured Discord roles:
//   DISCORD_STAFF_ROLE_ID      - marks who counts as "staff" (who may submit a
//                                staff LOA / see the option on the form).
//   DISCORD_STAFF_LOA_ROLE_ID  - granted to a staff member for the duration of an
//                                active staff LOA, removed once it ends.
//
// All Discord writes no-op when DISCORD_STAFF_LOA_ROLE_ID is not configured, so
// the feature is inert until the role ids are set.

const db = require('../config/database');
const { addRole, removeRole, fetchMemberRoleIds } = require('./discordRoles');

const staffRoleId    = () => process.env.DISCORD_STAFF_ROLE_ID || null;
const staffLoaRoleId = () => process.env.DISCORD_STAFF_LOA_ROLE_ID || null;

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
    const [rows] = await db.query(`
        SELECT 1 FROM leave_of_absence
        WHERE user_id = ? AND type = 'staff' AND status = 'approved'
          AND start_date <= UNIX_TIMESTAMP() AND end_date >= UNIX_TIMESTAMP()
        LIMIT 1
    `, [userId]);
    return rows.length > 0;
}

// Recompute one user's staff-LOA state: refresh the per-row applied flags and
// grant/revoke the Discord role to match whether they have an active staff LOA.
// Idempotent; safe to call after any submit/edit/delete.
async function syncUser(userId) {
    if (!userId) return;

    // Per-row flag reflects "this staff LOA is approved and within its window now".
    await db.query(`
        UPDATE leave_of_absence
        SET staff_role_applied = CASE
            WHEN status = 'approved' AND start_date <= UNIX_TIMESTAMP() AND end_date >= UNIX_TIMESTAMP()
            THEN 1 ELSE 0 END
        WHERE user_id = ? AND type = 'staff'
    `, [userId]);

    const roleId = staffLoaRoleId();
    if (!roleId) return;

    const [[u]] = await db.query('SELECT discord_id FROM users WHERE id = ?', [userId]);
    if (!u || !u.discord_id) return;

    if (await hasActiveStaffLoa(userId)) {
        await addRole(u.discord_id, roleId);
    } else {
        await removeRole(u.discord_id, roleId);
    }
}

// Cron entry point: reconcile every user whose staff-LOA window has just started
// or ended since the last run (i.e. a row whose applied flag disagrees with its
// current active state). Returns the number of users reconciled.
async function reconcileAll() {
    const [users] = await db.query(`
        SELECT DISTINCT user_id FROM leave_of_absence
        WHERE type = 'staff'
          AND staff_role_applied <> (CASE
              WHEN status = 'approved' AND start_date <= UNIX_TIMESTAMP() AND end_date >= UNIX_TIMESTAMP()
              THEN 1 ELSE 0 END)
    `);
    for (const { user_id } of users) {
        await syncUser(user_id);
    }
    return users.length;
}

module.exports = { isStaffMember, hasActiveStaffLoa, syncUser, reconcileAll };
