const express = require('express');
const router = express.Router();
const bcrypt = require('bcryptjs');
const { rateLimit } = require('express-rate-limit');
const db = require('../config/database');

const loginLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    limit: 10,
    message: 'Too many login attempts. Please try again in 15 minutes.',
    standardHeaders: true,
    legacyHeaders: false,
});

function sanitizeRedirect(url) {
    if (typeof url === 'string' && url.startsWith('/') && !url.startsWith('//')) {
        return url;
    }
    return '/admin';
}

function renderLoginError(res, error, redirect) {
    return res.render('admin-login', {
        title: 'Admin Login - Profiteers PMC',
        error,
        redirect
    });
}

router.get('/login', (req, res) => {
    if (req.isAuthenticated()) {
        return res.redirect('/admin');
    }
    
    let discordError = null;
    if (req.query.error === 'discord_auth_failed') {
        discordError = 'Discord authentication failed. You must be a member of the Profiteers PMC Discord server to login.';
    }
    
    res.render('login', {
        title: 'Login - Profiteers PMC',
        error: null,
        discordError: discordError,
        redirect: sanitizeRedirect(req.query.redirect)
    });
});

router.get('/admin-login', (req, res) => {
    if (req.isAuthenticated()) {
        return res.redirect('/admin');
    }

    res.render('admin-login', {
        title: 'Admin Login - Profiteers PMC',
        error: null,
        redirect: sanitizeRedirect(req.query.redirect)
    });
});

router.post('/login', loginLimiter, async (req, res) => {
    const { username, password } = req.body;
    const redirect = sanitizeRedirect(req.body.redirect);

    try {
        const [users] = await db.query('SELECT * FROM users WHERE username = ?', [username]);

        if (users.length === 0) {
            return renderLoginError(res, 'Invalid username or password', redirect);
        }

        const user = users[0];
        const isValidPassword = await bcrypt.compare(password, user.password_hash);

        if (!isValidPassword) {
            return renderLoginError(res, 'Invalid username or password', redirect);
        }

        await db.query('UPDATE users SET last_login = NOW() WHERE id = ?', [user.id]);

        req.login(user, (err) => {
            if (err) {
                console.error('Passport login error:', err);
                return renderLoginError(res, 'An error occurred during login', redirect);
            }

            req.session.userId = user.id;
            req.session.username = user.username;

            res.redirect(redirect);
        });
    } catch (error) {
        console.error('Login error:', error);
        renderLoginError(res, 'An error occurred during login', redirect);
    }
});

router.get('/logout', (req, res, next) => {
    req.logout((err) => {
        if (err) { return next(err); }
        req.session.destroy((err) => {
            if (err) { return next(err); }
            res.redirect('/');
        });
    });
});

module.exports = router;