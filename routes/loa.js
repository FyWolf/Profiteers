const express = require('express');
const router = express.Router();
const db = require('../config/database');
const { isAuthenticated, isAdmin } = require('../middleware/auth');
const { checkZeusStatus } = require('../middleware/zeus');
const { sendLOANotification } = require('../discord/loa');
const { discordClient } = require('../discord');

router.get('/my-loas', (req, res) => res.redirect('/loa/all'));

router.get('/submit', isAuthenticated, async (req, res) => {
    try {
        const [users] = await db.query(`
            SELECT id, username, discord_global_name, discord_username, is_admin
            FROM users 
            WHERE id != ?
            ORDER BY discord_global_name ASC, username ASC
        `, [req.session.userId]); // Exclude self from list

        res.render('loa/submit', {
            title: 'Submit Leave of Absence - Profiteers PMC',
            users: users
        });
    } catch (error) {
        console.error('Error loading LOA form:', error);
        res.render('error', {
            title: 'Error',
            message: 'Error Loading Form',
            description: 'Could not load the LOA submission form.',
            user: res.locals.user
        });
    }
});

router.post('/submit', isAuthenticated, async (req, res) => {
    try {
        const { start_date, end_date, reason, superior_id } = req.body;

        const startDate = new Date(start_date);
        const endDate = new Date(end_date);

        if (endDate <= startDate) {
            return res.redirect('/loa/submit?error=End date must be after start date');
        }

        const startTs = Math.floor(startDate.getTime() / 1000);
        const endTs = Math.floor(endDate.getTime() / 1000);

        const [result] = await db.query(`
            INSERT INTO leave_of_absence
            (user_id, start_date, end_date, reason, superior_id, status, submitted_at)
            VALUES (?, ?, ?, ?, ?, 'approved', UNIX_TIMESTAMP())
        `, [req.session.userId, startTs, endTs, reason, superior_id || null]);

        if (process.env.DISCORD_BOT_TOKEN) {
            try {
                const [users] = await db.query('SELECT * FROM users WHERE id = ?', [req.session.userId]);
                const [superiors] = superior_id ?
                    await db.query('SELECT * FROM users WHERE id = ?', [superior_id]) :
                    [[]];

                await sendLOANotification(
                    discordClient,
                    { id: result.insertId, start_date: startTs, end_date: endTs },
                    users[0],
                    superiors[0] || null,
                    'submitted'
                );
            } catch (discordError) {
                console.error('Discord LOA notification error:', discordError);
                // Don't fail the LOA submission if Discord fails
            }
        }

        res.redirect('/loa/my-loas?success=LOA submitted successfully');
    } catch (error) {
        console.error('Error submitting LOA:', error);
        res.redirect('/loa/submit?error=Failed to submit LOA');
    }
});

router.get('/edit/:id', isAuthenticated, async (req, res) => {
    try {
        const [loas] = await db.query(
            'SELECT * FROM leave_of_absence WHERE id = ? AND user_id = ?',
            [req.params.id, req.session.userId]
        );

        if (loas.length === 0) {
            return res.redirect('/loa/my-loas?error=LOA not found');
        }

        const [users] = await db.query(`
            SELECT id, username, discord_global_name, discord_username, is_admin
            FROM users
            WHERE id != ?
            ORDER BY discord_global_name ASC, username ASC
        `, [req.session.userId]); // Exclude self from list

        res.render('loa/edit', {
            title: 'Edit Leave of Absence - Profiteers PMC',
            loa: loas[0],
            users: users
        });
    } catch (error) {
        console.error('Error loading LOA:', error);
        res.redirect('/loa/my-loas?error=Failed to load LOA');
    }
});

router.post('/edit/:id', isAuthenticated, async (req, res) => {
    try {
        const { start_date, end_date, reason, superior_id } = req.body;

        const startDate = new Date(start_date);
        const endDate = new Date(end_date);

        if (endDate <= startDate) {
            return res.redirect(`/loa/edit/${req.params.id}?error=End date must be after start date`);
        }

        const startTs = Math.floor(startDate.getTime() / 1000);
        const endTs = Math.floor(endDate.getTime() / 1000);

        const [result] = await db.query(`
            UPDATE leave_of_absence
            SET start_date = ?, end_date = ?, reason = ?, superior_id = ?
            WHERE id = ? AND user_id = ?
        `, [startTs, endTs, reason, superior_id || null, req.params.id, req.session.userId]);

        if (result.affectedRows === 0) {
            return res.redirect('/loa/my-loas?error=LOA not found');
        }

        if (process.env.DISCORD_BOT_TOKEN) {
            try {
                const [loas] = await db.query('SELECT * FROM leave_of_absence WHERE id = ?', [req.params.id]);
                const [users] = await db.query('SELECT * FROM users WHERE id = ?', [req.session.userId]);
                const [superiors] = superior_id ? 
                    await db.query('SELECT * FROM users WHERE id = ?', [superior_id]) : 
                    [[]];

                if (loas[0]) {
                    await sendLOANotification(
                        discordClient,
                        loas[0],
                        users[0],
                        superiors[0] || null,
                        'updated'
                    );
                }
            } catch (discordError) {
                console.error('Discord LOA update error:', discordError);
                // Don't fail the LOA update if Discord fails
            }
        }

        res.redirect('/loa/my-loas?success=LOA updated successfully');
    } catch (error) {
        console.error('Error updating LOA:', error);
        res.redirect(`/loa/edit/${req.params.id}?error=Failed to update LOA`);
    }
});

router.post('/delete/:id', isAuthenticated, async (req, res) => {
    try {
        // Get LOA and user info BEFORE deleting for Discord notification
        let loaData = null;
        let userData = null;
        
        if (process.env.DISCORD_BOT_TOKEN) {
            try {
                const [loas] = await db.query(
                    'SELECT * FROM leave_of_absence WHERE id = ? AND user_id = ?',
                    [req.params.id, req.session.userId]
                );
                const [users] = await db.query('SELECT * FROM users WHERE id = ?', [req.session.userId]);
                
                if (loas[0] && users[0]) {
                    loaData = loas[0];
                    userData = users[0];
                }
            } catch (err) {
                console.error('Error fetching LOA data for Discord:', err);
            }
        }
        
        await db.query(
            'DELETE FROM leave_of_absence WHERE id = ? AND user_id = ?',
            [req.params.id, req.session.userId]
        );

        if (process.env.DISCORD_BOT_TOKEN && loaData && userData) {
            try {
                await sendLOANotification(
                    discordClient,
                    loaData,
                    userData,
                    null,
                    'deleted'
                );
            } catch (discordError) {
                console.error('Discord LOA deletion error:', discordError);
                // Don't fail the LOA deletion if Discord fails
            }
        }

        res.redirect('/loa/my-loas?success=LOA deleted successfully');
    } catch (error) {
        console.error('Error deleting LOA:', error);
        res.redirect('/loa/my-loas?error=Failed to delete LOA');
    }
});

router.get('/all', async (req, res) => {
    try {
        const [loas] = await db.query(`
            SELECT
                loa.*,
                u.username,
                u.discord_global_name,
                u.discord_avatar,
                u.discord_id,
                rm.nickname as roster_nickname,
                sup.username as superior_username,
                sup.discord_global_name as superior_display_name,
                rev.username as reviewer_username,
                rev.discord_global_name as reviewer_display_name,
                rev_rm.nickname as reviewer_roster_nickname
            FROM leave_of_absence loa
            JOIN users u ON loa.user_id = u.id
            LEFT JOIN roster_members rm ON rm.discord_id = u.discord_id
            LEFT JOIN users sup ON loa.superior_id = sup.id
            LEFT JOIN users rev ON loa.reviewed_by = rev.id
            LEFT JOIN roster_members rev_rm ON rev_rm.discord_id = rev.discord_id
            ORDER BY loa.start_date DESC
        `);

        const now = new Date();
        const activeLoas = loas.filter(loa => new Date(loa.end_date * 1000) >= now && loa.status === 'approved');
        const pastLoas = loas.filter(loa => new Date(loa.end_date * 1000) < now || loa.status !== 'approved');

        const isAdmin = req.session.isAdmin || false;
        const isZeus = req.session.userId ? await checkZeusStatus(req.session.userId) : false;

        let myLoas = [];
        if (req.session.userId) {
            const [myRows] = await db.query(`
                SELECT
                    loa.*,
                    sup.username as superior_username,
                    sup.discord_global_name as superior_display_name,
                    rev.username as reviewer_username
                FROM leave_of_absence loa
                LEFT JOIN users sup ON loa.superior_id = sup.id
                LEFT JOIN users rev ON loa.reviewed_by = rev.id
                WHERE loa.user_id = ?
                ORDER BY loa.start_date DESC
            `, [req.session.userId]);
            myLoas = myRows;
        }

        res.render('loa/all', {
            title: 'Leave of Absence - Profiteers PMC',
            activeLoas,
            pastLoas,
            myLoas,
            canManage: isAdmin || isZeus,
            success: req.query.success || null,
            error: req.query.error || null
        });
    } catch (error) {
        console.error('Error loading all LOAs:', error);
        res.render('error', {
            title: 'Error',
            message: 'Error Loading LOAs',
            description: 'Could not load leave requests.',
            user: res.locals.user
        });
    }
});

router.post('/review/:id', isAdmin, async (req, res) => {
    try {
        const [loas] = await db.query('SELECT reviewed_by FROM leave_of_absence WHERE id = ?', [req.params.id]);
        if (loas.length === 0) return res.redirect('/loa/all?error=LOA not found');

        if (loas[0].reviewed_by) {
            // Already reviewed — un-acknowledge
            await db.query(
                'UPDATE leave_of_absence SET reviewed_by = NULL, reviewed_at = NULL, review_notes = NULL WHERE id = ?',
                [req.params.id]
            );
        } else {
            const notes = req.body.review_notes || null;
            await db.query(
                'UPDATE leave_of_absence SET reviewed_by = ?, reviewed_at = UNIX_TIMESTAMP(), review_notes = ? WHERE id = ?',
                [req.session.userId, notes, req.params.id]
            );
        }

        res.redirect('/loa/all');
    } catch (error) {
        console.error('Error reviewing LOA:', error);
        res.redirect('/loa/all?error=Failed to update review');
    }
});

router.get('/api/check/:userId', async (req, res) => {
    try {
        const [loas] = await db.query(`
            SELECT id, start_date, end_date
            FROM leave_of_absence
            WHERE user_id = ?
              AND status = 'approved'
              AND start_date <= UNIX_TIMESTAMP()
              AND end_date >= UNIX_TIMESTAMP()
            LIMIT 1
        `, [req.params.userId]);

        res.json({
            onLoa: loas.length > 0,
            loa: loas[0] || null
        });
    } catch (error) {
        console.error('Error checking LOA status:', error);
        res.json({ onLoa: false, loa: null });
    }
});

module.exports = router;
