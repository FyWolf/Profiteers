const db     = require('../config/database');
const crypto = require('crypto');

// Known bots, crawlers, monitoring tools, and headless HTTP clients
const BOT_UA_RE = /bot|crawl|spider|slurp|scraper|curl|wget|python[-\/]|node[-\.]|go-http|java\/|libwww|okhttp|httpx|undici|axios|got\/|node-fetch|facebookexternalhit|discordbot|twitterbot|linkedinbot|whatsapp|telegrambot|uptimerobot|pingdom|statuscake|nagios|zabbix|datadog|newrelic|semrush|ahrefs|mj12bot|dotbot|rogerbot|archive\.org/i;

function isBot(ua) {
    if (!ua) return true;
    return BOT_UA_RE.test(ua);
}

function detectDevice(ua) {
    if (!ua) return 'desktop';
    if (/ipad|tablet|(android(?!.*mobile))/i.test(ua)) return 'tablet';
    if (/mobile|android|iphone|ipod|blackberry|windows phone/i.test(ua)) return 'mobile';
    return 'desktop';
}

// ── DB init ──────────────────────────────────────────────────────────────────

(async () => {
    try {
        await db.query(`
            CREATE TABLE IF NOT EXISTS page_views (
                id          INT NOT NULL AUTO_INCREMENT,
                path        VARCHAR(500) NOT NULL,
                user_id     INT NULL,
                ip          VARCHAR(45) NULL,
                session_id  VARCHAR(64) NULL,
                referrer    VARCHAR(500) NULL,
                device_type ENUM('desktop','mobile','tablet') NOT NULL DEFAULT 'desktop',
                user_agent  VARCHAR(500) NULL,
                is_bot      TINYINT(1) NOT NULL DEFAULT 0,
                visited_at  TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                PRIMARY KEY (id),
                INDEX idx_path       (path(191)),
                INDEX idx_user       (user_id),
                INDEX idx_session    (session_id),
                INDEX idx_bot        (is_bot),
                INDEX idx_visited_at (visited_at)
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 DEFAULT COLLATE=uca1400_ai_ci
        `);
        // Migrations for columns added after initial deploy
        await db.query(`ALTER TABLE page_views ADD COLUMN IF NOT EXISTS user_agent  VARCHAR(500) NULL`);
        await db.query(`ALTER TABLE page_views ADD COLUMN IF NOT EXISTS is_bot      TINYINT(1) NOT NULL DEFAULT 0`);
        await db.query(`ALTER TABLE page_views ADD COLUMN IF NOT EXISTS ip          VARCHAR(45) NULL`);
        await db.query(`ALTER TABLE page_views ADD COLUMN IF NOT EXISTS referrer    VARCHAR(500) NULL`);
        await db.query(`ALTER TABLE page_views ADD COLUMN IF NOT EXISTS session_id  VARCHAR(64) NULL`);
        await db.query(`ALTER TABLE page_views ADD COLUMN IF NOT EXISTS device_type ENUM('desktop','mobile','tablet') NOT NULL DEFAULT 'desktop'`);

        await db.query(`
            CREATE TABLE IF NOT EXISTS events (
                id          INT NOT NULL AUTO_INCREMENT,
                event_type  VARCHAR(100) NOT NULL,
                entity_id   INT NULL,
                user_id     INT NULL,
                ip          VARCHAR(45) NULL,
                session_id  VARCHAR(64) NULL,
                metadata    JSON NULL,
                created_at  TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                PRIMARY KEY (id),
                INDEX idx_event_type (event_type),
                INDEX idx_entity     (entity_id),
                INDEX idx_user       (user_id),
                INDEX idx_session    (session_id),
                INDEX idx_created_at (created_at)
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 DEFAULT COLLATE=uca1400_ai_ci
        `);
    } catch (err) {
        console.error('❌ Failed to initialise analytics tables:', err);
    }
})();

// ── Session cookie ────────────────────────────────────────────────────────────

const SESSION_COOKIE = '_asid';
const SESSION_TTL_MS = 30 * 60 * 1000; // 30-minute rolling window

function getOrCreateSession(req, res) {
    let sid = req.cookies?.[SESSION_COOKIE];
    if (!sid) {
        sid = crypto.randomBytes(16).toString('hex');
    }
    // Refresh TTL on every request (rolling session)
    res.cookie(SESSION_COOKIE, sid, {
        httpOnly: true,
        sameSite: 'lax',
        maxAge:   SESSION_TTL_MS,
        path:     '/',
    });
    return sid;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function extractIp(req) {
    return (req.headers['x-forwarded-for'] || req.socket.remoteAddress || '')
        .split(',')[0].trim().substring(0, 45) || null;
}

// ── Middleware ────────────────────────────────────────────────────────────────

const SKIP_EXACT   = new Set(['/login', '/logout']);
const SKIP_PREFIX  = ['/auth'];

function trackPageView(req, res, next) {
    if (req.method !== 'GET') return next();

    const p = req.path;
    if (SKIP_EXACT.has(p) || SKIP_PREFIX.some(prefix => p.startsWith(prefix))) return next();
    if (/\.\w{2,5}$/.test(p)) return next();

    const userId    = req.isAuthenticated() ? req.user.id : null;
    const ua        = (req.headers['user-agent'] || '').substring(0, 500);
    const bot       = isBot(ua) ? 1 : 0;
    const ip        = extractIp(req);
    const referrer  = (req.headers.referer || req.headers.referrer || '').substring(0, 500) || null;
    const device    = detectDevice(ua);
    const sessionId = getOrCreateSession(req, res);

    db.query(
        `INSERT INTO page_views
            (path, user_id, ip, session_id, referrer, device_type, user_agent, is_bot)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [p, userId, ip, sessionId, referrer, device, ua || null, bot]
    ).catch(() => {});

    next();
}

// ── Event tracking (call from routes) ────────────────────────────────────────
// Usage: await trackEvent(req, 'op_view', operationId, { title: op.title })

async function trackEvent(req, eventType, entityId = null, metadata = null) {
    const userId    = req.isAuthenticated?.() ? req.user.id : null;
    const ip        = extractIp(req);
    const sessionId = req.cookies?.[SESSION_COOKIE] || null;

    await db.query(
        `INSERT INTO events (event_type, entity_id, user_id, ip, session_id, metadata)
         VALUES (?, ?, ?, ?, ?, ?)`,
        [eventType, entityId, userId, ip, sessionId, metadata ? JSON.stringify(metadata) : null]
    ).catch(() => {});
}

module.exports = { trackPageView, trackEvent };
