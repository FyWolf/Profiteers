const express = require('express');
const router = express.Router();
const path = require('path');
const fs = require('fs').promises;
const db = require('../config/database');
const { isAdmin } = require('../middleware/auth');

router.use(isAdmin);

router.get('/', async (req, res) => {
    try {
        const [toolsCount] = await db.query('SELECT COUNT(*) as count FROM tools');
        const [foldersCount] = await db.query('SELECT COUNT(*) as count FROM gallery_folders');
        const [imagesCount] = await db.query('SELECT COUNT(*) as count FROM gallery_images');
        const [usersCount] = await db.query('SELECT COUNT(*) as count FROM users');
        const [medalsCount] = await db.query('SELECT COUNT(*) as count FROM medals');
        const [trainingsCount] = await db.query('SELECT COUNT(*) as count FROM trainings');

        res.render('admin/dashboard', {
            title: 'Admin Dashboard - Profiteers PMC',
            stats: {
                tools: toolsCount[0].count,
                folders: foldersCount[0].count,
                images: imagesCount[0].count,
                users: usersCount[0].count,
                medals: medalsCount[0].count,
                trainings: trainingsCount[0].count
            }
        });
    } catch (error) {
        console.error('Error loading dashboard:', error);
        res.render('error', {
            title: 'Error Loading Dashboard',
            message: 'Error Loading Dashboard',
            description: 'Could not load admin dashboard.',
            user: res.locals.user
        });
    }
});

router.get('/tools', async (req, res) => {
    try {
        const [tools] = await db.query('SELECT * FROM tools ORDER BY order_index ASC, created_at DESC');

        res.render('admin/tools', {
            title: 'Manage Tools - Admin',
            tools: tools,
            success: req.query.success,
            error: req.query.error
        });
    } catch (error) {
        console.error('Error fetching tools:', error);
        res.render('error', {
            title: 'Error Loading Tools',
            message: 'Error Loading Tools',
            description: 'Could not load tools management.',
            user: res.locals.user
        });
    }
});

router.get('/tools/add', (req, res) => {
    res.render('admin/tool-form', {
        title: 'Add Tool - Admin',
        tool: null,
        mode: 'add'
    });
});

router.post('/tools/add', async (req, res) => {
    const { title, description, link, order_index } = req.body;

    try {
        let imageUrl = null;

        if (req.files && req.files.image) {
            const image = req.files.image;
            const safeName = path.basename(image.name).replace(/[^a-zA-Z0-9._-]/g, '-');
            const fileName = Date.now() + '-' + safeName;
            const uploadPath = path.join(__dirname, '..', 'public', 'uploads', 'tools', fileName);

            await image.mv(uploadPath);
            imageUrl = '/uploads/tools/' + fileName;
        }

        await db.query(
            'INSERT INTO tools (title, description, image_url, link, order_index) VALUES (?, ?, ?, ?, ?)',
            [title, description, imageUrl, link, order_index || 0]
        );

        res.redirect('/admin/tools?success=Tool added successfully');
    } catch (error) {
        console.error('Error adding tool:', error);
        res.redirect('/admin/tools?error=Failed to add tool');
    }
});

router.get('/tools/edit/:id', async (req, res) => {
    try {
        const [tools] = await db.query('SELECT * FROM tools WHERE id = ?', [req.params.id]);

        if (tools.length === 0) {
            return res.redirect('/admin/tools?error=Tool not found');
        }

        res.render('admin/tool-form', {
            title: 'Edit Tool - Admin',
            tool: tools[0],
            mode: 'edit'
        });
    } catch (error) {
        console.error('Error fetching tool:', error);
        res.redirect('/admin/tools?error=Failed to load tool');
    }
});

router.post('/tools/edit/:id', async (req, res) => {
    const { title, description, link, order_index } = req.body;
    const toolId = req.params.id;

    try {
        const [currentTool] = await db.query('SELECT image_url FROM tools WHERE id = ?', [toolId]);

        let imageUrl = currentTool[0].image_url;

        if (req.files && req.files.image) {
            if (imageUrl) {
                const oldImagePath = path.join(__dirname, '..', 'public', imageUrl);
                try {
                    await fs.unlink(oldImagePath);
                } catch (err) {
                    console.log('Could not delete old image:', err);
                }
            }

            const image = req.files.image;
            const safeName = path.basename(image.name).replace(/[^a-zA-Z0-9._-]/g, '-');
            const fileName = Date.now() + '-' + safeName;
            const uploadPath = path.join(__dirname, '..', 'public', 'uploads', 'tools', fileName);

            await image.mv(uploadPath);
            imageUrl = '/uploads/tools/' + fileName;
        }

        await db.query(
            'UPDATE tools SET title = ?, description = ?, image_url = ?, link = ?, order_index = ? WHERE id = ?',
            [title, description, imageUrl, link, order_index || 0, toolId]
        );

        res.redirect('/admin/tools?success=Tool updated successfully');
    } catch (error) {
        console.error('Error updating tool:', error);
        res.redirect('/admin/tools?error=Failed to update tool');
    }
});

router.post('/tools/toggle/:id', async (req, res) => {
    try {
        await db.query('UPDATE tools SET is_visible = NOT is_visible WHERE id = ?', [req.params.id]);
        res.json({ success: true });
    } catch (error) {
        console.error('Error toggling tool:', error);
        res.json({ success: false, error: 'Failed to toggle visibility' });
    }
});

router.post('/tools/delete/:id', async (req, res) => {
    try {
        const [tools] = await db.query('SELECT image_url FROM tools WHERE id = ?', [req.params.id]);
        
        if (tools.length > 0 && tools[0].image_url) {
            const imagePath = path.join(__dirname, '..', 'public', tools[0].image_url);
            try {
                await fs.unlink(imagePath);
            } catch (err) {
                console.log('Could not delete image:', err);
            }
        }

        await db.query('DELETE FROM tools WHERE id = ?', [req.params.id]);
        res.redirect('/admin/tools?success=Tool deleted successfully');
    } catch (error) {
        console.error('Error deleting tool:', error);
        res.redirect('/admin/tools?error=Failed to delete tool');
    }
});

router.get('/gallery', async (req, res) => {
    try {
        const [folders] = await db.query('SELECT * FROM gallery_folders ORDER BY path ASC');
        const [recentImages] = await db.query(`
            SELECT gi.*, gf.name as folder_name, u.username
            FROM gallery_images gi
            JOIN gallery_folders gf ON gi.folder_id = gf.id
            JOIN users u ON gi.uploaded_by = u.id
            ORDER BY gi.uploaded_at DESC
            LIMIT 20
        `);

        res.render('admin/gallery', {
            title: 'Manage Gallery - Admin',
            folders: folders,
            recentImages: recentImages,
            success: req.query.success,
            error: req.query.error
        });
    } catch (error) {
        console.error('Error fetching gallery:', error);
        res.render('error', {
            title: 'Error Loading Gallery',
            message: 'Error Loading Gallery',
            description: 'Could not load gallery management.',
            user: res.locals.user
        });
    }
});

router.get('/gallery/add-folder', async (req, res) => {
    try {
        const [folders] = await db.query('SELECT * FROM gallery_folders ORDER BY path ASC');

        res.render('admin/folder-form', {
            title: 'Add Folder - Admin',
            folders: folders,
            folder: null,
            mode: 'add'
        });
    } catch (error) {
        console.error('Error loading form:', error);
        res.redirect('/admin/gallery?error=Failed to load form');
    }
});

router.post('/gallery/add-folder', async (req, res) => {
    const { name, parent_id } = req.body;

    try {
        let path = name;

        if (parent_id && parent_id !== '') {
            const [parent] = await db.query('SELECT path FROM gallery_folders WHERE id = ?', [parent_id]);
            if (parent.length > 0) {
                path = parent[0].path + '/' + name;
            }
        }

        await db.query(
            'INSERT INTO gallery_folders (name, parent_id, path) VALUES (?, ?, ?)',
            [name, parent_id || null, path]
        );

        res.redirect('/admin/gallery?success=Folder created successfully');
    } catch (error) {
        console.error('Error creating folder:', error);
        res.redirect('/admin/gallery?error=Failed to create folder');
    }
});

router.get('/gallery/upload', async (req, res) => {
    try {
        const [folders] = await db.query('SELECT * FROM gallery_folders ORDER BY path ASC');

        res.render('admin/upload-images', {
            title: 'Upload Images - Admin',
            folders: folders
        });
    } catch (error) {
        console.error('Error loading form:', error);
        res.redirect('/admin/gallery?error=Failed to load form');
    }
});

router.post('/gallery/upload', async (req, res) => {
    const { folder_id, captions } = req.body;

    if (!req.files || !req.files.images) {
        return res.redirect('/admin/gallery?error=No images uploaded');
    }

    try {
        const images = Array.isArray(req.files.images) ? req.files.images : [req.files.images];
        const captionArray = captions ? (Array.isArray(captions) ? captions : [captions]) : [];

        for (let i = 0; i < images.length; i++) {
            const image = images[i];
            const safeName = path.basename(image.name).replace(/[^a-zA-Z0-9._-]/g, '-');
            const fileName = Date.now() + '-' + i + '-' + safeName;
            const uploadPath = path.join(__dirname, '..', 'public', 'uploads', 'gallery', fileName);

            await image.mv(uploadPath);

            await db.query(
                'INSERT INTO gallery_images (folder_id, filename, original_name, caption, uploaded_by) VALUES (?, ?, ?, ?, ?)',
                [folder_id, fileName, path.basename(image.name), captionArray[i] || null, req.session.userId]
            );
        }

        res.redirect('/admin/gallery?success=Images uploaded successfully');
    } catch (error) {
        console.error('Error uploading images:', error);
        res.redirect('/admin/gallery?error=Failed to upload images');
    }
});

router.post('/gallery/delete-image/:id', async (req, res) => {
    try {
        const [images] = await db.query('SELECT filename FROM gallery_images WHERE id = ?', [req.params.id]);
        
        if (images.length > 0) {
            const imagePath = path.join(__dirname, '..', 'public', 'uploads', 'gallery', images[0].filename);
            try {
                await fs.unlink(imagePath);
            } catch (err) {
                console.log('Could not delete image file:', err);
            }
        }

        await db.query('DELETE FROM gallery_images WHERE id = ?', [req.params.id]);
        res.json({ success: true });
    } catch (error) {
        console.error('Error deleting image:', error);
        res.json({ success: false, error: 'Failed to delete image' });
    }
});

router.post('/gallery/delete-folder/:id', async (req, res) => {
    try {
        const [images] = await db.query(`
            SELECT gi.filename 
            FROM gallery_images gi
            JOIN gallery_folders gf ON gi.folder_id = gf.id
            WHERE gf.id = ? OR gf.path LIKE CONCAT((SELECT path FROM gallery_folders WHERE id = ?), '/%')
        `, [req.params.id, req.params.id]);

        for (const image of images) {
            const imagePath = path.join(__dirname, '..', 'public', 'uploads', 'gallery', image.filename);
            try {
                await fs.unlink(imagePath);
            } catch (err) {
                console.log('Could not delete image file:', err);
            }
        }

        // Database will cascade delete images and subfolders
        await db.query('DELETE FROM gallery_folders WHERE id = ?', [req.params.id]);
        
        res.redirect('/admin/gallery?success=Folder deleted successfully');
    } catch (error) {
        console.error('Error deleting folder:', error);
        res.redirect('/admin/gallery?error=Failed to delete folder');
    }
});

router.get('/users', async (req, res) => {
    try {
        const search = req.query.search || '';
        const page = parseInt(req.query.page) || 1;
        const limit = 50; // Users per page
        const offset = (page - 1) * limit;
        
        let whereClause = '';
        let params = [];
        
        if (search) {
            whereClause = `WHERE 
                username LIKE ? OR 
                discord_username LIKE ? OR 
                discord_global_name LIKE ?`;
            params = [`%${search}%`, `%${search}%`, `%${search}%`];
        }
        
        const [countResult] = await db.query(
            `SELECT COUNT(*) as total FROM users ${whereClause}`,
            params
        );
        const totalUsers = countResult[0].total;
        const totalPages = Math.ceil(totalUsers / limit);
        
        const [users] = await db.query(`
            SELECT 
                id, 
                username, 
                is_admin, 
                auth_type,
                discord_username,
                discord_global_name,
                discord_avatar,
                discord_id,
                created_at,
                last_login
            FROM users 
            ${whereClause}
            ORDER BY created_at DESC
            LIMIT ? OFFSET ?
        `, [...params, limit, offset]);

        res.render('admin/users', {
            title: 'Manage Users - Admin',
            users: users,
            search: search,
            currentPage: page,
            totalPages: totalPages,
            totalUsers: totalUsers,
            success: req.query.success,
            error: req.query.error
        });
    } catch (error) {
        console.error('Error fetching users:', error);
        res.render('error', {
            title: 'Error Loading Users',
            message: 'Error Loading Users',
            description: 'Could not load users management.',
            user: res.locals.user
        });
    }
});

router.post('/users/toggle-admin/:id', async (req, res) => {
    try {
        // Don't allow demoting yourself
        if (parseInt(req.params.id) === req.session.userId) {
            return res.json({ success: false, error: 'Cannot modify your own admin status' });
        }

        await db.query('UPDATE users SET is_admin = NOT is_admin WHERE id = ?', [req.params.id]);
        res.json({ success: true });
    } catch (error) {
        console.error('Error toggling admin:', error);
        res.json({ success: false, error: 'Failed to toggle admin status' });
    }
});

router.post('/users/delete/:id', async (req, res) => {
    try {
        // Don't allow deleting yourself
        if (parseInt(req.params.id) === req.session.userId) {
            return res.redirect('/admin/users?error=Cannot delete your own account');
        }

        await db.query('DELETE FROM users WHERE id = ?', [req.params.id]);
        res.redirect('/admin/users?success=User deleted successfully');
    } catch (error) {
        console.error('Error deleting user:', error);
        res.redirect('/admin/users?error=Failed to delete user');
    }
});

router.get('/medals', async (req, res) => {
    try {
        const [medals] = await db.query(`
            SELECT 
                m.*,
                u.username as created_by_username,
                COUNT(DISTINCT um.user_id) as awarded_count
            FROM medals m
            LEFT JOIN users u ON m.created_by = u.id
            LEFT JOIN user_medals um ON m.id = um.medal_id
            GROUP BY m.id
            ORDER BY m.created_at DESC
        `);

        res.render('admin/medals', {
            title: 'Manage Medals - Admin',
            medals: medals,
            success: req.query.success,
            error: req.query.error
        });
    } catch (error) {
        console.error('Error fetching medals:', error);
        res.render('error', {
            title: 'Error Loading Medals',
            message: 'Error Loading Medals',
            description: 'Could not load medals management.',
            user: res.locals.user
        });
    }
});

router.get('/medals/add', (req, res) => {
    res.render('admin/medal-form', {
        title: 'Add Medal - Admin',
        medal: null,
        action: 'add'
    });
});

router.post('/medals/add', async (req, res) => {
    try {
        const { name, description, color, icon } = req.body;

        await db.query(
            'INSERT INTO medals (name, description, color, icon, created_by) VALUES (?, ?, ?, ?, ?)',
            [name, description, color || '#FFD700', icon || '🏅', req.session.userId]
        );

        res.redirect('/admin/medals?success=Medal created successfully');
    } catch (error) {
        console.error('Error creating medal:', error);
        res.redirect('/admin/medals?error=Failed to create medal');
    }
});

router.get('/medals/edit/:id', async (req, res) => {
    try {
        const [medals] = await db.query('SELECT * FROM medals WHERE id = ?', [req.params.id]);
        
        if (medals.length === 0) {
            return res.redirect('/admin/medals?error=Medal not found');
        }

        res.render('admin/medal-form', {
            title: 'Edit Medal - Admin',
            medal: medals[0],
            action: 'edit'
        });
    } catch (error) {
        console.error('Error loading medal:', error);
        res.redirect('/admin/medals?error=Failed to load medal');
    }
});

router.post('/medals/edit/:id', async (req, res) => {
    try {
        const { name, description, color, icon } = req.body;

        await db.query(
            'UPDATE medals SET name = ?, description = ?, color = ?, icon = ? WHERE id = ?',
            [name, description, color, icon, req.params.id]
        );

        res.redirect('/admin/medals?success=Medal updated successfully');
    } catch (error) {
        console.error('Error updating medal:', error);
        res.redirect('/admin/medals?error=Failed to update medal');
    }
});

router.post('/medals/delete/:id', async (req, res) => {
    try {
        await db.query('DELETE FROM medals WHERE id = ?', [req.params.id]);
        res.redirect('/admin/medals?success=Medal deleted successfully');
    } catch (error) {
        console.error('Error deleting medal:', error);
        res.redirect('/admin/medals?error=Failed to delete medal');
    }
});

router.get('/users/:userId/medals', async (req, res) => {
    try {
        const [users] = await db.query('SELECT * FROM users WHERE id = ?', [req.params.userId]);

        if (users.length === 0) {
            return res.redirect('/admin/users?error=User not found');
        }

        const user = users[0];

        const [allMedals] = await db.query('SELECT * FROM medals ORDER BY name ASC');

        const [userMedals] = await db.query(`
            SELECT 
                m.*,
                um.id as award_id,
                um.awarded_at,
                um.notes,
                u.username as awarded_by_username
            FROM user_medals um
            JOIN medals m ON um.medal_id = m.id
            JOIN users u ON um.awarded_by = u.id
            WHERE um.user_id = ?
            ORDER BY um.awarded_at DESC
        `, [req.params.userId]);
        
        const userMedalIds = userMedals.map(m => m.id);
        const availableMedals = allMedals.filter(m => !userMedalIds.includes(m.id));
        
        res.render('admin/user-medals', {
            title: `Manage Medals - ${user.username}`,
            user: user,
            userMedals: userMedals,
            availableMedals: availableMedals,
            success: req.query.success,
            error: req.query.error
        });
    } catch (error) {
        console.error('Error loading user medals:', error);
        res.redirect('/admin/users?error=Failed to load user medals');
    }
});

router.post('/users/:userId/medals/award', async (req, res) => {
    try {
        const { medalId, notes } = req.body;
        
        await db.query(
            'INSERT INTO user_medals (user_id, medal_id, awarded_by, notes) VALUES (?, ?, ?, ?)',
            [req.params.userId, medalId, req.session.userId, notes || null]
        );
        
        res.redirect(`/admin/users/${req.params.userId}/medals?success=Medal awarded successfully`);
    } catch (error) {
        console.error('Error awarding medal:', error);
        res.redirect(`/admin/users/${req.params.userId}/medals?error=Failed to award medal`);
    }
});

router.post('/users/:userId/medals/revoke/:awardId', async (req, res) => {
    try {
        await db.query('DELETE FROM user_medals WHERE id = ?', [req.params.awardId]);
        res.redirect(`/admin/users/${req.params.userId}/medals?success=Medal revoked successfully`);
    } catch (error) {
        console.error('Error revoking medal:', error);
        res.redirect(`/admin/users/${req.params.userId}/medals?error=Failed to revoke medal`);
    }
});

router.get('/trainings', async (req, res) => {
    try {
        const [trainings] = await db.query(`
            SELECT 
                t.*,
                u.username as created_by_username,
                COUNT(DISTINCT ut.user_id) as assigned_count
            FROM trainings t
            LEFT JOIN users u ON t.created_by = u.id
            LEFT JOIN user_trainings ut ON t.id = ut.training_id
            GROUP BY t.id
            ORDER BY t.display_order ASC, t.name ASC
        `);

        res.render('admin/trainings', {
            title: 'Manage Trainings - Admin',
            trainings: trainings,
            success: req.query.success,
            error: req.query.error
        });
    } catch (error) {
        console.error('Error fetching trainings:', error);
        res.render('error', {
            title: 'Error Loading Trainings',
            message: 'Error Loading Trainings',
            description: 'Could not load trainings management.',
            user: res.locals.user
        });
    }
});

router.get('/trainings/add', (req, res) => {
    res.render('admin/training-form', {
        title: 'Add Training - Admin',
        training: null,
        action: 'add'
    });
});

router.post('/trainings/add', async (req, res) => {
    try {
        const { name, discord_role_id, description, color, image_url, display_order } = req.body;
        let finalImageUrl = image_url || '/images/badges/default-training.png';

        if (req.files && req.files.badge_upload) {
            const badgeFile = req.files.badge_upload;

            const fileExt = path.extname(badgeFile.name).replace(/[^a-z0-9.]/gi, '');
            const baseName = path.basename(badgeFile.name, path.extname(badgeFile.name))
                .toLowerCase()
                .replace(/[^a-z0-9.-]/g, '-');
            const fileName = baseName + fileExt;

            const uploadPath = path.join(__dirname, '../public/images/badges/', fileName);

            await badgeFile.mv(uploadPath);

            finalImageUrl = '/images/badges/' + fileName;
        }

        await db.query(
            'INSERT INTO trainings (name, discord_role_id, description, color, image_url, display_order, created_by) VALUES (?, ?, ?, ?, ?, ?, ?)',
            [name, discord_role_id, description || null, color || '#3498DB', finalImageUrl, display_order || 0, req.session.userId]
        );

        res.redirect('/admin/trainings?success=Training created successfully');
    } catch (error) {
        console.error('Error creating training:', error);
        if (error.code === 'ER_DUP_ENTRY') {
            res.redirect('/admin/trainings?error=Discord Role ID already exists');
        } else {
            res.redirect('/admin/trainings?error=Failed to create training');
        }
    }
});

router.get('/trainings/edit/:id', async (req, res) => {
    try {
        const [trainings] = await db.query('SELECT * FROM trainings WHERE id = ?', [req.params.id]);
        
        if (trainings.length === 0) {
            return res.redirect('/admin/trainings?error=Training not found');
        }

        res.render('admin/training-form', {
            title: 'Edit Training - Admin',
            training: trainings[0],
            action: 'edit'
        });
    } catch (error) {
        console.error('Error loading training:', error);
        res.redirect('/admin/trainings?error=Failed to load training');
    }
});

router.post('/trainings/edit/:id', async (req, res) => {
    try {
        const { name, discord_role_id, description, color, image_url, display_order } = req.body;
        let finalImageUrl = image_url;

        if (req.files && req.files.badge_upload) {
            const badgeFile = req.files.badge_upload;

            const fileExt = path.extname(badgeFile.name).replace(/[^a-z0-9.]/gi, '');
            const baseName = path.basename(badgeFile.name, path.extname(badgeFile.name))
                .toLowerCase()
                .replace(/[^a-z0-9.-]/g, '-');
            const fileName = baseName + fileExt;

            const uploadPath = path.join(__dirname, '../public/images/badges/', fileName);

            await badgeFile.mv(uploadPath);

            finalImageUrl = '/images/badges/' + fileName;
        }

        await db.query(
            'UPDATE trainings SET name = ?, discord_role_id = ?, description = ?, color = ?, image_url = ?, display_order = ? WHERE id = ?',
            [name, discord_role_id, description || null, color, finalImageUrl, display_order || 0, req.params.id]
        );

        res.redirect('/admin/trainings?success=Training updated successfully');
    } catch (error) {
        console.error('Error updating training:', error);
        if (error.code === 'ER_DUP_ENTRY') {
            res.redirect('/admin/trainings?error=Discord Role ID already exists');
        } else {
            res.redirect('/admin/trainings?error=Failed to update training');
        }
    }
});

router.post('/trainings/delete/:id', async (req, res) => {
    try {
        await db.query('DELETE FROM trainings WHERE id = ?', [req.params.id]);
        res.redirect('/admin/trainings?success=Training deleted successfully');
    } catch (error) {
        console.error('Error deleting training:', error);
        res.redirect('/admin/trainings?error=Failed to delete training');
    }
});

router.post('/users/:userId/sync-trainings', async (req, res) => {
    try {
        const userId = req.params.userId;

        const [users] = await db.query('SELECT discord_id FROM users WHERE id = ?', [userId]);
        
        if (users.length === 0 || !users[0].discord_id) {
            return res.json({ success: false, error: 'User not found or not a Discord user' });
        }
        
        const discordId = users[0].discord_id;
        const botToken = process.env.DISCORD_BOT_TOKEN;
        const guildId = '1172956513069973596';
        
        if (!botToken) {
            return res.json({ success: false, error: 'Bot token not configured' });
        }
        
        const axios = require('axios');
        const response = await axios.get(
            `https://discord.com/api/v10/guilds/${guildId}/members/${discordId}`,
            {
                headers: {
                    Authorization: `Bot ${botToken}`
                }
            }
        );
        
        const userRoles = response.data.roles || [];
        
        const [trainings] = await db.query('SELECT id, discord_role_id FROM trainings');

        await db.query('DELETE FROM user_trainings WHERE user_id = ?', [userId]);

        let assignedCount = 0;
        for (const training of trainings) {
            if (userRoles.includes(training.discord_role_id)) {
                await db.query(
                    'INSERT INTO user_trainings (user_id, training_id) VALUES (?, ?)',
                    [userId, training.id]
                );
                assignedCount++;
            }
        }
        
        res.json({ 
            success: true, 
            message: `Synced ${assignedCount} training(s)`,
            count: assignedCount
        });
    } catch (error) {
        console.error('Error syncing trainings:', error);
        res.json({ success: false, error: error.message || 'Failed to sync trainings' });
    }
});

router.get('/users/:userId/trainings', async (req, res) => {
    try {
        const [users] = await db.query('SELECT * FROM users WHERE id = ?', [req.params.userId]);

        if (users.length === 0) {
            return res.redirect('/admin/users?error=User not found');
        }

        const user = users[0];

        const [userTrainings] = await db.query(`
            SELECT 
                t.*,
                ut.synced_at,
                ut.last_verified
            FROM user_trainings ut
            JOIN trainings t ON ut.training_id = t.id
            WHERE ut.user_id = ?
            ORDER BY t.display_order ASC, t.name ASC
        `, [req.params.userId]);

        const [allTrainings] = await db.query('SELECT * FROM trainings ORDER BY display_order ASC, name ASC');
        
        res.render('admin/user-trainings', {
            title: `Trainings - ${user.username}`,
            user: user,
            userTrainings: userTrainings,
            allTrainings: allTrainings,
            success: req.query.success,
            error: req.query.error
        });
    } catch (error) {
        console.error('Error loading user trainings:', error);
        res.redirect('/admin/users?error=Failed to load user trainings');
    }
});

module.exports = router;