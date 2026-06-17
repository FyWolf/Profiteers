const express = require('express');
const router = express.Router();
const db = require('../config/database');
const axios = require('axios');
const { loadNodesWithMembers, buildTree } = require('../helpers/organigram');

router.get('/', async (req, res) => {
    try {
        const [tables] = await db.query("SHOW TABLES LIKE 'roster_roles'");
        if (tables.length === 0) {
            return res.render('error', {
                title: 'Roster Setup Required',
                message: 'Roster System Not Set Up',
                description: 'The roster system needs to be set up. Please run the database migration.',
                user: res.locals.user
            });
        }

        const [roles] = await db.query(`
            SELECT * FROM roster_roles
            WHERE display_on_roster = TRUE
            ORDER BY hierarchy_level ASC
        `);

        // Ranked member sections
        const membersByRole = {};
        for (const role of roles) {
            const [members] = await db.query(`
                SELECT
                    rm.*,
                    rr.name as role_name,
                    rr.color as role_color,
                    u.id as user_id
                FROM roster_members rm
                JOIN roster_roles rr ON rm.highest_role_id = rr.id
                LEFT JOIN users u ON rm.discord_id = u.discord_id
                WHERE rm.highest_role_id = ? AND rm.is_visible = TRUE
                ORDER BY rm.discord_global_name ASC, rm.discord_username ASC
            `, [role.id]);
            membersByRole[role.id] = members;
        }

        // Organigram — admin-curated org chart shown above the roster. Each node
        // may hold any number of roster members (by discord_id); the helper resolves
        // current name/avatar and a profile link only for those who are registered.
        const organigramNodes = await loadNodesWithMembers(db);

        const [syncInfo] = await db.query('SELECT MAX(last_synced) as last_sync FROM roster_members');

        res.render('roster', {
            title: 'Roster - Profiteers PMC',
            roles,
            membersByRole,
            organigramTree: buildTree(organigramNodes),
            lastSync: syncInfo[0]?.last_sync || null,
            user: res.locals.user
        });
    } catch (error) {
        console.error('Error loading roster:', error);
        res.render('error', {
            title: 'Error Loading Roster',
            message: 'Error Loading Roster',
            description: error.code === 'ER_NO_SUCH_TABLE'
                ? 'Please run the database migrations.'
                : 'Could not load the roster.',
            user: res.locals.user
        });
    }
});

async function runRosterSync() {
    const botToken = process.env.DISCORD_BOT_TOKEN;
    const guildId  = process.env.DISCORD_GUILD_ID;

    if (!botToken) throw new Error('Bot token not configured');

    console.log('Starting roster sync...');

    let allMembers = [];
    let after = '0';
    let hasMore = true;
    while (hasMore) {
        const response = await axios.get(
            `https://discord.com/api/v10/guilds/${guildId}/members?limit=1000&after=${after}`,
            { headers: { Authorization: `Bot ${botToken}` } }
        );
        const members = response.data;
        allMembers = allMembers.concat(members);
        if (members.length < 1000) hasMore = false;
        else after = members[members.length - 1].user.id;
    }

    console.log(`Fetched ${allMembers.length} members from Discord`);

    const [rosterRoles] = await db.query('SELECT * FROM roster_roles ORDER BY hierarchy_level ASC');
    const roleMap = {};
    rosterRoles.forEach(role => { roleMap[role.discord_role_id] = role; });

    await db.query('DELETE FROM roster_members');

    let syncedCount = 0, skippedBots = 0;

    for (const member of allMembers) {
        if (member.user.bot) { skippedBots++; continue; }

        const userRoles = member.roles || [];

        let highestRole = null, highestLevel = 999;
        for (const roleId of userRoles) {
            if (roleMap[roleId] && roleMap[roleId].hierarchy_level < highestLevel) {
                highestRole = roleMap[roleId];
                highestLevel = roleMap[roleId].hierarchy_level;
            }
        }

        if (!highestRole) continue;

        let joinedAtMySQL = null;
        if (member.joined_at) {
            joinedAtMySQL = new Date(member.joined_at).toISOString().slice(0, 19).replace('T', ' ');
        }

        await db.query(`
            INSERT INTO roster_members
            (discord_id, discord_username, discord_global_name, discord_avatar, nickname, highest_role_id, joined_at)
            VALUES (?, ?, ?, ?, ?, ?, ?)
        `, [
            member.user.id,
            member.user.username,
            member.user.global_name || member.user.username,
            member.user.avatar,
            member.nick || null,
            highestRole.id,
            joinedAtMySQL
        ]);

        await db.query(`
            UPDATE users SET
                discord_username = ?,
                discord_global_name = ?,
                discord_avatar = ?
            WHERE discord_id = ?
        `, [
            member.user.username,
            member.user.global_name || member.user.username,
            member.user.avatar,
            member.user.id
        ]);

        syncedCount++;
    }

    // Remove static (template) ORBAT assignments for members who are no longer
    // in the roster (i.e. they left the Discord guild). Dynamic operation ORBATs
    // are left alone — hosts manage those per-operation.
    const [cleanup] = await db.query(`
        DELETE oa FROM orbat_assignments oa
        JOIN orbat_roles r ON oa.role_id = r.id
        JOIN orbat_squads s ON r.squad_id = s.id
        JOIN users u ON oa.user_id = u.id
        WHERE s.orbat_id IS NOT NULL
          AND u.discord_id IS NOT NULL
          AND NOT EXISTS (
              SELECT 1 FROM roster_members rm WHERE rm.discord_id = u.discord_id
          )
    `);
    const orbatRemoved = cleanup.affectedRows || 0;

    console.log(`Roster sync complete: ${syncedCount} members synced (${skippedBots} bots skipped, ${orbatRemoved} stale ORBAT assignments removed)`);
    return { total: allMembers.length, synced: syncedCount, skipped: skippedBots, orbatRemoved };
}

router.post('/sync', async (req, res) => {
    if (!req.session.isAdmin) {
        return res.status(403).json({ success: false, error: 'Unauthorized' });
    }
    try {
        const result = await runRosterSync();
        const msg = result.orbatRemoved > 0
            ? `Synced ${result.synced} members (${result.orbatRemoved} stale ORBAT assignments removed)`
            : `Synced ${result.synced} members`;
        res.json({ success: true, message: msg, ...result });
    } catch (error) {
        console.error('Error syncing roster:', error);
        res.json({ success: false, error: error.response?.data?.message || error.message || 'Failed to sync roster' });
    }
});

router.get('/search', async (req, res) => {
    try {
        const query = req.query.q || '';
        if (query.length < 2) return res.json([]);

        const [members] = await db.query(`
            SELECT
                rm.discord_id, rm.discord_username, rm.discord_global_name,
                rm.nickname, rm.discord_avatar,
                u.id as user_id
            FROM roster_members rm
            LEFT JOIN users u ON rm.discord_id = u.discord_id
            WHERE rm.is_visible = TRUE
              AND (rm.discord_global_name LIKE ? OR rm.discord_username LIKE ? OR rm.nickname LIKE ?)
            ORDER BY rm.discord_global_name ASC
            LIMIT 20
        `, [`%${query}%`, `%${query}%`, `%${query}%`]);

        res.json(members.map(m => ({
            discord_id: m.discord_id,
            user_id: m.user_id,
            name: m.discord_global_name || m.discord_username || m.nickname,
            username: m.discord_username,
            discord_global_name: m.discord_global_name,
            discord_avatar: m.discord_avatar,
            needs_registration: !m.user_id
        })));
    } catch (error) {
        console.error('Error searching roster:', error);
        res.json([]);
    }
});

module.exports = router;
module.exports.runRosterSync = runRosterSync;
