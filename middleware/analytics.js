const db = require('../config/database');

// Known bots, crawlers, monitoring tools, and headless HTTP clients
const BOT_UA_RE = /bot|crawl|spider|slurp|scraper|curl|wget|python[-\/]|node[-\.]|go-http|java\/|libwww|okhttp|httpx|undici|axios|got\/|node-fetch|facebookexternalhit|discordbot|twitterbot|linkedinbot|whatsapp|telegrambot|uptimerobot|pingdom|statuscake|nagios|zabbix|datadog|newrelic|semrush|ahrefs|mj12bot|dotbot|rogerbot|archive\.org/i;

function isBot(ua) {
    if (!ua) return true; // no user-agent at all → definitely not a browser
    return BOT_UA_RE.test(ua);
}

(async () => {
    try {
        await db.query(`
            CREATE TABLE IF NOT EXISTS page_views (
                id INT NOT NULL AUTO_INCREMENT,
                path VARCHAR(500) NOT NULL,
                user_id INT NULL,
                user_agent VARCHAR(500) NULL,
                is_bot TINYINT(1) NOT NULL DEFAULT 0,
                visited_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                PRIMARY KEY (id),
                INDEX idx_path (path(191)),
                INDEX idx_user (user_id),
                INDEX idx_bot (is_bot),
                INDEX idx_visited_at (visited_at)
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 DEFAULT COLLATE=uca1400_ai_ci
        `);
        // Migrate existing tables that were created before bot tracking was added
        await db.query(`ALTER TABLE page_views ADD COLUMN IF NOT EXISTS user_agent VARCHAR(500) NULL`);
        await db.query(`ALTER TABLE page_views ADD COLUMN IF NOT EXISTS is_bot TINYINT(1) NOT NULL DEFAULT 0`);
    } catch (err) {
        console.error('❌ Failed to initialise page_views table:', err);
    }
})();

const SKIP_EXACT = new Set(['/login', '/logout']);
const SKIP_PREFIX = ['/auth'];

function trackPageView(req, res, next) {
    if (req.method !== 'GET') return next();

    const p = req.path;
    if (SKIP_EXACT.has(p) || SKIP_PREFIX.some(prefix => p.startsWith(prefix))) return next();
    if (/\.\w{2,5}$/.test(p)) return next();

    const userId = req.isAuthenticated() ? req.user.id : null;
    const ua = (req.headers['user-agent'] || '').substring(0, 500);
    const bot = isBot(ua) ? 1 : 0;

    db.query(
        'INSERT INTO page_views (path, user_id, user_agent, is_bot) VALUES (?, ?, ?, ?)',
        [p, userId, ua || null, bot]
    ).catch(() => {});

    next();
}

module.exports = { trackPageView };
