const express = require('express');
const router  = express.Router();
const db      = require('../config/database');

// Static public routes (always present in sitemap).
const STATIC_PATHS = [
    { path: '/',                     priority: 1.0, changefreq: 'weekly'  },
    { path: '/about',                priority: 0.8, changefreq: 'monthly' },
    { path: '/join',                 priority: 0.9, changefreq: 'monthly' },
    { path: '/info',                 priority: 0.7, changefreq: 'monthly' },
    { path: '/operations/upcoming',  priority: 0.9, changefreq: 'daily'   },
    { path: '/operations/all',       priority: 0.7, changefreq: 'weekly'  },
    { path: '/orbat/view-all',       priority: 0.6, changefreq: 'weekly'  },
    { path: '/modpacks',             priority: 0.6, changefreq: 'weekly'  },
    { path: '/gallery',              priority: 0.6, changefreq: 'weekly'  },
    { path: '/tools',                priority: 0.4, changefreq: 'monthly' },
];

function xmlEscape(s) {
    return String(s).replace(/[<>&'"]/g, c => ({
        '<': '&lt;', '>': '&gt;', '&': '&amp;', "'": '&apos;', '"': '&quot;'
    }[c]));
}

function isoDate(d) {
    if (!d) return null;
    const date = (d instanceof Date) ? d : new Date(d);
    return isNaN(date) ? null : date.toISOString();
}

router.get('/sitemap.xml', async (req, res) => {
    const base = (process.env.WEBSITE_URL || `${req.protocol}://${req.get('host')}`).replace(/\/$/, '');

    const urls = [];
    STATIC_PATHS.forEach(p => urls.push({
        loc: base + p.path, changefreq: p.changefreq, priority: p.priority
    }));

    try {
        const [ops] = await db.query(
            `SELECT id, updated_at, start_time
               FROM operations
              WHERE is_published = TRUE
              ORDER BY start_time DESC
              LIMIT 500`
        );
        ops.forEach(o => urls.push({
            loc: `${base}/operations/${o.id}`,
            lastmod: isoDate(o.updated_at),
            changefreq: 'weekly',
            priority: 0.7,
        }));
    } catch (e) { console.warn('sitemap operations:', e.message); }

    try {
        const [orbats] = await db.query(
            `SELECT id, updated_at FROM orbat_templates WHERE is_active = 1 ORDER BY id ASC LIMIT 200`
        );
        orbats.forEach(o => urls.push({
            loc: `${base}/orbat/view/${o.id}`,
            lastmod: isoDate(o.updated_at),
            changefreq: 'monthly',
            priority: 0.5,
        }));
    } catch (e) { console.warn('sitemap orbats:', e.message); }

    try {
        const [packs] = await db.query(`SELECT id FROM modpacks ORDER BY id DESC LIMIT 200`);
        packs.forEach(p => urls.push({
            loc: `${base}/modpacks/${p.id}`,
            changefreq: 'monthly',
            priority: 0.5,
        }));
    } catch (e) { console.warn('sitemap modpacks:', e.message); }

    const body =
        '<?xml version="1.0" encoding="UTF-8"?>\n' +
        '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n' +
        urls.map(u =>
            '  <url>\n' +
            `    <loc>${xmlEscape(u.loc)}</loc>\n` +
            (u.lastmod    ? `    <lastmod>${u.lastmod}</lastmod>\n` : '') +
            (u.changefreq ? `    <changefreq>${u.changefreq}</changefreq>\n` : '') +
            (u.priority   ? `    <priority>${u.priority.toFixed(1)}</priority>\n` : '') +
            '  </url>'
        ).join('\n') +
        '\n</urlset>\n';

    res.set('Content-Type', 'application/xml; charset=utf-8');
    res.set('Cache-Control', 'public, max-age=3600');
    res.send(body);
});

module.exports = router;
