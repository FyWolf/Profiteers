const express = require('express');
const router = express.Router();
const axios = require('axios');
const db = require('../../config/database');
const { hasPermission } = require('../../middleware/auth');

router.get('/', async (req, res) => {
    try {
        const search     = req.query.search || '';
        const page       = parseInt(req.query.page) || 1;
        const limit      = 50;
        const offset     = (page - 1) * limit;

        const SORT_COLS = {
            username:   'username',
            type:       'auth_type',
            joined:     'created_at',
            last_login: 'last_login'
        };
        const sort    = SORT_COLS[req.query.sort] ? req.query.sort : 'joined';
        const order   = req.query.order === 'asc' ? 'ASC' : 'DESC';
        const sortCol = SORT_COLS[sort];

        const filterType = ['discord', 'local'].includes(req.query.type) ? req.query.type : '';

        const conditions = [];
        const params = [];

        if (search) {
            conditions.push('(username LIKE ? OR discord_username LIKE ? OR discord_global_name LIKE ?)');
            params.push(`%${search}%`, `%${search}%`, `%${search}%`);
        }
        if (filterType) {
            conditions.push('auth_type = ?');
            params.push(filterType);
        }

        const whereClause = conditions.length ? 'WHERE ' + conditions.join(' AND ') : '';

        const [countResult] = await db.query(
            `SELECT COUNT(*) as total FROM users ${whereClause}`,
            params
        );
        const totalUsers = countResult[0].total;
        const totalPages = Math.ceil(totalUsers / limit);

        const [users] = await db.query(`
            SELECT
                id,
                username,
                auth_type,
                discord_username,
                discord_global_name,
                discord_avatar,
                discord_id,
                created_at,
                last_login
            FROM users
            ${whereClause}
            ORDER BY ${sortCol} ${order}
            LIMIT ? OFFSET ?
        `, [...params, limit, offset]);

        const userIds = users.map(u => u.id);
        let rolesByUser = {};
        if (userIds.length > 0) {
            const [roleRows] = await db.query(`
                SELECT ur.user_id, r.id as role_id, r.name as role_name
                FROM user_roles ur
                JOIN roles r ON ur.role_id = r.id
                WHERE ur.user_id IN (?)
                ORDER BY r.name ASC
            `, [userIds]);
            roleRows.forEach(row => {
                if (!rolesByUser[row.user_id]) rolesByUser[row.user_id] = [];
                rolesByUser[row.user_id].push({ id: row.role_id, name: row.role_name });
            });
        }
        users.forEach(u => { u.roles = rolesByUser[u.id] || []; });

        const [[globalStats]] = await db.query(`
            SELECT
                COUNT(*) as total,
                SUM(auth_type = 'discord') as discord_users,
                (SELECT COUNT(DISTINCT ur.user_id)
                 FROM user_roles ur
                 JOIN roles r ON ur.role_id = r.id
                 WHERE r.name = 'Super Admin') as super_admins
            FROM users
        `);

        res.render('admin/users', {
            title: 'Manage Users - Admin',
            users,
            search,
            sort,
            order: order.toLowerCase(),
            filterType,
            currentPage: page,
            totalPages,
            totalUsers,
            globalStats,
            success: req.query.success,
            error: req.query.error
        });
    } catch (error) {
        console.error('Error fetching users:', error);
        res.render('error', {
            title: 'Error Loading Users',
            message: 'Error Loading Users',
            description: 'Could not load users management.',
            user: res.locals.user
        });
    }
});

router.post('/delete/:id', hasPermission('users.manage'), async (req, res) => {
    try {
        if (parseInt(req.params.id) === req.session.userId) {
            return res.redirect('/admin/users?error=Cannot delete your own account');
        }

        await db.query('DELETE FROM users WHERE id = ?', [req.params.id]);
        res.redirect('/admin/users?success=User deleted successfully');
    } catch (error) {
        console.error('Error deleting user:', error);
        res.redirect('/admin/users?error=Failed to delete user');
    }
});

router.get('/:userId/medals', hasPermission('users.medals'), async (req, res) => {
    try {
        const [users] = await db.query('SELECT * FROM users WHERE id = ?', [req.params.userId]);

        if (users.length === 0) {
            return res.redirect('/admin/users?error=User not found');
        }

        const user = users[0];

        const [allMedals] = await db.query('SELECT * FROM medals ORDER BY name ASC');

        const [userMedals] = await db.query(`
            SELECT
                m.*,
                um.id as award_id,
                um.awarded_at,
                um.notes,
                u.username as awarded_by_username
            FROM user_medals um
            JOIN medals m ON um.medal_id = m.id
            JOIN users u ON um.awarded_by = u.id
            WHERE um.user_id = ?
            ORDER BY um.awarded_at DESC
        `, [req.params.userId]);

        const userMedalIds = userMedals.map(m => m.id);
        const availableMedals = allMedals.filter(m => !userMedalIds.includes(m.id));

        res.render('admin/user-medals', {
            title: `Manage Medals - ${user.username}`,
            user: user,
            userMedals: userMedals,
            availableMedals: availableMedals,
            success: req.query.success,
            error: req.query.error
        });
    } catch (error) {
        console.error('Error loading user medals:', error);
        res.redirect('/admin/users?error=Failed to load user medals');
    }
});

router.post('/:userId/medals/award', hasPermission('users.medals'), async (req, res) => {
    try {
        const { medalId, notes } = req.body;

        await db.query(
            'INSERT INTO user_medals (user_id, medal_id, awarded_by, notes) VALUES (?, ?, ?, ?)',
            [req.params.userId, medalId, req.session.userId, notes || null]
        );

        res.redirect(`/admin/users/${req.params.userId}/medals?success=Medal awarded successfully`);
    } catch (error) {
        console.error('Error awarding medal:', error);
        res.redirect(`/admin/users/${req.params.userId}/medals?error=Failed to award medal`);
    }
});

router.post('/:userId/medals/revoke/:awardId', hasPermission('users.medals'), async (req, res) => {
    try {
        await db.query('DELETE FROM user_medals WHERE id = ?', [req.params.awardId]);
        res.redirect(`/admin/users/${req.params.userId}/medals?success=Medal revoked successfully`);
    } catch (error) {
        console.error('Error revoking medal:', error);
        res.redirect(`/admin/users/${req.params.userId}/medals?error=Failed to revoke medal`);
    }
});

router.post('/:userId/sync-trainings', hasPermission('users.trainings'), async (req, res) => {
    try {
        const userId = req.params.userId;

        const [users] = await db.query('SELECT discord_id FROM users WHERE id = ?', [userId]);

        if (users.length === 0 || !users[0].discord_id) {
            return res.json({ success: false, error: 'User not found or not a Discord user' });
        }

        const discordId = users[0].discord_id;
        const botToken = process.env.DISCORD_BOT_TOKEN;
        const guildId = process.env.DISCORD_GUILD_ID;

        if (!botToken) {
            return res.json({ success: false, error: 'Bot token not configured' });
        }

        const response = await axios.get(
            `https://discord.com/api/v10/guilds/${guildId}/members/${discordId}`,
            {
                headers: {
                    Authorization: `Bot ${botToken}`
                }
            }
        );

        const userRoles = response.data.roles || [];

        const [trainings] = await db.query('SELECT id, discord_role_id FROM trainings');

        const matchedTrainings = trainings.filter(t => userRoles.includes(t.discord_role_id));

        const conn = await db.getConnection();
        try {
            await conn.beginTransaction();
            await conn.query('DELETE FROM user_trainings WHERE user_id = ?', [userId]);
            for (const training of matchedTrainings) {
                await conn.query(
                    'INSERT INTO user_trainings (user_id, training_id) VALUES (?, ?)',
                    [userId, training.id]
                );
            }
            await conn.commit();
        } catch (txErr) {
            await conn.rollback();
            throw txErr;
        } finally {
            conn.release();
        }

        res.json({
            success: true,
            message: `Synced ${matchedTrainings.length} training(s)`,
            count: matchedTrainings.length
        });
    } catch (error) {
        console.error('Error syncing trainings:', error);
        res.json({ success: false, error: 'Failed to sync trainings' });
    }
});

router.get('/:userId/trainings', hasPermission('users.trainings'), async (req, res) => {
    try {
        const [users] = await db.query('SELECT * FROM users WHERE id = ?', [req.params.userId]);

        if (users.length === 0) {
            return res.redirect('/admin/users?error=User not found');
        }

        const user = users[0];

        const [userTrainings] = await db.query(`
            SELECT
                t.*,
                ut.synced_at,
                ut.last_verified
            FROM user_trainings ut
            JOIN trainings t ON ut.training_id = t.id
            WHERE ut.user_id = ?
            ORDER BY t.display_order ASC, t.name ASC
        `, [req.params.userId]);

        const [allTrainings] = await db.query('SELECT * FROM trainings ORDER BY display_order ASC, name ASC');

        res.render('admin/user-trainings', {
            title: `Trainings - ${user.username}`,
            user: user,
            userTrainings: userTrainings,
            allTrainings: allTrainings,
            success: req.query.success,
            error: req.query.error
        });
    } catch (error) {
        console.error('Error loading user trainings:', error);
        res.redirect('/admin/users?error=Failed to load user trainings');
    }
});

router.get('/:userId/roles', hasPermission('users.manage'), async (req, res) => {
    try {
        const [users] = await db.query('SELECT * FROM users WHERE id = ?', [req.params.userId]);

        if (users.length === 0) {
            return res.redirect('/admin/users?error=User not found');
        }

        const targetUser = users[0];

        const [userRoles] = await db.query(`
            SELECT r.id, r.name, r.description, r.is_system, ur.assigned_at
            FROM user_roles ur
            JOIN roles r ON ur.role_id = r.id
            WHERE ur.user_id = ?
            ORDER BY r.name ASC
        `, [req.params.userId]);

        const [allRoles] = await db.query('SELECT id, name, description FROM roles ORDER BY name ASC');
        const userRoleIds = userRoles.map(r => r.id);
        const availableRoles = allRoles.filter(r => !userRoleIds.includes(r.id));

        res.render('admin/user-roles', {
            title: `Roles - ${targetUser.username}`,
            targetUser,
            userRoles,
            availableRoles,
            success: req.query.success,
            error: req.query.error
        });
    } catch (error) {
        console.error('Error loading user roles:', error);
        res.redirect('/admin/users?error=Failed to load user roles');
    }
});

router.post('/:userId/roles/assign', hasPermission('users.manage'), async (req, res) => {
    try {
        const { roleId } = req.body;
        await db.query(
            'INSERT IGNORE INTO user_roles (user_id, role_id, assigned_by) VALUES (?, ?, ?)',
            [req.params.userId, roleId, req.session.userId]
        );
        res.redirect(`/admin/users/${req.params.userId}/roles?success=Role assigned successfully`);
    } catch (error) {
        console.error('Error assigning role:', error);
        res.redirect(`/admin/users/${req.params.userId}/roles?error=Failed to assign role`);
    }
});

router.post('/:userId/roles/revoke/:roleId', hasPermission('users.manage'), async (req, res) => {
    try {
        await db.query(
            'DELETE FROM user_roles WHERE user_id = ? AND role_id = ?',
            [req.params.userId, req.params.roleId]
        );
        res.redirect(`/admin/users/${req.params.userId}/roles?success=Role revoked successfully`);
    } catch (error) {
        console.error('Error revoking role:', error);
        res.redirect(`/admin/users/${req.params.userId}/roles?error=Failed to revoke role`);
    }
});

module.exports = router;
