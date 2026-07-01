// Squad Discord Role Management
// Handles auto-assigning/removing Discord roles when players are assigned
// to or removed from ORBAT squad slots.

const db = require('../config/database');
const { addRole, removeRole } = require('./discordRoles');

/**
 * Get the Discord role ID configured for a squad.
 * @param {number} squadId
 * @returns {Promise<string|null>}
 */
async function getSquadDiscordRoleId(squadId) {
    const [rows] = await db.query(
        'SELECT discord_role_id FROM orbat_squads WHERE id = ?',
        [squadId]
    );
    return rows.length > 0 ? rows[0].discord_role_id : null;
}

/**
 * Get the squad ID for a given role (slot).
 * @param {number} roleId
 * @returns {Promise<number|null>}
 */
async function getSquadIdFromRole(roleId) {
    const [rows] = await db.query(
        'SELECT squad_id FROM orbat_roles WHERE id = ?',
        [roleId]
    );
    return rows.length > 0 ? rows[0].squad_id : null;
}

/**
 * Get the Discord user ID for a given site user ID.
 * @param {number} userId
 * @returns {Promise<string|null>}
 */
async function getDiscordIdFromUserId(userId) {
    const [rows] = await db.query(
        'SELECT discord_id FROM users WHERE id = ?',
        [userId]
    );
    return rows.length > 0 ? rows[0].discord_id : null;
}

/**
 * Assign the squad's Discord role to a user.
 * Looks up the squad from the roleId, then the discord_role_id from the squad,
 * then grants it to the user's Discord ID.
 * @param {number} roleId - The ORBAT role (slot) ID
 * @param {number} userId - The site user ID
 * @returns {Promise<{ok:boolean, error?:string}>}
 */
async function assignSquadRole(roleId, userId) {
    try {
        const squadId = await getSquadIdFromRole(roleId);
        if (!squadId) return { ok: false, error: 'Role not found' };

        const discordRoleId = await getSquadDiscordRoleId(squadId);
        if (!discordRoleId) return { ok: true }; // No role configured — not an error

        const discordUserId = await getDiscordIdFromUserId(userId);
        if (!discordUserId) return { ok: false, error: 'User has no Discord ID' };

        return await addRole(discordUserId, discordRoleId);
    } catch (err) {
        console.error('[SQUAD_ROLE] assign error:', err);
        return { ok: false, error: err.message };
    }
}

/**
 * Check if a user is assigned to any squad that uses the given Discord role.
 * Used to avoid removing a shared role when the user still needs it.
 */
async function isUserAssignedToDiscordRole(discordUserId, discordRoleId) {
    const [rows] = await db.query(`
        SELECT 1 FROM orbat_assignments oa
        JOIN orbat_roles r ON oa.role_id = r.id
        JOIN orbat_squads s ON r.squad_id = s.id
        JOIN users u ON oa.user_id = u.id
        WHERE u.discord_id = ?
          AND s.discord_role_id = ?
          AND oa.role_id != ?
        LIMIT 1
    `, [discordUserId, discordRoleId, -1]); // -1 placeholder, overridden below
    return rows.length > 0;
}

/**
 * Remove the squad's Discord role from a user.
 * Skips removal if the same Discord role is shared by another squad the user is assigned to.
 * @param {number} roleId - The ORBAT role (slot) ID
 * @param {number} userId - The site user ID
 * @returns {Promise<{ok:boolean, error?:string}>}
 */
async function removeSquadRole(roleId, userId) {
    try {
        const squadId = await getSquadIdFromRole(roleId);
        if (!squadId) return { ok: false, error: 'Role not found' };

        const discordRoleId = await getSquadDiscordRoleId(squadId);
        if (!discordRoleId) return { ok: true }; // No role configured

        const discordUserId = await getDiscordIdFromUserId(userId);
        if (!discordUserId) return { ok: false, error: 'User has no Discord ID' };

        // Check if user is still assigned to another squad using the same Discord role
        const [shared] = await db.query(`
            SELECT 1 FROM orbat_assignments oa
            JOIN orbat_roles r ON oa.role_id = r.id
            JOIN orbat_squads s ON r.squad_id = s.id
            WHERE s.discord_role_id = ?
              AND oa.user_id = ?
              AND oa.role_id != ?
            LIMIT 1
        `, [discordRoleId, userId, roleId]);

        if (shared.length > 0) {
            return { ok: true, skipped: true, reason: 'User still assigned to another squad sharing this role' };
        }

        return await removeRole(discordUserId, discordRoleId);
    } catch (err) {
        console.error('[SQUAD_ROLE] remove error:', err);
        return { ok: false, error: err.message };
    }
}

/**
 * Remove the squad's Discord role from a user by Discord ID directly.
 * Used when we only have the Discord ID (e.g., roster auto-removal).
 * Skips removal if the same Discord role is shared by another squad the user is assigned to.
 * @param {number} squadId
 * @param {string} discordUserId
 * @returns {Promise<{ok:boolean, error?:string}>}
 */
async function removeSquadRoleByDiscordId(squadId, discordUserId) {
    try {
        const discordRoleId = await getSquadDiscordRoleId(squadId);
        if (!discordRoleId) return { ok: true };

        // Check if user is still assigned to another squad using the same Discord role
        const [shared] = await db.query(`
            SELECT 1 FROM orbat_assignments oa
            JOIN orbat_roles r ON oa.role_id = r.id
            JOIN orbat_squads s ON r.squad_id = s.id
            JOIN users u ON oa.user_id = u.id
            WHERE s.discord_role_id = ?
              AND u.discord_id = ?
              AND r.squad_id != ?
            LIMIT 1
        `, [discordRoleId, discordUserId, squadId]);

        if (shared.length > 0) {
            return { ok: true, skipped: true, reason: 'User still assigned to another squad sharing this role' };
        }

        return await removeRole(discordUserId, discordRoleId);
    } catch (err) {
        console.error('[SQUAD_ROLE] remove by Discord ID error:', err);
        return { ok: false, error: err.message };
    }
}

/**
 * When a user moves from one squad to another (or is reassigned within the
 * same operation), call this to remove the old squad's role and add the new one.
 * @param {number} newRoleId
 * @param {number|null} oldSquadId
 * @param {number} userId
 */
async function swapSquadRole(newRoleId, oldSquadId, userId) {
    // Remove old squad role if applicable
    if (oldSquadId) {
        const discordUserId = await getDiscordIdFromUserId(userId);
        if (discordUserId) {
            const oldRoleId = await getSquadDiscordRoleId(oldSquadId);
            if (oldRoleId) {
                await removeRole(discordUserId, oldRoleId);
            }
        }
    }
    // Assign new squad role
    await assignSquadRole(newRoleId, userId);
}

module.exports = {
    getSquadDiscordRoleId,
    getSquadIdFromRole,
    assignSquadRole,
    removeSquadRole,
    removeSquadRoleByDiscordId,
    swapSquadRole
};
