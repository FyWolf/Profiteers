const express = require('express');
const router  = express.Router();
const db      = require('../config/database');
const path    = require('path');
const fs      = require('fs');
const { hasPermission } = require('../middleware/auth');
const loreAdmin = hasPermission('lore.manage');

const UPLOAD_DIR = path.join(__dirname, '..', 'public', 'uploads', 'lore');

function uniqueName(original) {
    const ext = path.extname(original).toLowerCase();
    return `${Date.now()}-${Math.random().toString(36).slice(2)}${ext}`;
}

router.get('/', async (req, res) => {
    try {
        const [nodes] = await db.query(
            `SELECT id, parent_id, type, slug, title, hint, content, display_order, visibility
               FROM lore_nodes
              WHERE visibility != 'draft'
              ORDER BY display_order ASC, id ASC`
        );
        res.render('lore/terminal', {
            title: 'Lore Terminal — Profiteers PMC',
            nodes: JSON.stringify(nodes),
        });
    } catch (err) {
        console.error('Lore terminal error:', err);
        res.status(500).render('error', {
            title: 'Error', message: 'Failed to load lore terminal.',
            description: err.message, user: res.locals.user,
        });
    }
});

router.get('/admin', loreAdmin, async (req, res) => {
    try {
        const [nodes] = await db.query(
            `SELECT id, parent_id, type, slug, title, hint, content, display_order, visibility
               FROM lore_nodes
              ORDER BY display_order ASC, id ASC`
        );
        res.render('lore/admin', {
            title: 'Lore Admin — Profiteers PMC',
            nodesJson: JSON.stringify(nodes),
        });
    } catch (err) {
        console.error('Lore admin error:', err);
        res.status(500).render('error', {
            title: 'Error', message: 'Failed to load lore admin.',
            description: err.message, user: res.locals.user,
        });
    }
});

router.get('/api/find', async (req, res) => {
    const { slug, parent_id } = req.query;
    if (!slug) return res.status(400).json({ error: 'slug required' });
    try {
        const byParent  = parent_id !== undefined;
        const condition = byParent ? 'parent_id = ?' : 'parent_id IS NULL';
        const params    = byParent ? [slug, Number(parent_id)] : [slug];
        const [rows] = await db.query(
            `SELECT id, parent_id, type, slug, title, hint, content, display_order, visibility
               FROM lore_nodes
              WHERE slug = ? AND ${condition} AND visibility != 'draft'`,
            params
        );
        if (!rows.length) return res.status(404).json({ error: 'not found' });
        const [files] = await db.query(
            'SELECT id, stored_name, original_name, mimetype, size FROM lore_files WHERE node_id = ? ORDER BY uploaded_at ASC',
            [rows[0].id]
        );
        res.json({ node: { ...rows[0], files } });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Internal server error' });
    }
});

router.get('/api/nodes/:id/files', async (req, res) => {
    try {
        const [files] = await db.query(
            'SELECT id, stored_name, original_name, mimetype, size FROM lore_files WHERE node_id = ? ORDER BY uploaded_at ASC',
            [req.params.id]
        );
        res.json({ files });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Internal server error' });
    }
});

router.post('/api/nodes/:id/files', loreAdmin, async (req, res) => {
    try {
        if (!req.files || !req.files.file) {
            return res.status(400).json({ error: 'No file uploaded' });
        }
        const file     = req.files.file;
        const stored   = uniqueName(file.name);
        const destPath = path.join(UPLOAD_DIR, stored);

        await file.mv(destPath);

        const [result] = await db.query(
            'INSERT INTO lore_files (node_id, stored_name, original_name, mimetype, size, uploaded_by) VALUES (?, ?, ?, ?, ?, ?)',
            [req.params.id, stored, file.name, file.mimetype, file.size, req.user.id]
        );
        const [rows] = await db.query('SELECT * FROM lore_files WHERE id = ?', [result.insertId]);
        res.json({ success: true, file: rows[0] });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Internal server error' });
    }
});

router.delete('/api/files/:id', loreAdmin, async (req, res) => {
    try {
        const [rows] = await db.query('SELECT stored_name FROM lore_files WHERE id = ?', [req.params.id]);
        if (!rows.length) return res.status(404).json({ error: 'File not found' });

        const filePath = path.join(UPLOAD_DIR, rows[0].stored_name);
        if (fs.existsSync(filePath)) fs.unlinkSync(filePath);

        await db.query('DELETE FROM lore_files WHERE id = ?', [req.params.id]);
        res.json({ success: true });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Internal server error' });
    }
});

router.post('/api/nodes', loreAdmin, async (req, res) => {
    try {
        const { parent_id, type, slug, title, hint, content, display_order } = req.body;
        if (!slug || !title || !type) return res.status(400).json({ error: 'slug, title and type are required' });
        const cleanSlug = slug.toLowerCase().replace(/[^a-z0-9_-]/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '');
        const [result] = await db.query(
            `INSERT INTO lore_nodes (parent_id, type, slug, title, hint, content, display_order, created_by)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
            [parent_id || null, type, cleanSlug, title, hint || null, content || null, display_order ?? 0, req.user.id]
        );
        const [rows] = await db.query('SELECT * FROM lore_nodes WHERE id = ?', [result.insertId]);
        res.json({ success: true, node: rows[0] });
    } catch (err) {
        if (err.code === 'ER_DUP_ENTRY') return res.status(409).json({ error: 'A node with that slug already exists in this directory.' });
        console.error(err);
        res.status(500).json({ error: 'Internal server error' });
    }
});

router.patch('/api/nodes/:id', loreAdmin, async (req, res) => {
    try {
        const { slug, title, hint, content, display_order, parent_id, type, visibility } = req.body;
        const fields = [];
        const vals   = [];
        if (slug  !== undefined) { fields.push('slug = ?');  vals.push(slug.toLowerCase().replace(/[^a-z0-9_-]/g, '-').replace(/-+/g,'-').replace(/^-|-$/g,'')); }
        if (title !== undefined) { fields.push('title = ?'); vals.push(title); }
        if (hint  !== undefined) { fields.push('hint = ?');  vals.push(hint || null); }
        if (content !== undefined)       { fields.push('content = ?');       vals.push(content || null); }
        if (display_order !== undefined) { fields.push('display_order = ?'); vals.push(Number(display_order)); }
        if (parent_id !== undefined)     { fields.push('parent_id = ?');     vals.push(parent_id || null); }
        if (type !== undefined)          { fields.push('type = ?');          vals.push(type); }
        if (visibility !== undefined) {
            const allowed = ['visible', 'hidden', 'draft'];
            if (!allowed.includes(visibility)) return res.status(400).json({ error: 'Invalid visibility value' });
            fields.push('visibility = ?');
            vals.push(visibility);
        }
        if (!fields.length) return res.status(400).json({ error: 'Nothing to update' });
        vals.push(req.params.id);
        await db.query(`UPDATE lore_nodes SET ${fields.join(', ')} WHERE id = ?`, vals);
        const [rows] = await db.query('SELECT * FROM lore_nodes WHERE id = ?', [req.params.id]);
        res.json({ success: true, node: rows[0] });
    } catch (err) {
        if (err.code === 'ER_DUP_ENTRY') return res.status(409).json({ error: 'A node with that slug already exists in this directory.' });
        console.error(err);
        res.status(500).json({ error: 'Internal server error' });
    }
});

router.delete('/api/nodes/:id', loreAdmin, async (req, res) => {
    try {
        const [files] = await db.query('SELECT stored_name FROM lore_files WHERE node_id = ?', [req.params.id]);
        for (const f of files) {
            const p = path.join(UPLOAD_DIR, f.stored_name);
            if (fs.existsSync(p)) fs.unlinkSync(p);
        }
        await db.query('DELETE FROM lore_nodes WHERE id = ?', [req.params.id]);
        res.json({ success: true });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Internal server error' });
    }
});

module.exports = router;
