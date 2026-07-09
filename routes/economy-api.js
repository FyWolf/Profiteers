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
const fileUpload = require('express-fileupload');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

// ─── PAA → PNG conversion ──────────────────────────────────
let Paa, sharp;
async function loadPaaModule() {
    if (!Paa) {
        const mod = await import('@bis-toolkit/paa');
        Paa = mod.Paa;
    }
    if (!sharp) {
        sharp = (await import('sharp')).default;
    }
}
loadPaaModule();

const STORE_IMAGES_DIR = path.join(__dirname, '..', 'public', 'images', 'store', 'items');

// Ensure the images directory exists
if (!fs.existsSync(STORE_IMAGES_DIR)) {
    fs.mkdirSync(STORE_IMAGES_DIR, { recursive: true });
}

// ─── API Key Authentication ─────────────────────────────────
function constantTimeEqual(a, b) {
    const bufA = Buffer.from(String(a));
    const bufB = Buffer.from(String(b));
    if (bufA.length !== bufB.length) return false;
    return crypto.timingSafeEqual(bufA, bufB);
}

function requireApiKey(req, res, next) {
    const key = req.headers['x-api-key'];
    const expected = process.env.ARMA_API_KEY;
    // Fail closed when the key is missing or the server has no key configured.
    if (!key || !expected || !constantTimeEqual(key, expected)) {
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
    // NOTE: `message` MUST be a static/trusted string. This only escapes double
    // quotes for SQF; it is not a general-purpose escaper. If you ever need to
    // include user- or DB-supplied text in an error, run it through
    // JSON.stringify (as sqfSuccess does) instead of interpolating it here.
    res.type('text/plain').send(`[0,"${message.replace(/"/g, '""')}"]`);
}

// ─── Helper: Get users.id from steam_id ────────────────────
async function getUserIdBySteamId(steamId) {
    const [rows] = await db.query(
        'SELECT id FROM users WHERE steam_id = ?',
        [steamId]
    );
    return rows.length ? rows[0].id : null;
}

// ─── PAA Upload & Conversion Endpoint ─────────────────────
// Called by the Arma 3 extension (UPLOADPIC command) via curl -F
router.post('/upload-picture', requireApiKey, fileUpload({
    limits: { fileSize: 5 * 1024 * 1024 }, // 5MB max
    abortOnLimit: true
}), async (req, res) => {
    try {
        if (!req.files || !req.files.file) {
            return res.status(400).send('0:No file uploaded');
        }

        const uploadedFile = req.files.file;
        const originalName = path.basename(uploadedFile.name || 'unknown.paa');
        const className = originalName.replace(/\.paa$/i, '').replace(/[^a-zA-Z0-9_-]/g, '_');

        // Read the PAA file buffer
        const paaBuffer = uploadedFile.data;

        // Convert PAA → PNG using @bis-toolkit/paa + sharp
        await loadPaaModule();

        const paa = new Paa();
        paa.read(new Uint8Array(paaBuffer));

        // Get RGBA pixel data from the first mipmap
        const pixelData = paa.getArgb32PixelData(new Uint8Array(paaBuffer), 0);
        const width = paa.mipmaps[0].width;
        const height = paa.mipmaps[0].height;

        // Convert ARGB32 → raw RGBA (sharp expects RGBA)
        const rgbaData = Buffer.alloc(pixelData.length);
        for (let i = 0; i < pixelData.length; i += 4) {
            const a = pixelData[i];     // ARGB: A
            const r = pixelData[i + 1]; // ARGB: R
            const g = pixelData[i + 2]; // ARGB: G
            const b = pixelData[i + 3]; // ARGB: B
            rgbaData[i] = r;
            rgbaData[i + 1] = g;
            rgbaData[i + 2] = b;
            rgbaData[i + 3] = a;
        }

        // Generate a unique filename
        const hash = crypto.createHash('md5').update(paaBuffer).digest('hex').substring(0, 8);
        const pngFilename = `${className}_${hash}.png`;
        const pngPath = path.join(STORE_IMAGES_DIR, pngFilename);

        // Write PNG using sharp
        await sharp(rgbaData, {
            raw: {
                width,
                height,
                channels: 4
            }
        }).png().toFile(pngPath);

        // Return the URL path
        const imageUrl = `/images/store/items/${pngFilename}`;
        console.log(`[Economy API] PAA converted: ${originalName} → ${imageUrl}`);
        res.type('text/plain').send(imageUrl);

    } catch (err) {
        console.error(`[Economy API] PAA conversion error:`, err);
        res.status(500).send(`0:Conversion failed: ${err.message}`);
    }
});

// ─── Main Endpoint ─────────────────────────────────────────
router.post('/', requireApiKey, async (req, res) => {
    try {
        const { action } = req.body;

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
                        const dateStr = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, '0')}${String(now.getDate()).padStart(2, '0')}`;
                        const catSlug = `imported_${dateStr}`;

                        // Check if today's category already exists
                        const [existing] = await conn.query(
                            'SELECT id FROM store_categories WHERE slug = ? LIMIT 1',
                            [catSlug]
                        );

                        if (existing.length) {
                            targetCategoryId = existing[0].id;
                            console.log(`[Economy API] Reusing existing category ID: ${targetCategoryId}`);
                        } else {
                            const catName = `Imported ${now.getDate()}/${now.getMonth() + 1}/${now.getFullYear()}`;

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
