const express = require('express');
const router = express.Router();
const db = require('../config/database');

// Gallery main page - show all images
router.get('/', async (req, res) => {
    try {
        const [images] = await db.query(`
            SELECT gi.*, gf.name as folder_name, gf.path as folder_path, u.username
            FROM gallery_images gi
            JOIN gallery_folders gf ON gi.folder_id = gf.id
            JOIN users u ON gi.uploaded_by = u.id
            ORDER BY gi.uploaded_at DESC
        `);

        const [folders] = await db.query('SELECT * FROM gallery_folders ORDER BY path ASC');

        res.render('gallery', {
            title: 'Gallery - Profiteers PMC',
            images: images,
            folders: folders,
            currentFolder: null,
            viewMode: 'all'
        });
    } catch (error) {
        console.error('Error fetching gallery:', error);
        res.render('error', {
            title: 'Error Loading Gallery',
            message: 'Error Loading Gallery',
            description: 'Could not load the gallery.',
            user: res.locals.user
        });
    }
});

// Gallery folder view
router.get('/folder/:id', async (req, res) => {
    const folderId = req.params.id;

    try {
        // Get current folder
        const [folders] = await db.query('SELECT * FROM gallery_folders WHERE id = ?', [folderId]);
        
        if (folders.length === 0) {
            return res.redirect('/gallery');
        }

        const currentFolder = folders[0];

        // Get all folders for sidebar
        const [allFolders] = await db.query('SELECT * FROM gallery_folders ORDER BY path ASC');

        // Get subfolders
        const [subfolders] = await db.query(
            'SELECT * FROM gallery_folders WHERE parent_id = ? ORDER BY name ASC',
            [folderId]
        );

        // Get images in this folder
        const [images] = await db.query(`
            SELECT gi.*, u.username
            FROM gallery_images gi
            JOIN users u ON gi.uploaded_by = u.id
            WHERE gi.folder_id = ?
            ORDER BY gi.uploaded_at DESC
        `, [folderId]);

        res.render('gallery', {
            title: `${currentFolder.name} - Gallery - Profiteers PMC`,
            images: images,
            folders: allFolders,
            currentFolder: currentFolder,
            subfolders: subfolders,
            viewMode: 'folder'
        });
    } catch (error) {
        console.error('Error fetching folder:', error);
        res.render('error', {
            title: 'Error Loading Folder',
            message: 'Error Loading Folder',
            description: 'Could not load the gallery folder.',
            user: res.locals.user
        });
    }
});

module.exports = router;
