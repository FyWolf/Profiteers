// Routes that are exempt from the Steam link nudge
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
 * Flags authenticated users who have not linked their Steam account by
 * setting res.locals.needsSteamLink, so the header can show a persistent
 * "link your Steam account" banner. This is a soft nudge — it never blocks
 * or redirects the request.
 *
 * Applied AFTER Passport/attachUser so req.user is populated.
 */
function requireSteamLink(req, res, next) {
    // Only nudge authenticated users
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

    // steam_id is already loaded onto req.user by passport.deserializeUser,
    // so there's no need for a per-request query here.
    const steamId = req.user && req.user.steam_id;
    if (!steamId) {
        res.locals.needsSteamLink = true;
    }

    next();
}

module.exports = { requireSteamLink };
