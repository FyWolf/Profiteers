const express = require('express');
const router = express.Router();
const path = require('path');
const fs = require('fs').promises;
const db = require('../../config/database');

const ALLOWED_IMAGE_EXTS = new Set(['.jpg', '.jpeg', '.png', '.gif', '.webp']);

function isAllowedImageExt(filename) {
    const ext = path.extname(filename).toLowerCase();
    return ALLOWED_IMAGE_EXTS.has(ext);
}

router.get('/', async (req, res) => {
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

router.get('/add-folder', async (req, res) => {
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

router.post('/add-folder', async (req, res) => {
    const { name, parent_id } = req.body;

    if (!name || /[/\\.]/.test(name)) {
        return res.redirect('/admin/gallery?error=Folder name must not contain / \\ or . characters');
    }

    try {
        let folderPath = name;

        if (parent_id && parent_id !== '') {
            const [parent] = await db.query('SELECT path FROM gallery_folders WHERE id = ?', [parent_id]);
            if (parent.length > 0) {
                folderPath = parent[0].path + '/' + name;
            }
        }

        await db.query(
            'INSERT INTO gallery_folders (name, parent_id, path) VALUES (?, ?, ?)',
            [name, parent_id || null, folderPath]
        );

        res.redirect('/admin/gallery?success=Folder created successfully');
    } catch (error) {
        console.error('Error creating folder:', error);
        res.redirect('/admin/gallery?error=Failed to create folder');
    }
});

router.get('/upload', async (req, res) => {
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

router.post('/upload', async (req, res) => {
    const { folder_id, captions } = req.body;

    if (!req.files || !req.files.images) {
        return res.redirect('/admin/gallery?error=No images uploaded');
    }

    try {
        const images = Array.isArray(req.files.images) ? req.files.images : [req.files.images];
        const captionArray = captions ? (Array.isArray(captions) ? captions : [captions]) : [];

        for (let i = 0; i < images.length; i++) {
            const image = images[i];
            const rawName = path.basename(image.name);

            if (!isAllowedImageExt(rawName)) {
                return res.redirect('/admin/gallery?error=Only image files are allowed (.jpg, .jpeg, .png, .gif, .webp)');
            }

            const ext = path.extname(rawName).toLowerCase();
            const base = path.basename(rawName, path.extname(rawName)).replace(/[^a-zA-Z0-9_-]/g, '-');
            const fileName = Date.now() + '-' + i + '-' + base + ext;
            const uploadPath = path.join(__dirname, '..', '..', 'public', 'uploads', 'gallery', fileName);

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

router.post('/delete-image/:id', async (req, res) => {
    try {
        const [images] = await db.query('SELECT filename FROM gallery_images WHERE id = ?', [req.params.id]);

        if (images.length > 0) {
            const imagePath = path.join(__dirname, '..', '..', 'public', 'uploads', 'gallery', images[0].filename);
            try {
                await fs.unlink(imagePath);
            } catch (err) {
            }
        }

        await db.query('DELETE FROM gallery_images WHERE id = ?', [req.params.id]);
        res.json({ success: true });
    } catch (error) {
        console.error('Error deleting image:', error);
        res.json({ success: false, error: 'Failed to delete image' });
    }
});

router.post('/delete-folder/:id', async (req, res) => {
    try {
        const [images] = await db.query(`
            SELECT gi.filename
            FROM gallery_images gi
            JOIN gallery_folders gf ON gi.folder_id = gf.id
            WHERE gf.id = ? OR gf.path LIKE CONCAT((SELECT path FROM gallery_folders WHERE id = ?), '/%')
        `, [req.params.id, req.params.id]);

        for (const image of images) {
            const imagePath = path.join(__dirname, '..', '..', 'public', 'uploads', 'gallery', image.filename);
            try {
                await fs.unlink(imagePath);
            } catch (err) {
            }
        }

        await db.query('DELETE FROM gallery_folders WHERE id = ?', [req.params.id]);

        res.redirect('/admin/gallery?success=Folder deleted successfully');
    } catch (error) {
        console.error('Error deleting folder:', error);
        res.redirect('/admin/gallery?error=Failed to delete folder');
    }
});

module.exports = router;
