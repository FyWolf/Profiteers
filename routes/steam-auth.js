const express = require('express');
const router = express.Router();
const passport = require('passport');
const { isAuthenticated } = require('../middleware/auth');

/**
 * GET /auth/steam
 * Initiates Steam OpenID authentication for linking a Steam account.
 * Only accessible to authenticated users.
 */
router.get('/steam', isAuthenticated, (req, res, next) => {
    passport.authenticate('steam-link')(req, res, next);
});

/**
 * GET /auth/steam/return
 * Callback URL that Steam redirects to after authentication.
 * Extracts the Steam 64 ID and links it to the user's account.
 */
router.get('/steam/return', isAuthenticated, (req, res, next) => {
    passport.authenticate('steam-link', {
        successRedirect: '/profile?success=Steam+account+linked+successfully',
        failureRedirect: '/profile?error=Failed+to+link+Steam+account',
        failureFlash: false
    })(req, res, next);
});

module.exports = router;
