const express = require('express');
const router = express.Router();
const path = require('path');
const sanitizeHtml = require('sanitize-html');
const db = require('../config/database');
const { isAuthenticated } = require('../middleware/auth');
const { isZeus, checkZeusStatus } = require('../middleware/zeus');

const NEWS_ALLOWED_TAGS = [
    'p', 'br', 'strong', 'em', 'u', 's', 'ul', 'ol', 'li',
    'h1', 'h2', 'h3', 'blockquote', 'a', 'img', 'span', 'div'
];
const NEWS_ALLOWED_ATTRS = {
    'a': ['href', 'target', 'rel'],
    'img': ['src', 'alt', 'width', 'height'],
    'span': ['style'],
    'div': ['style'],
    'p': ['style'],
};

function sanitizeNewsContent(raw) {
    return sanitizeHtml(raw, {
        allowedTags: NEWS_ALLOWED_TAGS,
        allowedAttributes: NEWS_ALLOWED_ATTRS,
        allowedSchemes: ['https', 'http'],
        allowedSchemesByTag: { img: ['https', 'http'] },
        transformTags: {
            'a': (tagName, attribs) => ({
                tagName,
                attribs: { ...attribs, rel: 'noopener noreferrer' }
            })
        }
    });
}

// Helper function to convert datetime-local input to unix timestamp
// Input: "2024-02-26T14:00" (user enters this as UTC)
// Output: Unix timestamp (seconds since epoch)
function toUnixTimestamp(datetimeLocal) {
    if (!datetimeLocal) return null;
    const date = new Date(datetimeLocal + ':00Z');
    return Math.floor(date.getTime() / 1000);
}

function parseBoolean(value) {
    return value === 'on' || value === '1' || value === true;
}

router.get('/upcoming', async (req, res) => {
    try {
        const search = req.query.search || '';
        
        let query = `
            SELECT 
                o.*,
                u.username as created_by_username,
                COUNT(DISTINCT CASE WHEN oa.status = 'present' THEN oa.user_id END) as present_count,
                COUNT(DISTINCT CASE WHEN oa.status = 'tentative' THEN oa.user_id END) as tentative_count
            FROM operations o
            LEFT JOIN users u ON o.created_by = u.id
            LEFT JOIN operation_attendance oa ON o.id = oa.operation_id
            WHERE o.start_time >= UNIX_TIMESTAMP() AND o.is_published = TRUE
        `;
        
        const params = [];
        if (search) {
            query += ` AND (o.title LIKE ? OR o.description LIKE ?)`;
            params.push(`%${search}%`, `%${search}%`);
        }
        
        query += ` GROUP BY o.id ORDER BY o.start_time ASC`;
        
        const [operations] = await db.query(query, params);
        
        res.render('operations/upcoming', {
            title: 'Upcoming Operations - Profiteers PMC',
            operations: operations,
            search: search
        });
    } catch (error) {
        console.error('Error loading upcoming operations:', error);
        res.render('error', {
            title: 'Error',
            message: 'Error Loading Operations',
            description: 'Could not load upcoming operations.',
            user: res.locals.user
        });
    }
});

router.get('/all', async (req, res) => {
    try {
        const search = req.query.search || '';
        
        let query = `
            SELECT 
                o.*,
                u.username as created_by_username,
                COUNT(DISTINCT CASE WHEN oa.status = 'present' THEN oa.user_id END) as present_count,
                COUNT(DISTINCT CASE WHEN oa.status = 'tentative' THEN oa.user_id END) as tentative_count
            FROM operations o
            LEFT JOIN users u ON o.created_by = u.id
            LEFT JOIN operation_attendance oa ON o.id = oa.operation_id
            WHERE o.is_published = TRUE
        `;
        
        const params = [];
        if (search) {
            query += ` AND (o.title LIKE ? OR o.description LIKE ?)`;
            params.push(`%${search}%`, `%${search}%`);
        }
        
        query += ` GROUP BY o.id ORDER BY o.start_time DESC`;
        
        const [operations] = await db.query(query, params);
        
        res.render('operations/all', {
            title: 'All Operations - Profiteers PMC',
            operations: operations,
            search: search
        });
    } catch (error) {
        console.error('Error loading all operations:', error);
        res.render('error', {
            title: 'Error',
            message: 'Error Loading Operations',
            description: 'Could not load operations.',
            user: res.locals.user
        });
    }
});

router.get('/:id', async (req, res) => {
    try {
        const [operations] = await db.query(`
            SELECT 
                o.*,
                u.username as created_by_username,
                u.discord_global_name as created_by_display_name,
                h.id as host_id,
                h.username as host_username,
                h.discord_global_name as host_display_name,
                h.discord_avatar as host_avatar,
                h.discord_id as host_discord_id,
                mp.id as modpack_id, mp.name as modpack_name,
                mp.mod_count as modpack_mod_count, mp.total_size as modpack_total_size
            FROM operations o
            LEFT JOIN users u ON o.created_by = u.id
            LEFT JOIN users h ON o.host_id = h.id
            LEFT JOIN modpacks mp ON o.modpack_id = mp.id
            WHERE o.id = ? AND o.is_published = TRUE
        `, [req.params.id]);
        
        if (operations.length === 0) {
            return res.status(404).render('error', {
                title: 'Operation Not Found',
                message: 'Operation Not Found',
                description: 'This operation does not exist or has been removed.',
                user: res.locals.user
            });
        }
        
        const operation = operations[0];
        
        const [attendance] = await db.query(`
            SELECT
                status,
                COUNT(*) as count
            FROM operation_attendance
            WHERE operation_id = ?
            GROUP BY status
        `, [req.params.id]);
        
        const attendanceCounts = {
            present: 0,
            tentative: 0,
            absent: 0
        };
        attendance.forEach(a => {
            attendanceCounts[a.status] = a.count;
        });
        
        let attendees = { present: [], tentative: [], absent: [] };
        if (req.session.userId) {
            const [allAttendees] = await db.query(`
                SELECT 
                    u.id,
                    u.username,
                    u.discord_global_name,
                    u.discord_avatar,
                    u.discord_id,
                    oa.status
                FROM operation_attendance oa
                JOIN users u ON oa.user_id = u.id
                WHERE oa.operation_id = ?
                ORDER BY u.username ASC
            `, [req.params.id]);
            
            allAttendees.forEach(attendee => {
                attendees[attendee.status].push(attendee);
            });
        }
        
        let userAttendance = null;
        if (req.session.userId) {
            const [userAtt] = await db.query(
                'SELECT status FROM operation_attendance WHERE operation_id = ? AND user_id = ?',
                [req.params.id, req.session.userId]
            );
            userAttendance = userAtt.length > 0 ? userAtt[0].status : null;
        }
        
        const [news] = await db.query(`
            SELECT 
                opn.*,
                u.username as posted_by_username,
                u.discord_global_name as posted_by_display_name,
                u.discord_avatar,
                u.discord_id
            FROM operation_news opn
            JOIN users u ON opn.posted_by = u.id
            WHERE opn.operation_id = ?
            ORDER BY opn.posted_at DESC
        `, [req.params.id]);
        
        let canManage = false;
        if (req.session.userId) {
            canManage = await checkZeusStatus(req.session.userId)
                || (operation && parseInt(operation.host_id) === parseInt(req.session.userId));
        }
        
        res.render('operations/view', {
            title: `${operation.title} - Profiteers PMC`,
            operation: operation,
            attendanceCounts: attendanceCounts,
            attendees: attendees,
            userAttendance: userAttendance,
            news: news,
            canManage: canManage
        });
    } catch (error) {
        console.error('Error loading operation:', error);
        res.render('error', {
            title: 'Error',
            message: 'Error Loading Operation',
            description: 'Could not load operation details.',
            user: res.locals.user
        });
    }
});

router.post('/:id/attendance', isAuthenticated, async (req, res) => {
    try {
        const { status } = req.body;
        
        if (!['present', 'tentative', 'absent'].includes(status)) {
            return res.json({ success: false, error: 'Invalid status' });
        }
        
        await db.query(`
            INSERT INTO operation_attendance (operation_id, user_id, status)
            VALUES (?, ?, ?)
            ON DUPLICATE KEY UPDATE status = ?, updated_at = NOW()
        `, [req.params.id, req.session.userId, status, status]);
        
        const [attendance] = await db.query(`
            SELECT
                status,
                COUNT(*) as count
            FROM operation_attendance
            WHERE operation_id = ?
            GROUP BY status
        `, [req.params.id]);
        
        const counts = {
            present: 0,
            tentative: 0,
            absent: 0
        };
        attendance.forEach(a => {
            counts[a.status] = a.count;
        });
        
        if (process.env.DISCORD_BOT_TOKEN) {
            try {
                const { updateOperationPost } = require('../discord/operations');
                const { discordClient } = require('../discord');
                
                const [ops] = await db.query('SELECT * FROM operations WHERE id = ?', [req.params.id]);
                if (ops[0] && ops[0].is_published) {
                    await updateOperationPost(discordClient, ops[0]);
                }
            } catch (discordError) {
                console.error('Discord attendance update error:', discordError);
                // Don't fail the attendance update if Discord fails
            }
        }
        
        res.json({ success: true, counts: counts });
    } catch (error) {
        console.error('Error updating attendance:', error);
        res.json({ success: false, error: 'Failed to update attendance' });
    }
});

router.get('/manage/list', isZeus, async (req, res) => {
    try {
        const [operations] = await db.query(`
            SELECT 
                o.*,
                u.username as created_by_username,
                COUNT(DISTINCT CASE WHEN oa.status = 'present' THEN oa.user_id END) as present_count,
                COUNT(DISTINCT CASE WHEN oa.status = 'tentative' THEN oa.user_id END) as tentative_count,
                COUNT(DISTINCT CASE WHEN oa.status = 'absent' THEN oa.user_id END) as absent_count
            FROM operations o
            LEFT JOIN users u ON o.created_by = u.id
            LEFT JOIN operation_attendance oa ON o.id = oa.operation_id
            GROUP BY o.id
            ORDER BY o.start_time DESC
        `);
        
        res.render('operations/manage', {
            title: 'Manage Operations - Profiteers PMC',
            operations: operations,
            success: req.query.success || null,
            error: req.query.error || null
        });
    } catch (error) {
        console.error('Error loading operations management:', error);
        res.render('error', {
            title: 'Error',
            message: 'Error Loading Management',
            description: 'Could not load operations management.',
            user: res.locals.user
        });
    }
});

router.get('/manage/create', isZeus, async (req, res) => {
    try {
        const [users] = await db.query(`
            SELECT id, username, discord_global_name, discord_username, is_admin
            FROM users
            ORDER BY discord_global_name ASC, username ASC
        `);

        const [modpacks] = await db.query('SELECT id, name, mod_count FROM modpacks ORDER BY name ASC');
        
        res.render('operations/form', {
            title: 'Create Operation - Profiteers PMC',
            operation: null,
            action: 'create',
            users: users,
            modpacks: modpacks
        });
    } catch (error) {
        console.error('Error loading create form:', error);
        res.render('error', {
            title: 'Error',
            message: 'Error Loading Form',
            description: 'Could not load the operation creation form.',
            user: res.locals.user
        });
    }
});

router.post('/manage/create', isZeus, async (req, res) => {
    try {
        const { title, description, start_time, end_time, banner_url, orbat_type, orbat_template_id, host_id, operation_type, modpack_id } = req.body;
        let finalBannerUrl = banner_url || '/images/operations/default-banner.jpg';

        if (req.files && req.files.banner_upload) {
            const bannerFile = req.files.banner_upload;
            
            const fileExt = path.extname(bannerFile.name).replace(/[^a-z0-9.]/gi, '');
            const baseName = path.basename(bannerFile.name, path.extname(bannerFile.name))
                .toLowerCase()
                .replace(/[^a-z0-9-]/g, '-');
            const fileName = baseName + fileExt;
            
            const uploadPath = path.join(__dirname, '../public/images/operations/', fileName);
            await bannerFile.mv(uploadPath);
            
            finalBannerUrl = '/images/operations/' + fileName;
        }

        const startTimestamp = toUnixTimestamp(start_time);
        const endTimestamp = toUnixTimestamp(end_time);
        
        const finalOrbatType = orbat_type || 'none';
        const finalOrbatTemplateId = (finalOrbatType === 'fixed' && orbat_template_id) ? orbat_template_id : null;
        const finalHostId = host_id || null;
        const finalOperationType = operation_type || 'main';
        const finalModpackId = modpack_id ? parseInt(modpack_id) : null;
        const published = true; // New operations are published by default

        const [result] = await db.query(`
            INSERT INTO operations 
            (title, description, banner_url, start_time, end_time, created_by, orbat_type, orbat_template_id, host_id, operation_type, is_published, modpack_id)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `, [title, description, finalBannerUrl, startTimestamp, endTimestamp, req.session.userId, finalOrbatType, finalOrbatTemplateId, finalHostId, finalOperationType, published, finalModpackId]);

        const newOpId = result.insertId;

        if (published && process.env.DISCORD_BOT_TOKEN) {
            try {
                const { createOperationPost } = require('../discord/operations');
                const { discordClient } = require('../discord');
                
                await createOperationPost(discordClient, {
                    id: newOpId,
                    title: title,
                    description: description,
                    start_time: startTimestamp,
                    end_time: endTimestamp,
                    banner_url: finalBannerUrl,
                    operation_type: finalOperationType
                });
            } catch (discordError) {
                console.error('Discord post error:', discordError);
                // Don't fail the operation creation if Discord fails
            }
        }

        res.redirect('/operations/manage/list?success=Operation created successfully');
    } catch (error) {
        console.error('Error creating operation:', error);
        res.redirect('/operations/manage/list?error=Failed to create operation');
    }
});

router.get('/manage/edit/:id', isAuthenticated, async (req, res) => {
    try {
        const [operations] = await db.query('SELECT * FROM operations WHERE id = ?', [req.params.id]);

        if (operations.length === 0) {
            return res.redirect('/operations/manage/list?error=Operation not found');
        }

        const isZeusUser = await checkZeusStatus(req.session.userId);
        const isHost = parseInt(operations[0].host_id) === parseInt(req.session.userId);
        if (!isZeusUser && !isHost) {
            return res.redirect('/operations/' + req.params.id + '?error=Access denied');
        }

        const [users] = await db.query(`
            SELECT id, username, discord_global_name, discord_username, is_admin
            FROM users
            ORDER BY discord_global_name ASC, username ASC
        `);

        const [modpacks] = await db.query('SELECT id, name, mod_count FROM modpacks ORDER BY name ASC');

        res.render('operations/form', {
            title: 'Edit Operation - Profiteers PMC',
            operation: operations[0],
            action: 'edit',
            users: users,
            modpacks: modpacks
        });
    } catch (error) {
        console.error('Error loading operation for edit:', error);
        res.redirect('/operations/manage/list?error=Failed to load operation');
    }
});

router.post('/manage/edit/:id', isAuthenticated, async (req, res) => {
    try {
        const [opCheck] = await db.query('SELECT host_id FROM operations WHERE id = ?', [req.params.id]);
        const isZeusUser = await checkZeusStatus(req.session.userId);
        const isHost = opCheck.length > 0 && parseInt(opCheck[0].host_id) === parseInt(req.session.userId);
        if (!isZeusUser && !isHost) {
            return res.redirect('/operations/' + req.params.id + '?error=Access denied');
        }

        const { title, description, start_time, end_time, banner_url, is_published, orbat_type, orbat_template_id, host_id, operation_type, modpack_id } = req.body;
        let finalBannerUrl = banner_url;

        if (req.files && req.files.banner_upload) {
            const bannerFile = req.files.banner_upload;
            
            const fileExt = path.extname(bannerFile.name).replace(/[^a-z0-9.]/gi, '');
            const baseName = path.basename(bannerFile.name, path.extname(bannerFile.name))
                .toLowerCase()
                .replace(/[^a-z0-9-]/g, '-');
            const fileName = baseName + fileExt;
            
            const uploadPath = path.join(__dirname, '../public/images/operations/', fileName);
            await bannerFile.mv(uploadPath);
            
            finalBannerUrl = '/images/operations/' + fileName;
        }

        const startTimestamp = toUnixTimestamp(start_time);
        const endTimestamp = toUnixTimestamp(end_time);
        const published = parseBoolean(is_published);
        
        const finalOrbatType = orbat_type || 'none';
        const finalOrbatTemplateId = (finalOrbatType === 'fixed' && orbat_template_id) ? orbat_template_id : null;
        const finalHostId = host_id || null;
        const finalOperationType = operation_type || 'main';
        const finalModpackId = modpack_id ? parseInt(modpack_id) : null;

        await db.query(`
            UPDATE operations 
            SET title = ?, description = ?, banner_url = ?, start_time = ?, end_time = ?, is_published = ?,
                orbat_type = ?, orbat_template_id = ?, host_id = ?, operation_type = ?, modpack_id = ?
            WHERE id = ?
        `, [title, description, finalBannerUrl, startTimestamp, endTimestamp, published, finalOrbatType, finalOrbatTemplateId, finalHostId, finalOperationType, finalModpackId, req.params.id]);

        if (published && process.env.DISCORD_BOT_TOKEN) {
            try {
                const { updateOperationPost } = require('../discord/operations');
                const { discordClient } = require('../discord');
                
                const [ops] = await db.query('SELECT * FROM operations WHERE id = ?', [req.params.id]);
                if (ops[0]) {
                    await updateOperationPost(discordClient, ops[0]);
                }
            } catch (discordError) {
                console.error('Discord update error:', discordError);
                // Don't fail the operation update if Discord fails
            }
        }

        res.redirect(`/operations/${req.params.id}?success=Operation updated successfully`);
    } catch (error) {
        console.error('Error updating operation:', error);
        res.redirect('/operations/manage/list?error=Failed to update operation');
    }
});

router.post('/manage/delete/:id', isZeus, async (req, res) => {
    try {
        await db.query('DELETE FROM operations WHERE id = ?', [req.params.id]);
        res.redirect('/operations/manage/list?success=Operation deleted successfully');
    } catch (error) {
        console.error('Error deleting operation:', error);
        res.redirect('/operations/manage/list?error=Failed to delete operation');
    }
});

router.post('/:id/news', isAuthenticated, async (req, res) => {
    try {
        const [opCheck] = await db.query('SELECT host_id FROM operations WHERE id = ?', [req.params.id]);
        const isZeusUser = await checkZeusStatus(req.session.userId);
        const isHost = opCheck.length > 0 && parseInt(opCheck[0].host_id) === parseInt(req.session.userId);
        if (!isZeusUser && !isHost) {
            return res.json({ success: false, error: 'Access denied' });
        }

        const { ping } = req.body;
        // Sanitize HTML from rich text editor — strips dangerous tags/attributes and data: URIs
        const content = sanitizeNewsContent(req.body.content || '');

        await db.query(`
            INSERT INTO operation_news (operation_id, content, posted_by)
            VALUES (?, ?, ?)
        `, [req.params.id, content, req.session.userId]);

        if (process.env.DISCORD_BOT_TOKEN) {
            try {
                const { postOperationNews } = require('../discord/operations');
                const { discordClient } = require('../discord');

                const [ops] = await db.query('SELECT * FROM operations WHERE id = ?', [req.params.id]);
                if (ops[0] && ops[0].is_published) {
                    await postOperationNews(
                        discordClient,
                        ops[0],
                        content,
                        req.session.username || req.session.discord_global_name || 'Staff',
                        ping
                    );
                }
            } catch (discordError) {
                console.error('Discord news post error:', discordError);
                // Don't fail the news post if Discord fails
            }
        }
        
        res.json({ success: true });
    } catch (error) {
        console.error('Error posting news:', error);
        res.json({ success: false, error: 'Failed to post news' });
    }
});

router.post('/news/delete/:newsId', isAuthenticated, async (req, res) => {
    try {
        const [newsCheck] = await db.query(`
            SELECT o.host_id FROM operation_news opn
            JOIN operations o ON o.id = opn.operation_id
            WHERE opn.id = ?
        `, [req.params.newsId]);
        const isZeusUser = await checkZeusStatus(req.session.userId);
        const isHost = newsCheck.length > 0 && parseInt(newsCheck[0].host_id) === parseInt(req.session.userId);
        if (!isZeusUser && !isHost) {
            return res.json({ success: false, error: 'Access denied' });
        }

        await db.query('DELETE FROM operation_news WHERE id = ?', [req.params.newsId]);
        res.json({ success: true });
    } catch (error) {
        console.error('Error deleting news:', error);
        res.json({ success: false, error: 'Failed to delete news' });
    }
});

module.exports = router;
