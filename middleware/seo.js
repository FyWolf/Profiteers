// Site-wide SEO / embed defaults exposed to every view via res.locals.
// Pages can override individual fields by passing them when including
// views/partials/header.ejs.

const SITE_NAME = 'Profiteers PMC';
const DEFAULT_DESCRIPTION =
    'Profiteers PMC — LGBTQ+ inclusive Arma 3 tactical unit. Operations, ORBAT, modpacks and tooling.';
const DEFAULT_IMAGE = '/images/og-image.png';

// Shared display-name resolver (guild nickname → global name → account username),
// exposed to every template so views never repeat the fallback chain.
const displayName = require('../helpers/displayName');

// Paths that should never be indexed (admin tools, account pages, auth flows).
// We match prefixes on req.path so /admin and /admin/foo/bar are both noindex.
const PRIVATE_PREFIXES = [
    '/admin',
    '/login',
    '/logout',
    '/auth',
    '/profile',
    '/operations/manage',
    '/lore/admin',
    '/plans',     // user plans are private/auth-gated
];

function isPrivatePath(p) {
    return PRIVATE_PREFIXES.some(pref => p === pref || p.startsWith(pref + '/'));
}

function attachSeoDefaults(req, res, next) {
    const url = (process.env.WEBSITE_URL || '').replace(/\/$/, '');

    res.locals.site = {
        name: SITE_NAME,
        url,
        defaultDescription: DEFAULT_DESCRIPTION,
        defaultImage:       DEFAULT_IMAGE,
    };
    res.locals.currentPath = req.originalUrl ? req.originalUrl.split('?')[0] : req.path;
    res.locals.noIndex     = isPrivatePath(req.path);
    res.locals.displayName = displayName;
    next();
}

module.exports = { attachSeoDefaults, SITE_NAME, DEFAULT_DESCRIPTION, DEFAULT_IMAGE };
