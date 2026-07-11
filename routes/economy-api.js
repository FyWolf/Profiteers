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
        // A bulk arsenal export converts thousands of images. libvips otherwise
        // retains decoded bitmaps/operations in an in-memory cache and spins up
        // a thread pool per op, which can balloon memory and OOM-kill Node in a
        // memory-limited container. Disable the cache and cap concurrency so the
        // footprint stays flat and predictable across a long export.
        sharp.cache(false);
        sharp.concurrency(1);
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

// Upload endpoint accepts either the full economy key (ARMA_API_KEY, server) or
// a scoped upload-only key (ARMA_UPLOAD_KEY). Image extraction runs on players'
// clients, so the client config ships the upload-only key — if it leaks, the
// worst it grants is PAA->PNG uploads, not access to the economy API.
function requireUploadKey(req, res, next) {
    const key = req.headers['x-api-key'];
    const full = process.env.ARMA_API_KEY;
    const upload = process.env.ARMA_UPLOAD_KEY;
    if (key && ((full && constantTimeEqual(key, full)) ||
                (upload && constantTimeEqual(key, upload)))) {
        return next();
    }
    return res.status(401).send('0:Unauthorized: invalid or missing API key');
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

// ─── PAA → PNG conversion (shared by the single + batch endpoints) ─────────
// Converts a PAA buffer to a PNG on disk and returns its public URL.
async function convertPaaToPng(paaBuffer, originalName) {
    const base = path.basename(originalName || 'unknown.paa');
    const className = base.replace(/\.(paa|jpe?g|png)$/i, '').replace(/[^a-zA-Z0-9_-]/g, '_');

    await loadPaaModule();

    // Non-PAA images (e.g. a vehicle's .jpg editorPreview, or an in-game
    // screenshot) don't need the PAA mipmap decode — sharp can re-encode the
    // bytes straight to PNG.
    if (!/\.paa$/i.test(base)) {
        const hash = crypto.createHash('md5').update(paaBuffer).digest('hex').substring(0, 8);
        const pngFilename = `${className}_${hash}.png`;
        const pngPath = path.join(STORE_IMAGES_DIR, pngFilename);
        await sharp(paaBuffer).png().toFile(pngPath);
        return `/images/store/items/${pngFilename}`;
    }

    // Optional: dump the raw upload for offline inspection (set PAA_DEBUG=1).
    if (process.env.PAA_DEBUG === '1') {
        try {
            const dbgDir = path.join(__dirname, '..', 'storage', 'paa-debug');
            fs.mkdirSync(dbgDir, { recursive: true });
            fs.writeFileSync(path.join(dbgDir, `${className}.paa`), paaBuffer);
        } catch (_) { /* best effort */ }
    }

    const paa = new Paa();
    paa.read(new Uint8Array(paaBuffer));
    if (!paa.mipmaps || paa.mipmaps.length === 0) throw new Error('PAA has no mipmaps');

    // Pick the largest mipmap by area (index 0 isn't always the biggest).
    let level = 0;
    for (let i = 1; i < paa.mipmaps.length; i++) {
        if (paa.mipmaps[i].width * paa.mipmaps[i].height >
            paa.mipmaps[level].width * paa.mipmaps[level].height) level = i;
    }
    const width = paa.mipmaps[level].width;
    const height = paa.mipmaps[level].height;

    // The library returns BGRA (FormatConverter.setColor writes b,g,r,a);
    // sharp raw expects RGBA — swap B<->R.
    const src = paa.getArgb32PixelData(new Uint8Array(paaBuffer), level);
    const expected = width * height * 4;
    const rgbaData = Buffer.alloc(expected);
    for (let i = 0; i + 3 < src.length && i + 3 < expected; i += 4) {
        rgbaData[i]     = src[i + 2]; // R
        rgbaData[i + 1] = src[i + 1]; // G
        rgbaData[i + 2] = src[i];     // B
        rgbaData[i + 3] = src[i + 3]; // A
    }

    const hash = crypto.createHash('md5').update(paaBuffer).digest('hex').substring(0, 8);
    const pngFilename = `${className}_${hash}.png`;
    const pngPath = path.join(STORE_IMAGES_DIR, pngFilename);
    await sharp(rgbaData, { raw: { width, height, channels: 4 } }).png().toFile(pngPath);
    return `/images/store/items/${pngFilename}`;
}

// ─── Single upload (UPLOADPIC) ─────────────────────────────
router.post('/upload-picture', requireUploadKey, fileUpload({
    limits: { fileSize: 5 * 1024 * 1024 }, // 5MB max
    abortOnLimit: true
}), async (req, res) => {
    try {
        if (!req.files || !req.files.file) return res.status(400).send('0:No file uploaded');
        const url = await convertPaaToPng(req.files.file.data, req.files.file.name);
        res.type('text/plain').send(url);
    } catch (err) {
        console.error(`[Economy API] PAA conversion error:`, err);
        res.status(500).send(`0:Conversion failed: ${err.message}`);
    }
});

// ─── Batch upload (UPLOADBATCH) ────────────────────────────
// Accepts many `file` fields in one request; returns one line per file, IN THE
// SAME ORDER received — either a /images/... URL or "0:<error>".
router.post('/upload-pictures', requireUploadKey, fileUpload({
    limits: { fileSize: 5 * 1024 * 1024, files: 500 },
    abortOnLimit: true
}), async (req, res) => {
    try {
        if (!req.files || !req.files.file) return res.status(400).send('0:No files uploaded');
        let files = req.files.file;
        if (!Array.isArray(files)) files = [files];

        const results = [];
        let okc = 0, failc = 0;
        for (const uf of files) {
            try { results.push(await convertPaaToPng(uf.data, uf.name)); okc++; }
            catch (e) { results.push('0:' + (e.message || 'conversion failed')); failc++; }
        }
        console.log(`[Economy API] Batch upload: ${okc} converted, ${failc} failed`);
        res.type('text/plain').send(results.join('\n'));
    } catch (err) {
        console.error('[Economy API] Batch upload error:', err);
        res.status(500).send('0:' + err.message);
    }
});

// Decode the exact 24/32-bit uncompressed BMP the Windows extension writes
// (BITMAPFILEHEADER + BITMAPINFOHEADER, bottom-up BGR) to raw RGBA for sharp —
// libvips has no BMP reader. Returns null if it isn't a BMP we recognize.
function decodeBmpToRaw(buf) {
    if (buf.length < 54 || buf[0] !== 0x42 || buf[1] !== 0x4D) return null; // 'BM'
    const dataOffset = buf.readUInt32LE(10);
    const width = buf.readInt32LE(18);
    let height = buf.readInt32LE(22);
    const bpp = buf.readUInt16LE(28);
    const compression = buf.readUInt32LE(30);
    if (compression !== 0 || (bpp !== 24 && bpp !== 32)) return null;
    const bottomUp = height > 0;
    height = Math.abs(height);
    if (width <= 0 || height <= 0) return null;
    const bytesPP = bpp / 8;
    const rowSize = Math.floor((bpp * width + 31) / 32) * 4; // padded to 4 bytes
    if (dataOffset + rowSize * height > buf.length) return null;
    const out = Buffer.alloc(width * height * 4);
    for (let y = 0; y < height; y++) {
        const srcY = bottomUp ? (height - 1 - y) : y;
        let src = dataOffset + srcY * rowSize;
        let dst = y * width * 4;
        for (let x = 0; x < width; x++) {
            out[dst]     = buf[src + 2]; // R
            out[dst + 1] = buf[src + 1]; // G
            out[dst + 2] = buf[src];     // B
            out[dst + 3] = 255;          // A
            src += bytesPP;
            dst += 4;
        }
    }
    return { data: out, width, height };
}

// ─── Vehicle screenshot saver ──────────────────────────────
// Saves an already-rendered image (BMP from the Windows CAPTURE, or PNG/JPG)
// to the store images dir, normalized to PNG. Returns the public URL.
async function saveScreenshot(buffer, className, angle) {
    await loadPaaModule();
    const safeClass = String(className || 'vehicle').replace(/[^a-zA-Z0-9_-]/g, '_');
    const safeAngle = String(angle || 'shot').replace(/[^a-zA-Z0-9_-]/g, '_');
    const hash = crypto.createHash('md5').update(buffer).digest('hex').substring(0, 8);
    const filename = `${safeClass}_${safeAngle}_${hash}.png`;
    const outPath = path.join(STORE_IMAGES_DIR, filename);

    const bmp = decodeBmpToRaw(buffer);
    const img = bmp
        ? sharp(bmp.data, { raw: { width: bmp.width, height: bmp.height, channels: 4 } })
        : sharp(buffer);
    await img.png().toFile(outPath);
    return `/images/store/items/${filename}`;
}

// ─── Vehicle screenshot upload (CAPTURE) ───────────────────
// One multi-angle screenshot per call: `file` = image bytes, `class_name` =
// the vehicle's Arma class, `angle` = front/side/rear/interior/etc. Links the
// saved image into store_item_images so the item page gallery shows it.
router.post('/upload-screenshot', requireUploadKey, fileUpload({
    limits: { fileSize: 10 * 1024 * 1024 }, // 10MB max
    abortOnLimit: true
}), async (req, res) => {
    try {
        if (!req.files || !req.files.file) return res.status(400).send('0:No file uploaded');
        const className = (req.body.class_name || req.body.className || '').trim();
        const angle = (req.body.angle || '').trim();
        if (!className) return res.status(400).send('0:Missing class_name');

        const url = await saveScreenshot(req.files.file.data, className, angle);

        // Link to the store item (by class name) if one exists; harmless no-op
        // if the vehicle hasn't been exported into the store yet.
        const [items] = await db.query('SELECT id FROM store_items WHERE class_name = ? LIMIT 1', [className]);
        if (items.length) {
            await db.query(`
                INSERT INTO store_item_images (item_id, url, kind, angle, sort)
                VALUES (?, ?, 'screenshot', ?, 0)
                ON DUPLICATE KEY UPDATE angle = VALUES(angle)
            `, [items[0].id, url, angle || null]);
        }
        res.type('text/plain').send(url);
    } catch (err) {
        console.error('[Economy API] Screenshot upload error:', err);
        res.status(500).send('0:' + (err.message || 'upload failed'));
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
                                [catName, catSlug, '📦']
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
                    let updated = 0;
                    let skipped = 0;

                    for (const item of parsedItems) {
                        const { className, displayName, picture, description, itemType, stats } = item;

                        if (!className || !displayName) {
                            skipped++;
                            continue;
                        }

                        // stats arrives as a parsed object (the items payload is a
                        // JSON string we JSON.parse above) or, defensively, a JSON
                        // string. Store canonical JSON text, or NULL when empty.
                        let statsJson = null;
                        if (stats && typeof stats === 'object' && Object.keys(stats).length) {
                            statsJson = JSON.stringify(stats);
                        } else if (typeof stats === 'string' && stats.trim() && stats.trim() !== '{}') {
                            statsJson = stats.trim();
                        }

                        // Only store a real web image URL. The client sends a
                        // resolved /images/... URL when the icon uploaded, but the
                        // original .paa path (or a procedural "#..." texture) when
                        // extraction/upload failed — those are useless in a browser
                        // (404), so store NULL and let the store show its type
                        // placeholder instead of a broken image.
                        const imageUrl = (typeof picture === 'string' &&
                            (picture.startsWith('/images/') || picture.startsWith('http')))
                            ? picture : null;

                        // Refresh image_url, item_type and stats for items that
                        // already exist so a re-export self-heals. On image_url we
                        // prefer the new URL, else keep the old one ONLY if it's a
                        // valid uploaded path (so a failed re-export can't wipe a
                        // good icon, and a stale .paa path gets cleaned to NULL).
                        // Admin-set fields (price, stock, is_active, display_name,
                        // description) are kept.
                        const [result] = await conn.query(`
                            INSERT INTO store_items
                                (category_id, class_name, display_name, description, image_url, item_type, stats, base_price, stock, is_active)
                            VALUES (?, ?, ?, ?, ?, ?, ?, 0, -1, 1)
                            ON DUPLICATE KEY UPDATE
                                image_url = COALESCE(VALUES(image_url),
                                                     CASE WHEN image_url LIKE '/images/%' THEN image_url ELSE NULL END),
                                item_type = VALUES(item_type),
                                stats     = VALUES(stats)
                        `, [
                            targetCategoryId,
                            className,
                            displayName,
                            description || '',
                            imageUrl,
                            itemType || 'misc',
                            statsJson
                        ]);

                        // affectedRows: 1 = inserted, 2 = image updated, 0 = unchanged
                        if (result.affectedRows === 1) {
                            inserted++;
                        } else if (result.affectedRows === 2) {
                            updated++;
                        } else {
                            skipped++;
                        }
                    }

                    await conn.commit();
                    console.log(`[Economy API] Export complete: ${inserted} inserted, ${updated} updated, ${skipped} unchanged`);
                    return sqfSuccess(res, [inserted + updated]);

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
