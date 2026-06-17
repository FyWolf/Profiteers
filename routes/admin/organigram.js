const express = require('express');
const router = express.Router();
const db = require('../../config/database');

const DEFAULT_COLOR = '#6b8e23';
const isHexColor = c => typeof c === 'string' && /^#[0-9a-fA-F]{6}$/.test(c.trim());

// Build a parent→children tree from a flat node list (roots = parent_id NULL).
function buildTree(nodes) {
    const byId = new Map();
    nodes.forEach(n => byId.set(n.id, { ...n, children: [] }));
    const roots = [];
    byId.forEach(node => {
        if (node.parent_id && byId.has(node.parent_id)) {
            byId.get(node.parent_id).children.push(node);
        } else {
            roots.push(node);
        }
    });
    return roots;
}

// Collect the ids of a node and all its descendants (cycle guard for re-parenting).
function collectSubtreeIds(nodes, rootId) {
    const childrenOf = {};
    nodes.forEach(n => {
        if (n.parent_id) (childrenOf[n.parent_id] ||= []).push(n.id);
    });
    const ids = new Set();
    const stack = [rootId];
    while (stack.length) {
        const id = stack.pop();
        if (ids.has(id)) continue;
        ids.add(id);
        (childrenOf[id] || []).forEach(c => stack.push(c));
    }
    return ids;
}

// Load all nodes with the assigned member resolved for display.
async function loadNodes() {
    const [nodes] = await db.query(`
        SELECT
            n.id, n.parent_id, n.title, n.member_discord_id, n.color, n.display_order,
            rm.nickname AS roster_nickname,
            rm.discord_global_name,
            rm.discord_username AS username,
            rm.discord_avatar,
            rm.discord_id
        FROM organigram_nodes n
        LEFT JOIN roster_members rm ON rm.discord_id = n.member_discord_id
        ORDER BY n.display_order ASC, n.id ASC
    `);
    return nodes;
}

router.get('/', async (req, res) => {
    try {
        const nodes = await loadNodes();
        res.render('admin/organigram', {
            title: 'Organigram - Admin',
            nodes,
            tree: buildTree(nodes),
            success: req.query.success,
            error:   req.query.error
        });
    } catch (error) {
        console.error('Error loading organigram:', error);
        res.render('error', {
            title: 'Error',
            message: 'Error Loading Organigram',
            description: 'Could not load the organigram editor.',
            user: res.locals.user
        });
    }
});

router.post('/nodes', async (req, res) => {
    try {
        const { title, parent_id, member_discord_id, color } = req.body;
        if (!title || !title.trim()) {
            return res.redirect('/admin/organigram?error=Position title is required');
        }

        let parentId = parent_id ? parseInt(parent_id) : null;
        if (parentId && isNaN(parentId)) parentId = null;
        if (parentId) {
            const [[parent]] = await db.query('SELECT id FROM organigram_nodes WHERE id = ?', [parentId]);
            if (!parent) parentId = null;
        }

        const [[{ maxOrder }]] = await db.query(
            'SELECT MAX(display_order) AS maxOrder FROM organigram_nodes WHERE parent_id <=> ?',
            [parentId]
        );
        const nextOrder = (maxOrder ?? -1) + 1;

        await db.query(
            'INSERT INTO organigram_nodes (parent_id, title, member_discord_id, color, display_order) VALUES (?, ?, ?, ?, ?)',
            [
                parentId,
                title.trim(),
                (member_discord_id && member_discord_id.trim()) || null,
                isHexColor(color) ? color.trim() : DEFAULT_COLOR,
                nextOrder
            ]
        );

        res.redirect('/admin/organigram?success=Position added');
    } catch (error) {
        console.error('Error creating organigram node:', error);
        res.redirect('/admin/organigram?error=Failed to add position');
    }
});

router.post('/nodes/:id', async (req, res) => {
    try {
        const id = parseInt(req.params.id);
        const [[node]] = await db.query('SELECT id FROM organigram_nodes WHERE id = ?', [id]);
        if (!node) {
            return res.redirect('/admin/organigram?error=Position not found');
        }

        const { title, parent_id, member_discord_id, color, display_order } = req.body;
        if (!title || !title.trim()) {
            return res.redirect('/admin/organigram?error=Position title is required');
        }

        let parentId = parent_id ? parseInt(parent_id) : null;
        if (parentId && isNaN(parentId)) parentId = null;

        // Cycle guard: a node cannot be parented to itself or any of its descendants.
        if (parentId) {
            const nodes = await loadNodes();
            const subtree = collectSubtreeIds(nodes, id);
            if (subtree.has(parentId)) {
                return res.redirect('/admin/organigram?error=A position cannot report to itself or one of its subordinates');
            }
            const [[parent]] = await db.query('SELECT id FROM organigram_nodes WHERE id = ?', [parentId]);
            if (!parent) parentId = null;
        }

        const order = display_order != null && display_order !== '' ? parseInt(display_order) : 0;

        await db.query(
            'UPDATE organigram_nodes SET title = ?, parent_id = ?, member_discord_id = ?, color = ?, display_order = ? WHERE id = ?',
            [
                title.trim(),
                parentId,
                (member_discord_id && member_discord_id.trim()) || null,
                isHexColor(color) ? color.trim() : DEFAULT_COLOR,
                isNaN(order) ? 0 : order,
                id
            ]
        );

        res.redirect('/admin/organigram?success=Position updated');
    } catch (error) {
        console.error('Error updating organigram node:', error);
        res.redirect('/admin/organigram?error=Failed to update position');
    }
});

router.post('/nodes/:id/delete', async (req, res) => {
    try {
        const id = parseInt(req.params.id);
        const [[node]] = await db.query('SELECT id, parent_id FROM organigram_nodes WHERE id = ?', [id]);
        if (!node) {
            return res.redirect('/admin/organigram?error=Position not found');
        }

        // Preserve the subtree: re-parent direct children to the deleted node's parent.
        await db.query('UPDATE organigram_nodes SET parent_id = ? WHERE parent_id = ?', [node.parent_id, id]);
        await db.query('DELETE FROM organigram_nodes WHERE id = ?', [id]);

        res.redirect('/admin/organigram?success=Position deleted');
    } catch (error) {
        console.error('Error deleting organigram node:', error);
        res.redirect('/admin/organigram?error=Failed to delete position');
    }
});

module.exports = router;
