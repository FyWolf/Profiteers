const express = require('express');
const router = express.Router();
const db = require('../config/database');
const { getMainOrbatId } = require('../helpers/mainOrbat');
const { getUserPlatoon } = require('../helpers/platoons');

// ─── Middleware ──────────────────────────────────────────────
function requireAuth(req, res, next) {
    if (!req.isAuthenticated()) return res.redirect('/login');
    next();
}

// ─── Browse helpers ──────────────────────────────────────────
const ITEM_TYPES = ['weapon', 'magazine', 'attachment', 'uniform', 'vest', 'helmet', 'backpack', 'item', 'grenade', 'explosive', 'misc'];
const SORTS = {
    name:       'si.display_name ASC',
    price_asc:  'si.base_price ASC, si.display_name ASC',
    price_desc: 'si.base_price DESC, si.display_name ASC',
    newest:     'si.id DESC'
};
const PER_PAGE_OPTIONS = [24, 48, 96, 192];
const DEFAULT_PER_PAGE = 48;

// Normalize a query param that may be a string, a comma-list, or a repeated key.
function toArray(v) {
    if (v === undefined || v === null || v === '') return [];
    const arr = Array.isArray(v) ? v : String(v).split(',');
    return arr.map(s => String(s).trim()).filter(Boolean);
}

// Numeric stats (from the store_items.stats JSON) offered as min/max range
// filters. They're shown only when the current result set actually contains
// them. `key` is the exact JSON label emitted by the arsenal export; `slug` is
// the URL-param stem (?<slug>Min / ?<slug>Max). `key` is a fixed constant here
// (never user input), so it is safe to inline into a JSON path.
const STAT_FILTERS = [
    { slug: 'capacity', key: 'Capacity',          label: 'Capacity' },
    { slug: 'weight',   key: 'Weight',            label: 'Weight' },
    { slug: 'muzzle',   key: 'Muzzle velocity',   label: 'Muzzle velocity' },
    { slug: 'magcap',   key: 'Magazine capacity', label: 'Magazine capacity' },
    { slug: 'rounds',   key: 'Rounds',            label: 'Rounds' },
    { slug: 'armorHead',    key: 'Armor: Head',    label: 'Head armor' },
    { slug: 'armorChest',   key: 'Armor: Chest',   label: 'Chest armor' },
    { slug: 'armorBody',    key: 'Armor: Body',    label: 'Body armor' },
    { slug: 'armorArms',    key: 'Armor: Arms',    label: 'Arm armor' },
    { slug: 'armorStomach', key: 'Armor: Stomach', label: 'Stomach armor' },
    { slug: 'armorAbdomen', key: 'Armor: Abdomen', label: 'Abdomen armor' },
    { slug: 'armorPelvis',  key: 'Armor: Pelvis',  label: 'Pelvis armor' },
    { slug: 'armorLegs',    key: 'Armor: Legs',    label: 'Leg armor' }
];

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

// ─── Browse (search / filter / sort / paginate) ─────────────
router.get('/browse', requireAuth, async (req, res) => {
    try {
        const userId = res.locals.user.id;

        const q     = (req.query.q || '').trim();
        const types = toArray(req.query.type).filter(t => ITEM_TYPES.includes(t));
        const cats  = toArray(req.query.category).map(n => parseInt(n, 10)).filter(Number.isInteger);
        const min   = (req.query.min ?? '') !== '' ? parseInt(req.query.min, 10) : null;
        const max   = (req.query.max ?? '') !== '' ? parseInt(req.query.max, 10) : null;
        const avail = req.query.avail === 'in_stock' ? 'in_stock' : '';
        const owned = ['owned', 'not'].includes(req.query.owned) ? req.query.owned : '';
        const sort  = SORTS[req.query.sort] ? req.query.sort : 'name';
        let perPage = parseInt(req.query.perPage, 10);
        if (!PER_PAGE_OPTIONS.includes(perPage)) perPage = DEFAULT_PER_PAGE;
        let page    = parseInt(req.query.page, 10);
        if (!Number.isInteger(page) || page < 1) page = 1;

        // Per-stat numeric ranges, e.g. ?capacityMin=50&capacityMax=200.
        const statFilters = {};
        for (const sf of STAT_FILTERS) {
            const rawMin = req.query[sf.slug + 'Min'];
            const rawMax = req.query[sf.slug + 'Max'];
            const mn = (rawMin ?? '') !== '' ? parseFloat(rawMin) : null;
            const mx = (rawMax ?? '') !== '' ? parseFloat(rawMax) : null;
            const okMin = mn !== null && !Number.isNaN(mn);
            const okMax = mx !== null && !Number.isNaN(mx);
            if (okMin || okMax) statFilters[sf.slug] = { min: okMin ? mn : null, max: okMax ? mx : null };
        }

        // Build a parameterized WHERE from the active filters. `omit` lets a
        // facet-count query drop its own group so those counts stay meaningful.
        const buildWhere = (omit = {}) => {
            // Vehicles are platoon assets bought from the shared fund — they live
            // in the dedicated /store/vehicles page, never the personal browse.
            const clauses = ['si.is_active = 1', "si.item_type <> 'vehicle'"];
            const params = [];
            if (q) {
                clauses.push('(si.display_name LIKE ? OR si.class_name LIKE ?)');
                params.push(`%${q}%`, `%${q}%`);
            }
            if (!omit.type && types.length)     { clauses.push('si.item_type IN (?)');   params.push(types); }
            if (!omit.category && cats.length)  { clauses.push('si.category_id IN (?)');  params.push(cats); }
            if (min !== null && !Number.isNaN(min)) { clauses.push('si.base_price >= ?'); params.push(min); }
            if (max !== null && !Number.isNaN(max)) { clauses.push('si.base_price <= ?'); params.push(max); }
            if (avail) clauses.push('(si.stock = -1 OR si.stock > 0)');
            if (owned === 'owned')    clauses.push('pi.quantity > 0');
            else if (owned === 'not') clauses.push('(pi.quantity IS NULL OR pi.quantity = 0)');
            if (!omit.stats) {
                for (const sf of STAT_FILTERS) {
                    const f = statFilters[sf.slug];
                    if (!f) continue;
                    // sf.key is a fixed catalog constant (not user input) → safe to
                    // inline into the JSON path; the min/max values stay parameterized.
                    const expr = `CAST(JSON_VALUE(si.stats, '$."${sf.key}"') AS DECIMAL(12,2))`;
                    if (f.min !== null) { clauses.push(`${expr} >= ?`); params.push(f.min); }
                    if (f.max !== null) { clauses.push(`${expr} <= ?`); params.push(f.max); }
                }
            }
            return { where: clauses.join(' AND '), params };
        };

        const join = 'LEFT JOIN player_inventory pi ON pi.item_id = si.id AND pi.user_id = ?';
        const w = buildWhere();

        const [[{ total }]] = await db.query(
            `SELECT COUNT(*) AS total FROM store_items si ${join} WHERE ${w.where}`,
            [userId, ...w.params]
        );
        const totalPages = Math.max(1, Math.ceil(total / perPage));
        if (page > totalPages) page = totalPages;

        const [items] = await db.query(
            `SELECT si.*, COALESCE(pi.quantity, 0) AS owned_qty,
                    sc.name AS category_name, sc.slug AS category_slug
             FROM store_items si
             ${join}
             JOIN store_categories sc ON sc.id = si.category_id
             WHERE ${w.where}
             ORDER BY ${SORTS[sort]}
             LIMIT ? OFFSET ?`,
            [userId, ...w.params, perPage, (page - 1) * perPage]
        );

        // Facet counts — each query omits its own group so the numbers reflect
        // "how many would match if I also picked this".
        const wc = buildWhere({ category: true });
        const [catFacet] = await db.query(
            `SELECT sc.id, sc.name, COUNT(*) AS cnt
             FROM store_items si ${join}
             JOIN store_categories sc ON sc.id = si.category_id
             WHERE ${wc.where}
             GROUP BY sc.id, sc.name
             ORDER BY sc.name`,
            [userId, ...wc.params]
        );
        const wt = buildWhere({ type: true });
        const [typeFacet] = await db.query(
            `SELECT si.item_type, COUNT(*) AS cnt
             FROM store_items si ${join}
             WHERE ${wt.where}
             GROUP BY si.item_type`,
            [userId, ...wt.params]
        );

        // Contextual stat ranges: over the current result set (ignoring the stat
        // filters themselves), find which numeric stats are present and their
        // available min/max — so only relevant range filters are offered.
        const ws = buildWhere({ stats: true });
        const boundsSel = STAT_FILTERS.map(sf => {
            const p = `JSON_VALUE(si.stats, '$."${sf.key}"')`;
            return `COUNT(${p}) AS \`${sf.slug}_cnt\`, ` +
                   `MIN(CAST(${p} AS DECIMAL(12,2))) AS \`${sf.slug}_min\`, ` +
                   `MAX(CAST(${p} AS DECIMAL(12,2))) AS \`${sf.slug}_max\``;
        }).join(', ');
        const [[bounds]] = await db.query(
            `SELECT ${boundsSel} FROM store_items si ${join} WHERE ${ws.where}`,
            [userId, ...ws.params]
        );
        const statFacets = [];
        for (const sf of STAT_FILTERS) {
            const cnt = Number(bounds[`${sf.slug}_cnt`] || 0);
            const active = !!statFilters[sf.slug];
            const bmin = bounds[`${sf.slug}_min`];
            const bmax = bounds[`${sf.slug}_max`];
            const hasRange = bmin !== null && bmax !== null && Number(bmax) > Number(bmin);
            if ((cnt <= 0 || !hasRange) && !active) continue;
            const cur = statFilters[sf.slug] || {};
            statFacets.push({
                slug: sf.slug, label: sf.label, cnt,
                min: bmin !== null ? Number(bmin) : '',
                max: bmax !== null ? Number(bmax) : '',
                curMin: cur.min ?? '', curMax: cur.max ?? ''
            });
        }

        const [currency] = await db.query('SELECT balance FROM player_currency WHERE user_id = ?', [userId]);

        // Canonical query string (without page) for pagination links.
        const usp = new URLSearchParams();
        if (q) usp.set('q', q);
        types.forEach(t => usp.append('type', t));
        cats.forEach(c => usp.append('category', c));
        if (min !== null) usp.set('min', String(min));
        if (max !== null) usp.set('max', String(max));
        if (avail) usp.set('avail', avail);
        if (owned) usp.set('owned', owned);
        if (sort !== 'name') usp.set('sort', sort);
        if (perPage !== DEFAULT_PER_PAGE) usp.set('perPage', String(perPage));
        for (const sf of STAT_FILTERS) {
            const f = statFilters[sf.slug];
            if (!f) continue;
            if (f.min !== null) usp.set(sf.slug + 'Min', String(f.min));
            if (f.max !== null) usp.set(sf.slug + 'Max', String(f.max));
        }

        res.render('store/browse', {
            title: 'Browse Store',
            items, total, totalPages, page, perPage,
            perPageOptions: PER_PAGE_OPTIONS,
            from: total ? (page - 1) * perPage + 1 : 0,
            to: Math.min(page * perPage, total),
            catFacet, typeFacet, statFacets,
            filters: { q, types, cats, min, max, avail, owned, sort },
            baseQs: usp.toString(),
            balance: currency?.[0]?.balance ?? 0,
            user: res.locals.user
        });
    } catch (err) {
        console.error('Store browse error:', err);
        res.status(500).render('error', { title: 'Error', message: 'Failed to load store', user: res.locals.user });
    }
});

// ─── Category → browse (kept so old links / bookmarks still work) ───
router.get('/category/:slug', requireAuth, async (req, res) => {
    try {
        const [rows] = await db.query('SELECT id FROM store_categories WHERE slug = ?', [req.params.slug]);
        if (!rows.length) return res.redirect('/store');
        return res.redirect('/store/browse?category=' + rows[0].id);
    } catch (err) {
        console.error('Store category redirect error:', err);
        return res.redirect('/store');
    }
});

// ─── Item Detail Page ───────────────────────────────────────
router.get('/item/:id', requireAuth, async (req, res) => {
    try {
        const itemId = parseInt(req.params.id, 10);
        if (!Number.isInteger(itemId)) return res.redirect('/store');

        const [items] = await db.query(`
            SELECT si.*, sc.name AS category_name, sc.slug AS category_slug,
                   COALESCE(pi.quantity, 0) AS owned_qty
            FROM store_items si
            JOIN store_categories sc ON sc.id = si.category_id
            LEFT JOIN player_inventory pi ON pi.item_id = si.id AND pi.user_id = ?
            WHERE si.id = ? AND si.is_active = 1
        `, [res.locals.user.id, itemId]);

        if (!items.length) return res.redirect('/store');
        const item = items[0];

        // Gallery: the auto preview + any in-game screenshots (mostly vehicles).
        const [gallery] = await db.query(
            'SELECT url, kind, angle FROM store_item_images WHERE item_id = ? ORDER BY kind = "preview" DESC, sort ASC, id ASC',
            [itemId]
        );

        // stats is a JSON column — mysql2 returns it already parsed, but guard
        // for a string, then flatten to an array of [label, value] for the view.
        let stats = item.stats;
        if (typeof stats === 'string') {
            try { stats = JSON.parse(stats); } catch (e) { stats = null; }
        }
        const statEntries = (stats && typeof stats === 'object') ? Object.entries(stats) : [];

        const [currency] = await db.query(
            'SELECT balance FROM player_currency WHERE user_id = ?',
            [res.locals.user.id]
        );

        res.render('store/item', {
            title: item.display_name,
            item,
            statEntries,
            gallery,
            balance: currency?.[0]?.balance ?? 0,
            user: res.locals.user
        });
    } catch (err) {
        console.error('Store item error:', err);
        res.status(500).render('error', { title: 'Error', message: 'Failed to load item', user: res.locals.user });
    }
});

// ─── Platoon Vehicle Store ──────────────────────────────────
// Vehicles are platoon-wide assets: the viewer's platoon (a root squad of the
// Main ORBAT) owns a shared fund and an inventory. Anyone can view; only members
// with store.vehicles.purchase can buy, and always for their own platoon.
router.get('/vehicles', requireAuth, async (req, res) => {
    try {
        const userId = res.locals.user.id;
        const canBuy = Array.isArray(res.locals.user.permissions)
            && res.locals.user.permissions.includes('store.vehicles.purchase');

        const mainOrbatId = await getMainOrbatId();
        const platoon = mainOrbatId ? await getUserPlatoon(userId, mainOrbatId) : null;

        let fund = null;
        let owned = [];
        if (platoon) {
            const [funds] = await db.query(
                'SELECT * FROM platoon_funds WHERE platoon_squad_id = ?',
                [platoon.id]
            );
            fund = funds[0] || { platoon_squad_id: platoon.id, balance: 0, lifetime_earned: 0, lifetime_spent: 0 };

            const [ownedRows] = await db.query(`
                SELECT pv.quantity, pv.acquired_at, si.*
                FROM platoon_vehicles pv
                JOIN store_items si ON si.id = pv.item_id
                WHERE pv.platoon_squad_id = ?
                ORDER BY si.display_name
            `, [platoon.id]);
            owned = ownedRows;
        }

        const [vehicles] = await db.query(`
            SELECT si.*, sc.name AS category_name, sc.slug AS category_slug
            FROM store_items si
            JOIN store_categories sc ON sc.id = si.category_id
            WHERE si.is_active = 1 AND si.item_type = 'vehicle'
            ORDER BY si.display_name
        `);

        res.render('store/vehicles', {
            title: 'Platoon Vehicles',
            platoon, fund, owned, vehicles, canBuy,
            balance: fund ? fund.balance : 0,
            user: res.locals.user
        });
    } catch (err) {
        console.error('Platoon vehicles error:', err);
        res.status(500).render('error', { title: 'Error', message: 'Failed to load platoon vehicles', user: res.locals.user });
    }
});

// ─── API: Buy Platoon Vehicle (shared fund) ─────────────────
router.post('/api/vehicles/buy', requireAuth, async (req, res) => {
    const perms = res.locals.user.permissions || [];
    if (!perms.includes('store.vehicles.purchase')) {
        return res.status(403).json({ success: false, error: 'You do not have permission to buy platoon vehicles' });
    }

    const { itemId } = req.body;
    const quantity = parseInt(req.body.quantity ?? 1, 10);
    const userId = res.locals.user.id;

    if (!itemId || !Number.isInteger(quantity) || quantity < 1) {
        return res.status(400).json({ success: false, error: 'Invalid request' });
    }

    // Buyers always purchase for their own platoon (derived from the Main ORBAT),
    // which is what ties the fund/inventory to a platoon and enforces membership.
    const mainOrbatId = await getMainOrbatId();
    const platoon = mainOrbatId ? await getUserPlatoon(userId, mainOrbatId) : null;
    if (!platoon) {
        return res.status(400).json({ success: false, error: 'You are not assigned to a platoon in the Main ORBAT' });
    }

    const conn = await db.getConnection();
    try {
        await conn.beginTransaction();

        const [items] = await conn.query(
            "SELECT * FROM store_items WHERE id = ? AND is_active = 1 AND item_type = 'vehicle' FOR UPDATE",
            [itemId]
        );
        if (!items.length) {
            await conn.rollback();
            return res.status(404).json({ success: false, error: 'Vehicle not found' });
        }
        const item = items[0];

        if (item.stock !== -1 && item.stock < quantity) {
            await conn.rollback();
            return res.status(400).json({ success: false, error: 'Not enough stock' });
        }

        // Get or create the platoon fund, locked for the balance check.
        let [funds] = await conn.query(
            'SELECT * FROM platoon_funds WHERE platoon_squad_id = ? FOR UPDATE',
            [platoon.id]
        );
        if (!funds.length) {
            await conn.query('INSERT INTO platoon_funds (platoon_squad_id, balance) VALUES (?, 0)', [platoon.id]);
            funds = [{ balance: 0 }];
        }
        const fund = funds[0];
        const totalPrice = item.base_price * quantity;

        if (fund.balance < totalPrice) {
            await conn.rollback();
            return res.status(400).json({ success: false, error: 'Insufficient platoon funds' });
        }

        await conn.query(
            'UPDATE platoon_funds SET balance = balance - ?, lifetime_spent = lifetime_spent + ? WHERE platoon_squad_id = ?',
            [totalPrice, totalPrice, platoon.id]
        );

        await conn.query(`
            INSERT INTO platoon_vehicles (platoon_squad_id, item_id, quantity, acquired_by)
            VALUES (?, ?, ?, ?)
            ON DUPLICATE KEY UPDATE quantity = quantity + ?
        `, [platoon.id, itemId, quantity, userId, quantity]);

        // Unified purchase log (buyer = user) → referenced by the fund audit row.
        const [txn] = await conn.query(`
            INSERT INTO store_transactions (user_id, item_id, quantity, unit_price, total_price, transaction_type)
            VALUES (?, ?, ?, ?, ?, 'purchase')
        `, [userId, itemId, quantity, item.base_price, totalPrice]);

        await conn.query(`
            INSERT INTO platoon_fund_transactions (platoon_squad_id, amount, balance_after, reason, source, reference_id, created_by)
            VALUES (?, ?, ?, ?, 'purchase', ?, ?)
        `, [platoon.id, -totalPrice, fund.balance - totalPrice, `Purchased ${quantity}x ${item.display_name}`, txn.insertId, userId]);

        if (item.stock !== -1) {
            await conn.query('UPDATE store_items SET stock = stock - ? WHERE id = ?', [quantity, itemId]);
        }

        await conn.commit();
        res.json({ success: true, balance: fund.balance - totalPrice });
    } catch (err) {
        await conn.rollback();
        console.error('Vehicle purchase error:', err);
        res.status(500).json({ success: false, error: 'Transaction failed' });
    } finally {
        conn.release();
    }
});

// ─── API: Purchase Item ─────────────────────────────────────
router.post('/api/buy', requireAuth, async (req, res) => {
    const { itemId } = req.body;
    const quantity = parseInt(req.body.quantity ?? 1, 10);
    const userId = res.locals.user.id;

    if (!itemId || !Number.isInteger(quantity) || quantity < 1) {
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
