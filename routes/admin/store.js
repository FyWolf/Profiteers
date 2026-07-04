const express = require('express');
const router = express.Router();
const db = require('../../config/database');

// ─── Store Dashboard ────────────────────────────────────────
router.get('/', async (req, res) => {
    try {
        const [categories] = await db.query(`
            SELECT sc.*, COUNT(si.id) AS item_count
            FROM store_categories sc
            LEFT JOIN store_items si ON si.category_id = sc.id
            GROUP BY sc.id
            ORDER BY sc.display_order, sc.name
        `);
        const [stats] = await db.query(`
            SELECT
                COUNT(*) AS total_items,
                COALESCE(SUM(CASE WHEN is_active = 1 THEN 1 ELSE 0 END), 0) AS active_items,
                COALESCE(SUM(base_price * stock), 0) AS total_stock_value
            FROM store_items
        `);
        const [recentTransactions] = await db.query(`
            SELECT st.*, si.display_name, rm.discord_username
            FROM store_transactions st
            JOIN store_items si ON si.id = st.item_id
            JOIN roster_members rm ON rm.id = st.user_id
            ORDER BY st.created_at DESC
            LIMIT 20
        `);
        res.render('admin/store/index', {
            title: 'Store Management',
            categories,
            stats: stats[0],
            recentTransactions,
            user: res.locals.user
        });
    } catch (err) {
        console.error('Admin store error:', err);
        res.status(500).render('error', { title: 'Error', message: 'Failed to load store admin', user: res.locals.user });
    }
});

// ─── Categories ─────────────────────────────────────────────
router.get('/categories', async (req, res) => {
    try {
        const [categories] = await db.query(
            'SELECT * FROM store_categories ORDER BY display_order, name'
        );
        res.render('admin/store/categories', {
            title: 'Store Categories',
            categories,
            user: res.locals.user
        });
    } catch (err) {
        console.error(err);
        res.status(500).render('error', { title: 'Error', message: 'Failed to load categories', user: res.locals.user });
    }
});

router.post('/categories', async (req, res) => {
    const { name, slug, icon, display_order } = req.body;
    try {
        await db.query(
            'INSERT INTO store_categories (name, slug, icon, display_order) VALUES (?, ?, ?, ?)',
            [name, slug, icon || 'box', parseInt(display_order) || 0]
        );
        res.redirect('/admin/store/categories');
    } catch (err) {
        console.error(err);
        res.redirect('/admin/store/categories?error=Failed to create category');
    }
});

router.post('/categories/:id/delete', async (req, res) => {
    try {
        await db.query('DELETE FROM store_categories WHERE id = ?', [req.params.id]);
        res.redirect('/admin/store/categories');
    } catch (err) {
        console.error(err);
        res.redirect('/admin/store/categories?error=Failed to delete category');
    }
});

// ─── Items ──────────────────────────────────────────────────
router.get('/items', async (req, res) => {
    try {
        const [items] = await db.query(`
            SELECT si.*, sc.name AS category_name
            FROM store_items si
            JOIN store_categories sc ON sc.id = si.category_id
            ORDER BY sc.name, si.display_name
        `);
        const [categories] = await db.query('SELECT * FROM store_categories ORDER BY name');
        res.render('admin/store/items', {
            title: 'Store Items',
            items,
            categories,
            user: res.locals.user
        });
    } catch (err) {
        console.error(err);
        res.status(500).render('error', { title: 'Error', message: 'Failed to load items', user: res.locals.user });
    }
});

router.post('/items', async (req, res) => {
    const { category_id, class_name, display_name, description, item_type, base_price, stock, max_per_player } = req.body;
    try {
        await db.query(
            `INSERT INTO store_items (category_id, class_name, display_name, description, item_type, base_price, stock, max_per_player)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
            [category_id, class_name, display_name, description || null, item_type, parseInt(base_price) || 0, parseInt(stock) || -1, parseInt(max_per_player) || -1]
        );
        res.redirect('/admin/store/items');
    } catch (err) {
        console.error(err);
        res.redirect('/admin/store/items?error=Failed to create item');
    }
});

router.post('/items/:id/edit', async (req, res) => {
    const { category_id, class_name, display_name, description, item_type, base_price, stock, max_per_player, is_active } = req.body;
    try {
        await db.query(
            `UPDATE store_items SET category_id=?, class_name=?, display_name=?, description=?, item_type=?, base_price=?, stock=?, max_per_player=?, is_active=? WHERE id=?`,
            [category_id, class_name, display_name, description, item_type, parseInt(base_price), parseInt(stock) || -1, parseInt(max_per_player) || -1, is_active ? 1 : 0, req.params.id]
        );
        res.redirect('/admin/store/items');
    } catch (err) {
        console.error(err);
        res.redirect('/admin/store/items?error=Failed to update item');
    }
});

router.post('/items/:id/delete', async (req, res) => {
    try {
        await db.query('DELETE FROM store_items WHERE id = ?', [req.params.id]);
        res.redirect('/admin/store/items');
    } catch (err) {
        console.error(err);
        res.redirect('/admin/store/items?error=Failed to delete item');
    }
});

// ─── Bulk Import ────────────────────────────────────────────
router.get('/import', async (req, res) => {
    try {
        const [categories] = await db.query('SELECT * FROM store_categories ORDER BY name');
        res.render('admin/store/import', {
            title: 'Bulk Import Items',
            categories,
            user: res.locals.user
        });
    } catch (err) {
        console.error(err);
        res.status(500).render('error', { title: 'Error', message: 'Failed to load import page', user: res.locals.user });
    }
});

router.post('/import', async (req, res) => {
    const { category_id, class_names, item_type, base_price } = req.body;
    try {
        const lines = class_names
            .split('\n')
            .map(l => l.trim())
            .filter(l => l.length > 0 && !l.startsWith('//') && !l.startsWith('#'));

        let inserted = 0;
        let skipped = 0;

        for (const className of lines) {
            // Generate a display name from the class name (humanize it)
            const displayName = className
                .replace(/_/g, ' ')
                .replace(/([a-z])([A-Z])/g, '$1 $2')
                .replace(/\b\w/g, c => c.toUpperCase())
                .trim();

            try {
                await db.query(
                    `INSERT IGNORE INTO store_items (category_id, class_name, display_name, item_type, base_price, stock, is_active)
                     VALUES (?, ?, ?, ?, ?, -1, 1)`,
                    [category_id, className, displayName, item_type || 'misc', parseInt(base_price) || 0]
                );
                inserted++;
            } catch (err) {
                if (err.code === 'ER_DUP_ENTRY') {
                    skipped++;
                } else {
                    console.error(`Failed to import ${className}:`, err.message);
                }
            }
        }

        res.redirect(`/admin/store/items?success=Imported ${inserted} items (${skipped} duplicates skipped)`);
    } catch (err) {
        console.error(err);
        res.redirect('/admin/store/import?error=Import failed');
    }
});

// ─── Currency Management ────────────────────────────────────
router.get('/currency', async (req, res) => {
    try {
        const [balances] = await db.query(`
            SELECT pc.*, rm.discord_username, rm.nickname
            FROM player_currency pc
            JOIN roster_members rm ON rm.id = pc.user_id
            ORDER BY pc.balance DESC
            LIMIT 100
        `);
        const [players] = await db.query(`
            SELECT rm.id, rm.discord_username, rm.nickname, COALESCE(pc.balance, 0) AS balance
            FROM roster_members rm
            LEFT JOIN player_currency pc ON pc.user_id = rm.id
            ORDER BY rm.discord_username ASC
        `);
        res.render('admin/store/currency', {
            title: 'Currency Management',
            balances,
            players,
            user: res.locals.user
        });
    } catch (err) {
        console.error(err);
        res.status(500).render('error', { title: 'Error', message: 'Failed to load currency', user: res.locals.user });
    }
});

router.post('/currency/grant', async (req, res) => {
    const { user_id, amount, reason } = req.body;
    try {
        await db.query(
            'INSERT INTO player_currency (user_id, balance, lifetime_earned) VALUES (?, ?, ?) ON DUPLICATE KEY UPDATE balance = balance + ?, lifetime_earned = lifetime_earned + ?',
            [user_id, parseInt(amount), parseInt(amount), parseInt(amount), parseInt(amount)]
        );
        await db.query(
            'INSERT INTO currency_transactions (user_id, amount, balance_after, reason, source) VALUES (?, ?, (SELECT balance FROM player_currency WHERE user_id = ?), ?, ?)',
            [user_id, parseInt(amount), user_id, reason || 'Admin grant', 'admin_grant']
        );
        res.redirect('/admin/store/currency');
    } catch (err) {
        console.error(err);
        res.redirect('/admin/store/currency?error=Failed to grant currency');
    }
});

router.post('/currency/remove', async (req, res) => {
    const { user_id, amount, reason } = req.body;
    try {
        await db.query(
            'UPDATE player_currency SET balance = GREATEST(balance - ?, 0) WHERE user_id = ?',
            [parseInt(amount), user_id]
        );
        await db.query(
            'INSERT INTO currency_transactions (user_id, amount, balance_after, reason, source) VALUES (?, ?, (SELECT balance FROM player_currency WHERE user_id = ?), ?, ?)',
            [user_id, -parseInt(amount), user_id, reason || 'Admin removal', 'admin_remove']
        );
        res.redirect('/admin/store/currency');
    } catch (err) {
        console.error(err);
        res.redirect('/admin/store/currency?error=Failed to remove currency');
    }
});

// ─── Transactions ───────────────────────────────────────────
router.get('/transactions', async (req, res) => {
    try {
        const page = parseInt(req.query.page) || 1;
        const limit = 50;
        const offset = (page - 1) * limit;

        const [transactions] = await db.query(`
            SELECT st.*, si.display_name, rm.discord_username
            FROM store_transactions st
            JOIN store_items si ON si.id = st.item_id
            JOIN roster_members rm ON rm.id = st.user_id
            ORDER BY st.created_at DESC
            LIMIT ? OFFSET ?
        `, [limit, offset]);

        const [[{ total }]] = await db.query('SELECT COUNT(*) AS total FROM store_transactions');

        res.render('admin/store/transactions', {
            title: 'Store Transactions',
            transactions,
            page,
            totalPages: Math.ceil(total / limit),
            user: res.locals.user
        });
    } catch (err) {
        console.error(err);
        res.status(500).render('error', { title: 'Error', message: 'Failed to load transactions', user: res.locals.user });
    }
});

module.exports = router;
