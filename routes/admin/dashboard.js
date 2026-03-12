const express = require('express');
const router = express.Router();
const db = require('../../config/database');

router.get('/', async (req, res) => {
    try {
        const [[stats]] = await db.query(`
            SELECT
                (SELECT COUNT(*) FROM tools) as tools,
                (SELECT COUNT(*) FROM gallery_folders) as folders,
                (SELECT COUNT(*) FROM gallery_images) as images,
                (SELECT COUNT(*) FROM users) as users,
                (SELECT COUNT(*) FROM medals) as medals,
                (SELECT COUNT(*) FROM trainings) as trainings
        `);

        res.render('admin/dashboard', {
            title: 'Admin Dashboard - Profiteers PMC',
            stats
        });
    } catch (error) {
        console.error('Error loading dashboard:', error);
        res.render('error', {
            title: 'Error Loading Dashboard',
            message: 'Error Loading Dashboard',
            description: 'Could not load admin dashboard.',
            user: res.locals.user
        });
    }
});

module.exports = router;
