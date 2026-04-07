const express = require('express');
const router  = express.Router();
const db      = require('../../config/database');

router.get('/', async (req, res) => {
    try {
        const [[stats]] = await db.query(`
            SELECT
                (SELECT COUNT(*) FROM tools)          as tools,
                (SELECT COUNT(*) FROM gallery_folders) as folders,
                (SELECT COUNT(*) FROM gallery_images)  as images,
                (SELECT COUNT(*) FROM users)           as users,
                (SELECT COUNT(*) FROM medals)          as medals,
                (SELECT COUNT(*) FROM trainings)       as trainings
        `);

        let analytics = {
            views_today: 0, views_week: 0, views_month: 0,
            sessions_today: 0, sessions_week: 0,
            unique_ips_week: 0,
            bots_today: 0, bots_week: 0
        };
        let topPages        = [];
        let dailyViews      = [];
        let deviceBreakdown = [];
        let topReferrers    = [];
        let hourlyViews     = Array.from({ length: 24 }, (_, i) => ({ hour: i, views: 0 }));

        try {
            [[analytics]] = await db.query(`
                SELECT
                    (SELECT COUNT(*) FROM page_views WHERE is_bot = 0 AND visited_at >= CURDATE())                                                                        as views_today,
                    (SELECT COUNT(*) FROM page_views WHERE is_bot = 0 AND visited_at >= DATE_SUB(NOW(), INTERVAL 7 DAY))                                                  as views_week,
                    (SELECT COUNT(*) FROM page_views WHERE is_bot = 0 AND visited_at >= DATE_SUB(NOW(), INTERVAL 30 DAY))                                                 as views_month,
                    (SELECT COUNT(DISTINCT session_id) FROM page_views WHERE is_bot = 0 AND visited_at >= CURDATE()                        AND session_id IS NOT NULL)     as sessions_today,
                    (SELECT COUNT(DISTINCT session_id) FROM page_views WHERE is_bot = 0 AND visited_at >= DATE_SUB(NOW(), INTERVAL 7 DAY)  AND session_id IS NOT NULL)     as sessions_week,
                    (SELECT COUNT(DISTINCT ip)         FROM page_views WHERE is_bot = 0 AND visited_at >= DATE_SUB(NOW(), INTERVAL 7 DAY)  AND ip         IS NOT NULL)     as unique_ips_week,
                    (SELECT COUNT(*) FROM page_views WHERE is_bot = 1 AND visited_at >= CURDATE())                                                                        as bots_today,
                    (SELECT COUNT(*) FROM page_views WHERE is_bot = 1 AND visited_at >= DATE_SUB(NOW(), INTERVAL 7 DAY))                                                  as bots_week
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

            [deviceBreakdown] = await db.query(`
                SELECT device_type, COUNT(*) as views
                FROM page_views
                WHERE is_bot = 0 AND visited_at >= DATE_SUB(NOW(), INTERVAL 7 DAY)
                GROUP BY device_type
                ORDER BY views DESC
            `);

            [topReferrers] = await db.query(`
                SELECT
                    CASE
                        WHEN referrer IS NULL OR referrer = ''   THEN 'Direct'
                        WHEN referrer LIKE '%discord%'           THEN 'Discord'
                        WHEN referrer LIKE '%google%'            THEN 'Google'
                        WHEN referrer LIKE '%bing%'              THEN 'Bing'
                        WHEN referrer LIKE '%facebook%'          THEN 'Facebook'
                        WHEN referrer LIKE '%twitter%'
                          OR referrer LIKE '%x.com%'             THEN 'Twitter / X'
                        ELSE SUBSTRING_INDEX(
                               SUBSTRING_INDEX(
                                 SUBSTRING_INDEX(referrer, '/', 3),
                               '//', -1),
                             '/', 1)
                    END as source,
                    COUNT(*) as views
                FROM page_views
                WHERE is_bot = 0 AND visited_at >= DATE_SUB(NOW(), INTERVAL 7 DAY)
                GROUP BY source
                ORDER BY views DESC
                LIMIT 8
            `);

            const [rawHourly] = await db.query(`
                SELECT HOUR(visited_at) as hour, COUNT(*) as views
                FROM page_views
                WHERE is_bot = 0 AND visited_at >= DATE_SUB(NOW(), INTERVAL 7 DAY)
                GROUP BY HOUR(visited_at)
            `);
            rawHourly.forEach(r => { hourlyViews[r.hour].views = r.views; });

        } catch (analyticsErr) {
            // page_views table may not exist yet on first boot
            console.warn('Analytics queries failed (table may not exist yet):', analyticsErr.message);
        }

        res.render('admin/dashboard', {
            title: 'Admin Dashboard - Profiteers PMC',
            stats,
            analytics,
            topPages,
            dailyViews,
            deviceBreakdown,
            topReferrers,
            hourlyViews
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
