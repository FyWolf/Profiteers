const express = require('express');
const router = express.Router();
const path = require('path');
const db = require('../../config/database');

const BADGES_UPLOAD_DIR = path.join(__dirname, '..', '..', 'public', 'images', 'badges');

async function saveBadgeImage(file) {
    const ext = path.extname(file.name).replace(/[^a-z0-9.]/gi, '');
    const base = path.basename(file.name, path.extname(file.name)).toLowerCase().replace(/[^a-z0-9-]/g, '-');
    const fileName = `${base}${ext}`;
    await file.mv(path.join(BADGES_UPLOAD_DIR, fileName));
    return `/images/badges/${fileName}`;
}

router.get('/', async (req, res) => {
    try {
        const [trainings] = await db.query(`
            SELECT
                t.*,
                u.username as created_by_username,
                COUNT(DISTINCT ut.user_id) as assigned_count
            FROM trainings t
            LEFT JOIN users u ON t.created_by = u.id
            LEFT JOIN user_trainings ut ON t.id = ut.training_id
            GROUP BY t.id
            ORDER BY t.display_order ASC, t.name ASC
        `);

        res.render('admin/trainings', {
            title: 'Manage Trainings - Admin',
            trainings: trainings,
            success: req.query.success,
            error: req.query.error
        });
    } catch (error) {
        console.error('Error fetching trainings:', error);
        res.render('error', {
            title: 'Error Loading Trainings',
            message: 'Error Loading Trainings',
            description: 'Could not load trainings management.',
            user: res.locals.user
        });
    }
});

router.get('/add', (req, res) => {
    res.render('admin/training-form', {
        title: 'Add Training - Admin',
        training: null,
        action: 'add'
    });
});

router.post('/add', async (req, res) => {
    try {
        const { name, discord_role_id, description, color, image_url, display_order } = req.body;
        let finalImageUrl = image_url || '/images/badges/default-training.png';

        if (req.files && req.files.badge_upload) {
            finalImageUrl = await saveBadgeImage(req.files.badge_upload);
        }

        await db.query(
            'INSERT INTO trainings (name, discord_role_id, description, color, image_url, display_order, created_by) VALUES (?, ?, ?, ?, ?, ?, ?)',
            [name, discord_role_id, description || null, color || '#3498DB', finalImageUrl, display_order || 0, req.session.userId]
        );

        res.redirect('/admin/trainings?success=Training created successfully');
    } catch (error) {
        console.error('Error creating training:', error);
        if (error.code === 'ER_DUP_ENTRY') {
            res.redirect('/admin/trainings?error=Discord Role ID already exists');
        } else {
            res.redirect('/admin/trainings?error=Failed to create training');
        }
    }
});

router.get('/edit/:id', async (req, res) => {
    try {
        const [trainings] = await db.query('SELECT * FROM trainings WHERE id = ?', [req.params.id]);

        if (trainings.length === 0) {
            return res.redirect('/admin/trainings?error=Training not found');
        }

        res.render('admin/training-form', {
            title: 'Edit Training - Admin',
            training: trainings[0],
            action: 'edit'
        });
    } catch (error) {
        console.error('Error loading training:', error);
        res.redirect('/admin/trainings?error=Failed to load training');
    }
});

router.post('/edit/:id', async (req, res) => {
    try {
        const { name, discord_role_id, description, color, image_url, display_order } = req.body;
        let finalImageUrl = image_url;

        if (req.files && req.files.badge_upload) {
            finalImageUrl = await saveBadgeImage(req.files.badge_upload);
        }

        await db.query(
            'UPDATE trainings SET name = ?, discord_role_id = ?, description = ?, color = ?, image_url = ?, display_order = ? WHERE id = ?',
            [name, discord_role_id, description || null, color, finalImageUrl, display_order || 0, req.params.id]
        );

        res.redirect('/admin/trainings?success=Training updated successfully');
    } catch (error) {
        console.error('Error updating training:', error);
        if (error.code === 'ER_DUP_ENTRY') {
            res.redirect('/admin/trainings?error=Discord Role ID already exists');
        } else {
            res.redirect('/admin/trainings?error=Failed to update training');
        }
    }
});

router.post('/delete/:id', async (req, res) => {
    try {
        await db.query('DELETE FROM trainings WHERE id = ?', [req.params.id]);
        res.redirect('/admin/trainings?success=Training deleted successfully');
    } catch (error) {
        console.error('Error deleting training:', error);
        res.redirect('/admin/trainings?error=Failed to delete training');
    }
});

module.exports = router;
