const express = require('express');
const router = express.Router();
const db = require('../../config/database');
const { getMainOrbatId } = require('../../helpers/mainOrbat');
const { getPlatoons } = require('../../helpers/platoons');

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
            SELECT st.*, si.display_name, u.discord_global_name AS discord_username
            FROM store_transactions st
            JOIN store_items si ON si.id = st.item_id
            JOIN users u ON u.id = st.user_id
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
            user: res.locals.user,
            error: req.query.error || null
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
            user: res.locals.user,
            error: req.query.error || null,
            success: req.query.success || null
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
            user: res.locals.user,
            error: req.query.error || null
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
            SELECT pc.*, u.discord_username, u.discord_global_name
            FROM player_currency pc
            JOIN users u ON u.id = pc.user_id
            ORDER BY pc.balance DESC
            LIMIT 100
        `);
        const [players] = await db.query(`
            SELECT u.id, u.discord_username, u.discord_global_name, COALESCE(pc.balance, 0) AS balance
            FROM users u
            LEFT JOIN player_currency pc ON pc.user_id = u.id
            WHERE u.discord_id IS NOT NULL
            ORDER BY u.discord_global_name ASC
        `);
        res.render('admin/store/currency', {
            title: 'Currency Management',
            balances,
            players,
            user: res.locals.user,
            error: req.query.error || null
        });
    } catch (err) {
        console.error(err);
        res.status(500).render('error', { title: 'Error', message: 'Failed to load currency', user: res.locals.user });
    }
});

router.post('/currency/grant', async (req, res) => {
    const { user_id, reason } = req.body;
    const amount = parseInt(req.body.amount, 10);
    if (!user_id) {
        return res.redirect('/admin/store/currency?error=Please select a player');
    }
    if (!Number.isInteger(amount) || amount <= 0) {
        return res.redirect('/admin/store/currency?error=Enter a positive amount');
    }
    try {
        await db.query(
            'INSERT INTO player_currency (user_id, balance, lifetime_earned) VALUES (?, ?, ?) ON DUPLICATE KEY UPDATE balance = balance + ?, lifetime_earned = lifetime_earned + ?',
            [user_id, amount, amount, amount, amount]
        );
        await db.query(
            'INSERT INTO currency_transactions (user_id, amount, balance_after, reason, source) VALUES (?, ?, (SELECT balance FROM player_currency WHERE user_id = ?), ?, ?)',
            [user_id, amount, user_id, reason || 'Admin grant', 'admin_grant']
        );
        res.redirect('/admin/store/currency');
    } catch (err) {
        console.error(err);
        res.redirect('/admin/store/currency?error=Failed to grant currency');
    }
});

router.post('/currency/remove', async (req, res) => {
    const { user_id, reason } = req.body;
    const amount = parseInt(req.body.amount, 10);
    if (!user_id) {
        return res.redirect('/admin/store/currency?error=Please select a player');
    }
    if (!Number.isInteger(amount) || amount <= 0) {
        return res.redirect('/admin/store/currency?error=Enter a positive amount');
    }
    try {
        await db.query(
            'UPDATE player_currency SET balance = GREATEST(balance - ?, 0) WHERE user_id = ?',
            [amount, user_id]
        );
        await db.query(
            'INSERT INTO currency_transactions (user_id, amount, balance_after, reason, source) VALUES (?, ?, (SELECT balance FROM player_currency WHERE user_id = ?), ?, ?)',
            [user_id, -amount, user_id, reason || 'Admin removal', 'admin_remove']
        );
        res.redirect('/admin/store/currency');
    } catch (err) {
        console.error(err);
        res.redirect('/admin/store/currency?error=Failed to remove currency');
    }
});

// ─── Platoon Fund Management ────────────────────────────────
// Platoons are the root squads of the Main ORBAT; each owns a shared fund that
// vehicle purchases draw from. Admins top up / adjust those funds here.
router.get('/platoon-funds', async (req, res) => {
    try {
        const mainOrbatId = await getMainOrbatId();
        const platoons = await getPlatoons(mainOrbatId);

        let funds = [];
        if (platoons.length) {
            const ids = platoons.map(p => p.id);
            const [fundRows] = await db.query(
                'SELECT * FROM platoon_funds WHERE platoon_squad_id IN (?)',
                [ids]
            );
            const byId = {};
            fundRows.forEach(f => { byId[f.platoon_squad_id] = f; });
            funds = platoons.map(p => ({
                id: p.id,
                name: p.name,
                balance: byId[p.id]?.balance ?? 0,
                lifetime_earned: byId[p.id]?.lifetime_earned ?? 0,
                lifetime_spent: byId[p.id]?.lifetime_spent ?? 0
            }));
        }

        const [recent] = await db.query(`
            SELECT pft.*, os.name AS platoon_name, u.discord_global_name AS by_username
            FROM platoon_fund_transactions pft
            JOIN orbat_squads os ON os.id = pft.platoon_squad_id
            LEFT JOIN users u ON u.id = pft.created_by
            ORDER BY pft.created_at DESC
            LIMIT 20
        `);

        res.render('admin/store/platoon-funds', {
            title: 'Platoon Funds',
            hasMainOrbat: !!mainOrbatId,
            funds,
            recent,
            user: res.locals.user,
            error: req.query.error || null,
            success: req.query.success || null
        });
    } catch (err) {
        console.error('Admin platoon funds error:', err);
        res.status(500).render('error', { title: 'Error', message: 'Failed to load platoon funds', user: res.locals.user });
    }
});

// Shared helper: adjust a platoon fund by `delta` (signed) and log it.
async function adjustPlatoonFund(platoonId, delta, reason, source, createdBy) {
    const conn = await db.getConnection();
    try {
        await conn.beginTransaction();
        let [funds] = await conn.query(
            'SELECT balance FROM platoon_funds WHERE platoon_squad_id = ? FOR UPDATE',
            [platoonId]
        );
        if (!funds.length) {
            await conn.query('INSERT INTO platoon_funds (platoon_squad_id, balance) VALUES (?, 0)', [platoonId]);
            funds = [{ balance: 0 }];
        }
        const current = funds[0].balance;
        // Never let a removal push the balance below zero.
        const newBalance = Math.max(current + delta, 0);
        const applied = newBalance - current; // the actual signed change

        if (applied >= 0) {
            await conn.query(
                'UPDATE platoon_funds SET balance = ?, lifetime_earned = lifetime_earned + ? WHERE platoon_squad_id = ?',
                [newBalance, applied, platoonId]
            );
        } else {
            await conn.query(
                'UPDATE platoon_funds SET balance = ?, lifetime_spent = lifetime_spent + ? WHERE platoon_squad_id = ?',
                [newBalance, -applied, platoonId]
            );
        }

        await conn.query(
            'INSERT INTO platoon_fund_transactions (platoon_squad_id, amount, balance_after, reason, source, created_by) VALUES (?, ?, ?, ?, ?, ?)',
            [platoonId, applied, newBalance, reason, source, createdBy]
        );
        await conn.commit();
    } catch (err) {
        await conn.rollback();
        throw err;
    } finally {
        conn.release();
    }
}

router.post('/platoon-funds/grant', async (req, res) => {
    const platoonId = parseInt(req.body.platoon_id, 10);
    const amount = parseInt(req.body.amount, 10);
    const reason = req.body.reason;
    if (!Number.isInteger(platoonId)) {
        return res.redirect('/admin/store/platoon-funds?error=Please select a platoon');
    }
    if (!Number.isInteger(amount) || amount <= 0) {
        return res.redirect('/admin/store/platoon-funds?error=Enter a positive amount');
    }
    try {
        await adjustPlatoonFund(platoonId, amount, reason || 'Admin grant', 'admin_grant', res.locals.user.id);
        res.redirect('/admin/store/platoon-funds?success=Fund topped up');
    } catch (err) {
        console.error('Grant platoon fund error:', err);
        res.redirect('/admin/store/platoon-funds?error=Failed to grant funds');
    }
});

router.post('/platoon-funds/remove', async (req, res) => {
    const platoonId = parseInt(req.body.platoon_id, 10);
    const amount = parseInt(req.body.amount, 10);
    const reason = req.body.reason;
    if (!Number.isInteger(platoonId)) {
        return res.redirect('/admin/store/platoon-funds?error=Please select a platoon');
    }
    if (!Number.isInteger(amount) || amount <= 0) {
        return res.redirect('/admin/store/platoon-funds?error=Enter a positive amount');
    }
    try {
        await adjustPlatoonFund(platoonId, -amount, reason || 'Admin removal', 'admin_remove', res.locals.user.id);
        res.redirect('/admin/store/platoon-funds?success=Fund adjusted');
    } catch (err) {
        console.error('Remove platoon fund error:', err);
        res.redirect('/admin/store/platoon-funds?error=Failed to remove funds');
    }
});

// ─── Transactions ───────────────────────────────────────────
router.get('/transactions', async (req, res) => {
    try {
        const page = parseInt(req.query.page) || 1;
        const limit = 50;
        const offset = (page - 1) * limit;

        const [transactions] = await db.query(`
            SELECT st.*, si.display_name, u.discord_global_name AS discord_username
            FROM store_transactions st
            JOIN store_items si ON si.id = st.item_id
            JOIN users u ON u.id = st.user_id
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

// ─── Inventory Management ──────────────────────────────────
router.get('/inventory', async (req, res) => {
    try {
        const [players] = await db.query(`
            SELECT u.id, u.discord_username, u.discord_global_name
            FROM users u
            WHERE u.discord_id IS NOT NULL
            ORDER BY u.discord_global_name ASC
        `);
        const [items] = await db.query(`
            SELECT si.id, si.display_name, si.class_name, si.item_type, sc.name AS category_name
            FROM store_items si
            JOIN store_categories sc ON sc.id = si.category_id
            WHERE si.is_active = 1
            ORDER BY sc.name, si.display_name
        `);

        let playerInventory = [];
        let selectedPlayer = null;
        if (req.query.user_id) {
            const [playersFound] = await db.query(
                'SELECT id, discord_username, discord_global_name FROM users WHERE id = ?',
                [req.query.user_id]
            );
            if (playersFound.length) {
                selectedPlayer = playersFound[0];
                [playerInventory] = await db.query(`
                    SELECT pi.id AS inventory_id, pi.quantity, pi.source, pi.acquired_at,
                           si.id AS item_id, si.display_name, si.class_name, si.item_type, si.base_price,
                           sc.name AS category_name
                    FROM player_inventory pi
                    JOIN store_items si ON si.id = pi.item_id
                    JOIN store_categories sc ON sc.id = si.category_id
                    WHERE pi.user_id = ?
                    ORDER BY sc.name, si.display_name
                `, [req.query.user_id]);
            }
        }

        res.render('admin/store/inventory', {
            title: 'Inventory Management',
            players,
            items,
            selectedPlayer,
            playerInventory,
            user: res.locals.user,
            error: req.query.error || null,
            success: req.query.success || null
        });
    } catch (err) {
        console.error('Admin inventory error:', err);
        res.status(500).render('error', { title: 'Error', message: 'Failed to load inventory management', user: res.locals.user });
    }
});

router.post('/inventory/grant', async (req, res) => {
    const { user_id, item_id, quantity } = req.body;
    if (!user_id || !item_id || !quantity || quantity < 1) {
        return res.redirect('/admin/store/inventory?error=Invalid request');
    }

    try {
        const [items] = await db.query('SELECT display_name FROM store_items WHERE id = ?', [item_id]);
        if (!items.length) {
            return res.redirect('/admin/store/inventory?error=Item not found');
        }

        await db.query(`
            INSERT INTO player_inventory (user_id, item_id, quantity, source)
            VALUES (?, ?, ?, 'grant')
            ON DUPLICATE KEY UPDATE quantity = quantity + ?
        `, [user_id, item_id, parseInt(quantity), parseInt(quantity)]);

        await db.query(`
            INSERT INTO store_transactions (user_id, item_id, quantity, unit_price, total_price, transaction_type)
            VALUES (?, ?, ?, 0, 0, 'grant')
        `, [user_id, item_id, parseInt(quantity)]);

        res.redirect(`/admin/store/inventory?user_id=${user_id}&success=Granted ${quantity}x ${items[0].display_name}`);
    } catch (err) {
        console.error('Grant inventory error:', err);
        res.redirect(`/admin/store/inventory?user_id=${user_id}&error=Failed to grant item`);
    }
});

router.post('/inventory/remove', async (req, res) => {
    const { user_id, inventory_id, quantity } = req.body;
    if (!user_id || !inventory_id || !quantity || quantity < 1) {
        return res.redirect(`/admin/store/inventory?user_id=${user_id}&error=Invalid request`);
    }

    try {
        const [rows] = await db.query(
            'SELECT pi.item_id, pi.quantity, si.display_name FROM player_inventory pi JOIN store_items si ON si.id = pi.item_id WHERE pi.id = ? AND pi.user_id = ?',
            [inventory_id, user_id]
        );
        if (!rows.length) {
            return res.redirect(`/admin/store/inventory?user_id=${user_id}&error=Inventory entry not found`);
        }

        const itemId = rows[0].item_id;
        const currentQty = rows[0].quantity;
        const removeQty = Math.min(parseInt(quantity), currentQty);

        if (removeQty >= currentQty) {
            await db.query('DELETE FROM player_inventory WHERE id = ? AND user_id = ?', [inventory_id, user_id]);
        } else {
            await db.query(
                'UPDATE player_inventory SET quantity = quantity - ? WHERE id = ? AND user_id = ?',
                [removeQty, inventory_id, user_id]
            );
        }

        // Capture item_id before the DELETE above so the refund log never records NULL.
        await db.query(`
            INSERT INTO store_transactions (user_id, item_id, quantity, unit_price, total_price, transaction_type)
            VALUES (?, ?, ?, 0, 0, 'refund')
        `, [user_id, itemId, -removeQty]);

        res.redirect(`/admin/store/inventory?user_id=${user_id}&success=Removed ${removeQty}x ${rows[0].display_name}`);
    } catch (err) {
        console.error('Remove inventory error:', err);
        res.redirect(`/admin/store/inventory?user_id=${user_id}&error=Failed to remove item`);
    }
});

module.exports = router;
