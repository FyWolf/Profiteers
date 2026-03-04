const express = require('express');
const router = express.Router();
const db = require('../config/database');
const { isAuthenticated } = require('../middleware/auth');

// User profile page (requires authentication)
router.get('/', isAuthenticated, async (req, res) => {
    try {
        // Get user information
        const [users] = await db.query('SELECT * FROM users WHERE id = ?', [req.session.userId]);
        
        if (users.length === 0) {
            return res.redirect('/login');
        }
        
        const user = users[0];
        
        // Get user's medals with award details
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
        
        // Get user's trainings
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
        
        // Get user statistics
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

// Public profile page (view another user's profile)
router.get('/:userId', async (req, res) => {
    try {
        // Get user information by user ID (not Discord ID for privacy)
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
        
        // Get user's medals with award details
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
        
        // Get user's trainings
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
        
        // Get user statistics
        const stats = {
            memberSince: profileUser.created_at,
            lastLogin: profileUser.last_login,
            medalCount: medals.length,
            trainingCount: trainings.length,
            authType: profileUser.auth_type
        };
        
        // Check if viewing own profile
        const isOwnProfile = req.session.userId && req.session.userId === profileUser.id;
        
        // Check if user is logged in (for showing private info)
        const isLoggedIn = !!req.session.userId;
        
        res.render('profile', {
            title: `${profileUser.discord_global_name || profileUser.username}'s Profile - Profiteers PMC`,
            profileUser: profileUser,
            medals: medals,
            trainings: trainings,
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