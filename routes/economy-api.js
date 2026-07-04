/*
 * Profiteers Economy - Arma 3 Extension API
 * ==========================================
 * Single endpoint called by the profiteers_api_x64.so extension.
 * All requests are POST with JSON body containing an "action" field.
 *
 * Authentication: X-API-Key header must match ARMA_API_KEY in .env
 *
 * Response format (SQF-compatible):
 *   [1, data] on success
 *   [0, "error message"] on failure
 *
 * The SQF fn_apiCall.sqf parses this with call compile.
 */

const express = require('express');
const router = express.Router();
const db = require('../config/database');

// ─── API Key Authentication ─────────────────────────────────
function requireApiKey(req, res, next) {
    const key = req.headers['x-api-key'];
    if (!key || key !== process.env.ARMA_API_KEY) {
        return res.status(401).send('[0,"Unauthorized: invalid or missing API key"]');
    }
    next();
}

// ─── Helper: Send SQF-compatible response ──────────────────
function sqfSuccess(res, data) {
    // data is converted to a string that SQF's call compile can parse
    res.type('text/plain').send(`[1,${JSON.stringify(data)}]`);
}

function sqfError(res, message) {
    res.type('text/plain').send(`[0,"${message.replace(/"/g, '""')}"]`);
}

// ─── Helper: Get roster_members.id from steam_id ───────────
async function getUserIdBySteamId(steamId) {
    const [rows] = await db.query(
        'SELECT id FROM roster_members WHERE steam_id = ?',
        [steamId]
    );
    return rows.length ? rows[0].id : null;
}

// ─── Main Endpoint ─────────────────────────────────────────
router.post('/', requireApiKey, async (req, res) => {
    try {
        const { action } = req.body;

        console.log(`[Economy API] Request received - action: ${action}, body keys: ${Object.keys(req.body).join(', ')}`);

        if (!action) {
            return sqfError(res, 'Missing action field');
        }

        switch (action) {

            // ─── Fetch Player Balance ──────────────────────
            case 'fetchBalance': {
                const { steamId } = req.body;
                if (!steamId) return sqfError(res, 'Missing steamId');

                const userId = await getUserIdBySteamId(steamId);
                if (!userId) return sqfSuccess(res, 0);

                const [rows] = await db.query(
                    'SELECT COALESCE(balance, 0) AS balance FROM player_currency WHERE user_id = ?',
                    [userId]
                );

                return sqfSuccess(res, rows.length ? rows[0].balance : 0);
            }

            // ─── Fetch Player Inventory ────────────────────
            case 'fetchInventory': {
                const { steamId } = req.body;
                if (!steamId) return sqfError(res, 'Missing steamId');

                const userId = await getUserIdBySteamId(steamId);
                if (!userId) return sqfSuccess(res, []);

                const [items] = await db.query(`
                    SELECT si.class_name, si.item_type, pi.quantity
                    FROM player_inventory pi
                    JOIN store_items si ON si.id = pi.item_id
                    WHERE pi.user_id = ? AND pi.quantity > 0 AND si.is_active = 1
                `, [userId]);

                // Format as array of [className, itemType, quantity]
                const inventory = items.map(i => [i.class_name, i.item_type, i.quantity]);
                return sqfSuccess(res, inventory);
            }

            // ─── Fetch Saved Loadouts ──────────────────────
            case 'fetchLoadouts': {
                const { steamId } = req.body;
                if (!steamId) return sqfError(res, 'Missing steamId');

                const userId = await getUserIdBySteamId(steamId);
                if (!userId) return sqfSuccess(res, []);

                const [loadouts] = await db.query(`
                    SELECT id, name, loadout_data, is_default
                    FROM player_loadouts
                    WHERE user_id = ?
                    ORDER BY is_default DESC, updated_at DESC
                `, [userId]);

                // Format as array of [id, name, loadoutData, isDefault]
                const result = loadouts.map(l => [
                    l.id,
                    l.name,
                    typeof l.loadout_data === 'string' ? l.loadout_data : JSON.stringify(l.loadout_data),
                    l.is_default
                ]);
                return sqfSuccess(res, result);
            }

            // ─── Save Loadout ──────────────────────────────
            case 'saveLoadout': {
                const { steamId, loadoutName, loadoutJson } = req.body;
                if (!steamId) return sqfError(res, 'Missing steamId');
                if (!loadoutName) return sqfError(res, 'Missing loadoutName');
                if (!loadoutJson) return sqfError(res, 'Missing loadoutJson');

                const userId = await getUserIdBySteamId(steamId);
                if (!userId) return sqfError(res, 'Player not found');

                await db.query(`
                    INSERT INTO player_loadouts (user_id, name, loadout_data)
                    VALUES (?, ?, ?)
                `, [userId, loadoutName, loadoutJson]);

                console.log(`[Economy API] Loadout saved: ${loadoutName} for user ${userId}`);
                return sqfSuccess(res, []);
            }

            // ─── Export Arsenal to Store ───────────────────
            case 'exportArsenal': {
                const { steamId, items, categoryId } = req.body;
                if (!steamId) return sqfError(res, 'Missing steamId');

                // Items may come as a JSON string (from SQF) or already parsed (from web)
                let parsedItems = items;
                if (typeof parsedItems === 'string') {
                    try { parsedItems = JSON.parse(parsedItems); } catch (e) { return sqfError(res, 'Invalid items JSON string'); }
                }
                if (!parsedItems || !Array.isArray(parsedItems)) return sqfError(res, 'Missing or invalid items array');

                let targetCategoryId = parseInt(categoryId) || 0;

                const conn = await db.getConnection();
                try {
                    await conn.beginTransaction();

                    // Auto-create category if needed
                    if (targetCategoryId === 0) {
                        const now = new Date();
                        const catName = `Imported ${now.getDate()}/${now.getMonth() + 1}/${now.getFullYear()}`;
                        const catSlug = `imported_${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, '0')}${String(now.getDate()).padStart(2, '0')}`;

                        await conn.query(
                            'INSERT INTO store_categories (name, slug, icon) VALUES (?, ?, ?)',
                            [catName, catSlug, 'box']
                        );

                        const [catRows] = await conn.query(
                            'SELECT id FROM store_categories WHERE slug = ? LIMIT 1',
                            [catSlug]
                        );

                        targetCategoryId = catRows.length ? catRows[0].id : 1;
                        console.log(`[Economy API] Created category: ${catName} (ID: ${targetCategoryId})`);
                    }

                    // Insert items
                    let inserted = 0;
                    let skipped = 0;

                    for (const item of parsedItems) {
                        const { className, displayName, picture, description, itemType } = item;

                        if (!className || !displayName) {
                            skipped++;
                            continue;
                        }

                        const [result] = await conn.query(`
                            INSERT IGNORE INTO store_items
                                (category_id, class_name, display_name, description, image_url, item_type, base_price, stock, is_active)
                            VALUES (?, ?, ?, ?, ?, ?, 0, -1, 1)
                        `, [
                            targetCategoryId,
                            className,
                            displayName,
                            description || '',
                            picture || '',
                            itemType || 'misc'
                        ]);

                        if (result.affectedRows > 0) {
                            inserted++;
                        } else {
                            skipped++;
                        }
                    }

                    await conn.commit();
                    console.log(`[Economy API] Export complete: ${inserted} inserted, ${skipped} skipped`);
                    return sqfSuccess(res, [inserted]);

                } catch (err) {
                    await conn.rollback();
                    throw err;
                } finally {
                    conn.release();
                }
            }

            default:
                return sqfError(res, `Unknown action: ${action}`);
        }
    } catch (err) {
        console.error(`[Economy API] Error:`, err);
        return sqfError(res, 'Internal server error');
    }
});

module.exports = router;
