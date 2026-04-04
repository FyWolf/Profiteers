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

        let analytics = { views_today: 0, views_week: 0, views_month: 0, unique_today: 0, unique_week: 0, bots_today: 0, bots_week: 0 };
        let topPages = [];
        let dailyViews = [];

        try {
            [[analytics]] = await db.query(`
                SELECT
                    (SELECT COUNT(*) FROM page_views WHERE is_bot = 0 AND visited_at >= CURDATE()) as views_today,
                    (SELECT COUNT(*) FROM page_views WHERE is_bot = 0 AND visited_at >= DATE_SUB(NOW(), INTERVAL 7 DAY)) as views_week,
                    (SELECT COUNT(*) FROM page_views WHERE is_bot = 0 AND visited_at >= DATE_SUB(NOW(), INTERVAL 30 DAY)) as views_month,
                    (SELECT COUNT(DISTINCT user_id) FROM page_views WHERE is_bot = 0 AND visited_at >= CURDATE() AND user_id IS NOT NULL) as unique_today,
                    (SELECT COUNT(DISTINCT user_id) FROM page_views WHERE is_bot = 0 AND visited_at >= DATE_SUB(NOW(), INTERVAL 7 DAY) AND user_id IS NOT NULL) as unique_week,
                    (SELECT COUNT(*) FROM page_views WHERE is_bot = 1 AND visited_at >= CURDATE()) as bots_today,
                    (SELECT COUNT(*) FROM page_views WHERE is_bot = 1 AND visited_at >= DATE_SUB(NOW(), INTERVAL 7 DAY)) as bots_week
            `);

            [topPages] = await db.query(`
                SELECT path, COUNT(*) as views
                FROM page_views
                WHERE is_bot = 0 AND visited_at >= DATE_SUB(NOW(), INTERVAL 7 DAY)
                GROUP BY path
                ORDER BY views DESC
                LIMIT 8
            `);

            [dailyViews] = await db.query(`
                SELECT DATE(visited_at) as date, COUNT(*) as views
                FROM page_views
                WHERE is_bot = 0 AND visited_at >= DATE_SUB(NOW(), INTERVAL 7 DAY)
                GROUP BY DATE(visited_at)
                ORDER BY date ASC
            `);
        } catch (_) {
            // page_views table may not exist yet on first boot
        }

        res.render('admin/dashboard', {
            title: 'Admin Dashboard - Profiteers PMC',
            stats,
            analytics,
            topPages,
            dailyViews
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
