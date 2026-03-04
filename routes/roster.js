const express = require('express');
const router = express.Router();
const db = require('../config/database');
const axios = require('axios');

// Public roster page
router.get('/', async (req, res) => {
    try {
        // Check if roster tables exist
        const [tables] = await db.query("SHOW TABLES LIKE 'roster_roles'");
        
        if (tables.length === 0) {
            // Tables don't exist yet - show setup message
            return res.render('error', {
                title: 'Roster Setup Required',
                message: 'Roster System Not Set Up',
                description: 'The roster system needs to be set up. Please run the database migration: mysql < database/roster-schema.sql',
                user: res.locals.user
            });
        }

        // Get all roster roles ordered by hierarchy
        const [roles] = await db.query(`
            SELECT * FROM roster_roles 
            WHERE display_on_roster = TRUE
            ORDER BY hierarchy_level ASC
        `);

        // Get all visible members grouped by their highest role
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

        // Get last sync time
        const [syncInfo] = await db.query(
            'SELECT MAX(last_synced) as last_sync FROM roster_members'
        );

        res.render('roster', {
            title: 'Roster - Profiteers PMC',
            roles: roles,
            membersByRole: membersByRole,
            lastSync: syncInfo[0]?.last_sync || null
        });
    } catch (error) {
        console.error('Error loading roster:', error);
        res.render('error', {
            title: 'Error Loading Roster',
            message: 'Error Loading Roster',
            description: error.code === 'ER_NO_SUCH_TABLE' 
                ? 'Please run the database migration: mysql < database/roster-schema.sql'
                : 'Could not load the roster.',
            user: res.locals.user
        });
    }
});

// Sync roster from Discord (admin only)
router.post('/sync', async (req, res) => {
    // Check if user is admin
    if (!req.session.isAdmin) {
        return res.status(403).json({ success: false, error: 'Unauthorized' });
    }

    try {
        const botToken = process.env.DISCORD_BOT_TOKEN;
        const guildId = '1172956513069973596';

        if (!botToken) {
            return res.json({ success: false, error: 'Bot token not configured' });
        }

        console.log('🔄 Starting roster sync...');

        // Fetch all guild members
        let allMembers = [];
        let after = '0';
        let hasMore = true;

        while (hasMore) {
            const response = await axios.get(
                `https://discord.com/api/v10/guilds/${guildId}/members?limit=1000&after=${after}`,
                {
                    headers: {
                        Authorization: `Bot ${botToken}`
                    }
                }
            );

            const members = response.data;
            allMembers = allMembers.concat(members);

            if (members.length < 1000) {
                hasMore = false;
            } else {
                after = members[members.length - 1].user.id;
            }
        }

        console.log(`📥 Fetched ${allMembers.length} members from Discord`);

        // Get all roster roles
        const [rosterRoles] = await db.query(
            'SELECT * FROM roster_roles ORDER BY hierarchy_level ASC'
        );

        const roleMap = {};
        rosterRoles.forEach(role => {
            roleMap[role.discord_role_id] = role;
        });

        // Clear existing roster
        await db.query('DELETE FROM roster_members');

        let syncedCount = 0;
        let skippedBots = 0;

        // Process each member
        for (const member of allMembers) {
            // Skip bots
            if (member.user.bot) {
                skippedBots++;
                continue;
            }

            const userRoles = member.roles || [];
            
            // Find highest role this member has
            let highestRole = null;
            let highestLevel = 999;

            for (const roleId of userRoles) {
                if (roleMap[roleId] && roleMap[roleId].hierarchy_level < highestLevel) {
                    highestRole = roleMap[roleId];
                    highestLevel = roleMap[roleId].hierarchy_level;
                }
            }

            // Only add if they have at least one roster role
            if (highestRole) {
                // Convert Discord ISO datetime to MySQL datetime
                let joinedAtMySQL = null;
                if (member.joined_at) {
                    const joinedDate = new Date(member.joined_at);
                    joinedAtMySQL = joinedDate.toISOString().slice(0, 19).replace('T', ' ');
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

                syncedCount++;
            }
        }

        console.log(`✅ Synced ${syncedCount} members (skipped ${skippedBots} bots)`);

        res.json({
            success: true,
            message: `Synced ${syncedCount} members`,
            total: allMembers.length,
            synced: syncedCount,
            skipped: skippedBots
        });
    } catch (error) {
        console.error('❌ Error syncing roster:', error);
        res.json({
            success: false,
            error: error.response?.data?.message || error.message || 'Failed to sync roster'
        });
    }
});

// Search roster for player assignment (API endpoint)
router.get('/search', async (req, res) => {
    try {
        const query = req.query.q || '';
        
        if (query.length < 2) {
            return res.json([]);
        }
        
        const [members] = await db.query(`
            SELECT 
                rm.discord_id,
                rm.discord_username,
                rm.discord_global_name,
                rm.nickname,
                rm.discord_avatar,
                u.id as user_id
            FROM roster_members rm
            LEFT JOIN users u ON rm.discord_id = u.discord_id
            WHERE 
                rm.is_visible = TRUE
                AND (
                    rm.discord_global_name LIKE ? 
                    OR rm.discord_username LIKE ?
                    OR rm.nickname LIKE ?
                )
            ORDER BY rm.discord_global_name ASC
            LIMIT 20
        `, [`%${query}%`, `%${query}%`, `%${query}%`]);
        
        // Format for frontend - include ALL members
        const results = members.map(m => ({
            discord_id: m.discord_id,
            user_id: m.user_id,
            name: m.discord_global_name || m.discord_username || m.nickname,
            username: m.discord_username,
            discord_global_name: m.discord_global_name,
            discord_avatar: m.discord_avatar,
            needs_registration: !m.user_id // Flag if they haven't logged in yet
        }));
        
        res.json(results);
    } catch (error) {
        console.error('Error searching roster:', error);
        res.json([]);
    }
});

module.exports = router;