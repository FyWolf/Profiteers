const { checkZeusStatus } = require('./zeus');

function isAuthenticated(req, res, next) {
    if (req.isAuthenticated()) {
        return next();
    }
    res.redirect('/login?redirect=' + encodeURIComponent(req.originalUrl));
}

function isAdmin(req, res, next) {
    if (req.isAuthenticated() && req.user.is_admin) {
        return next();
    }

    res.status(403).render('error', {
        title: 'Access Denied - Profiteers PMC',
        message: 'Access Denied',
        description: 'You do not have permission to access this page.',
        user: res.locals.user
    });
}

async function attachUser(req, res, next) {
    if (req.isAuthenticated()) {
        const isZeus = await checkZeusStatus(req.user.id);
        res.locals.user = {
            id: req.user.id,
            username: req.user.username,
            isAdmin: Boolean(req.user.is_admin),
            isZeus: isZeus
        };
    } else {
        res.locals.user = null;
    }
    next();
}

module.exports = {
    isAuthenticated,
    isAdmin,
    attachUser
};
