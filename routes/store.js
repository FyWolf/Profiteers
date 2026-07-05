const express = require('express');
const router = express.Router();
const db = require('../config/database');

// ─── Middleware ──────────────────────────────────────────────
function requireAuth(req, res, next) {
    if (!req.isAuthenticated()) return res.redirect('/login');
    next();
}

// ─── Store Home ──────────────────────────────────────────────
router.get('/', requireAuth, async (req, res) => {
    try {
        const [categories] = await db.query(`
            SELECT sc.*, COUNT(si.id) AS item_count
            FROM store_categories sc
            LEFT JOIN store_items si ON si.category_id = sc.id AND si.is_active = 1
            GROUP BY sc.id
            ORDER BY sc.display_order, sc.name
        `);
        const [currency] = await db.query(
            'SELECT balance FROM player_currency WHERE user_id = ?',
            [res.locals.user.id]
        );
        res.render('store/index', {
            title: 'Store',
            categories,
            balance: currency?.[0]?.balance ?? 0,
            user: res.locals.user
        });
    } catch (err) {
        console.error('Store home error:', err);
        res.status(500).render('error', { title: 'Error', message: 'Failed to load store', user: res.locals.user });
    }
});

// ─── Category / Item Listing ────────────────────────────────
router.get('/category/:slug', requireAuth, async (req, res) => {
    try {
        const [categories] = await db.query('SELECT * FROM store_categories WHERE slug = ?', [req.params.slug]);
        if (!categories.length) return res.redirect('/store');
        const category = categories[0];

        const [items] = await db.query(`
            SELECT si.*, COALESCE(pi.quantity, 0) AS owned_qty
            FROM store_items si
            LEFT JOIN player_inventory pi ON pi.item_id = si.id AND pi.user_id = ?
            WHERE si.category_id = ? AND si.is_active = 1
            ORDER BY si.item_type, si.display_name
        `, [res.locals.user.id, category.id]);

        const [currency] = await db.query(
            'SELECT balance FROM player_currency WHERE user_id = ?',
            [res.locals.user.id]
        );

        res.render('store/category', {
            title: category.name,
            category,
            items,
            balance: currency?.[0]?.balance ?? 0,
            user: res.locals.user
        });
    } catch (err) {
        console.error('Store category error:', err);
        res.status(500).render('error', { title: 'Error', message: 'Failed to load category', user: res.locals.user });
    }
});

// ─── API: Purchase Item ─────────────────────────────────────
router.post('/api/buy', requireAuth, async (req, res) => {
    const { itemId, quantity = 1 } = req.body;
    const userId = res.locals.user.id;

    if (!itemId || quantity < 1) {
        return res.status(400).json({ success: false, error: 'Invalid request' });
    }

    const conn = await db.getConnection();
    try {
        await conn.beginTransaction();

        // Get item
        const [items] = await conn.query(
            'SELECT * FROM store_items WHERE id = ? AND is_active = 1 FOR UPDATE',
            [itemId]
        );
        if (!items.length) {
            await conn.rollback();
            return res.status(404).json({ success: false, error: 'Item not found' });
        }
        const item = items[0];

        // Check stock
        if (item.stock !== -1 && item.stock < quantity) {
            await conn.rollback();
            return res.status(400).json({ success: false, error: 'Not enough stock' });
        }

        // Check max per player
        if (item.max_per_player !== -1) {
            const [owned] = await conn.query(
                'SELECT COALESCE(SUM(quantity), 0) AS qty FROM player_inventory WHERE user_id = ? AND item_id = ?',
                [userId, itemId]
            );
            if (owned[0].qty + quantity > item.max_per_player) {
                await conn.rollback();
                return res.status(400).json({ success: false, error: 'You already own the maximum allowed of this item' });
            }
        }

        // Get or create wallet
        let [wallets] = await conn.query(
            'SELECT * FROM player_currency WHERE user_id = ? FOR UPDATE',
            [userId]
        );
        if (!wallets.length) {
            await conn.query(
                'INSERT INTO player_currency (user_id, balance) VALUES (?, 0)',
                [userId]
            );
            wallets = [{ balance: 0, lifetime_earned: 0, lifetime_spent: 0 }];
        }
        const wallet = wallets[0];
        const totalPrice = item.base_price * quantity;

        if (wallet.balance < totalPrice) {
            await conn.rollback();
            return res.status(400).json({ success: false, error: 'Insufficient funds' });
        }

        // Deduct currency
        await conn.query(
            'UPDATE player_currency SET balance = balance - ?, lifetime_spent = lifetime_spent + ? WHERE user_id = ?',
            [totalPrice, totalPrice, userId]
        );

        // Add/update inventory
        await conn.query(`
            INSERT INTO player_inventory (user_id, item_id, quantity, source)
            VALUES (?, ?, ?, 'purchase')
            ON DUPLICATE KEY UPDATE quantity = quantity + ?
        `, [userId, itemId, quantity, quantity]);

        // Log transaction
        await conn.query(`
            INSERT INTO store_transactions (user_id, item_id, quantity, unit_price, total_price, transaction_type)
            VALUES (?, ?, ?, ?, ?, 'purchase')
        `, [userId, itemId, quantity, item.base_price, totalPrice]);

        // Log currency transaction
        await conn.query(`
            INSERT INTO currency_transactions (user_id, amount, balance_after, reason, source)
            VALUES (?, ?, ?, ?, 'purchase')
        `, [userId, -totalPrice, wallet.balance - totalPrice, `Purchased ${quantity}x ${item.display_name}`]);

        // Deduct stock if limited
        if (item.stock !== -1) {
            await conn.query('UPDATE store_items SET stock = stock - ? WHERE id = ?', [quantity, itemId]);
        }

        await conn.commit();
        res.json({ success: true, balance: wallet.balance - totalPrice });
    } catch (err) {
        await conn.rollback();
        console.error('Purchase error:', err);
        res.status(500).json({ success: false, error: 'Transaction failed' });
    } finally {
        conn.release();
    }
});

// ─── Helper: Get users.id from steam_id ────────────────────
async function getUserIdBySteamId(steamId) {
    const [rows] = await db.query(
        'SELECT id FROM users WHERE steam_id = ?',
        [steamId]
    );
    return rows.length ? rows[0].id : null;
}

// ─── API: Get Player Inventory (used by Arma addon) ─────────
router.get('/api/inventory/:steamId', async (req, res) => {
    try {
        const userId = await getUserIdBySteamId(req.params.steamId);
        if (!userId) return res.json({ items: [] });

        const [items] = await db.query(`
            SELECT si.class_name, si.item_type, pi.quantity
            FROM player_inventory pi
            JOIN store_items si ON si.id = pi.item_id
            WHERE pi.user_id = ? AND pi.quantity > 0 AND si.is_active = 1
        `, [userId]);

        res.json({ items });
    } catch (err) {
        console.error('Inventory API error:', err);
        res.status(500).json({ error: 'Server error' });
    }
});

// ─── API: Get Player Balance (used by Arma addon) ───────────
router.get('/api/balance/:steamId', async (req, res) => {
    try {
        const userId = await getUserIdBySteamId(req.params.steamId);
        if (!userId) return res.json({ balance: 0 });

        const [currency] = await db.query(
            'SELECT balance FROM player_currency WHERE user_id = ?',
            [userId]
        );
        res.json({ balance: currency?.[0]?.balance ?? 0 });
    } catch (err) {
        console.error('Balance API error:', err);
        res.status(500).json({ error: 'Server error' });
    }
});

// ─── API: Save Loadout ──────────────────────────────────────
router.post('/api/loadout/save', requireAuth, async (req, res) => {
    const { name, loadoutData, isDefault } = req.body;
    const userId = res.locals.user.id;

    if (!name || !loadoutData) {
        return res.status(400).json({ success: false, error: 'Name and loadout data required' });
    }

    try {
        if (isDefault) {
            await db.query('UPDATE player_loadouts SET is_default = 0 WHERE user_id = ?', [userId]);
        }
        await db.query(`
            INSERT INTO player_loadouts (user_id, name, loadout_data, is_default)
            VALUES (?, ?, ?, ?)
        `, [userId, name, JSON.stringify(loadoutData), isDefault ? 1 : 0]);

        res.json({ success: true });
    } catch (err) {
        console.error('Save loadout error:', err);
        res.status(500).json({ success: false, error: 'Failed to save loadout' });
    }
});

// ─── API: Get Loadouts ──────────────────────────────────────
router.get('/api/loadouts/:steamId', async (req, res) => {
    try {
        const userId = await getUserIdBySteamId(req.params.steamId);
        if (!userId) return res.json({ loadouts: [] });

        const [loadouts] = await db.query(
            'SELECT id, name, loadout_data, is_default FROM player_loadouts WHERE user_id = ? ORDER BY is_default DESC, updated_at DESC',
            [userId]
        );
        res.json({ loadouts });
    } catch (err) {
        console.error('Loadouts API error:', err);
        res.status(500).json({ error: 'Server error' });
    }
});

// ─── API: Delete Loadout ────────────────────────────────────
router.delete('/api/loadout/:id', requireAuth, async (req, res) => {
    try {
        await db.query(
            'DELETE FROM player_loadouts WHERE id = ? AND user_id = ?',
            [req.params.id, res.locals.user.id]
        );
        res.json({ success: true });
    } catch (err) {
        console.error('Delete loadout error:', err);
        res.status(500).json({ success: false, error: 'Failed to delete loadout' });
    }
});

module.exports = router;
