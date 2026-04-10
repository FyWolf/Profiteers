const express = require('express');
const router = express.Router();
const db = require('../config/database');
const axios = require('axios');

const DEPARTMENTS = [
    {
        key: 'operations',
        label: 'Operations',
        env: 'DISCORD_DEPT_OPERATIONS_ROLE_ID',
        subcategories: [
            { label: 'Zeus Team',    env: 'DISCORD_OPS_ZEUS_ROLE_ID'    },
            { label: 'Lore Wing',    env: 'DISCORD_OPS_LORE_ROLE_ID'    },
            { label: 'Tech Wing',    env: 'DISCORD_OPS_TECH_ROLE_ID'    },
            { label: 'Modding Wing', env: 'DISCORD_OPS_MODDING_ROLE_ID' },
        ]
    },
    {
        key: 'training',
        label: 'Training',
        env: 'DISCORD_DEPT_TRAINING_ROLE_ID',
        subcategories: [
            { label: 'AIT Instructor', env: 'DISCORD_TRAIN_AIT_ROLE_ID' },
            { label: 'BCT Instructor', env: 'DISCORD_TRAIN_BCT_ROLE_ID' },
            { label: 'NCO Instructor', env: 'DISCORD_TRAIN_NCO_ROLE_ID' },
        ]
    },
    { key: 'moderation',  label: 'Moderation',  env: 'DISCORD_DEPT_MODERATION_ROLE_ID',  subcategories: [] },
    { key: 'recruitment', label: 'Recruitment', env: 'DISCORD_DEPT_RECRUITMENT_ROLE_ID', subcategories: [] },
];

// Build a flat map of { discord_role_id → label } for all dept + sub-cat roles
function getDeptRoleMap() {
    const map = {};
    DEPARTMENTS.forEach(d => {
        const id = process.env[d.env];
        if (id) map[id] = d.label;
        (d.subcategories || []).forEach(sc => {
            const scId = process.env[sc.env];
            if (scId) map[scId] = sc.label;
        });
    });
    return map;
}

// Quick lookup: sub-category label → parent dept label
function buildSubcatParentMap() {
    const map = {};
    DEPARTMENTS.forEach(d => {
        (d.subcategories || []).forEach(sc => { map[sc.label] = d.label; });
    });
    return map;
}

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

        // Ranked member sections — exclude staff (anyone with departments set)
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
                  AND (rm.departments IS NULL OR JSON_LENGTH(rm.departments) = 0)
                ORDER BY rm.discord_global_name ASC, rm.discord_username ASC
            `, [role.id]);
            membersByRole[role.id] = members;
        }

        // Staff — all members with any department assignment
        const [allStaff] = await db.query(`
            SELECT
                rm.*,
                rr.name as role_name, rr.color as role_color, rr.hierarchy_level,
                u.id as user_id
            FROM roster_members rm
            JOIN roster_roles rr ON rm.highest_role_id = rr.id
            LEFT JOIN users u ON rm.discord_id = u.discord_id
            WHERE rm.is_visible = TRUE AND rm.departments IS NOT NULL AND JSON_LENGTH(rm.departments) > 0
            ORDER BY rr.hierarchy_level ASC, rm.discord_global_name ASC
        `);

        // Build staffByDept: { deptLabel: { members: [], subcats: { subcatLabel: [] } } }
        const subcatParent = buildSubcatParentMap();
        const staffByDept = {};
        DEPARTMENTS.forEach(d => {
            staffByDept[d.label] = { members: [], subcats: {} };
            (d.subcategories || []).forEach(sc => { staffByDept[d.label].subcats[sc.label] = []; });
        });

        allStaff.forEach(m => {
            let labels = [];
            try { labels = JSON.parse(m.departments) || []; } catch {}

            const memberDeptSet = new Set();
            const memberSubcats = [];

            labels.forEach(lbl => {
                if (subcatParent[lbl]) {
                    // It's a sub-category label
                    memberSubcats.push(lbl);
                    memberDeptSet.add(subcatParent[lbl]);
                } else {
                    const dept = DEPARTMENTS.find(d => d.label === lbl);
                    if (dept) memberDeptSet.add(lbl);
                }
            });

            memberDeptSet.forEach(deptLabel => {
                if (!staffByDept[deptLabel]) return;
                const deptDef = DEPARTMENTS.find(d => d.label === deptLabel);
                const relevantSubcats = memberSubcats.filter(sc =>
                    (deptDef?.subcategories || []).some(s => s.label === sc)
                );

                if (relevantSubcats.length > 0) {
                    relevantSubcats.forEach(sc => {
                        if (staffByDept[deptLabel].subcats[sc]) {
                            staffByDept[deptLabel].subcats[sc].push(m);
                        }
                    });
                } else {
                    staffByDept[deptLabel].members.push(m);
                }
            });
        });

        const [syncInfo] = await db.query('SELECT MAX(last_synced) as last_sync FROM roster_members');

        res.render('roster', {
            title: 'Roster - Profiteers PMC',
            roles,
            membersByRole,
            staffByDept,
            departments: DEPARTMENTS,   // full structure for sub-cat rendering
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

    const deptRoleMap = getDeptRoleMap();

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

        // Collect all dept + sub-cat labels this member has
        const memberLabels = [];
        for (const roleId of userRoles) {
            if (deptRoleMap[roleId]) memberLabels.push(deptRoleMap[roleId]);
        }

        let joinedAtMySQL = null;
        if (member.joined_at) {
            joinedAtMySQL = new Date(member.joined_at).toISOString().slice(0, 19).replace('T', ' ');
        }

        await db.query(`
            INSERT INTO roster_members
            (discord_id, discord_username, discord_global_name, discord_avatar, nickname, highest_role_id, joined_at, departments)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        `, [
            member.user.id,
            member.user.username,
            member.user.global_name || member.user.username,
            member.user.avatar,
            member.nick || null,
            highestRole.id,
            joinedAtMySQL,
            memberLabels.length > 0 ? JSON.stringify(memberLabels) : null
        ]);

        syncedCount++;
    }

    console.log(`Roster sync complete: ${syncedCount} members synced (${skippedBots} bots skipped)`);
    return { total: allMembers.length, synced: syncedCount, skipped: skippedBots };
}

router.post('/sync', async (req, res) => {
    if (!req.session.isAdmin) {
        return res.status(403).json({ success: false, error: 'Unauthorized' });
    }
    try {
        const result = await runRosterSync();
        res.json({ success: true, message: `Synced ${result.synced} members`, ...result });
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
