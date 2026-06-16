// Thin wrapper around the Discord REST API for guild role management.
// Mirrors the axios + Bot-token pattern used in routes/roster.js and
// routes/admin/users.js. All write calls are best-effort: failures are
// logged and surfaced via the return value, never thrown.

const axios = require('axios');

const API = 'https://discord.com/api/v10';

function config() {
    return {
        token:   process.env.DISCORD_BOT_TOKEN,
        guildId: process.env.DISCORD_GUILD_ID,
    };
}

function authHeaders() {
    return { headers: { Authorization: `Bot ${config().token}` } };
}

/**
 * Fetch the guild's assignable roles, most-significant first.
 * Excludes @everyone (id === guildId) and managed (bot/integration/boost) roles,
 * since those cannot be granted manually. Returns [] when not configured.
 * @returns {Promise<Array<{id:string,name:string,color:number,position:number}>>}
 */
async function fetchGuildRoles() {
    const { token, guildId } = config();
    if (!token || !guildId) return [];

    const res = await axios.get(`${API}/guilds/${guildId}/roles`, authHeaders());
    return (res.data || [])
        .filter(r => r.id !== guildId && !r.managed)
        .map(r => ({ id: r.id, name: r.name, color: r.color, position: r.position }))
        .sort((a, b) => b.position - a.position);
}

/**
 * Fetch the role ids a guild member currently holds.
 * Returns an array of id strings, or null if the lookup could not be performed
 * (not configured, member left the guild, or a transient error).
 * @returns {Promise<string[]|null>}
 */
async function fetchMemberRoleIds(discordUserId) {
    const { token, guildId } = config();
    if (!token || !guildId || !discordUserId) return null;

    try {
        const res = await axios.get(
            `${API}/guilds/${guildId}/members/${discordUserId}`,
            authHeaders()
        );
        return (res.data?.roles || []).map(String);
    } catch (err) {
        const status = err.response?.status;
        console.error(`[REWARDS] fetch member ${discordUserId} roles failed`
            + ` (status ${status ?? 'n/a'}): ${err.response?.data?.message || err.message}`);
        return null;
    }
}

// Internal: PUT/DELETE a single role on a member. Returns { ok, status, error }.
async function modifyRole(method, discordUserId, roleId) {
    const { token, guildId } = config();
    if (!token || !guildId) return { ok: false, error: 'Discord not configured' };
    if (!discordUserId || !roleId) return { ok: false, error: 'Missing user or role id' };

    const url = `${API}/guilds/${guildId}/members/${discordUserId}/roles/${roleId}`;
    try {
        await axios({ method, url, ...authHeaders() });
        return { ok: true };
    } catch (err) {
        const status = err.response?.status;
        // 403 = bot role hierarchy too low / missing Manage Roles; 404 = member or role gone.
        console.error(`[REWARDS] ${method} role ${roleId} for user ${discordUserId} failed`
            + ` (status ${status ?? 'n/a'}): ${err.response?.data?.message || err.message}`);
        return { ok: false, status, error: err.response?.data?.message || err.message };
    }
}

/** Grant a role to a guild member. */
function addRole(discordUserId, roleId) {
    return modifyRole('put', discordUserId, roleId);
}

/** Remove a role from a guild member. */
function removeRole(discordUserId, roleId) {
    return modifyRole('delete', discordUserId, roleId);
}

module.exports = { fetchGuildRoles, fetchMemberRoleIds, addRole, removeRole };
