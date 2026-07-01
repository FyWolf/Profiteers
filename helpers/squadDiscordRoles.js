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
 * Remove the squad's Discord role from a user.
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

        return await removeRole(discordUserId, discordRoleId);
    } catch (err) {
        console.error('[SQUAD_ROLE] remove error:', err);
        return { ok: false, error: err.message };
    }
}

/**
 * Remove the squad's Discord role from a user by Discord ID directly.
 * Used when we only have the Discord ID (e.g., roster auto-removal).
 * @param {number} squadId
 * @param {string} discordUserId
 * @returns {Promise<{ok:boolean, error?:string}>}
 */
async function removeSquadRoleByDiscordId(squadId, discordUserId) {
    try {
        const discordRoleId = await getSquadDiscordRoleId(squadId);
        if (!discordRoleId) return { ok: true };

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
