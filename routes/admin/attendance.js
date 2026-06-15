const express = require('express');
const router = express.Router();
const db = require('../../config/database');

router.get('/', async (req, res) => {
    try {
        const { operation_id, player, status, date_from, date_to } = req.query;

        let query = `
            SELECT
                oa.id,
                oa.operation_id,
                oa.operation_date,
                oa.slot_type_name,
                oa.slot_type_abbr,
                oa.squad_name,
                oa.status,
                oa.notes,
                oa.created_at,
                op.title       AS operation_title,
                u.username     AS player_username,
                u.discord_global_name AS player_display,
                su.username    AS submitted_by_username
            FROM orbat_attendance oa
            JOIN operations op ON oa.operation_id = op.id
            JOIN users u       ON oa.user_id = u.id
            JOIN users su      ON oa.submitted_by = su.id
            WHERE 1=1
        `;
        const params = [];

        if (operation_id) {
            query += ' AND oa.operation_id = ?';
            params.push(parseInt(operation_id));
        }
        if (player) {
            query += ' AND (u.username LIKE ? OR u.discord_global_name LIKE ?)';
            params.push(`%${player}%`, `%${player}%`);
        }
        if (status && ['present','excused','awol'].includes(status)) {
            query += ' AND oa.status = ?';
            params.push(status);
        }
        if (date_from) {
            const ts = Math.floor(new Date(date_from).getTime() / 1000);
            if (!isNaN(ts)) { query += ' AND oa.operation_date >= ?'; params.push(ts); }
        }
        if (date_to) {
            const ts = Math.floor(new Date(date_to).getTime() / 1000);
            if (!isNaN(ts)) { query += ' AND oa.operation_date <= ?'; params.push(ts); }
        }

        query += ' ORDER BY oa.operation_date DESC, op.title ASC, u.username ASC';

        const [records] = await db.query(query, params);

        // For filter dropdowns
        const [operations] = await db.query(
            'SELECT id, title FROM operations WHERE orbat_type = ? ORDER BY start_time DESC LIMIT 100',
            ['fixed']
        );

        const totalPresent = records.filter(r => r.status === 'present').length;
        const pctPresent = records.length > 0 ? Math.round(totalPresent / records.length * 100) : 0;

        res.render('admin/attendance', {
            title: 'Attendance Report - Admin',
            records,
            operations,
            filters: { operation_id, player, status, date_from, date_to },
            totalPresent,
            pctPresent
        });
    } catch (err) {
        console.error('Error loading admin attendance:', err);
        res.render('error', { title: 'Error', message: 'Error Loading Attendance', description: '', user: res.locals.user });
    }
});

module.exports = router;
