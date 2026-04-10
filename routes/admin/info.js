const express = require('express');
const router = express.Router();
const db = require('../../config/database');

// ── Servers ───────────────────────────────────────────────────────────────────

router.get('/', (req, res) => res.redirect('/admin/info/servers'));

router.get('/servers', async (req, res) => {
    try {
        const [servers] = await db.query('SELECT * FROM info_servers ORDER BY display_order ASC, name ASC');
        res.render('admin/info-servers', {
            title: 'Server Config - Admin',
            servers,
            success: req.query.success,
            error: req.query.error
        });
    } catch (error) {
        console.error('Error loading info servers:', error);
        res.redirect('/admin?error=Failed to load server config');
    }
});

router.post('/servers/add', async (req, res) => {
    const { name, host, port, game_type, display_order } = req.body;
    try {
        await db.query(
            'INSERT INTO info_servers (name, host, port, game_type, display_order) VALUES (?, ?, ?, ?, ?)',
            [name, host, parseInt(port) || 2302, game_type || 'arma3', parseInt(display_order) || 0]
        );
        res.redirect('/admin/info/servers?success=Server added');
    } catch (error) {
        console.error('Error adding server:', error);
        res.redirect('/admin/info/servers?error=Failed to add server');
    }
});

router.post('/servers/edit/:id', async (req, res) => {
    const { name, host, port, game_type, display_order } = req.body;
    try {
        await db.query(
            'UPDATE info_servers SET name=?, host=?, port=?, game_type=?, display_order=? WHERE id=?',
            [name, host, parseInt(port) || 2302, game_type || 'arma3', parseInt(display_order) || 0, req.params.id]
        );
        res.redirect('/admin/info/servers?success=Server updated');
    } catch (error) {
        console.error('Error updating server:', error);
        res.redirect('/admin/info/servers?error=Failed to update server');
    }
});

router.post('/servers/delete/:id', async (req, res) => {
    try {
        await db.query('DELETE FROM info_servers WHERE id=?', [req.params.id]);
        res.redirect('/admin/info/servers?success=Server deleted');
    } catch (error) {
        console.error('Error deleting server:', error);
        res.redirect('/admin/info/servers?error=Failed to delete server');
    }
});

// ── Staff & Departments ───────────────────────────────────────────────────────

router.get('/staff', async (req, res) => {
    try {
        const [departments] = await db.query('SELECT * FROM info_departments ORDER BY display_order ASC, name ASC');
        const [staffMembers] = await db.query(`
            SELECT
                s.id, s.discord_id, s.department_id, s.display_order,
                rm.discord_global_name, rm.discord_username, rm.discord_avatar, rm.nickname,
                rr.name AS role_name, rr.color AS role_color, rr.hierarchy_level
            FROM info_staff s
            JOIN roster_members rm ON s.discord_id = rm.discord_id
            JOIN roster_roles   rr ON rm.highest_role_id = rr.id
            ORDER BY rr.hierarchy_level ASC, s.display_order ASC
        `);
        const [rosterMembers] = await db.query(`
            SELECT rm.discord_id, rm.discord_global_name, rm.discord_username, rm.discord_avatar,
                   rm.nickname, rr.name AS role_name, rr.color AS role_color
            FROM roster_members rm
            JOIN roster_roles rr ON rm.highest_role_id = rr.id
            WHERE rm.is_visible = TRUE
            ORDER BY rr.hierarchy_level ASC, rm.discord_global_name ASC
        `);
        res.render('admin/info-staff', {
            title: 'Staff Config - Admin',
            departments,
            staffMembers,
            rosterMembers,
            success: req.query.success,
            error: req.query.error
        });
    } catch (error) {
        console.error('Error loading staff config:', error);
        res.redirect('/admin?error=Failed to load staff config');
    }
});

router.post('/departments/add', async (req, res) => {
    const { name, display_order } = req.body;
    try {
        await db.query('INSERT INTO info_departments (name, display_order) VALUES (?, ?)', [name, parseInt(display_order) || 0]);
        res.redirect('/admin/info/staff?success=Department added');
    } catch (error) {
        console.error('Error adding department:', error);
        res.redirect('/admin/info/staff?error=Failed to add department');
    }
});

router.post('/departments/edit/:id', async (req, res) => {
    const { name, display_order } = req.body;
    try {
        await db.query('UPDATE info_departments SET name=?, display_order=? WHERE id=?', [name, parseInt(display_order) || 0, req.params.id]);
        res.redirect('/admin/info/staff?success=Department updated');
    } catch (error) {
        console.error('Error updating department:', error);
        res.redirect('/admin/info/staff?error=Failed to update department');
    }
});

router.post('/departments/delete/:id', async (req, res) => {
    try {
        await db.query('UPDATE info_staff SET department_id=NULL WHERE department_id=?', [req.params.id]);
        await db.query('DELETE FROM info_departments WHERE id=?', [req.params.id]);
        res.redirect('/admin/info/staff?success=Department deleted');
    } catch (error) {
        console.error('Error deleting department:', error);
        res.redirect('/admin/info/staff?error=Failed to delete department');
    }
});

router.post('/staff/add', async (req, res) => {
    const { discord_id, department_id, display_order } = req.body;
    try {
        const deptId = department_id && department_id !== '' ? parseInt(department_id) : null;
        await db.query(
            'INSERT INTO info_staff (discord_id, department_id, display_order) VALUES (?, ?, ?) ON DUPLICATE KEY UPDATE department_id=VALUES(department_id), display_order=VALUES(display_order)',
            [discord_id, deptId, parseInt(display_order) || 0]
        );
        res.redirect('/admin/info/staff?success=Staff member added');
    } catch (error) {
        console.error('Error adding staff member:', error);
        res.redirect('/admin/info/staff?error=Failed to add staff member');
    }
});

router.post('/staff/edit/:id', async (req, res) => {
    const { department_id, display_order } = req.body;
    try {
        const deptId = department_id && department_id !== '' ? parseInt(department_id) : null;
        await db.query('UPDATE info_staff SET department_id=?, display_order=? WHERE id=?', [deptId, parseInt(display_order) || 0, req.params.id]);
        res.redirect('/admin/info/staff?success=Staff member updated');
    } catch (error) {
        console.error('Error updating staff member:', error);
        res.redirect('/admin/info/staff?error=Failed to update staff member');
    }
});

router.post('/staff/delete/:id', async (req, res) => {
    try {
        await db.query('DELETE FROM info_staff WHERE id=?', [req.params.id]);
        res.redirect('/admin/info/staff?success=Staff member removed');
    } catch (error) {
        console.error('Error removing staff member:', error);
        res.redirect('/admin/info/staff?error=Failed to remove staff member');
    }
});

// ── Kit Regulations ───────────────────────────────────────────────────────────

router.get('/kit', async (req, res) => {
    try {
        const [kitRoles] = await db.query('SELECT * FROM kit_roles ORDER BY display_order ASC, name ASC');
        const [kitSlots] = await db.query('SELECT * FROM kit_slots ORDER BY role_id ASC, display_order ASC, id ASC');
        const slotsByRole = {};
        kitSlots.forEach(s => {
            if (!slotsByRole[s.role_id]) slotsByRole[s.role_id] = [];
            slotsByRole[s.role_id].push(s);
        });
        res.render('admin/info-kit', {
            title: 'Kit Regulations - Admin',
            kitRoles,
            slotsByRole,
            success: req.query.success,
            error: req.query.error
        });
    } catch (error) {
        console.error('Error loading kit config:', error);
        res.redirect('/admin?error=Failed to load kit config');
    }
});

router.post('/kit/roles/add', async (req, res) => {
    const { name, display_order } = req.body;
    try {
        await db.query('INSERT INTO kit_roles (name, display_order) VALUES (?, ?)', [name, parseInt(display_order) || 0]);
        res.redirect('/admin/info/kit?success=Role added');
    } catch (error) {
        console.error('Error adding kit role:', error);
        res.redirect('/admin/info/kit?error=Failed to add role');
    }
});

router.post('/kit/roles/edit/:id', async (req, res) => {
    const { name, display_order } = req.body;
    try {
        await db.query('UPDATE kit_roles SET name=?, display_order=? WHERE id=?', [name, parseInt(display_order) || 0, req.params.id]);
        res.redirect('/admin/info/kit?success=Role updated');
    } catch (error) {
        console.error('Error updating kit role:', error);
        res.redirect('/admin/info/kit?error=Failed to update role');
    }
});

router.post('/kit/roles/delete/:id', async (req, res) => {
    try {
        await db.query('DELETE FROM kit_roles WHERE id=?', [req.params.id]);
        res.redirect('/admin/info/kit?success=Role deleted');
    } catch (error) {
        console.error('Error deleting kit role:', error);
        res.redirect('/admin/info/kit?error=Failed to delete role');
    }
});

// Slot endpoints (JSON for inline editing)
router.post('/kit/slots/add', async (req, res) => {
    const { role_id, slot_name, slot_value, display_order } = req.body;
    try {
        const [result] = await db.query(
            'INSERT INTO kit_slots (role_id, slot_name, slot_value, display_order) VALUES (?, ?, ?, ?)',
            [role_id, slot_name, slot_value || null, parseInt(display_order) || 0]
        );
        res.json({ success: true, id: result.insertId });
    } catch (error) {
        console.error('Error adding kit slot:', error);
        res.json({ success: false, error: 'Failed to add slot' });
    }
});

router.post('/kit/slots/edit/:id', async (req, res) => {
    const { slot_name, slot_value, display_order } = req.body;
    try {
        await db.query('UPDATE kit_slots SET slot_name=?, slot_value=?, display_order=? WHERE id=?',
            [slot_name, slot_value || null, parseInt(display_order) || 0, req.params.id]);
        res.json({ success: true });
    } catch (error) {
        console.error('Error updating kit slot:', error);
        res.json({ success: false, error: 'Failed to update slot' });
    }
});

router.post('/kit/slots/delete/:id', async (req, res) => {
    try {
        await db.query('DELETE FROM kit_slots WHERE id=?', [req.params.id]);
        res.json({ success: true });
    } catch (error) {
        console.error('Error deleting kit slot:', error);
        res.json({ success: false, error: 'Failed to delete slot' });
    }
});

module.exports = router;
