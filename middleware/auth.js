function isAuthenticated(req, res, next) {
    if (req.session && req.session.userId) {
        return next();
    }
    res.redirect('/login?redirect=' + encodeURIComponent(req.originalUrl));
}

function isAdmin(req, res, next) {
    const isAdmin = Boolean(req.session && req.session.userId && req.session.isAdmin);
    
    if (isAdmin) {
        return next();
    }
    
    if (process.env.NODE_ENV === 'development') {
        console.log('Admin access denied:', {
            hasSession: !!req.session,
            hasUserId: !!req.session?.userId,
            isAdminRaw: req.session?.isAdmin,
            isAdminType: typeof req.session?.isAdmin,
            isAdminBoolean: Boolean(req.session?.isAdmin)
        });
    }
    
    res.status(403).render('error', {
        title: 'Access Denied - Profiteers PMC',
        message: 'Access Denied',
        description: 'You do not have permission to access this page.',
        user: req.session.userId ? { 
            username: req.session.username, 
            isAdmin: Boolean(req.session.isAdmin) 
        } : null
    });
}

const { checkZeusStatus } = require('./zeus');

async function attachUser(req, res, next) {
    if (req.session.userId) {
        const isZeus = await checkZeusStatus(req.session.userId);
        res.locals.user = {
            id: req.session.userId,
            username: req.session.username,
            isAdmin: Boolean(req.session.isAdmin),
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