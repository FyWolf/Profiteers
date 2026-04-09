const express = require('express');
const router = express.Router();
const db = require('../config/database');
const { isAuthenticated } = require('../middleware/auth');

router.get('/', isAuthenticated, async (req, res) => {
    try {
        const [users] = await db.query('SELECT * FROM users WHERE id = ?', [req.session.userId]);
        
        if (users.length === 0) {
            return res.redirect('/login');
        }
        
        const user = users[0];
        
        const [medals] = await db.query(`
            SELECT
                m.*,
                um.awarded_at,
                um.notes,
                u.username as awarded_by_username
            FROM user_medals um
            JOIN medals m ON um.medal_id = m.id
            JOIN users u ON um.awarded_by = u.id
            WHERE um.user_id = ?
            ORDER BY um.awarded_at DESC
        `, [req.session.userId]);

        const [trainings] = await db.query(`
            SELECT 
                t.*,
                ut.synced_at,
                ut.last_verified
            FROM user_trainings ut
            JOIN trainings t ON ut.training_id = t.id
            WHERE ut.user_id = ?
            ORDER BY t.display_order ASC, t.name ASC
        `, [req.session.userId]);

        const [roleRows] = await db.query(`
            SELECT r.name FROM user_roles ur
            JOIN roles r ON ur.role_id = r.id
            WHERE ur.user_id = ? ORDER BY r.name ASC
        `, [req.session.userId]);

        const stats = {
            memberSince: user.created_at,
            lastLogin: user.last_login,
            medalCount: medals.length,
            trainingCount: trainings.length,
            authType: user.auth_type
        };

        res.render('profile', {
            title: 'My Profile - Profiteers PMC',
            profileUser: user,
            medals: medals,
            trainings: trainings,
            roles: roleRows.map(r => r.name),
            stats: stats,
            isOwnProfile: true,
            isLoggedIn: true
        });
    } catch (error) {
        console.error('Error loading profile:', error);
        res.render('error', {
            title: 'Error Loading Profile',
            message: 'Error Loading Profile',
            description: 'Could not load your profile.',
            user: res.locals.user
        });
    }
});

router.get('/:userId', async (req, res) => {
    try {
        const [users] = await db.query('SELECT * FROM users WHERE id = ?', [req.params.userId]);
        
        if (users.length === 0) {
            return res.render('error', {
                title: 'User Not Found',
                message: 'User Not Found',
                description: 'This user profile does not exist.',
                user: res.locals.user
            });
        }
        
        const profileUser = users[0];
        
        const [medals] = await db.query(`
            SELECT
                m.*,
                um.awarded_at,
                um.notes,
                u.username as awarded_by_username
            FROM user_medals um
            JOIN medals m ON um.medal_id = m.id
            JOIN users u ON um.awarded_by = u.id
            WHERE um.user_id = ?
            ORDER BY um.awarded_at DESC
        `, [profileUser.id]);

        const [trainings] = await db.query(`
            SELECT 
                t.*,
                ut.synced_at,
                ut.last_verified
            FROM user_trainings ut
            JOIN trainings t ON ut.training_id = t.id
            WHERE ut.user_id = ?
            ORDER BY t.display_order ASC, t.name ASC
        `, [profileUser.id]);

        const [roleRows] = await db.query(`
            SELECT r.name FROM user_roles ur
            JOIN roles r ON ur.role_id = r.id
            WHERE ur.user_id = ? ORDER BY r.name ASC
        `, [profileUser.id]);

        const stats = {
            memberSince: profileUser.created_at,
            lastLogin: profileUser.last_login,
            medalCount: medals.length,
            trainingCount: trainings.length,
            authType: profileUser.auth_type
        };

        const isOwnProfile = req.session.userId && req.session.userId === profileUser.id;
        const isLoggedIn = !!req.session.userId;

        res.render('profile', {
            title: `${profileUser.discord_global_name || profileUser.username}'s Profile - Profiteers PMC`,
            profileUser: profileUser,
            medals: medals,
            trainings: trainings,
            roles: roleRows.map(r => r.name),
            stats: stats,
            isOwnProfile: isOwnProfile,
            isLoggedIn: isLoggedIn
        });
    } catch (error) {
        console.error('Error loading profile:', error);
        res.render('error', {
            title: 'Error Loading Profile',
            message: 'Error Loading Profile',
            description: 'Could not load the profile.',
            user: res.locals.user
        });
    }
});

module.exports = router;