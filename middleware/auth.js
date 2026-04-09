const { checkZeusStatus } = require('./zeus');

function isAuthenticated(req, res, next) {
    if (req.isAuthenticated()) {
        return next();
    }
    res.redirect('/login?redirect=' + encodeURIComponent(req.originalUrl));
}

/**
 * Returns middleware that requires the user to hold a specific permission.
 * Access is granted purely through RBAC roles — no flag bypass.
 */
function hasPermission(permission) {
    return function (req, res, next) {
        if (!req.isAuthenticated()) {
            return res.redirect('/login?redirect=' + encodeURIComponent(req.originalUrl));
        }

        if (Array.isArray(req.user.permissions) && req.user.permissions.includes(permission)) {
            return next();
        }

        return res.status(403).render('error', {
            title: 'Access Denied - Profiteers PMC',
            message: 'Access Denied',
            description: 'You do not have permission to perform this action.',
            user: res.locals.user
        });
    };
}

/**
 * Gate that requires the admin.access permission.
 */
function isAdmin(req, res, next) {
    if (!req.isAuthenticated()) {
        return res.redirect('/login?redirect=' + encodeURIComponent(req.originalUrl));
    }

    if (Array.isArray(req.user.permissions) && req.user.permissions.includes('admin.access')) {
        return next();
    }

    return res.status(403).render('error', {
        title: 'Access Denied - Profiteers PMC',
        message: 'Access Denied',
        description: 'You do not have permission to access this page.',
        user: res.locals.user
    });
}

async function attachUser(req, res, next) {
    if (req.isAuthenticated()) {
        const permissions = req.user.permissions || [];
        const isAdminFlag = permissions.includes('admin.access');

        // Keep session props in sync for legacy route handlers that read req.session.isAdmin
        req.session.userId   = req.user.id;
        req.session.username = req.user.username;
        req.session.isAdmin  = isAdminFlag;

        const isZeus = await checkZeusStatus(req.user.id);

        res.locals.user = {
            id: req.user.id,
            username: req.user.username,
            isAdmin: isAdminFlag,
            isZeus: isZeus,
            permissions: permissions
        };
    } else {
        res.locals.user = null;
    }
    next();
}

module.exports = {
    isAuthenticated,
    isAdmin,
    hasPermission,
    attachUser
};
