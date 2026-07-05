const db = require('../config/database');

// Routes that are exempt from the Steam link requirement
const EXEMPT_PATHS = [
    '/profile',
    '/logout',
    '/login',
    '/auth',
];

const EXEMPT_PREFIXES = [
    '/admin',
    '/auth',
    '/css/',
    '/js/',
    '/images/',
    '/fonts/',
];

/**
 * Middleware that checks if the authenticated user has linked their
 * Steam account. If not, they are redirected to their profile page
 * with a message explaining why linking is required.
 *
 * This is applied AFTER attachUser so res.locals.user is available.
 */
async function requireSteamLink(req, res, next) {
    // Only check for authenticated users
    if (!req.isAuthenticated()) {
        return next();
    }

    // Skip exempt routes
    const path = req.path;
    if (EXEMPT_PATHS.includes(path)) {
        return next();
    }
    for (const prefix of EXEMPT_PREFIXES) {
        if (path.startsWith(prefix)) {
            return next();
        }
    }
    // Skip API routes (they're called by the Arma server, not by players)
    if (path.startsWith('/store/api/')) {
        return next();
    }

    try {
        // Check if the user has a steam_id linked on their account
        const [rows] = await db.query(
            'SELECT steam_id FROM users WHERE id = ?',
            [req.session.userId]
        );

        const hasSteamLinked = rows.length > 0 && rows[0].steam_id !== null && rows[0].steam_id !== '';

        if (!hasSteamLinked) {
            // Set a flag so the header can show a persistent notification
            res.locals.needsSteamLink = true;
        }

        next();
    } catch (err) {
        console.error('Steam link check error:', err);
        next();
    }
}

module.exports = { requireSteamLink };
