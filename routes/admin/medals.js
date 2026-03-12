const express = require('express');
const router = express.Router();
const db = require('../../config/database');

router.get('/', async (req, res) => {
    try {
        const [medals] = await db.query(`
            SELECT
                m.*,
                u.username as created_by_username,
                COUNT(DISTINCT um.user_id) as awarded_count
            FROM medals m
            LEFT JOIN users u ON m.created_by = u.id
            LEFT JOIN user_medals um ON m.id = um.medal_id
            GROUP BY m.id
            ORDER BY m.created_at DESC
        `);

        res.render('admin/medals', {
            title: 'Manage Medals - Admin',
            medals: medals,
            success: req.query.success,
            error: req.query.error
        });
    } catch (error) {
        console.error('Error fetching medals:', error);
        res.render('error', {
            title: 'Error Loading Medals',
            message: 'Error Loading Medals',
            description: 'Could not load medals management.',
            user: res.locals.user
        });
    }
});

router.get('/add', (req, res) => {
    res.render('admin/medal-form', {
        title: 'Add Medal - Admin',
        medal: null,
        action: 'add'
    });
});

router.post('/add', async (req, res) => {
    try {
        const { name, description, color, icon } = req.body;

        await db.query(
            'INSERT INTO medals (name, description, color, icon, created_by) VALUES (?, ?, ?, ?, ?)',
            [name, description, color || '#FFD700', icon || '\uD83C\uDFC5', req.session.userId]
        );

        res.redirect('/admin/medals?success=Medal created successfully');
    } catch (error) {
        console.error('Error creating medal:', error);
        res.redirect('/admin/medals?error=Failed to create medal');
    }
});

router.get('/edit/:id', async (req, res) => {
    try {
        const [medals] = await db.query('SELECT * FROM medals WHERE id = ?', [req.params.id]);

        if (medals.length === 0) {
            return res.redirect('/admin/medals?error=Medal not found');
        }

        res.render('admin/medal-form', {
            title: 'Edit Medal - Admin',
            medal: medals[0],
            action: 'edit'
        });
    } catch (error) {
        console.error('Error loading medal:', error);
        res.redirect('/admin/medals?error=Failed to load medal');
    }
});

router.post('/edit/:id', async (req, res) => {
    try {
        const { name, description, color, icon } = req.body;

        await db.query(
            'UPDATE medals SET name = ?, description = ?, color = ?, icon = ? WHERE id = ?',
            [name, description, color, icon, req.params.id]
        );

        res.redirect('/admin/medals?success=Medal updated successfully');
    } catch (error) {
        console.error('Error updating medal:', error);
        res.redirect('/admin/medals?error=Failed to update medal');
    }
});

router.post('/delete/:id', async (req, res) => {
    try {
        await db.query('DELETE FROM medals WHERE id = ?', [req.params.id]);
        res.redirect('/admin/medals?success=Medal deleted successfully');
    } catch (error) {
        console.error('Error deleting medal:', error);
        res.redirect('/admin/medals?error=Failed to delete medal');
    }
});

module.exports = router;
