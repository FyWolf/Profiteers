const express = require('express');
const router = express.Router();
const path = require('path');
const fs = require('fs').promises;
const db = require('../../config/database');

const TOOLS_UPLOAD_DIR = path.join(__dirname, '..', '..', 'public', 'uploads', 'tools');

async function saveToolImage(file) {
    const ext = path.extname(file.name).replace(/[^a-z0-9.]/gi, '');
    const base = path.basename(file.name, path.extname(file.name)).replace(/[^a-zA-Z0-9_-]/g, '-');
    const fileName = `${Date.now()}-${base}${ext}`;
    await file.mv(path.join(TOOLS_UPLOAD_DIR, fileName));
    return `/uploads/tools/${fileName}`;
}

router.get('/', async (req, res) => {
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

router.get('/add', (req, res) => {
    res.render('admin/tool-form', {
        title: 'Add Tool - Admin',
        tool: null,
        mode: 'add'
    });
});

router.post('/add', async (req, res) => {
    const { title, description, link, order_index } = req.body;

    try {
        let imageUrl = null;

        if (req.files && req.files.image) {
            imageUrl = await saveToolImage(req.files.image);
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

router.get('/edit/:id', async (req, res) => {
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

router.post('/edit/:id', async (req, res) => {
    const { title, description, link, order_index } = req.body;
    const toolId = req.params.id;

    try {
        const [currentTool] = await db.query('SELECT image_url FROM tools WHERE id = ?', [toolId]);

        if (currentTool.length === 0) {
            return res.redirect('/admin/tools?error=Tool not found');
        }

        let imageUrl = currentTool[0].image_url;

        if (req.files && req.files.image) {
            if (imageUrl) {
                try {
                    await fs.unlink(path.join(__dirname, '..', '..', 'public', imageUrl));
                } catch (err) {
                    console.log('Could not delete old image:', err);
                }
            }
            imageUrl = await saveToolImage(req.files.image);
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

router.post('/toggle/:id', async (req, res) => {
    try {
        await db.query('UPDATE tools SET is_visible = NOT is_visible WHERE id = ?', [req.params.id]);
        res.json({ success: true });
    } catch (error) {
        console.error('Error toggling tool:', error);
        res.json({ success: false, error: 'Failed to toggle visibility' });
    }
});

router.post('/delete/:id', async (req, res) => {
    try {
        const [tools] = await db.query('SELECT image_url FROM tools WHERE id = ?', [req.params.id]);

        if (tools.length > 0 && tools[0].image_url) {
            const imagePath = path.join(__dirname, '..', '..', 'public', tools[0].image_url);
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

module.exports = router;
