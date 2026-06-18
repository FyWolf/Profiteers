const express    = require('express');
const fs         = require('fs');
const fsp        = require('fs').promises;
const path       = require('path');
const fileUpload = require('express-fileupload');
const AdmZip     = require('adm-zip');
const db         = require('../../config/database');

const router = express.Router();

const MAPS_DIR = path.join(__dirname, '..', '..', 'public', 'images', 'maps');

// ─── List all plans ────────────────────────────────────────────────────────
router.get('/', async (req, res) => {
    try {
        const [plans] = await db.query(
            `SELECT p.id, p.name, p.map_world, p.link_access, p.created_at, p.updated_at,
                    COALESCE(rm.nickname, u.discord_global_name, u.username) AS owner_username,
                    (SELECT COUNT(*) FROM map_plan_layers      WHERE plan_id = p.id) AS layer_count,
                    (SELECT COUNT(*) FROM map_plan_annotations WHERE plan_id = p.id) AS ann_count,
                    (SELECT COUNT(*) FROM map_plan_acl         WHERE plan_id = p.id) AS member_count
               FROM map_plans p
               JOIN users u ON u.id = p.owner_id
               LEFT JOIN roster_members rm ON rm.discord_id = u.discord_id
              ORDER BY p.updated_at DESC`
        );

        let terrains = [];
        try {
            const entries = await fsp.readdir(MAPS_DIR, { withFileTypes: true });
            terrains = await Promise.all(entries
                .filter(e => e.isDirectory())
                .map(async e => {
                    const base = path.join(MAPS_DIR, e.name);
                    const [metaRaw, cfgRaw] = await Promise.all([
                        fsp.readFile(path.join(base, 'meta.json'), 'utf8').catch(() => null),
                        fsp.readFile(path.join(base, 'map.json'),  'utf8').catch(() => null),
                    ]);
                    if (!metaRaw && !cfgRaw) return null;
                    const meta = metaRaw ? JSON.parse(metaRaw) : {};
                    const cfg  = cfgRaw  ? JSON.parse(cfgRaw)  : {};
                    return {
                        worldName: e.name,
                        displayName: meta.displayName || cfg.name || e.name,
                        worldSize:   meta.worldSize   || cfg.worldSize || null,
                    };
                }));
            terrains = terrains.filter(Boolean);
        } catch { /* maps dir missing — fine */ }

        res.render('admin/map-plans', {
            title: 'Manage Map Plans - Admin',
            plans,
            terrains,
            error:   req.query.error   || null,
            success: req.query.success || null,
            user: res.locals.user
        });
    } catch (err) {
        console.error('Admin map-plans list error:', err);
        res.render('error', {
            title: 'Error', message: 'Error', description: 'Could not load admin plans.',
            user: res.locals.user
        });
    }
});

// ─── Delete plan ───────────────────────────────────────────────────────────
router.delete('/:id', async (req, res) => {
    try {
        await db.query('DELETE FROM map_plans WHERE id = ?', [req.params.id]);
        res.json({ success: true });
    } catch (err) {
        console.error('Admin delete plan error:', err);
        res.json({ success: false, error: 'Failed to delete plan' });
    }
});

// ─── Transfer ownership ────────────────────────────────────────────────────
router.post('/:id/transfer', async (req, res) => {
    try {
        const { username } = req.body;
        if (!username) return res.json({ success: false, error: 'Username required' });

        const [u] = await db.query(
            'SELECT id FROM users WHERE username = ? OR LOWER(username) = LOWER(?) LIMIT 1',
            [username, username]
        );
        if (!u.length) return res.json({ success: false, error: 'User not found' });

        await db.query('UPDATE map_plans SET owner_id = ? WHERE id = ?', [u[0].id, req.params.id]);
        // Drop any existing ACL row for the new owner so ownership is clean.
        await db.query('DELETE FROM map_plan_acl WHERE plan_id = ? AND user_id = ?',
            [req.params.id, u[0].id]);
        res.json({ success: true });
    } catch (err) {
        console.error('Transfer plan error:', err);
        res.json({ success: false, error: 'Failed to transfer plan' });
    }
});

// ─── Terrain import (zip) ──────────────────────────────────────────────────
//
// Admin uploads a pre-rendered terrain zip. The zip's root must contain either
// meta.json or map.json. The terrain is extracted into public/images/maps/<world>.
//
// Per-route fileUpload middleware overrides the global 10MB cap because
// terrains are typically hundreds of MB. useTempFiles streams to disk instead
// of buffering in memory.
//
// The temp dir MUST live on the same (large) partition as the terrains, NOT the
// OS temp dir: on many servers /tmp is a small or RAM-backed (tmpfs) mount, so a
// multi-hundred-MB upload overflows it and fails with ENOSPC even though the data
// partition has plenty of free space. Override with TERRAIN_TMP_DIR if needed.
const TERRAIN_TMP_DIR = process.env.TERRAIN_TMP_DIR || path.join(MAPS_DIR, '..', '.uploads-tmp');
try {
    fs.mkdirSync(TERRAIN_TMP_DIR, { recursive: true });
} catch (e) {
    console.error('Could not create terrain temp dir', TERRAIN_TMP_DIR, '-', e.message);
}

const terrainUpload = fileUpload({
    useTempFiles: true,
    tempFileDir:  TERRAIN_TMP_DIR,
    abortOnLimit: false,
    createParentPath: true,
});

router.post('/terrains/import', terrainUpload, async (req, res) => {
    if (!req.files || !req.files.terrain) {
        return res.redirect('/admin/map-plans?error=No file uploaded');
    }
    const file = req.files.terrain;
    const overwrite = req.body.overwrite === '1' || req.body.overwrite === 'on';
    const requestedName = (req.body.world_name || '').trim();

    if (!file.name.toLowerCase().endsWith('.zip')) {
        return res.redirect('/admin/map-plans?error=' + encodeURIComponent('File must be a .zip'));
    }

    try {
        const zip = new AdmZip(file.tempFilePath || file.data);
        const entries = zip.getEntries();
        if (!entries.length) {
            return res.redirect('/admin/map-plans?error=' + encodeURIComponent('Zip is empty'));
        }

        // Detect zip layout: are entries at the root, or nested in a single top folder?
        // A terrain zip should put meta.json/map.json either at the root or one level deep.
        const findEntry = name => entries.find(e => {
            const p = e.entryName.replace(/\\/g, '/');
            return p === name || p.endsWith('/' + name);
        });
        const metaEntry = findEntry('meta.json');
        const mapEntry  = findEntry('map.json');
        if (!metaEntry && !mapEntry) {
            return res.redirect('/admin/map-plans?error=' +
                encodeURIComponent('Zip must contain meta.json or map.json'));
        }

        // Compute the prefix to strip — the folder containing the manifest.
        const manifestEntry = metaEntry || mapEntry;
        const manifestPath = manifestEntry.entryName.replace(/\\/g, '/');
        const stripPrefix = manifestPath.includes('/')
            ? manifestPath.substring(0, manifestPath.lastIndexOf('/') + 1)
            : '';

        // Determine world name.
        let worldName = requestedName;
        if (!worldName) {
            try {
                const raw = (metaEntry || mapEntry).getData().toString('utf8');
                const j = JSON.parse(raw);
                worldName = j.worldName || j.name || (stripPrefix ? stripPrefix.replace(/\/$/, '').split('/').pop() : '');
            } catch { /* fall through */ }
        }
        if (!worldName) {
            worldName = path.basename(file.name, '.zip');
        }
        if (!/^[a-zA-Z0-9_-]+$/.test(worldName)) {
            return res.redirect('/admin/map-plans?error=' +
                encodeURIComponent('World name must be alphanumeric / underscore / dash. Got: ' + worldName));
        }

        const targetDir = path.join(MAPS_DIR, worldName);
        const targetResolved = path.resolve(targetDir);
        if (!targetResolved.startsWith(path.resolve(MAPS_DIR) + path.sep) &&
            targetResolved !== path.resolve(MAPS_DIR)) {
            return res.redirect('/admin/map-plans?error=' + encodeURIComponent('Bad target path'));
        }

        if (fs.existsSync(targetDir) && !overwrite) {
            return res.redirect('/admin/map-plans?error=' +
                encodeURIComponent('Terrain "' + worldName + '" already exists. Tick "Overwrite" to replace it.'));
        }

        if (fs.existsSync(targetDir) && overwrite) {
            await fsp.rm(targetDir, { recursive: true, force: true });
        }
        await fsp.mkdir(targetDir, { recursive: true });

        // Extract entries, stripping the manifest prefix and guarding against zip-slip.
        for (const entry of entries) {
            if (entry.isDirectory) continue;
            const raw = entry.entryName.replace(/\\/g, '/');
            if (stripPrefix && !raw.startsWith(stripPrefix)) continue;
            const rel = stripPrefix ? raw.substring(stripPrefix.length) : raw;
            if (!rel || rel.startsWith('/')) continue;

            const outPath = path.resolve(targetDir, rel);
            if (!outPath.startsWith(path.resolve(targetDir) + path.sep)) {
                console.warn('Skipping zip-slip entry:', raw);
                continue;
            }
            await fsp.mkdir(path.dirname(outPath), { recursive: true });
            await fsp.writeFile(outPath, entry.getData());
        }

        // Cleanup temp file.
        if (file.tempFilePath) {
            await fsp.unlink(file.tempFilePath).catch(() => {});
        }

        res.redirect('/admin/map-plans?success=' +
            encodeURIComponent('Terrain "' + worldName + '" imported.'));
    } catch (err) {
        console.error('Terrain import error:', err);
        if (file.tempFilePath) await fsp.unlink(file.tempFilePath).catch(() => {});
        res.redirect('/admin/map-plans?error=' +
            encodeURIComponent('Import failed: ' + err.message));
    }
});

// ─── Delete a terrain ──────────────────────────────────────────────────────
router.delete('/terrains/:world', async (req, res) => {
    try {
        const world = req.params.world;
        if (!/^[a-zA-Z0-9_-]+$/.test(world)) {
            return res.json({ success: false, error: 'Invalid world name' });
        }
        const dir = path.join(MAPS_DIR, world);
        const resolved = path.resolve(dir);
        if (!resolved.startsWith(path.resolve(MAPS_DIR) + path.sep)) {
            return res.json({ success: false, error: 'Bad path' });
        }
        if (!fs.existsSync(dir)) {
            return res.json({ success: false, error: 'Terrain not found' });
        }
        await fsp.rm(dir, { recursive: true, force: true });
        res.json({ success: true });
    } catch (err) {
        console.error('Delete terrain error:', err);
        res.json({ success: false, error: 'Failed to delete terrain' });
    }
});

module.exports = router;
