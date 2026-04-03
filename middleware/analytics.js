const db = require('../config/database');

(async () => {
    try {
        await db.query(`
            CREATE TABLE IF NOT EXISTS page_views (
                id INT NOT NULL AUTO_INCREMENT,
                path VARCHAR(500) NOT NULL,
                user_id INT NULL,
                visited_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                PRIMARY KEY (id),
                INDEX idx_path (path(191)),
                INDEX idx_user (user_id),
                INDEX idx_visited_at (visited_at)
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 DEFAULT COLLATE=uca1400_ai_ci
        `);
    } catch (err) {
        console.error('❌ Failed to create page_views table:', err);
    }
})();

const SKIP_EXACT = new Set(['/login', '/logout']);
const SKIP_PREFIX = ['/auth'];

function trackPageView(req, res, next) {
    if (req.method !== 'GET') return next();

    const p = req.path;
    if (SKIP_EXACT.has(p) || SKIP_PREFIX.some(prefix => p.startsWith(prefix))) return next();
    if (/\.\w{2,5}$/.test(p)) return next(); // skip anything that looks like a file

    const userId = req.isAuthenticated() ? req.user.id : null;

    db.query('INSERT INTO page_views (path, user_id) VALUES (?, ?)', [p, userId])
        .catch(() => {}); // never block the request

    next();
}

module.exports = { trackPageView };
