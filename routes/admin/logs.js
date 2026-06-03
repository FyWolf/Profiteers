const express = require('express');
const router = express.Router();
const db = require('../../config/database');
const { resolveDestination } = require('../../middleware/action-log');

const PAGE_SIZE = 50;

router.get('/', async (req, res) => {
    try {
        const page = Math.max(1, parseInt(req.query.page) || 1);
        const offset = (page - 1) * PAGE_SIZE;

        const search   = (req.query.q || '').trim();
        const category = (req.query.category || '').trim();
        const method   = (req.query.method || '').trim().toUpperCase();
        const userId   = (req.query.user || '').trim();
        const status   = (req.query.status || '').trim(); // 'success' | 'failed'

        const where = [];
        const params = [];

        if (search) {
            where.push('(l.action_label LIKE ? OR l.path LIKE ? OR l.username LIKE ?)');
            params.push(`%${search}%`, `%${search}%`, `%${search}%`);
        }
        if (category) { where.push('l.category = ?'); params.push(category); }
        if (['POST', 'PUT', 'PATCH', 'DELETE'].includes(method)) { where.push('l.method = ?'); params.push(method); }
        if (userId)   { where.push('l.user_id = ?'); params.push(userId); }
        if (status === 'success') where.push('l.success = 1');
        if (status === 'failed')  where.push('l.success = 0');

        const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';

        const [[{ total }]] = await db.query(
            `SELECT COUNT(*) AS total FROM admin_action_logs l ${whereSql}`,
            params
        );

        const [logs] = await db.query(
            `SELECT
                l.*,
                COALESCE(rm.nickname, u.discord_global_name, u.username, l.username) AS actor_name,
                u.discord_id   AS actor_discord_id,
                u.discord_avatar AS actor_avatar
             FROM admin_action_logs l
             LEFT JOIN users u ON l.user_id = u.id
             LEFT JOIN roster_members rm ON rm.discord_id = u.discord_id
             ${whereSql}
             ORDER BY l.created_at DESC, l.id DESC
             LIMIT ? OFFSET ?`,
            [...params, PAGE_SIZE, offset]
        );

        // Best-effort link to the page where each action can be viewed.
        for (const log of logs) {
            log.destination = resolveDestination(log);
        }

        // Filter option sources
        const [categories] = await db.query(
            `SELECT DISTINCT category FROM admin_action_logs WHERE category IS NOT NULL ORDER BY category ASC`
        );
        const [actors] = await db.query(
            `SELECT DISTINCT l.user_id, COALESCE(rm.nickname, u.discord_global_name, u.username, l.username) AS name
             FROM admin_action_logs l
             LEFT JOIN users u ON l.user_id = u.id
             LEFT JOIN roster_members rm ON rm.discord_id = u.discord_id
             WHERE l.user_id IS NOT NULL
             ORDER BY name ASC`
        );

        const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));

        res.render('admin/logs', {
            title: 'Action Log - Admin',
            logs,
            categories: categories.map(c => c.category),
            actors,
            total,
            page,
            totalPages,
            pageSize: PAGE_SIZE,
            filters: { search, category, method, user: userId, status },
        });
    } catch (error) {
        console.error('Error loading action log:', error);
        res.render('error', {
            title: 'Error',
            message: 'Error Loading Action Log',
            description: 'Could not load the action log.',
            user: res.locals.user
        });
    }
});

module.exports = router;
