const express = require('express');
const router = express.Router();
const axios = require('axios');
const db = require('../../config/database');

router.get('/', async (req, res) => {
    try {
        const search     = req.query.search || '';
        const page       = parseInt(req.query.page) || 1;
        const limit      = 50;
        const offset     = (page - 1) * limit;

        // Sorting — whitelist column keys to prevent injection
        const SORT_COLS = {
            username:   'username',
            type:       'auth_type',
            role:       'is_admin',
            joined:     'created_at',
            last_login: 'last_login'
        };
        const sort     = SORT_COLS[req.query.sort] ? req.query.sort : 'joined';
        const order    = req.query.order === 'asc' ? 'ASC' : 'DESC';
        const sortCol  = SORT_COLS[sort];

        // Filters
        const filterType = ['discord', 'local'].includes(req.query.type) ? req.query.type : '';
        const filterRole = ['admin', 'user'].includes(req.query.role) ? req.query.role : '';

        // Build WHERE
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
        if (filterRole === 'admin') conditions.push('is_admin = 1');
        if (filterRole === 'user')  conditions.push('is_admin = 0');

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
                is_admin,
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

        const [[globalStats]] = await db.query(`
            SELECT
                COUNT(*) as total,
                SUM(is_admin) as admins,
                SUM(auth_type = 'discord') as discord_users
            FROM users
        `);

        res.render('admin/users', {
            title: 'Manage Users - Admin',
            users,
            search,
            sort,
            order: order.toLowerCase(),
            filterType,
            filterRole,
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

router.post('/toggle-admin/:id', async (req, res) => {
    try {
        // Don't allow demoting yourself
        if (parseInt(req.params.id) === req.session.userId) {
            return res.json({ success: false, error: 'Cannot modify your own admin status' });
        }

        await db.query('UPDATE users SET is_admin = NOT is_admin WHERE id = ?', [req.params.id]);
        res.json({ success: true });
    } catch (error) {
        console.error('Error toggling admin:', error);
        res.json({ success: false, error: 'Failed to toggle admin status' });
    }
});

router.post('/delete/:id', async (req, res) => {
    try {
        // Don't allow deleting yourself
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

router.get('/:userId/medals', async (req, res) => {
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

router.post('/:userId/medals/award', async (req, res) => {
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

router.post('/:userId/medals/revoke/:awardId', async (req, res) => {
    try {
        await db.query('DELETE FROM user_medals WHERE id = ?', [req.params.awardId]);
        res.redirect(`/admin/users/${req.params.userId}/medals?success=Medal revoked successfully`);
    } catch (error) {
        console.error('Error revoking medal:', error);
        res.redirect(`/admin/users/${req.params.userId}/medals?error=Failed to revoke medal`);
    }
});

router.post('/:userId/sync-trainings', async (req, res) => {
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

        await db.query('DELETE FROM user_trainings WHERE user_id = ?', [userId]);

        let assignedCount = 0;
        for (const training of trainings) {
            if (userRoles.includes(training.discord_role_id)) {
                await db.query(
                    'INSERT INTO user_trainings (user_id, training_id) VALUES (?, ?)',
                    [userId, training.id]
                );
                assignedCount++;
            }
        }

        res.json({
            success: true,
            message: `Synced ${assignedCount} training(s)`,
            count: assignedCount
        });
    } catch (error) {
        console.error('Error syncing trainings:', error);
        res.json({ success: false, error: error.message || 'Failed to sync trainings' });
    }
});

router.get('/:userId/trainings', async (req, res) => {
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

module.exports = router;
