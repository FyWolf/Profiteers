const express = require('express');
const router = express.Router();
const db = require('../../config/database');

router.get('/', async (req, res) => {
    try {
        const [toolsCount] = await db.query('SELECT COUNT(*) as count FROM tools');
        const [foldersCount] = await db.query('SELECT COUNT(*) as count FROM gallery_folders');
        const [imagesCount] = await db.query('SELECT COUNT(*) as count FROM gallery_images');
        const [usersCount] = await db.query('SELECT COUNT(*) as count FROM users');
        const [medalsCount] = await db.query('SELECT COUNT(*) as count FROM medals');
        const [trainingsCount] = await db.query('SELECT COUNT(*) as count FROM trainings');

        res.render('admin/dashboard', {
            title: 'Admin Dashboard - Profiteers PMC',
            stats: {
                tools: toolsCount[0].count,
                folders: foldersCount[0].count,
                images: imagesCount[0].count,
                users: usersCount[0].count,
                medals: medalsCount[0].count,
                trainings: trainingsCount[0].count
            }
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
