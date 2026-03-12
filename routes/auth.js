const express = require('express');
const router = express.Router();
const bcrypt = require('bcryptjs');
const db = require('../config/database');

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
        redirect: req.query.redirect || '/admin'
    });
});

router.get('/admin-login', (req, res) => {
    if (req.isAuthenticated()) {
        return res.redirect('/admin');
    }
    
    res.render('admin-login', {
        title: 'Admin Login - Profiteers PMC',
        error: null,
        redirect: req.query.redirect || '/admin'
    });
});

router.post('/login', async (req, res) => {
    const { username, password, redirect } = req.body;

    try {
        const [users] = await db.query('SELECT * FROM users WHERE username = ?', [username]);

        if (users.length === 0) {
            return res.render('admin-login', {
                title: 'Admin Login - Profiteers PMC',
                error: 'Invalid username or password',
                redirect: redirect || '/admin'
            });
        }

        const user = users[0];
        const isValidPassword = await bcrypt.compare(password, user.password_hash);

        if (!isValidPassword) {
            return res.render('admin-login', {
                title: 'Admin Login - Profiteers PMC',
                error: 'Invalid username or password',
                redirect: redirect || '/admin'
            });
        }

        await db.query('UPDATE users SET last_login = NOW() WHERE id = ?', [user.id]);

        req.login(user, (err) => {
            if (err) {
                console.error('Passport login error:', err);
                return res.render('admin-login', {
                    title: 'Admin Login - Profiteers PMC',
                    error: 'An error occurred during login',
                    redirect: redirect || '/admin'
                });
            }

            // Set session props for backward compatibility with route handlers
            req.session.userId = user.id;
            req.session.username = user.username;
            req.session.isAdmin = Boolean(user.is_admin);

            res.redirect(redirect || '/admin');
        });
    } catch (error) {
        console.error('Login error:', error);
        res.render('admin-login', {
            title: 'Admin Login - Profiteers PMC',
            error: 'An error occurred during login',
            redirect: redirect || '/admin'
        });
    }
});

router.get('/logout', (req, res) => {
    req.logout(() => {
        req.session.destroy();
        res.redirect('/');
    });
});

module.exports = router;