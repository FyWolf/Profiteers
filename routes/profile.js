const express = require('express');
const router = express.Router();
const db = require('../config/database');
const { isAuthenticated } = require('../middleware/auth');

// Returns true if the given user holds any leader slot in any orbat template.
async function isLeaderAnywhere(userId, db) {
    if (!userId) return false;
    const [[{ count }]] = await db.query(`
        SELECT COUNT(*) AS count
        FROM orbat_assignments oa
        JOIN orbat_roles orr ON oa.role_id      = orr.id
        JOIN slot_types  st  ON orr.slot_type_id = st.id
        WHERE oa.user_id = ? AND st.is_leader = 1
    `, [userId]);
    return count > 0;
}

async function fetchAttendanceForProfile(profileUserId, viewerUserId, viewerPermissions, db) {
    const isAdmin = Array.isArray(viewerPermissions) && viewerPermissions.includes('attendance.manage');
    const canDetail = isAdmin || await isLeaderAnywhere(viewerUserId, db);

    if (canDetail) {
        const [rows] = await db.query(`
            SELECT
                oa.operation_date,
                oa.slot_type_name,
                oa.slot_type_abbr,
                oa.squad_name,
                oa.status,
                op.id    AS operation_id,
                op.title AS operation_title
            FROM orbat_attendance oa
            JOIN operations op ON oa.operation_id = op.id
            WHERE oa.user_id = ?
            ORDER BY oa.operation_date DESC
            LIMIT 50
        `, [profileUserId]);
        return { canViewAttendanceDetail: true, attendanceHistory: rows, attendancePresentCount: rows.filter(r => r.status === 'present').length };
    }

    const [[{ cnt }]] = await db.query(
        `SELECT COUNT(*) AS cnt FROM orbat_attendance WHERE user_id = ? AND status = 'present'`,
        [profileUserId]
    );
    return { canViewAttendanceDetail: false, attendanceHistory: null, attendancePresentCount: cnt };
}

router.get('/', isAuthenticated, async (req, res) => {
    try {
        const [users] = await db.query('SELECT * FROM users WHERE id = ?', [req.session.userId]);
        if (users.length === 0) return res.redirect('/login');
        const user = users[0];

        const [medals, trainings, roleRows] = await Promise.all([
            db.query(`
                SELECT m.*, um.awarded_at, um.notes, u.username as awarded_by_username
                FROM user_medals um
                JOIN medals m ON um.medal_id = m.id
                JOIN users  u ON um.awarded_by = u.id
                WHERE um.user_id = ? ORDER BY um.awarded_at DESC
            `, [req.session.userId]),
            db.query(`
                SELECT t.*, ut.synced_at, ut.last_verified
                FROM user_trainings ut
                JOIN trainings t ON ut.training_id = t.id
                WHERE ut.user_id = ? ORDER BY t.display_order ASC, t.name ASC
            `, [req.session.userId]),
            db.query(`
                SELECT r.name FROM user_roles ur
                JOIN roles r ON ur.role_id = r.id
                WHERE ur.user_id = ? ORDER BY r.name ASC
            `, [req.session.userId])
        ]);

        const attendance = await fetchAttendanceForProfile(
            req.session.userId, req.session.userId, res.locals.user?.permissions, db
        );

        res.render('profile', {
            title: 'My Profile - Profiteers PMC',
            profileUser: user,
            medals: medals[0],
            trainings: trainings[0],
            roles: roleRows[0].map(r => r.name),
            stats: {
                memberSince: user.created_at,
                lastLogin: user.last_login,
                medalCount: medals[0].length,
                trainingCount: trainings[0].length,
                authType: user.auth_type
            },
            ...attendance,
            isOwnProfile: true,
            isLoggedIn: true
        });
    } catch (error) {
        console.error('Error loading profile:', error);
        res.render('error', { title: 'Error Loading Profile', message: 'Error Loading Profile', description: 'Could not load your profile.', user: res.locals.user });
    }
});

router.get('/:userId', async (req, res) => {
    try {
        const [users] = await db.query('SELECT * FROM users WHERE id = ?', [req.params.userId]);
        if (users.length === 0) {
            return res.render('error', { title: 'User Not Found', message: 'User Not Found', description: 'This user profile does not exist.', user: res.locals.user });
        }
        const profileUser = users[0];

        const [medals, trainings, roleRows] = await Promise.all([
            db.query(`
                SELECT m.*, um.awarded_at, um.notes, u.username as awarded_by_username
                FROM user_medals um
                JOIN medals m ON um.medal_id = m.id
                JOIN users  u ON um.awarded_by = u.id
                WHERE um.user_id = ? ORDER BY um.awarded_at DESC
            `, [profileUser.id]),
            db.query(`
                SELECT t.*, ut.synced_at, ut.last_verified
                FROM user_trainings ut
                JOIN trainings t ON ut.training_id = t.id
                WHERE ut.user_id = ? ORDER BY t.display_order ASC, t.name ASC
            `, [profileUser.id]),
            db.query(`
                SELECT r.name FROM user_roles ur
                JOIN roles r ON ur.role_id = r.id
                WHERE ur.user_id = ? ORDER BY r.name ASC
            `, [profileUser.id])
        ]);

        const attendance = await fetchAttendanceForProfile(
            profileUser.id, req.session.userId, res.locals.user?.permissions, db
        );

        res.render('profile', {
            title: `${profileUser.discord_global_name || profileUser.username}'s Profile - Profiteers PMC`,
            profileUser,
            medals: medals[0],
            trainings: trainings[0],
            roles: roleRows[0].map(r => r.name),
            stats: {
                memberSince: profileUser.created_at,
                lastLogin: profileUser.last_login,
                medalCount: medals[0].length,
                trainingCount: trainings[0].length,
                authType: profileUser.auth_type
            },
            ...attendance,
            isOwnProfile: req.session.userId && req.session.userId === profileUser.id,
            isLoggedIn: !!req.session.userId
        });
    } catch (error) {
        console.error('Error loading profile:', error);
        res.render('error', { title: 'Error Loading Profile', message: 'Error Loading Profile', description: 'Could not load the profile.', user: res.locals.user });
    }
});

module.exports = router;
