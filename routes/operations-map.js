const express = require('express');
const router = express.Router({ mergeParams: true });
const fs = require('fs').promises;
const path = require('path');
const db = require('../config/database');
const { isAuthenticated } = require('../middleware/auth');
const { checkZeusStatus } = require('../middleware/zeus');

router.get('/maps', async (req, res) => {
    try {
        const mapsDir = path.join(__dirname, '..', 'public', 'images', 'maps');
        let entries;
        try {
            entries = await fs.readdir(mapsDir, { withFileTypes: true });
        } catch {
            return res.json({ success: true, maps: [] });
        }

        const dirs = entries.filter(e => e.isDirectory()).map(e => e.name);

        const maps = await Promise.all(dirs.map(async (worldName) => {
            const base = path.join(mapsDir, worldName);
            const [metaRaw, cfgRaw] = await Promise.all([
                fs.readFile(path.join(base, 'meta.json'), 'utf8').catch(() => null),
                fs.readFile(path.join(base, 'map.json'),  'utf8').catch(() => null),
            ]);
            const meta = metaRaw ? JSON.parse(metaRaw) : {};
            const cfg  = cfgRaw  ? JSON.parse(cfgRaw)  : {};
            return {
                worldName,
                displayName: meta.displayName || cfg.name || worldName,
                worldSize:   meta.worldSize   || cfg.worldSize || null,
                author:      meta.author      || null,
                previewUrl:  `/images/maps/${worldName}/preview_512.png`,
            };
        }));

        res.json({ success: true, maps });
    } catch (err) {
        console.error('List maps error:', err);
        res.json({ success: false, error: 'Failed to list maps' });
    }
});

async function canEdit(userId, operationId) {
    if (!userId) return false;
    const [rows] = await db.query(
        'SELECT host_id, created_by FROM operations WHERE id = ?',
        [operationId]
    );
    if (!rows.length) return false;
    const isHost    = parseInt(rows[0].host_id) === parseInt(userId);
    const isCreator = parseInt(rows[0].created_by) === parseInt(userId);
    const isZeus    = await checkZeusStatus(userId);
    return isHost || isCreator || isZeus;
}

async function requireEdit(req, res, next) {
    if (!req.isAuthenticated()) return res.status(401).json({ success: false, error: 'Not authenticated' });
    try {
        const hasMapEditor = req.user.is_admin ||
            (Array.isArray(req.user.permissions) && req.user.permissions.includes('map.editor'));
        if (hasMapEditor || await canEdit(req.session.userId, req.params.id)) return next();
        return res.status(403).json({ success: false, error: 'Permission denied' });
    } catch (err) {
        next(err);
    }
}

router.get('/:id/map', async (req, res) => {
    try {
        const [ops] = await db.query(
            'SELECT id, title, is_published, orbat_type, orbat_template_id FROM operations WHERE id = ?',
            [req.params.id]
        );
        if (!ops.length || !ops[0].is_published) {
            return res.status(404).render('error', {
                title: 'Not Found', message: 'Operation Not Found',
                description: 'This operation does not exist or is not published.',
                user: res.locals.user
            });
        }
        const op = ops[0];

        let squads = [];
        if (op.orbat_type === 'fixed' && op.orbat_template_id) {
            [squads] = await db.query(
                'SELECT id, name, color, icon FROM orbat_squads WHERE orbat_id = ? ORDER BY display_order ASC',
                [op.orbat_template_id]
            );
        } else if (op.orbat_type === 'dynamic') {
            [squads] = await db.query(
                'SELECT id, name, color, icon FROM orbat_squads WHERE operation_id = ? ORDER BY display_order ASC',
                [req.params.id]
            );
        }
        squads = squads.map(s => ({
            ...s,
            icon_url: s.icon ? `/uploads/squad-icons/${s.icon}` : null
        }));

        const edit = req.isAuthenticated()
            ? await canEdit(req.session.userId, req.params.id)
            : false;

        res.render('operations/map', {
            title: `${op.title} — Mission Map`,
            operation: op,
            canEdit: edit,
            squads,
            user: res.locals.user
        });
    } catch (err) {
        console.error('Map page error:', err);
        res.status(500).render('error', {
            title: 'Error', message: 'Error Loading Map',
            description: 'Could not load the mission map.',
            user: res.locals.user
        });
    }
});

router.get('/:id/map/data', async (req, res) => {
    try {
        const [ops] = await db.query(
            'SELECT map_world FROM operations WHERE id = ?',
            [req.params.id]
        );
        const mapWorld = ops[0]?.map_world || null;

        const editor = req.isAuthenticated()
            ? await canEdit(req.session.userId, req.params.id)
            : false;

        const [layers] = await db.query(
            `SELECT id, name, color, is_visible, is_public, display_order
               FROM operation_map_layers
              WHERE operation_id = ?${editor ? '' : ' AND is_public = 1'}
              ORDER BY display_order ASC, id ASC`,
            [req.params.id]
        );

        const [annotations] = await db.query(
            `SELECT id, layer_id, type, geometry, properties, created_by
               FROM operation_map_annotations
              WHERE operation_id = ?
              ORDER BY id ASC`,
            [req.params.id]
        );

        const layerMap = {};
        layers.forEach(l => { layerMap[l.id] = { ...l, annotations: [] }; });
        annotations.forEach(a => {
            const ann = {
                ...a,
                geometry:   typeof a.geometry   === 'string' ? JSON.parse(a.geometry)   : a.geometry,
                properties: typeof a.properties === 'string' ? JSON.parse(a.properties) : a.properties
            };
            if (layerMap[a.layer_id]) layerMap[a.layer_id].annotations.push(ann);
        });

        res.json({ success: true, mapWorld, layers: Object.values(layerMap) });
    } catch (err) {
        console.error('Map data error:', err);
        res.json({ success: false, error: 'Failed to load map data' });
    }
});

router.patch('/:id/map/world', requireEdit, async (req, res) => {
    try {
        const { map_world } = req.body;
        if (map_world && !/^[a-zA-Z0-9_-]+$/.test(map_world)) {
            return res.json({ success: false, error: 'Invalid world name' });
        }
        await db.query(
            'UPDATE operations SET map_world = ? WHERE id = ?',
            [map_world || null, req.params.id]
        );
        res.json({ success: true });
    } catch (err) {
        console.error('Update map world error:', err);
        res.json({ success: false, error: 'Failed to update map world' });
    }
});

router.post('/:id/map/layers', requireEdit, async (req, res) => {
    try {
        const { name, color } = req.body;
        if (!name || !name.trim()) return res.json({ success: false, error: 'Layer name required' });

        const [countRows] = await db.query(
            'SELECT COUNT(*) as n FROM operation_map_layers WHERE operation_id = ?',
            [req.params.id]
        );

        const [result] = await db.query(
            `INSERT INTO operation_map_layers (operation_id, name, color, display_order, created_by)
             VALUES (?, ?, ?, ?, ?)`,
            [req.params.id, name.trim(), color || '#3498DB', countRows[0].n, req.session.userId]
        );

        res.json({ success: true, layer: {
            id: result.insertId,
            name: name.trim(),
            color: color || '#3498DB',
            is_visible: 1,
            is_public: 1,
            display_order: countRows[0].n,
            annotations: []
        }});
    } catch (err) {
        console.error('Create layer error:', err);
        res.json({ success: false, error: 'Failed to create layer' });
    }
});

router.patch('/:id/map/layers/:layerId', requireEdit, async (req, res) => {
    try {
        const { name, color, is_visible, is_public, display_order } = req.body;
        const fields = [];
        const vals   = [];

        if (name          !== undefined) { fields.push('name = ?');          vals.push(name.trim()); }
        if (color         !== undefined) { fields.push('color = ?');         vals.push(color); }
        if (is_visible    !== undefined) { fields.push('is_visible = ?');    vals.push(is_visible ? 1 : 0); }
        if (is_public     !== undefined) { fields.push('is_public = ?');     vals.push(is_public  ? 1 : 0); }
        if (display_order !== undefined) { fields.push('display_order = ?'); vals.push(display_order); }

        if (!fields.length) return res.json({ success: false, error: 'Nothing to update' });

        vals.push(req.params.layerId, req.params.id);
        await db.query(
            `UPDATE operation_map_layers SET ${fields.join(', ')}
              WHERE id = ? AND operation_id = ?`,
            vals
        );
        res.json({ success: true });
    } catch (err) {
        console.error('Update layer error:', err);
        res.json({ success: false, error: 'Failed to update layer' });
    }
});

router.delete('/:id/map/layers/:layerId', requireEdit, async (req, res) => {
    try {
        await db.query(
            'DELETE FROM operation_map_layers WHERE id = ? AND operation_id = ?',
            [req.params.layerId, req.params.id]
        );
        res.json({ success: true });
    } catch (err) {
        console.error('Delete layer error:', err);
        res.json({ success: false, error: 'Failed to delete layer' });
    }
});

router.post('/:id/map/annotations', requireEdit, async (req, res) => {
    try {
        const { layer_id, type, geometry, properties } = req.body;

        const VALID_TYPES = ['nato_marker', 'polyline', 'polygon', 'rectangle', 'circle', 'text', 'squad_marker'];
        if (!VALID_TYPES.includes(type)) return res.json({ success: false, error: 'Invalid type' });
        if (!layer_id || !geometry)      return res.json({ success: false, error: 'layer_id and geometry required' });

        const [layerCheck] = await db.query(
            'SELECT id FROM operation_map_layers WHERE id = ? AND operation_id = ?',
            [layer_id, req.params.id]
        );
        if (!layerCheck.length) return res.json({ success: false, error: 'Layer not found' });

        const [result] = await db.query(
            `INSERT INTO operation_map_annotations
               (layer_id, operation_id, type, geometry, properties, created_by)
             VALUES (?, ?, ?, ?, ?, ?)`,
            [layer_id, req.params.id, type,
             JSON.stringify(geometry),
             properties ? JSON.stringify(properties) : null,
             req.session.userId]
        );
        res.json({ success: true, id: result.insertId });
    } catch (err) {
        console.error('Create annotation error:', err);
        res.json({ success: false, error: 'Failed to create annotation' });
    }
});

router.patch('/:id/map/annotations/:annId', requireEdit, async (req, res) => {
    try {
        const { geometry, properties } = req.body;
        const fields = [];
        const vals   = [];

        if (geometry   !== undefined) { fields.push('geometry = ?');   vals.push(JSON.stringify(geometry)); }
        if (properties !== undefined) { fields.push('properties = ?'); vals.push(JSON.stringify(properties)); }

        if (!fields.length) return res.json({ success: false, error: 'Nothing to update' });

        vals.push(req.params.annId, req.params.id);
        await db.query(
            `UPDATE operation_map_annotations SET ${fields.join(', ')}
              WHERE id = ? AND operation_id = ?`,
            vals
        );
        res.json({ success: true });
    } catch (err) {
        console.error('Update annotation error:', err);
        res.json({ success: false, error: 'Failed to update annotation' });
    }
});

router.delete('/:id/map/annotations/:annId', requireEdit, async (req, res) => {
    try {
        await db.query(
            'DELETE FROM operation_map_annotations WHERE id = ? AND operation_id = ?',
            [req.params.annId, req.params.id]
        );
        res.json({ success: true });
    } catch (err) {
        console.error('Delete annotation error:', err);
        res.json({ success: false, error: 'Failed to delete annotation' });
    }
});

module.exports = router;
