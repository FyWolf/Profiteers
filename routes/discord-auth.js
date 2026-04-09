const express = require('express');
const router = express.Router();
const passport = require('../config/passport');

function sanitizeRedirect(url) {
    if (typeof url === 'string' && url.startsWith('/') && !url.startsWith('//')) {
        return url;
    }
    return '/';
}

router.get('/discord', passport.authenticate('discord'));

router.get('/discord/callback', 
    passport.authenticate('discord', {
        failureRedirect: '/login?error=discord_auth_failed',
        failureMessage: true
    }),
    (req, res) => {
        // Set basic session props — isAdmin is resolved by attachUser middleware
        req.session.userId = req.user.id;
        req.session.username = req.user.username;
        
        const redirect = sanitizeRedirect(req.session.redirectTo);
        delete req.session.redirectTo;
        res.redirect(redirect);
    }
);

module.exports = router;
