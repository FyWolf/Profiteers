const express = require('express');
const crypto  = require('crypto');
const router  = express.Router();
const db      = require('../config/database');
const { isAuthenticated } = require('../middleware/auth');

// Real-time collaboration broadcast helper. Lazy-loaded to avoid a circular
// dep (plans-collab requires this file for resolveAccess).
function emitCollab(req, event, payload) {
    try { require('../services/plans-collab').broadcast(req, event, payload); }
    catch (e) { /* socket layer not ready or absent — fail silent */ }
}

// ─── Access resolution ─────────────────────────────────────────────────────
//
// Roles, in descending order of authority:
//   owner   — implicit (plan.owner_id), full control
//   admin   — explicit ACL row, edit + manage ACL/share
//   editor  — explicit ACL row, edit layers/annotations/terrain
//   viewer  — explicit ACL row OR via link_access=view + share_token, read-only
//
// Site-wide `map.plans.admin` permission grants admin role on every plan.

const ROLE_RANK = { owner: 4, admin: 3, editor: 2, viewer: 1 };
const canRead   = r => !!r;
const canEdit   = r => ROLE_RANK[r] >= ROLE_RANK.editor;
const canManage = r => ROLE_RANK[r] >= ROLE_RANK.admin;
const isOwner   = r => r === 'owner';

async function resolveAccess(req, planId) {
    const [rows] = await db.query('SELECT * FROM map_plans WHERE id = ?', [planId]);
    if (!rows.length) return { plan: null, role: null };
    const plan = rows[0];
    const userId = req.session?.userId;

    if (userId && parseInt(plan.owner_id) === parseInt(userId)) {
        return { plan, role: 'owner' };
    }

    if (userId) {
        const [acl] = await db.query(
            'SELECT role FROM map_plan_acl WHERE plan_id = ? AND user_id = ?',
            [planId, userId]
        );
        if (acl.length) return { plan, role: acl[0].role };
    }

    if (req.user?.permissions?.includes('map.plans.admin')) {
        return { plan, role: 'admin' };
    }

    if (plan.link_access === 'view' && req.query.t && req.query.t === plan.share_token) {
        return { plan, role: 'viewer' };
    }

    return { plan, role: null };
}

function requireRole(check) {
    return async (req, res, next) => {
        try {
            const { plan, role } = await resolveAccess(req, req.params.id);
            if (!plan)      return res.status(404).json({ success: false, error: 'Plan not found' });
            if (!check(role)) return res.status(403).json({ success: false, error: 'Permission denied' });
            req.plan = plan;
            req.planRole = role;
            next();
        } catch (err) { next(err); }
    };
}

const requireRead   = requireRole(canRead);
const requireEdit   = requireRole(canEdit);
const requireManage = requireRole(canManage);
const requireOwner  = requireRole(isOwner);

// ─── Squad resolution for the editor ───────────────────────────────────────
async function resolveSquads(orbatTemplateId) {
    if (!orbatTemplateId) return [];
    const [rows] = await db.query(
        'SELECT id, name, color, icon FROM orbat_squads WHERE orbat_id = ? ORDER BY display_order ASC',
        [orbatTemplateId]
    );
    return rows.map(s => ({ ...s, icon_url: s.icon ? `/uploads/squad-icons/${s.icon}` : null }));
}

// ─── List plans ────────────────────────────────────────────────────────────
router.get('/', isAuthenticated, async (req, res) => {
    try {
        const [mine] = await db.query(
            `SELECT id, name, description, map_world, orbat_template_id, link_access, created_at, updated_at
               FROM map_plans WHERE owner_id = ? ORDER BY updated_at DESC`,
            [req.session.userId]
        );

        const [shared] = await db.query(
            `SELECT p.id, p.name, p.description, p.map_world, p.orbat_template_id, p.link_access,
                    p.created_at, p.updated_at, a.role, u.username AS owner_username
               FROM map_plan_acl a
               JOIN map_plans  p ON p.id = a.plan_id
               JOIN users      u ON u.id = p.owner_id
              WHERE a.user_id = ?
              ORDER BY p.updated_at DESC`,
            [req.session.userId]
        );

        res.render('plans/list', {
            title: 'Map Plans',
            mine,
            shared,
            user: res.locals.user
        });
    } catch (err) {
        console.error('List plans error:', err);
        res.status(500).render('error', {
            title: 'Error', message: 'Error Loading Plans',
            description: 'Could not load your plans.',
            user: res.locals.user
        });
    }
});

// ─── New plan form ─────────────────────────────────────────────────────────
router.get('/new', isAuthenticated, async (req, res, next) => {
    try {
        const [orbats] = await db.query(
            `SELECT id, name FROM orbat_templates WHERE is_active = 1 ORDER BY name ASC`
        );
        res.render('plans/form', {
            title: 'New Plan',
            plan: null,
            orbats,
            user: res.locals.user
        });
    } catch (err) { next(err); }
});

// ─── Create plan ───────────────────────────────────────────────────────────
router.post('/', isAuthenticated, async (req, res) => {
    try {
        const { name, description, map_world, orbat_template_id } = req.body;
        if (!name || !name.trim()) {
            return res.status(400).json({ success: false, error: 'Name required' });
        }
        if (map_world && !/^[a-zA-Z0-9_-]+$/.test(map_world)) {
            return res.status(400).json({ success: false, error: 'Invalid terrain name' });
        }

        const shareToken = crypto.randomBytes(16).toString('hex');
        const orbatId = orbat_template_id ? parseInt(orbat_template_id) : null;

        const [r] = await db.query(
            `INSERT INTO map_plans (owner_id, name, description, map_world, orbat_template_id, share_token)
             VALUES (?, ?, ?, ?, ?, ?)`,
            [req.session.userId, name.trim(), description || null, map_world || null, orbatId, shareToken]
        );

        if (req.is('application/json') || req.xhr) {
            return res.json({ success: true, id: r.insertId });
        }
        res.redirect('/plans/' + r.insertId);
    } catch (err) {
        console.error('Create plan error:', err);
        res.status(500).json({ success: false, error: 'Failed to create plan' });
    }
});

// ─── Edit-metadata form ────────────────────────────────────────────────────
router.get('/:id/edit', isAuthenticated, async (req, res, next) => {
    try {
        const { plan, role } = await resolveAccess(req, req.params.id);
        if (!plan)            return res.status(404).render('error', { title: '404', message: 'Plan Not Found', description: '', user: res.locals.user });
        if (!canManage(role)) return res.status(403).render('error', { title: '403', message: 'Access Denied', description: 'You cannot edit this plan.', user: res.locals.user });

        const [orbats] = await db.query(
            `SELECT id, name FROM orbat_templates WHERE is_active = 1 ORDER BY name ASC`
        );
        res.render('plans/form', {
            title: 'Edit Plan',
            plan,
            orbats,
            user: res.locals.user
        });
    } catch (err) { next(err); }
});

// ─── Update metadata ───────────────────────────────────────────────────────
router.patch('/:id', requireManage, async (req, res) => {
    try {
        const { name, description, map_world, orbat_template_id } = req.body;
        const fields = [];
        const vals   = [];

        if (name !== undefined) {
            if (!name.trim()) return res.json({ success: false, error: 'Name required' });
            fields.push('name = ?'); vals.push(name.trim());
        }
        if (description !== undefined) { fields.push('description = ?'); vals.push(description || null); }
        if (map_world   !== undefined) {
            if (map_world && !/^[a-zA-Z0-9_-]+$/.test(map_world)) {
                return res.json({ success: false, error: 'Invalid terrain name' });
            }
            fields.push('map_world = ?'); vals.push(map_world || null);
        }
        if (orbat_template_id !== undefined) {
            const oid = orbat_template_id ? parseInt(orbat_template_id) : null;
            fields.push('orbat_template_id = ?'); vals.push(oid);
        }

        if (!fields.length) return res.json({ success: false, error: 'Nothing to update' });
        vals.push(req.params.id);

        await db.query(`UPDATE map_plans SET ${fields.join(', ')} WHERE id = ?`, vals);
        res.json({ success: true });
    } catch (err) {
        console.error('Update plan error:', err);
        res.json({ success: false, error: 'Failed to update plan' });
    }
});

// Form-style update so the edit page can submit a normal form.
router.post('/:id/edit', requireManage, async (req, res) => {
    try {
        const { name, description, map_world, orbat_template_id } = req.body;
        if (!name || !name.trim()) {
            return res.redirect('/plans/' + req.params.id + '/edit');
        }
        if (map_world && !/^[a-zA-Z0-9_-]+$/.test(map_world)) {
            return res.redirect('/plans/' + req.params.id + '/edit');
        }
        const oid = orbat_template_id ? parseInt(orbat_template_id) : null;
        await db.query(
            `UPDATE map_plans SET name = ?, description = ?, map_world = ?, orbat_template_id = ? WHERE id = ?`,
            [name.trim(), description || null, map_world || null, oid, req.params.id]
        );
        res.redirect('/plans/' + req.params.id);
    } catch (err) {
        console.error('Update plan (form) error:', err);
        res.redirect('/plans/' + req.params.id + '/edit');
    }
});

// ─── Delete plan ───────────────────────────────────────────────────────────
router.delete('/:id', requireOwner, async (req, res) => {
    try {
        await db.query('DELETE FROM map_plans WHERE id = ?', [req.params.id]);
        res.json({ success: true });
    } catch (err) {
        console.error('Delete plan error:', err);
        res.json({ success: false, error: 'Failed to delete plan' });
    }
});

// ─── Duplicate plan ────────────────────────────────────────────────────────
router.post('/:id/duplicate', isAuthenticated, async (req, res) => {
    try {
        const { plan, role } = await resolveAccess(req, req.params.id);
        if (!plan || !canRead(role)) return res.status(403).json({ success: false, error: 'Permission denied' });

        const shareToken = crypto.randomBytes(16).toString('hex');
        const [r] = await db.query(
            `INSERT INTO map_plans (owner_id, name, description, map_world, orbat_template_id, share_token)
             VALUES (?, ?, ?, ?, ?, ?)`,
            [req.session.userId, plan.name + ' (copy)', plan.description, plan.map_world, plan.orbat_template_id, shareToken]
        );
        const newPlanId = r.insertId;

        const [layers] = await db.query(
            `SELECT id, name, color, is_visible, is_public, display_order FROM map_plan_layers WHERE plan_id = ? ORDER BY display_order ASC`,
            [plan.id]
        );
        const layerIdMap = {};
        for (const l of layers) {
            const [lr] = await db.query(
                `INSERT INTO map_plan_layers (plan_id, name, color, is_visible, is_public, display_order, created_by)
                 VALUES (?, ?, ?, ?, ?, ?, ?)`,
                [newPlanId, l.name, l.color, l.is_visible, l.is_public, l.display_order, req.session.userId]
            );
            layerIdMap[l.id] = lr.insertId;
        }

        const [anns] = await db.query(
            `SELECT layer_id, type, geometry, properties FROM map_plan_annotations WHERE plan_id = ?`,
            [plan.id]
        );
        for (const a of anns) {
            const newLayerId = layerIdMap[a.layer_id];
            if (!newLayerId) continue;
            await db.query(
                `INSERT INTO map_plan_annotations (layer_id, plan_id, type, geometry, properties, created_by)
                 VALUES (?, ?, ?, ?, ?, ?)`,
                [newLayerId, newPlanId, a.type,
                 typeof a.geometry === 'string' ? a.geometry : JSON.stringify(a.geometry),
                 a.properties == null ? null : (typeof a.properties === 'string' ? a.properties : JSON.stringify(a.properties)),
                 req.session.userId]
            );
        }

        res.json({ success: true, id: newPlanId });
    } catch (err) {
        console.error('Duplicate plan error:', err);
        res.json({ success: false, error: 'Failed to duplicate plan' });
    }
});

// ─── Open plan editor ──────────────────────────────────────────────────────
router.get('/:id', async (req, res, next) => {
    try {
        const { plan, role } = await resolveAccess(req, req.params.id);
        if (!plan)         return res.status(404).render('error', { title: '404', message: 'Plan Not Found', description: 'This plan does not exist.', user: res.locals.user });
        if (!canRead(role)) {
            if (!req.isAuthenticated()) return res.redirect('/login?redirect=' + encodeURIComponent(req.originalUrl));
            return res.status(403).render('error', { title: '403', message: 'Access Denied', description: 'You do not have access to this plan.', user: res.locals.user });
        }

        const squads = await resolveSquads(plan.orbat_template_id);

        const [[ownerRow]] = await db.query('SELECT username FROM users WHERE id = ?', [plan.owner_id]);

        // If the viewer reached this page via a share token (no session ACL match), propagate
        // the token so subsequent API calls also pass requireRead. We detect this by checking
        // that the role is 'viewer' AND the request had ?t= matching the share token AND the
        // user isn't otherwise an editor/admin/owner.
        const reachedViaToken = role === 'viewer'
            && req.query.t
            && plan.link_access === 'view'
            && req.query.t === plan.share_token;
        const tokenSuffix = reachedViaToken ? `?t=${req.query.t}` : '';

        res.render('plans/editor', {
            title:       plan.name + ' — Map Plan',
            plan,
            ownerName:   ownerRow ? ownerRow.username : null,
            role,
            canEdit:     canEdit(role),
            canManage:   canManage(role),
            isOwner:     isOwner(role),
            squads,
            tokenSuffix,
            user:        res.locals.user
        });
    } catch (err) { next(err); }
});

// ─── Map data (read) ───────────────────────────────────────────────────────
router.get('/:id/data', requireRead, async (req, res) => {
    try {
        const editor = canEdit(req.planRole);
        const [layers] = await db.query(
            `SELECT id, name, color, is_visible, is_public, display_order
               FROM map_plan_layers
              WHERE plan_id = ?${editor ? '' : ' AND is_public = 1'}
              ORDER BY display_order ASC, id ASC`,
            [req.params.id]
        );
        const [annotations] = await db.query(
            `SELECT id, layer_id, type, geometry, properties, created_by
               FROM map_plan_annotations
              WHERE plan_id = ?
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
        res.json({ success: true, mapWorld: req.plan.map_world, layers: Object.values(layerMap) });
    } catch (err) {
        console.error('Plan map data error:', err);
        res.json({ success: false, error: 'Failed to load map data' });
    }
});

// ─── Change terrain ────────────────────────────────────────────────────────
router.patch('/:id/world', requireEdit, async (req, res) => {
    try {
        const { map_world } = req.body;
        if (map_world && !/^[a-zA-Z0-9_-]+$/.test(map_world)) {
            return res.json({ success: false, error: 'Invalid terrain name' });
        }
        await db.query('UPDATE map_plans SET map_world = ? WHERE id = ?', [map_world || null, req.params.id]);
        res.json({ success: true });
    } catch (err) {
        console.error('Plan world error:', err);
        res.json({ success: false, error: 'Failed to update terrain' });
    }
});

// ─── Layers ────────────────────────────────────────────────────────────────
router.post('/:id/layers', requireEdit, async (req, res) => {
    try {
        const { name, color } = req.body;
        if (!name || !name.trim()) return res.json({ success: false, error: 'Layer name required' });

        const [countRows] = await db.query(
            'SELECT COUNT(*) as n FROM map_plan_layers WHERE plan_id = ?',
            [req.params.id]
        );
        const [r] = await db.query(
            `INSERT INTO map_plan_layers (plan_id, name, color, display_order, created_by)
             VALUES (?, ?, ?, ?, ?)`,
            [req.params.id, name.trim(), color || '#3498DB', countRows[0].n, req.session.userId]
        );
        const layer = {
            id: r.insertId, name: name.trim(), color: color || '#3498DB',
            is_visible: 1, is_public: 1, display_order: countRows[0].n, annotations: []
        };
        emitCollab(req, 'layer:create', { layer });
        res.json({ success: true, layer });
    } catch (err) {
        console.error('Plan create layer error:', err);
        res.json({ success: false, error: 'Failed to create layer' });
    }
});

router.patch('/:id/layers/:layerId', requireEdit, async (req, res) => {
    try {
        const { name, color, is_visible, is_public, display_order } = req.body;
        const fields = [], vals = [];
        if (name          !== undefined) { fields.push('name = ?');          vals.push(name.trim()); }
        if (color         !== undefined) { fields.push('color = ?');         vals.push(color); }
        if (is_visible    !== undefined) { fields.push('is_visible = ?');    vals.push(is_visible ? 1 : 0); }
        if (is_public     !== undefined) { fields.push('is_public = ?');     vals.push(is_public  ? 1 : 0); }
        if (display_order !== undefined) { fields.push('display_order = ?'); vals.push(display_order); }
        if (!fields.length) return res.json({ success: false, error: 'Nothing to update' });
        vals.push(req.params.layerId, req.params.id);
        await db.query(
            `UPDATE map_plan_layers SET ${fields.join(', ')} WHERE id = ? AND plan_id = ?`,
            vals
        );
        const patch = {};
        if (name          !== undefined) patch.name          = name.trim();
        if (color         !== undefined) patch.color         = color;
        if (is_visible    !== undefined) patch.is_visible    = is_visible ? 1 : 0;
        if (is_public     !== undefined) patch.is_public     = is_public  ? 1 : 0;
        if (display_order !== undefined) patch.display_order = display_order;
        emitCollab(req, 'layer:update', { id: parseInt(req.params.layerId), patch });
        res.json({ success: true });
    } catch (err) {
        console.error('Plan update layer error:', err);
        res.json({ success: false, error: 'Failed to update layer' });
    }
});

router.delete('/:id/layers/:layerId', requireEdit, async (req, res) => {
    try {
        await db.query('DELETE FROM map_plan_layers WHERE id = ? AND plan_id = ?',
            [req.params.layerId, req.params.id]);
        emitCollab(req, 'layer:delete', { id: parseInt(req.params.layerId) });
        res.json({ success: true });
    } catch (err) {
        console.error('Plan delete layer error:', err);
        res.json({ success: false, error: 'Failed to delete layer' });
    }
});

// ─── Annotations ───────────────────────────────────────────────────────────
const VALID_ANN_TYPES = ['nato_marker','arma_marker','polyline','polygon','rectangle','circle','text','squad_marker'];

router.post('/:id/annotations', requireEdit, async (req, res) => {
    try {
        const { layer_id, type, geometry, properties } = req.body;
        if (!VALID_ANN_TYPES.includes(type)) return res.json({ success: false, error: 'Invalid type' });
        if (!layer_id || !geometry)          return res.json({ success: false, error: 'layer_id and geometry required' });

        const [layerCheck] = await db.query(
            'SELECT id FROM map_plan_layers WHERE id = ? AND plan_id = ?',
            [layer_id, req.params.id]
        );
        if (!layerCheck.length) return res.json({ success: false, error: 'Layer not found' });

        const [r] = await db.query(
            `INSERT INTO map_plan_annotations (layer_id, plan_id, type, geometry, properties, created_by)
             VALUES (?, ?, ?, ?, ?, ?)`,
            [layer_id, req.params.id, type,
             JSON.stringify(geometry),
             properties ? JSON.stringify(properties) : null,
             req.session.userId]
        );
        emitCollab(req, 'annotation:create', {
            annotation: {
                id: r.insertId, layer_id, type,
                geometry, properties: properties || null,
                created_by: req.session.userId
            }
        });
        res.json({ success: true, id: r.insertId });
    } catch (err) {
        console.error('Plan create annotation error:', err);
        res.json({ success: false, error: 'Failed to create annotation' });
    }
});

router.patch('/:id/annotations/:annId', requireEdit, async (req, res) => {
    try {
        const { geometry, properties } = req.body;
        const fields = [], vals = [];
        if (geometry   !== undefined) { fields.push('geometry = ?');   vals.push(JSON.stringify(geometry)); }
        if (properties !== undefined) { fields.push('properties = ?'); vals.push(JSON.stringify(properties)); }
        if (!fields.length) return res.json({ success: false, error: 'Nothing to update' });
        vals.push(req.params.annId, req.params.id);
        await db.query(
            `UPDATE map_plan_annotations SET ${fields.join(', ')} WHERE id = ? AND plan_id = ?`,
            vals
        );
        const patch = {};
        if (geometry   !== undefined) patch.geometry   = geometry;
        if (properties !== undefined) patch.properties = properties;
        emitCollab(req, 'annotation:update', { id: parseInt(req.params.annId), patch });
        res.json({ success: true });
    } catch (err) {
        console.error('Plan update annotation error:', err);
        res.json({ success: false, error: 'Failed to update annotation' });
    }
});

router.delete('/:id/annotations/:annId', requireEdit, async (req, res) => {
    try {
        await db.query('DELETE FROM map_plan_annotations WHERE id = ? AND plan_id = ?',
            [req.params.annId, req.params.id]);
        emitCollab(req, 'annotation:delete', { id: parseInt(req.params.annId) });
        res.json({ success: true });
    } catch (err) {
        console.error('Plan delete annotation error:', err);
        res.json({ success: false, error: 'Failed to delete annotation' });
    }
});

// ─── ACL ───────────────────────────────────────────────────────────────────
// Autocomplete: search users by partial username, excluding owner + existing ACL members.
router.get('/:id/acl/search', requireManage, async (req, res) => {
    try {
        const q = (req.query.q || '').trim();
        if (q.length < 1) return res.json({ success: true, users: [] });
        const like = '%' + q.replace(/[%_\\]/g, ch => '\\' + ch) + '%';
        const [rows] = await db.query(
            `SELECT u.id, u.username
               FROM users u
              WHERE u.username LIKE ?
                AND u.id <> ?
                AND u.id NOT IN (SELECT user_id FROM map_plan_acl WHERE plan_id = ?)
              ORDER BY (u.username = ?) DESC, LENGTH(u.username) ASC, u.username ASC
              LIMIT 10`,
            [like, req.plan.owner_id, req.params.id, q]
        );
        res.json({ success: true, users: rows });
    } catch (err) {
        console.error('ACL search error:', err);
        res.json({ success: false, error: 'Search failed' });
    }
});

router.get('/:id/acl', requireManage, async (req, res) => {
    try {
        const [rows] = await db.query(
            `SELECT a.user_id, a.role, u.username
               FROM map_plan_acl a JOIN users u ON u.id = a.user_id
              WHERE a.plan_id = ?
              ORDER BY a.role, u.username`,
            [req.params.id]
        );
        res.json({ success: true, members: rows });
    } catch (err) {
        console.error('ACL list error:', err);
        res.json({ success: false, error: 'Failed to list members' });
    }
});

router.post('/:id/acl', requireManage, async (req, res) => {
    try {
        let { user_id, username, role } = req.body;
        if (!['viewer','editor','admin'].includes(role)) {
            return res.json({ success: false, error: 'Invalid role' });
        }

        let uid = user_id ? parseInt(user_id) : null;
        if (!uid && username) {
            const [u] = await db.query(
                'SELECT id FROM users WHERE username = ? OR LOWER(username) = LOWER(?) LIMIT 1',
                [username, username]
            );
            if (u.length) uid = u[0].id;
        }
        if (!uid)      return res.json({ success: false, error: 'User not found' });
        if (parseInt(uid) === parseInt(req.plan.owner_id)) {
            return res.json({ success: false, error: 'Owner already has full access' });
        }

        await db.query(
            `INSERT INTO map_plan_acl (plan_id, user_id, role) VALUES (?, ?, ?)
             ON DUPLICATE KEY UPDATE role = VALUES(role)`,
            [req.params.id, uid, role]
        );
        const [[u]] = await db.query('SELECT id, username FROM users WHERE id = ?', [uid]);
        res.json({ success: true, member: { user_id: u.id, username: u.username, role } });
    } catch (err) {
        console.error('ACL add error:', err);
        res.json({ success: false, error: 'Failed to add member' });
    }
});

router.patch('/:id/acl/:userId', requireManage, async (req, res) => {
    try {
        const { role } = req.body;
        if (!['viewer','editor','admin'].includes(role)) {
            return res.json({ success: false, error: 'Invalid role' });
        }
        await db.query(
            'UPDATE map_plan_acl SET role = ? WHERE plan_id = ? AND user_id = ?',
            [role, req.params.id, req.params.userId]
        );
        res.json({ success: true });
    } catch (err) {
        console.error('ACL update error:', err);
        res.json({ success: false, error: 'Failed to update member' });
    }
});

router.delete('/:id/acl/:userId', requireManage, async (req, res) => {
    try {
        await db.query(
            'DELETE FROM map_plan_acl WHERE plan_id = ? AND user_id = ?',
            [req.params.id, req.params.userId]
        );
        res.json({ success: true });
    } catch (err) {
        console.error('ACL remove error:', err);
        res.json({ success: false, error: 'Failed to remove member' });
    }
});

// ─── Share link ────────────────────────────────────────────────────────────
router.post('/:id/share', requireManage, async (req, res) => {
    try {
        const { link_access, rotate } = req.body;
        const fields = [], vals = [];
        if (link_access !== undefined) {
            if (!['none','view'].includes(link_access)) {
                return res.json({ success: false, error: 'Invalid link_access' });
            }
            fields.push('link_access = ?'); vals.push(link_access);
        }
        if (rotate) {
            fields.push('share_token = ?'); vals.push(crypto.randomBytes(16).toString('hex'));
        }
        if (fields.length) {
            vals.push(req.params.id);
            await db.query(`UPDATE map_plans SET ${fields.join(', ')} WHERE id = ?`, vals);
        }
        const [[p]] = await db.query('SELECT share_token, link_access FROM map_plans WHERE id = ?', [req.params.id]);
        res.json({ success: true, share_token: p.share_token, link_access: p.link_access });
    } catch (err) {
        console.error('Share update error:', err);
        res.json({ success: false, error: 'Failed to update share settings' });
    }
});

module.exports = router;
module.exports.resolveAccess = resolveAccess;
module.exports.canRead       = canRead;
module.exports.canEdit       = canEdit;
module.exports.canManage     = canManage;
