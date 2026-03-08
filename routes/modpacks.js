/**
 * Modpack Routes
 * 
 * Handles modpack management: listing, viewing, uploading, downloading, and deletion.
 * Parses Arma 3 Launcher HTML preset files to extract mod info.
 * Triggers background Steam API indexing after upload.
 */

const express = require('express');
const router = express.Router();
const path = require('path');
const fs = require('fs');
const db = require('../config/database');
const ModpackIndexer = require('../services/modpack-indexer');

const indexer = new ModpackIndexer(db);

function isAuthenticated(req, res, next) {
    if (req.session && req.session.userId) {
        return next();
    }
    res.redirect('/auth/login');
}

function isZeus(req, res, next) {
    if (req.session && req.session.userId) {
        if (res.locals.user && (res.locals.user.isAdmin || res.locals.user.isZeus)) {
            return next();
        }
    }
    res.status(403).render('error', {
        title: 'Access Denied',
        message: 'You need Zeus or Admin permissions to access this page.'
    });
}

/**
 * Parse an Arma 3 Launcher HTML preset file and extract mod information.
 * @param {string} htmlContent - The raw HTML content of the preset file
 * @returns {Object} { name: string, mods: Array<{displayName, workshopId, steamUrl}> }
 */
function parseArmaPreset(htmlContent) {
    const mods = [];
    let presetName = 'Unnamed Modpack';

    const nameMatch = htmlContent.match(/<meta\s+name="arma:PresetName"\s+content="([^"]+)"/i);
    if (nameMatch) {
        presetName = nameMatch[1];
    }

    // Pattern: <tr data-type="ModContainer"> ... <td data-type="DisplayName">NAME</td> ... <a href="URL" data-type="Link">
    const modRegex = /<tr[^>]*data-type="ModContainer"[^>]*>[\s\S]*?<td[^>]*data-type="DisplayName"[^>]*>([\s\S]*?)<\/td>[\s\S]*?<a\s+href="([^"]+)"[^>]*data-type="Link"/gi;

    let match;
    while ((match = modRegex.exec(htmlContent)) !== null) {
        const displayName = match[1].trim().replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>');
        const steamUrl = match[2].trim();

        const idMatch = steamUrl.match(/[?&]id=(\d+)/);
        if (idMatch) {
            mods.push({
                displayName,
                workshopId: parseInt(idMatch[1]),
                steamUrl
            });
        }
    }

    return { name: presetName, mods };
}

function formatSize(bytes) {
    if (!bytes || bytes === 0) return '—';
    const units = ['B', 'KB', 'MB', 'GB', 'TB'];
    const i = Math.floor(Math.log(bytes) / Math.log(1024));
    return (bytes / Math.pow(1024, i)).toFixed(2) + ' ' + units[i];
}

router.get('/', async (req, res) => {
    try {
        const [modpacks] = await db.query(`
            SELECT m.*, COALESCE(u.discord_global_name, u.username) as creator_name
            FROM modpacks m
            LEFT JOIN users u ON m.created_by = u.id
            ORDER BY m.created_at DESC
        `);

        res.render('modpacks/list', {
            title: 'Modpacks - Profiteers PMC',
            modpacks,
            formatSize,
            success: req.query.success || null,
            error: req.query.error || null
        });
    } catch (error) {
        console.error('Error loading modpacks:', error);
        res.render('error', { title: 'Error', message: 'Failed to load modpacks.' });
    }
});

router.get('/:id', async (req, res) => {
    try {
        const [modpacks] = await db.query(`
            SELECT m.*, COALESCE(u.discord_global_name, u.username) as creator_name
            FROM modpacks m
            LEFT JOIN users u ON m.created_by = u.id
            WHERE m.id = ?
        `, [req.params.id]);

        if (modpacks.length === 0) {
            return res.render('error', { title: 'Not Found', message: 'Modpack not found.' });
        }

        const modpack = modpacks[0];

        const [mods] = await db.query(`
            SELECT * FROM modpack_mods 
            WHERE modpack_id = ? 
            ORDER BY COALESCE(steam_name, display_name) ASC
        `, [req.params.id]);

        const indexedCount = mods.filter(m => m.is_indexed).length;
        const totalSize = mods.reduce((sum, m) => sum + (parseInt(m.file_size) || 0), 0);

        res.render('modpacks/view', {
            title: `${modpack.name} - Modpacks - Profiteers PMC`,
            modpack,
            mods,
            indexedCount,
            totalSize,
            formatSize
        });
    } catch (error) {
        console.error('Error loading modpack:', error);
        res.render('error', { title: 'Error', message: 'Failed to load modpack.' });
    }
});

router.get('/:id/download', async (req, res) => {
    try {
        const [modpacks] = await db.query('SELECT name, file_path FROM modpacks WHERE id = ?', [req.params.id]);
        
        if (modpacks.length === 0) {
            return res.status(404).send('Modpack not found');
        }

        const modpack = modpacks[0];
        const filePath = path.join(__dirname, '..', modpack.file_path);
        
        if (!fs.existsSync(filePath)) {
            return res.status(404).send('Modpack file not found on server');
        }

        const safeName = modpack.name.replace(/[^a-zA-Z0-9_-]/g, '_');
        res.download(filePath, `Arma_3_Preset_${safeName}.html`);
    } catch (error) {
        console.error('Error downloading modpack:', error);
        res.status(500).send('Failed to download modpack');
    }
});

router.get('/:id/status', async (req, res) => {
    try {
        const [modpacks] = await db.query(
            'SELECT index_status, index_progress, mod_count, total_size, index_error FROM modpacks WHERE id = ?',
            [req.params.id]
        );

        if (modpacks.length === 0) {
            return res.json({ error: 'Not found' });
        }

        res.json({
            status: modpacks[0].index_status,
            progress: modpacks[0].index_progress,
            total: modpacks[0].mod_count,
            totalSize: modpacks[0].total_size,
            totalSizeFormatted: formatSize(modpacks[0].total_size),
            error: modpacks[0].index_error
        });
    } catch (error) {
        res.json({ error: 'Failed to get status' });
    }
});

router.get('/upload/new', isZeus, async (req, res) => {
    res.render('modpacks/upload', {
        title: 'Upload Modpack - Profiteers PMC'
    });
});

router.post('/upload', isZeus, async (req, res) => {
    try {
        if (!req.files || !req.files.modpack_file) {
            return res.redirect('/modpacks/upload/new?error=Please select an HTML preset file');
        }

        const file = req.files.modpack_file;

        if (!file.name.endsWith('.html') && !file.name.endsWith('.htm')) {
            return res.redirect('/modpacks/upload/new?error=Only .html Arma 3 preset files are supported');
        }

        const htmlContent = file.data.toString('utf8');
        const parsed = parseArmaPreset(htmlContent);

        if (parsed.mods.length === 0) {
            return res.redirect('/modpacks/upload/new?error=No mods found in the preset file. Make sure it is a valid Arma 3 Launcher preset.');
        }

        const modpackName = req.body.name && req.body.name.trim() ? req.body.name.trim() : parsed.name;
        const description = req.body.description ? req.body.description.trim() : null;

        const timestamp = Date.now();
        const safeName = modpackName.replace(/[^a-zA-Z0-9_-]/g, '_');
        const fileName = `${safeName}_${timestamp}.html`;
        const uploadDir = path.join(__dirname, '../public/uploads/modpacks');

        if (!fs.existsSync(uploadDir)) {
            fs.mkdirSync(uploadDir, { recursive: true });
        }

        const filePath = path.join(uploadDir, fileName);
        await file.mv(filePath);

        const relativeFilePath = `/public/uploads/modpacks/${fileName}`;

        const [result] = await db.query(
            `INSERT INTO modpacks (name, description, file_path, created_by, mod_count, index_status) VALUES (?, ?, ?, ?, ?, 'pending')`,
            [modpackName, description, relativeFilePath, req.session.userId, parsed.mods.length]
        );

        const modpackId = result.insertId;

        for (const mod of parsed.mods) {
            await db.query(
                `INSERT INTO modpack_mods (modpack_id, workshop_id, display_name, steam_url) VALUES (?, ?, ?, ?)`,
                [modpackId, mod.workshopId, mod.displayName, mod.steamUrl]
            );
        }

        console.log(`[Modpacks] Uploaded "${modpackName}" with ${parsed.mods.length} mods. Starting background indexing...`);

        // Start background indexing (non-blocking)
        indexer.startIndexing(modpackId).catch(err => {
            console.error('[Modpacks] Background indexing error:', err);
        });

        res.redirect(`/modpacks/${modpackId}?success=Modpack uploaded! Steam data is being fetched in the background.`);

    } catch (error) {
        console.error('Error uploading modpack:', error);
        res.redirect('/modpacks/upload/new?error=Failed to upload modpack');
    }
});

router.post('/:id/reindex', isZeus, async (req, res) => {
    try {
        const [modpacks] = await db.query('SELECT id, name FROM modpacks WHERE id = ?', [req.params.id]);
        
        if (modpacks.length === 0) {
            return res.redirect('/modpacks?error=Modpack not found');
        }

        console.log(`[Modpacks] Re-indexing "${modpacks[0].name}"...`);

        indexer.reindex(req.params.id).catch(err => {
            console.error('[Modpacks] Re-index error:', err);
        });

        res.redirect(`/modpacks/${req.params.id}?success=Re-indexing started. Refresh the page to see progress.`);

    } catch (error) {
        console.error('Error starting reindex:', error);
        res.redirect(`/modpacks/${req.params.id}?error=Failed to start re-indexing`);
    }
});

router.post('/:id/delete', isZeus, async (req, res) => {
    try {
        const [modpacks] = await db.query('SELECT file_path FROM modpacks WHERE id = ?', [req.params.id]);
        
        if (modpacks.length === 0) {
            return res.redirect('/modpacks?error=Modpack not found');
        }

        const filePath = path.join(__dirname, '..', modpacks[0].file_path);
        if (fs.existsSync(filePath)) {
            fs.unlinkSync(filePath);
        }

        // Delete from database (CASCADE will remove modpack_mods)
        await db.query('DELETE FROM modpacks WHERE id = ?', [req.params.id]);

        res.redirect('/modpacks?success=Modpack deleted');
    } catch (error) {
        console.error('Error deleting modpack:', error);
        res.redirect('/modpacks?error=Failed to delete modpack');
    }
});

module.exports = router;
