const express = require('express');
const router = express.Router();
const db = require('../../config/database');

router.get('/', async (req, res) => {
    try {
        const [roles] = await db.query(`
            SELECT
                r.id,
                r.name,
                r.description,
                r.is_system,
                r.created_at,
                COUNT(DISTINCT rp.permission_id) AS permission_count,
                COUNT(DISTINCT ur.user_id)        AS user_count
            FROM roles r
            LEFT JOIN role_permissions rp ON r.id = rp.role_id
            LEFT JOIN user_roles ur       ON r.id = ur.role_id
            GROUP BY r.id
            ORDER BY r.is_system DESC, r.name ASC
        `);

        res.render('admin/roles/index', {
            title: 'Manage Roles - Admin',
            roles,
            success: req.query.success,
            error:   req.query.error
        });
    } catch (error) {
        console.error('Error loading roles:', error);
        res.render('error', {
            title: 'Error',
            message: 'Error Loading Roles',
            description: 'Could not load roles management.',
            user: res.locals.user
        });
    }
});

router.get('/create', async (req, res) => {
    try {
        const [permissions] = await db.query(
            'SELECT * FROM permissions ORDER BY category ASC, name ASC'
        );
        res.render('admin/roles/form', {
            title: 'Create Role - Admin',
            role: null,
            permissions,
            rolePerms: [],
            error: req.query.error
        });
    } catch (error) {
        console.error('Error loading create role form:', error);
        res.redirect('/admin/roles?error=Failed to load form');
    }
});

router.post('/create', async (req, res) => {
    try {
        const { name, description } = req.body;
        const selectedPerms = [].concat(req.body.permissions || []);

        if (!name || !name.trim()) {
            return res.redirect('/admin/roles/create?error=Role name is required');
        }

        const [result] = await db.query(
            'INSERT INTO roles (name, description) VALUES (?, ?)',
            [name.trim(), description?.trim() || null]
        );
        const roleId = result.insertId;

        if (selectedPerms.length > 0) {
            const rows = selectedPerms.map(pid => [roleId, parseInt(pid)]);
            await db.query('INSERT IGNORE INTO role_permissions (role_id, permission_id) VALUES ?', [rows]);
        }

        res.redirect('/admin/roles?success=Role created successfully');
    } catch (error) {
        if (error.code === 'ER_DUP_ENTRY') {
            return res.redirect('/admin/roles/create?error=A role with that name already exists');
        }
        console.error('Error creating role:', error);
        res.redirect('/admin/roles/create?error=Failed to create role');
    }
});

router.get('/:id/edit', async (req, res) => {
    try {
        const [roles] = await db.query('SELECT * FROM roles WHERE id = ?', [req.params.id]);
        if (roles.length === 0) {
            return res.redirect('/admin/roles?error=Role not found');
        }

        const [permissions] = await db.query(
            'SELECT * FROM permissions ORDER BY category ASC, name ASC'
        );
        const [rolePermsRows] = await db.query(
            'SELECT permission_id FROM role_permissions WHERE role_id = ?',
            [req.params.id]
        );
        const rolePerms = rolePermsRows.map(r => r.permission_id);

        res.render('admin/roles/form', {
            title: `Edit Role - ${roles[0].name}`,
            role: roles[0],
            permissions,
            rolePerms,
            error: req.query.error
        });
    } catch (error) {
        console.error('Error loading edit role form:', error);
        res.redirect('/admin/roles?error=Failed to load role');
    }
});

router.post('/:id/edit', async (req, res) => {
    try {
        const [roles] = await db.query('SELECT * FROM roles WHERE id = ?', [req.params.id]);
        if (roles.length === 0) {
            return res.redirect('/admin/roles?error=Role not found');
        }

        const { name, description } = req.body;
        const selectedPerms = [].concat(req.body.permissions || []);

        if (!name || !name.trim()) {
            return res.redirect(`/admin/roles/${req.params.id}/edit?error=Role name is required`);
        }

        const newName = roles[0].is_system ? roles[0].name : name.trim();

        await db.query(
            'UPDATE roles SET name = ?, description = ? WHERE id = ?',
            [newName, description?.trim() || null, req.params.id]
        );

        await db.query('DELETE FROM role_permissions WHERE role_id = ?', [req.params.id]);
        if (selectedPerms.length > 0) {
            const rows = selectedPerms.map(pid => [parseInt(req.params.id), parseInt(pid)]);
            await db.query('INSERT IGNORE INTO role_permissions (role_id, permission_id) VALUES ?', [rows]);
        }

        res.redirect('/admin/roles?success=Role updated successfully');
    } catch (error) {
        if (error.code === 'ER_DUP_ENTRY') {
            return res.redirect(`/admin/roles/${req.params.id}/edit?error=A role with that name already exists`);
        }
        console.error('Error updating role:', error);
        res.redirect(`/admin/roles/${req.params.id}/edit?error=Failed to update role`);
    }
});

router.post('/:id/delete', async (req, res) => {
    try {
        const [roles] = await db.query('SELECT * FROM roles WHERE id = ?', [req.params.id]);
        if (roles.length === 0) {
            return res.redirect('/admin/roles?error=Role not found');
        }

        if (roles[0].is_system) {
            return res.redirect('/admin/roles?error=System roles cannot be deleted');
        }

        await db.query('DELETE FROM roles WHERE id = ?', [req.params.id]);
        res.redirect('/admin/roles?success=Role deleted successfully');
    } catch (error) {
        console.error('Error deleting role:', error);
        res.redirect('/admin/roles?error=Failed to delete role');
    }
});

module.exports = router;
