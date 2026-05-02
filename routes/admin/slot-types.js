const express = require('express');
const router = express.Router();
const db = require('../../config/database');

router.get('/', async (req, res) => {
    try {
        const [slotTypes] = await db.query(`
            SELECT
                st.*,
                COUNT(DISTINCT sts.superior_type_id) AS superior_count,
                COUNT(DISTINCT orr.id)               AS usage_count
            FROM slot_types st
            LEFT JOIN slot_type_superiors sts ON st.id = sts.slot_type_id
            LEFT JOIN orbat_roles orr         ON st.id = orr.slot_type_id
            GROUP BY st.id
            ORDER BY st.display_order ASC, st.name ASC
        `);

        const [superiorRows] = await db.query(
            'SELECT slot_type_id, superior_type_id FROM slot_type_superiors'
        );
        const slotTypeCurrentSuperiors = {};
        superiorRows.forEach(r => {
            if (!slotTypeCurrentSuperiors[r.slot_type_id]) {
                slotTypeCurrentSuperiors[r.slot_type_id] = [];
            }
            slotTypeCurrentSuperiors[r.slot_type_id].push(r.superior_type_id);
        });

        res.render('admin/slot-types', {
            title: 'Slot Types - Admin',
            slotTypes,
            slotTypeCurrentSuperiors,
            success: req.query.success,
            error:   req.query.error
        });
    } catch (error) {
        console.error('Error loading slot types:', error);
        res.render('error', {
            title: 'Error',
            message: 'Error Loading Slot Types',
            description: 'Could not load slot type management.',
            user: res.locals.user
        });
    }
});

router.post('/add', async (req, res) => {
    try {
        const { name, abbreviation } = req.body;

        if (!name || !name.trim()) {
            return res.redirect('/admin/slot-types?error=Name is required');
        }

        const [[{ maxOrder }]] = await db.query('SELECT MAX(display_order) AS maxOrder FROM slot_types');
        const nextOrder = (maxOrder ?? -1) + 1;

        await db.query(
            'INSERT INTO slot_types (name, abbreviation, display_order, created_by) VALUES (?, ?, ?, ?)',
            [name.trim(), abbreviation?.trim() || null, nextOrder, req.session.userId]
        );

        res.redirect('/admin/slot-types?success=Slot type created');
    } catch (error) {
        console.error('Error creating slot type:', error);
        res.redirect('/admin/slot-types?error=Failed to create slot type');
    }
});

router.post('/edit/:id', async (req, res) => {
    try {
        const [rows] = await db.query('SELECT id FROM slot_types WHERE id = ?', [req.params.id]);
        if (rows.length === 0) {
            return res.redirect('/admin/slot-types?error=Slot type not found');
        }

        const { name, abbreviation } = req.body;

        if (!name || !name.trim()) {
            return res.redirect('/admin/slot-types?error=Name is required');
        }

        await db.query(
            'UPDATE slot_types SET name = ?, abbreviation = ? WHERE id = ?',
            [name.trim(), abbreviation?.trim() || null, req.params.id]
        );

        res.redirect('/admin/slot-types?success=Slot type updated');
    } catch (error) {
        console.error('Error updating slot type:', error);
        res.redirect('/admin/slot-types?error=Failed to update slot type');
    }
});

router.post('/delete/:id', async (req, res) => {
    try {
        const [[{ usage_count }]] = await db.query(
            'SELECT COUNT(*) AS usage_count FROM orbat_roles WHERE slot_type_id = ?',
            [req.params.id]
        );

        if (usage_count > 0) {
            return res.redirect(
                `/admin/slot-types?error=Cannot delete: this type is used by ${usage_count} orbat slot(s)`
            );
        }

        await db.query('DELETE FROM slot_types WHERE id = ?', [req.params.id]);
        res.redirect('/admin/slot-types?success=Slot type deleted');
    } catch (error) {
        console.error('Error deleting slot type:', error);
        res.redirect('/admin/slot-types?error=Failed to delete slot type');
    }
});

// Persist drag-and-drop order
router.post('/reorder', async (req, res) => {
    const { ids } = req.body;
    if (!Array.isArray(ids) || ids.length === 0) {
        return res.json({ success: false, error: 'Invalid order data' });
    }
    const conn = await db.getConnection();
    try {
        await conn.beginTransaction();
        for (let idx = 0; idx < ids.length; idx++) {
            await conn.query('UPDATE slot_types SET display_order = ? WHERE id = ?', [idx, parseInt(ids[idx])]);
        }
        await conn.commit();
        res.json({ success: true });
    } catch (error) {
        await conn.rollback();
        console.error('Error reordering slot types:', error);
        res.json({ success: false, error: 'Failed to save order' });
    } finally {
        conn.release();
    }
});

// Replace the full list of superiors for a given slot type
router.post('/:id/superiors', async (req, res) => {
    const conn = await db.getConnection();
    try {
        const [rows] = await conn.query('SELECT id FROM slot_types WHERE id = ?', [req.params.id]);
        if (rows.length === 0) {
            return res.redirect('/admin/slot-types?error=Slot type not found');
        }

        const selectedIds = [].concat(req.body.superior_ids || [])
            .map(id => parseInt(id))
            .filter(id => !isNaN(id) && id !== parseInt(req.params.id));

        await conn.beginTransaction();
        await conn.query('DELETE FROM slot_type_superiors WHERE slot_type_id = ?', [req.params.id]);

        if (selectedIds.length > 0) {
            const superiorData = selectedIds.map(supId => [parseInt(req.params.id), supId]);
            await conn.query('INSERT IGNORE INTO slot_type_superiors (slot_type_id, superior_type_id) VALUES ?', [superiorData]);
        }

        await conn.commit();
        res.redirect('/admin/slot-types?success=Hierarchy updated');
    } catch (error) {
        await conn.rollback();
        console.error('Error updating slot type superiors:', error);
        res.redirect('/admin/slot-types?error=Failed to update hierarchy');
    } finally {
        conn.release();
    }
});

module.exports = router;
