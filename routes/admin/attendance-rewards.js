const express = require('express');
const router = express.Router();
const db = require('../../config/database');
const { fetchGuildRoles } = require('../../helpers/discordRoles');
const { evaluateAll } = require('../../helpers/attendanceRewards');

// Normalize a submitted role-id field (single value or array) into a clean
// JSON string of snowflake-id strings, or null when empty.
function roleIdsToJson(value) {
    const ids = [].concat(value || [])
        .map(v => String(v).trim())
        .filter(v => /^\d+$/.test(v));
    return ids.length ? JSON.stringify([...new Set(ids)]) : null;
}

router.get('/', async (req, res) => {
    try {
        const [rules] = await db.query(`
            SELECT r.*,
                   (SELECT COUNT(*) FROM attendance_reward_applications a WHERE a.rule_id = r.id) AS applied_count
            FROM attendance_reward_rules r
            ORDER BY r.threshold ASC, r.id ASC
        `);

        let guildRoles = [];
        let rolesError = null;
        try {
            guildRoles = await fetchGuildRoles();
        } catch (err) {
            console.error('Error fetching guild roles:', err.response?.status, err.message);
            rolesError = 'Could not load Discord roles. Check the bot token / guild configuration.';
        }
        const roleNameById = {};
        guildRoles.forEach(r => { roleNameById[r.id] = r.name; });

        res.render('admin/attendance-rewards', {
            title: 'Attendance Rewards - Admin',
            rules,
            guildRoles,
            roleNameById,
            rolesError,
            success: req.query.success,
            error:   req.query.error
        });
    } catch (error) {
        console.error('Error loading attendance rewards:', error);
        res.render('error', {
            title: 'Error',
            message: 'Error Loading Attendance Rewards',
            description: error.code === 'ER_NO_SUCH_TABLE'
                ? 'Please run the database migrations.'
                : 'Could not load attendance reward rules.',
            user: res.locals.user
        });
    }
});

router.post('/add', async (req, res) => {
    try {
        const { name, threshold } = req.body;
        const n = parseInt(threshold, 10);

        if (!name || !name.trim()) {
            return res.redirect('/admin/attendance-rewards?error=Name is required');
        }
        if (isNaN(n) || n < 1) {
            return res.redirect('/admin/attendance-rewards?error=Threshold must be a positive whole number');
        }

        await db.query(
            `INSERT INTO attendance_reward_rules (name, threshold, add_role_ids, remove_role_ids, created_by)
             VALUES (?, ?, ?, ?, ?)`,
            [name.trim(), n, roleIdsToJson(req.body.add_role_ids), roleIdsToJson(req.body.remove_role_ids), req.session.userId]
        );

        // Backfill members who already qualify.
        let summary = '';
        try {
            const r = await evaluateAll();
            summary = ` Applied to ${r.applied} member(s)${r.errors ? `, ${r.errors} error(s)` : ''}.`;
        } catch (err) {
            console.error('Backfill after rule creation failed:', err.message);
            summary = ' (Backfill could not run — check Discord configuration.)';
        }

        res.redirect(`/admin/attendance-rewards?success=Rule created.${summary}`);
    } catch (error) {
        console.error('Error creating reward rule:', error);
        res.redirect('/admin/attendance-rewards?error=Failed to create rule');
    }
});

router.post('/edit/:id', async (req, res) => {
    try {
        const [rows] = await db.query('SELECT id FROM attendance_reward_rules WHERE id = ?', [req.params.id]);
        if (rows.length === 0) {
            return res.redirect('/admin/attendance-rewards?error=Rule not found');
        }

        const { name, threshold } = req.body;
        const n = parseInt(threshold, 10);

        if (!name || !name.trim()) {
            return res.redirect('/admin/attendance-rewards?error=Name is required');
        }
        if (isNaN(n) || n < 1) {
            return res.redirect('/admin/attendance-rewards?error=Threshold must be a positive whole number');
        }

        const isActive = req.body.is_active === 'on' ? 1 : 0;

        await db.query(
            `UPDATE attendance_reward_rules
                SET name = ?, threshold = ?, add_role_ids = ?, remove_role_ids = ?, is_active = ?
              WHERE id = ?`,
            [name.trim(), n, roleIdsToJson(req.body.add_role_ids), roleIdsToJson(req.body.remove_role_ids), isActive, req.params.id]
        );

        res.redirect('/admin/attendance-rewards?success=Rule updated. Use "Re-run all" to apply changes to existing members.');
    } catch (error) {
        console.error('Error updating reward rule:', error);
        res.redirect('/admin/attendance-rewards?error=Failed to update rule');
    }
});

router.post('/delete/:id', async (req, res) => {
    try {
        await db.query('DELETE FROM attendance_reward_rules WHERE id = ?', [req.params.id]);
        res.redirect('/admin/attendance-rewards?success=Rule deleted (already-granted roles were left untouched)');
    } catch (error) {
        console.error('Error deleting reward rule:', error);
        res.redirect('/admin/attendance-rewards?error=Failed to delete rule');
    }
});

router.post('/run', async (req, res) => {
    try {
        const r = await evaluateAll();
        res.redirect(`/admin/attendance-rewards?success=Re-run complete: ${r.applied} application(s) across ${r.rules} rule(s)${r.errors ? `, ${r.errors} error(s) (see logs)` : ''}.`);
    } catch (error) {
        console.error('Error running reward evaluation:', error);
        res.redirect('/admin/attendance-rewards?error=Re-run failed — check Discord configuration and logs');
    }
});

module.exports = router;
