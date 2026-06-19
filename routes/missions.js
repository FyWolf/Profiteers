const express     = require('express');
const router      = express.Router();
const path        = require('path');
const fs          = require('fs');
const fsp         = require('fs').promises;
const fileUpload  = require('express-fileupload');
const sanitizeHtml = require('sanitize-html');
const db          = require('../config/database');
const { hasPermission } = require('../middleware/auth');

// ─── Storage ────────────────────────────────────────────────────────────────
// Mission files are private WIP artifacts — they live OUTSIDE public/ and are
// only ever served through the auth-gated download routes below.
const STORAGE_DIR = path.join(__dirname, '..', 'storage', 'missions');
// Large uploads stream to disk; keep the temp dir on the same partition as the
// store (the OS temp dir may be a small tmpfs — see routes/admin/map-plans.js).
const MISSION_TMP_DIR = process.env.MISSION_TMP_DIR || path.join(STORAGE_DIR, '..', '.uploads-tmp');
try { fs.mkdirSync(STORAGE_DIR, { recursive: true }); } catch (e) { console.error('mkdir mission storage:', e.message); }
try { fs.mkdirSync(MISSION_TMP_DIR, { recursive: true }); } catch (e) { console.error('mkdir mission tmp:', e.message); }

const projectDir = id => path.join(STORAGE_DIR, String(parseInt(id, 10)));

// Mission files can be large (raw mission folders, PBOs) — 1 GB cap, temp-file streamed.
const missionUpload = fileUpload({
    useTempFiles: true,
    tempFileDir:  MISSION_TMP_DIR,
    abortOnLimit: false,
    createParentPath: true,
    limits: { fileSize: parseInt(process.env.MISSION_MAX_FILE_SIZE) || 1024 * 1024 * 1024 },
});

// ─── Constants / validation ──────────────────────────────────────────────────
const STATUSES   = ['planning', 'in_progress', 'blocked', 'review', 'completed', 'cancelled'];
const PRIORITIES = ['low', 'normal', 'high', 'urgent'];
const RAW_EXTS   = ['.zip', '.pbo', '.7z', '.rar', '.gz'];

// A mission drops off the board into the archive once its due date is this many
// days in the past. Missions with no due date are never auto-archived.
// (ARCHIVE_AFTER_DAYS is a fixed integer, so it is safe to inline in SQL.)
const ARCHIVE_AFTER_DAYS = 30;
const ARCHIVED_SQL = `(mp.due_date IS NOT NULL AND mp.due_date < (CURDATE() - INTERVAL ${ARCHIVE_AFTER_DAYS} DAY))`;
const ACTIVE_SQL   = `(mp.due_date IS NULL OR mp.due_date >= (CURDATE() - INTERVAL ${ARCHIVE_AFTER_DAYS} DAY))`;

const DESC_ALLOWED_TAGS = ['p','br','strong','em','u','s','ul','ol','li','h2','h3','blockquote','a','span','code','pre','hr'];
const DESC_ALLOWED_ATTRS = { a: ['href','target','rel'] };
function sanitizeDescription(raw) {
    return sanitizeHtml(raw || '', {
        allowedTags: DESC_ALLOWED_TAGS,
        allowedAttributes: DESC_ALLOWED_ATTRS,
        allowedSchemes: ['https', 'http'],
        transformTags: { a: (t, a) => ({ tagName: t, attribs: { ...a, rel: 'noopener noreferrer', target: '_blank' } }) },
    });
}

function parseDate(v) {
    return (v && /^\d{4}-\d{2}-\d{2}$/.test(v)) ? v : null;
}
function clampProgress(v) {
    const n = parseInt(v, 10);
    return Number.isFinite(n) ? Math.min(100, Math.max(0, n)) : 0;
}
function safeName(name) {
    return path.basename(name || 'file').replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 180) || 'file';
}
// Display-name fallback chain used across the codebase (roster nickname → global → username).
const DISPLAY = alias => `COALESCE(rm_${alias}.nickname, ${alias}.discord_global_name, ${alias}.username)`;

// Parse the parallel assignee_user_id[] / assignee_role[] arrays from a form post.
function parseAssignees(body) {
    const ids   = [].concat(body.assignee_user_id || []);
    const roles = [].concat(body.assignee_role   || []);
    const seen  = new Set();
    const out   = [];
    ids.forEach((raw, i) => {
        const uid = parseInt(raw, 10);
        if (!Number.isFinite(uid) || seen.has(uid)) return;
        seen.add(uid);
        out.push([uid, (roles[i] || '').trim().slice(0, 60) || null]);
    });
    return out;
}

async function replaceAssignees(projectId, pairs) {
    await db.query('DELETE FROM mission_project_assignees WHERE project_id = ?', [projectId]);
    if (pairs.length) {
        const rows = pairs.map(([uid, role]) => [projectId, uid, role]);
        await db.query('INSERT IGNORE INTO mission_project_assignees (project_id, user_id, role) VALUES ?', [rows]);
    }
}

// Form dropdown data (users / operations / modpacks).
async function loadFormLists() {
    const [users] = await db.query(`
        SELECT u.id, u.username, u.discord_global_name, u.discord_id, u.discord_avatar,
               (SELECT nickname FROM roster_members rm WHERE rm.discord_id = u.discord_id LIMIT 1) AS roster_nickname
        FROM users u
        ORDER BY u.discord_global_name ASC, u.username ASC
    `);
    const [operations] = await db.query('SELECT id, title FROM operations ORDER BY start_time DESC LIMIT 300');
    const [modpacks]   = await db.query('SELECT id, name FROM modpacks ORDER BY name ASC');
    const [campaigns]  = await db.query('SELECT id, name FROM mission_campaigns ORDER BY display_order ASC, name ASC');
    return { users, operations, modpacks, campaigns };
}

// ─── Board (Gantt) ────────────────────────────────────────────────────────────
router.get('/', hasPermission('missions.view'), async (req, res) => {
    try {
        // Optional campaign filter: ?campaign=<id> | 'none' (uncategorised).
        const where = [ACTIVE_SQL];
        const params = [];
        const campaignParam = req.query.campaign;
        if (campaignParam === 'none') where.push('mp.campaign_id IS NULL');
        else if (campaignParam && /^\d+$/.test(campaignParam)) { where.push('mp.campaign_id = ?'); params.push(parseInt(campaignParam, 10)); }

        const [projects] = await db.query(`
            SELECT mp.*,
                   ${DISPLAY('lu')} AS lead_display_name,
                   c.name AS campaign_name, c.color AS campaign_color,
                   (SELECT COUNT(*) FROM mission_files mf WHERE mf.project_id = mp.id) AS version_count,
                   (SELECT COUNT(*) FROM mission_project_assignees a WHERE a.project_id = mp.id) AS assignee_count
            FROM mission_projects mp
            LEFT JOIN users lu ON mp.lead_user_id = lu.id
            LEFT JOIN roster_members rm_lu ON rm_lu.discord_id = lu.discord_id
            LEFT JOIN mission_campaigns c ON mp.campaign_id = c.id
            WHERE ${where.join(' AND ')}
            ORDER BY (mp.campaign_id IS NULL) ASC, c.display_order ASC, c.name ASC,
                     (mp.status = 'completed' OR mp.status = 'cancelled') ASC,
                     (mp.due_date IS NULL) ASC, mp.due_date ASC, mp.created_at DESC
        `, params);

        const [campaigns] = await db.query('SELECT id, name, color FROM mission_campaigns ORDER BY display_order ASC, name ASC');
        const [[{ archived_count }]] = await db.query(`SELECT COUNT(*) AS archived_count FROM mission_projects mp WHERE ${ARCHIVED_SQL}`);

        // Attach phases (sub-bars) to each visible project.
        const ids = projects.map(p => p.id);
        const byProject = {};
        if (ids.length) {
            const [phases] = await db.query(
                'SELECT id, project_id, name, start_date, due_date, color FROM mission_phases WHERE project_id IN (?) ORDER BY display_order ASC, start_date ASC, id ASC',
                [ids]
            );
            phases.forEach(ph => { (byProject[ph.project_id] = byProject[ph.project_id] || []).push(ph); });
        }
        projects.forEach(p => { p.phases = byProject[p.id] || []; });

        res.render('missions/board', {
            title: 'Mission Board — Profiteers PMC',
            description: 'Mission production planning board.',
            projects,
            statuses: STATUSES,
            campaigns,
            selectedCampaign: campaignParam || '',
            archivedCount: archived_count,
            canManage: req.user.permissions.includes('missions.manage'),
            success: req.query.success || null,
            error:   req.query.error   || null,
        });
    } catch (error) {
        console.error('Error loading mission board:', error);
        res.render('error', { title: 'Error', message: 'Error Loading Mission Board', description: 'Could not load the mission board.', user: res.locals.user });
    }
});

// ─── Archive (missions past their due date by the threshold) ────────────────────
router.get('/archive', hasPermission('missions.view'), async (req, res) => {
    try {
        const [projects] = await db.query(`
            SELECT mp.*,
                   ${DISPLAY('lu')} AS lead_display_name,
                   c.name AS campaign_name, c.color AS campaign_color,
                   (SELECT COUNT(*) FROM mission_files mf WHERE mf.project_id = mp.id) AS version_count
            FROM mission_projects mp
            LEFT JOIN users lu ON mp.lead_user_id = lu.id
            LEFT JOIN roster_members rm_lu ON rm_lu.discord_id = lu.discord_id
            LEFT JOIN mission_campaigns c ON mp.campaign_id = c.id
            WHERE ${ARCHIVED_SQL}
            ORDER BY mp.due_date DESC
        `);
        res.render('missions/archive', {
            title: 'Mission Archive — Profiteers PMC',
            description: 'Archived mission projects.',
            projects,
            afterDays: ARCHIVE_AFTER_DAYS,
            canManage: req.user.permissions.includes('missions.manage'),
        });
    } catch (error) {
        console.error('Error loading mission archive:', error);
        res.render('error', { title: 'Error', message: 'Error Loading Archive', description: 'Could not load the mission archive.', user: res.locals.user });
    }
});

// ─── Campaign management ────────────────────────────────────────────────────────
router.get('/campaigns', hasPermission('missions.manage'), async (req, res) => {
    try {
        const [campaigns] = await db.query(`
            SELECT c.*, (SELECT COUNT(*) FROM mission_projects mp WHERE mp.campaign_id = c.id) AS mission_count
            FROM mission_campaigns c
            ORDER BY c.display_order ASC, c.name ASC
        `);
        res.render('missions/campaigns', {
            title: 'Mission Campaigns — Profiteers PMC',
            campaigns,
            success: req.query.success || null,
            error:   req.query.error   || null,
        });
    } catch (error) {
        console.error('Error loading campaigns:', error);
        res.redirect('/missions?error=Failed to load campaigns');
    }
});

router.post('/campaigns', hasPermission('missions.manage'), async (req, res) => {
    try {
        const name = (req.body.name || '').trim();
        if (!name) return res.redirect('/missions/campaigns?error=Campaign name is required');
        await db.query(
            'INSERT INTO mission_campaigns (name, description, color, display_order, created_by) VALUES (?, ?, ?, ?, ?)',
            [name.slice(0, 120), (req.body.description || '').trim() || null,
             /^#[0-9a-fA-F]{6}$/.test(req.body.color || '') ? req.body.color : '#fcb00d',
             parseInt(req.body.display_order, 10) || 0, req.session.userId]
        );
        res.redirect('/missions/campaigns?success=Campaign created');
    } catch (error) {
        console.error('Error creating campaign:', error);
        res.redirect('/missions/campaigns?error=Failed to create campaign');
    }
});

router.post('/campaigns/:cid/edit', hasPermission('missions.manage'), async (req, res) => {
    try {
        const name = (req.body.name || '').trim();
        if (!name) return res.redirect('/missions/campaigns?error=Campaign name is required');
        await db.query(
            'UPDATE mission_campaigns SET name = ?, description = ?, color = ?, display_order = ? WHERE id = ?',
            [name.slice(0, 120), (req.body.description || '').trim() || null,
             /^#[0-9a-fA-F]{6}$/.test(req.body.color || '') ? req.body.color : '#fcb00d',
             parseInt(req.body.display_order, 10) || 0, req.params.cid]
        );
        res.redirect('/missions/campaigns?success=Campaign updated');
    } catch (error) {
        console.error('Error updating campaign:', error);
        res.redirect('/missions/campaigns?error=Failed to update campaign');
    }
});

router.post('/campaigns/:cid/delete', hasPermission('missions.manage'), async (req, res) => {
    try {
        await db.query('DELETE FROM mission_campaigns WHERE id = ?', [req.params.cid]);
        res.redirect('/missions/campaigns?success=Campaign deleted (its missions were kept, now uncategorised)');
    } catch (error) {
        console.error('Error deleting campaign:', error);
        res.redirect('/missions/campaigns?error=Failed to delete campaign');
    }
});

// ─── Create ───────────────────────────────────────────────────────────────────
router.get('/manage/create', hasPermission('missions.manage'), async (req, res) => {
    try {
        const lists = await loadFormLists();
        res.render('missions/form', { title: 'New Mission Project — Profiteers PMC', action: 'create', project: null, assignees: [], statuses: STATUSES, priorities: PRIORITIES, ...lists });
    } catch (error) {
        console.error('Error loading create form:', error);
        res.redirect('/missions?error=Failed to load form');
    }
});

router.post('/manage/create', hasPermission('missions.manage'), async (req, res) => {
    try {
        const { title, status, priority, map_world, color } = req.body;
        if (!title || !title.trim()) return res.redirect('/missions?error=Title is required');

        const [result] = await db.query(`
            INSERT INTO mission_projects
                (title, description, status, priority, progress, start_date, due_date, lead_user_id, operation_id, campaign_id, modpack_id, map_world, color, created_by)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `, [
            title.trim().slice(0, 200),
            sanitizeDescription(req.body.description),
            STATUSES.includes(status) ? status : 'planning',
            PRIORITIES.includes(priority) ? priority : 'normal',
            clampProgress(req.body.progress),
            parseDate(req.body.start_date),
            parseDate(req.body.due_date),
            req.body.lead_user_id ? parseInt(req.body.lead_user_id, 10) : null,
            req.body.operation_id ? parseInt(req.body.operation_id, 10) : null,
            req.body.campaign_id  ? parseInt(req.body.campaign_id, 10)  : null,
            req.body.modpack_id   ? parseInt(req.body.modpack_id, 10)   : null,
            (map_world || '').trim().slice(0, 100) || null,
            /^#[0-9a-fA-F]{6}$/.test(color || '') ? color : '#6b8e23',
            req.session.userId,
        ]);
        await replaceAssignees(result.insertId, parseAssignees(req.body));
        res.redirect('/missions/' + result.insertId + '?success=Mission project created');
    } catch (error) {
        console.error('Error creating mission project:', error);
        res.redirect('/missions?error=Failed to create mission project');
    }
});

// ─── Edit ───────────────────────────────────────────────────────────────────
router.get('/:id/edit', hasPermission('missions.manage'), async (req, res) => {
    try {
        const [[project]] = await db.query('SELECT * FROM mission_projects WHERE id = ?', [req.params.id]);
        if (!project) return res.redirect('/missions?error=Mission project not found');
        const [assignees] = await db.query('SELECT user_id, role FROM mission_project_assignees WHERE project_id = ?', [req.params.id]);
        const lists = await loadFormLists();
        res.render('missions/form', { title: 'Edit Mission Project — Profiteers PMC', action: 'edit', project, assignees, statuses: STATUSES, priorities: PRIORITIES, ...lists });
    } catch (error) {
        console.error('Error loading edit form:', error);
        res.redirect('/missions?error=Failed to load mission project');
    }
});

router.post('/:id/edit', hasPermission('missions.manage'), async (req, res) => {
    try {
        const [[project]] = await db.query('SELECT id FROM mission_projects WHERE id = ?', [req.params.id]);
        if (!project) return res.redirect('/missions?error=Mission project not found');

        const { title, status, priority, map_world, color } = req.body;
        if (!title || !title.trim()) return res.redirect(`/missions/${req.params.id}/edit?error=Title is required`);

        await db.query(`
            UPDATE mission_projects SET
                title = ?, description = ?, status = ?, priority = ?, progress = ?,
                start_date = ?, due_date = ?, lead_user_id = ?, operation_id = ?, campaign_id = ?, modpack_id = ?,
                map_world = ?, color = ?
            WHERE id = ?
        `, [
            title.trim().slice(0, 200),
            sanitizeDescription(req.body.description),
            STATUSES.includes(status) ? status : 'planning',
            PRIORITIES.includes(priority) ? priority : 'normal',
            clampProgress(req.body.progress),
            parseDate(req.body.start_date),
            parseDate(req.body.due_date),
            req.body.lead_user_id ? parseInt(req.body.lead_user_id, 10) : null,
            req.body.operation_id ? parseInt(req.body.operation_id, 10) : null,
            req.body.campaign_id  ? parseInt(req.body.campaign_id, 10)  : null,
            req.body.modpack_id   ? parseInt(req.body.modpack_id, 10)   : null,
            (map_world || '').trim().slice(0, 100) || null,
            /^#[0-9a-fA-F]{6}$/.test(color || '') ? color : '#6b8e23',
            req.params.id,
        ]);
        await replaceAssignees(req.params.id, parseAssignees(req.body));
        res.redirect('/missions/' + req.params.id + '?success=Mission project updated');
    } catch (error) {
        console.error('Error updating mission project:', error);
        res.redirect(`/missions/${req.params.id}/edit?error=Failed to update mission project`);
    }
});

router.post('/:id/delete', hasPermission('missions.manage'), async (req, res) => {
    try {
        await db.query('DELETE FROM mission_projects WHERE id = ?', [req.params.id]);
        await fsp.rm(projectDir(req.params.id), { recursive: true, force: true }).catch(() => {});
        res.redirect('/missions?success=Mission project deleted');
    } catch (error) {
        console.error('Error deleting mission project:', error);
        res.redirect('/missions?error=Failed to delete mission project');
    }
});

// ─── AJAX: drag-reschedule & quick status ─────────────────────────────────────
router.post('/:id/dates', hasPermission('missions.manage'), async (req, res) => {
    try {
        const start = parseDate(req.body.start);
        const end   = parseDate(req.body.end);
        await db.query('UPDATE mission_projects SET start_date = ?, due_date = ? WHERE id = ?', [start, end, req.params.id]);
        res.json({ success: true });
    } catch (error) {
        console.error('Error updating dates:', error);
        res.json({ success: false, error: 'Failed to update dates' });
    }
});

router.post('/:id/status', hasPermission('missions.manage'), async (req, res) => {
    try {
        const status = STATUSES.includes(req.body.status) ? req.body.status : null;
        if (!status) return res.json({ success: false, error: 'Invalid status' });
        await db.query('UPDATE mission_projects SET status = ?, progress = ? WHERE id = ?',
            [status, clampProgress(req.body.progress), req.params.id]);
        res.json({ success: true });
    } catch (error) {
        console.error('Error updating status:', error);
        res.json({ success: false, error: 'Failed to update status' });
    }
});

// ─── Phases (sub-periods within a mission) ──────────────────────────────────────
router.post('/:id/phases', hasPermission('missions.manage'), async (req, res) => {
    try {
        const [[project]] = await db.query('SELECT id FROM mission_projects WHERE id = ?', [req.params.id]);
        if (!project) return res.redirect('/missions?error=Mission project not found');
        const name = (req.body.name || '').trim();
        if (!name) return res.redirect(`/missions/${req.params.id}?error=Phase name is required`);
        await db.query(
            'INSERT INTO mission_phases (project_id, name, start_date, due_date, color, display_order) VALUES (?, ?, ?, ?, ?, ?)',
            [req.params.id, name.slice(0, 120), parseDate(req.body.start_date), parseDate(req.body.due_date),
             /^#[0-9a-fA-F]{6}$/.test(req.body.color || '') ? req.body.color : '#3498db',
             parseInt(req.body.display_order, 10) || 0]
        );
        res.redirect(`/missions/${req.params.id}?success=Phase added`);
    } catch (error) {
        console.error('Error adding phase:', error);
        res.redirect(`/missions/${req.params.id}?error=Failed to add phase`);
    }
});

router.post('/:id/phases/:phaseId/edit', hasPermission('missions.manage'), async (req, res) => {
    try {
        const name = (req.body.name || '').trim();
        if (!name) return res.redirect(`/missions/${req.params.id}?error=Phase name is required`);
        await db.query(
            'UPDATE mission_phases SET name = ?, start_date = ?, due_date = ?, color = ?, display_order = ? WHERE id = ? AND project_id = ?',
            [name.slice(0, 120), parseDate(req.body.start_date), parseDate(req.body.due_date),
             /^#[0-9a-fA-F]{6}$/.test(req.body.color || '') ? req.body.color : '#3498db',
             parseInt(req.body.display_order, 10) || 0, req.params.phaseId, req.params.id]
        );
        res.redirect(`/missions/${req.params.id}?success=Phase updated`);
    } catch (error) {
        console.error('Error updating phase:', error);
        res.redirect(`/missions/${req.params.id}?error=Failed to update phase`);
    }
});

router.post('/:id/phases/:phaseId/delete', hasPermission('missions.manage'), async (req, res) => {
    try {
        await db.query('DELETE FROM mission_phases WHERE id = ? AND project_id = ?', [req.params.phaseId, req.params.id]);
        res.redirect(`/missions/${req.params.id}?success=Phase deleted`);
    } catch (error) {
        console.error('Error deleting phase:', error);
        res.redirect(`/missions/${req.params.id}?error=Failed to delete phase`);
    }
});

router.post('/:id/phases/:phaseId/dates', hasPermission('missions.manage'), async (req, res) => {
    try {
        await db.query('UPDATE mission_phases SET start_date = ?, due_date = ? WHERE id = ? AND project_id = ?',
            [parseDate(req.body.start), parseDate(req.body.end), req.params.phaseId, req.params.id]);
        res.json({ success: true });
    } catch (error) {
        console.error('Error updating phase dates:', error);
        res.json({ success: false, error: 'Failed to update phase dates' });
    }
});

// ─── Mission file versions ────────────────────────────────────────────────────
router.post('/:id/files', hasPermission('missions.manage'), missionUpload, async (req, res) => {
    const id = parseInt(req.params.id, 10);
    try {
        const [[project]] = await db.query('SELECT id FROM mission_projects WHERE id = ?', [id]);
        if (!project) return res.redirect('/missions?error=Mission project not found');

        const versionLabel = (req.body.version_label || '').trim();
        if (!versionLabel) return res.redirect(`/missions/${id}?error=A version name is required`);

        const rawFile = req.files && req.files.raw_file;
        const pboFile = req.files && req.files.pbo_file;
        if (!rawFile && !pboFile) return res.redirect(`/missions/${id}?error=Upload a raw file and/or a PBO`);

        if (pboFile && path.extname(pboFile.name).toLowerCase() !== '.pbo')
            return res.redirect(`/missions/${id}?error=PBO file must have a .pbo extension`);
        if (rawFile && !RAW_EXTS.includes(path.extname(rawFile.name).toLowerCase()))
            return res.redirect(`/missions/${id}?error=Raw file must be one of: ${RAW_EXTS.join(', ')}`);

        await fsp.mkdir(projectDir(id), { recursive: true });
        const [[{ next }]] = await db.query('SELECT COALESCE(MAX(version_number), 0) + 1 AS next FROM mission_files WHERE project_id = ?', [id]);

        const stored = { raw_stored_name: null, raw_original_name: null, raw_size: null, pbo_stored_name: null, pbo_original_name: null, pbo_size: null };
        if (rawFile) {
            const name = `v${next}_raw_${Date.now()}_${safeName(rawFile.name)}`;
            await rawFile.mv(path.join(projectDir(id), name));
            stored.raw_stored_name = name; stored.raw_original_name = rawFile.name.slice(0, 255); stored.raw_size = rawFile.size;
        }
        if (pboFile) {
            const name = `v${next}_pbo_${Date.now()}_${safeName(pboFile.name)}`;
            await pboFile.mv(path.join(projectDir(id), name));
            stored.pbo_stored_name = name; stored.pbo_original_name = pboFile.name.slice(0, 255); stored.pbo_size = pboFile.size;
        }

        await db.query(`
            INSERT INTO mission_files
                (project_id, version_number, version_label, changelog,
                 raw_stored_name, raw_original_name, raw_size, pbo_stored_name, pbo_original_name, pbo_size, uploaded_by)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `, [
            id, next,
            versionLabel.slice(0, 100),
            (req.body.changelog || '').trim() || null,
            stored.raw_stored_name, stored.raw_original_name, stored.raw_size,
            stored.pbo_stored_name, stored.pbo_original_name, stored.pbo_size,
            req.session.userId,
        ]);
        res.redirect(`/missions/${id}?success=Uploaded version ${next}`);
    } catch (error) {
        console.error('Error uploading mission version:', error);
        res.redirect(`/missions/${id}?error=Upload failed`);
    }
});

router.post('/:id/files/:fileId/delete', hasPermission('missions.manage'), async (req, res) => {
    try {
        const [[f]] = await db.query('SELECT * FROM mission_files WHERE id = ? AND project_id = ?', [req.params.fileId, req.params.id]);
        if (f) {
            for (const n of [f.raw_stored_name, f.pbo_stored_name]) {
                if (n) await fsp.rm(path.join(projectDir(req.params.id), n), { force: true }).catch(() => {});
            }
            await db.query('DELETE FROM mission_files WHERE id = ?', [req.params.fileId]);
        }
        res.redirect(`/missions/${req.params.id}?success=Version deleted`);
    } catch (error) {
        console.error('Error deleting mission version:', error);
        res.redirect(`/missions/${req.params.id}?error=Failed to delete version`);
    }
});

router.get('/:id/files/:fileId/download/:kind', hasPermission('missions.view'), async (req, res) => {
    try {
        const kind = req.params.kind === 'pbo' ? 'pbo' : 'raw';
        const [[f]] = await db.query('SELECT * FROM mission_files WHERE id = ? AND project_id = ?', [req.params.fileId, req.params.id]);
        if (!f) return res.status(404).send('File not found');
        const stored   = f[`${kind}_stored_name`];
        const original = f[`${kind}_original_name`];
        if (!stored) return res.status(404).send('File not found');
        return sendFile(res, projectDir(req.params.id), stored, versionedName(original, f.version_number));
    } catch (error) {
        console.error('Error downloading mission file:', error);
        res.status(500).send('Download failed');
    }
});

// ─── Info attachments ─────────────────────────────────────────────────────────
router.post('/:id/attachments', hasPermission('missions.manage'), missionUpload, async (req, res) => {
    const id = parseInt(req.params.id, 10);
    try {
        const [[project]] = await db.query('SELECT id FROM mission_projects WHERE id = ?', [id]);
        if (!project) return res.redirect('/missions?error=Mission project not found');
        const file = req.files && req.files.attachment;
        if (!file) return res.redirect(`/missions/${id}?error=No file selected`);

        await fsp.mkdir(projectDir(id), { recursive: true });
        const name = `att_${Date.now()}_${safeName(file.name)}`;
        await file.mv(path.join(projectDir(id), name));
        await db.query(`
            INSERT INTO mission_project_attachments (project_id, stored_name, original_name, size, mime, uploaded_by)
            VALUES (?, ?, ?, ?, ?, ?)
        `, [id, name, file.name.slice(0, 255), file.size, (file.mimetype || '').slice(0, 120), req.session.userId]);
        res.redirect(`/missions/${id}?success=Attachment uploaded`);
    } catch (error) {
        console.error('Error uploading attachment:', error);
        res.redirect(`/missions/${id}?error=Attachment upload failed`);
    }
});

router.post('/:id/attachments/:attId/delete', hasPermission('missions.manage'), async (req, res) => {
    try {
        const [[a]] = await db.query('SELECT * FROM mission_project_attachments WHERE id = ? AND project_id = ?', [req.params.attId, req.params.id]);
        if (a) {
            await fsp.rm(path.join(projectDir(req.params.id), a.stored_name), { force: true }).catch(() => {});
            await db.query('DELETE FROM mission_project_attachments WHERE id = ?', [req.params.attId]);
        }
        res.redirect(`/missions/${req.params.id}?success=Attachment deleted`);
    } catch (error) {
        console.error('Error deleting attachment:', error);
        res.redirect(`/missions/${req.params.id}?error=Failed to delete attachment`);
    }
});

router.get('/:id/attachments/:attId/download', hasPermission('missions.view'), async (req, res) => {
    try {
        const [[a]] = await db.query('SELECT * FROM mission_project_attachments WHERE id = ? AND project_id = ?', [req.params.attId, req.params.id]);
        if (!a) return res.status(404).send('File not found');

        const dir  = projectDir(req.params.id);
        const full = path.resolve(path.join(dir, a.stored_name));
        if (!full.startsWith(path.resolve(dir) + path.sep)) return res.status(400).send('Bad path');
        if (!fs.existsSync(full)) return res.status(404).send('File missing on disk');

        // Web-viewable types open in the browser; everything else downloads.
        if (isInlineViewable(a.mime, a.original_name)) {
            if (a.mime) res.type(a.mime);
            res.setHeader('Content-Disposition', `inline; filename="${headerFilename(a.original_name)}"`);
            return res.sendFile(full);
        }
        return res.download(full, a.original_name);
    } catch (error) {
        console.error('Error downloading attachment:', error);
        res.status(500).send('Download failed');
    }
});

// ─── Detail page ──────────────────────────────────────────────────────────────
router.get('/:id', hasPermission('missions.view'), async (req, res) => {
    try {
        const [[project]] = await db.query(`
            SELECT mp.*,
                   ${DISPLAY('lu')} AS lead_display_name, lu.discord_id AS lead_discord_id, lu.discord_avatar AS lead_avatar,
                   ${DISPLAY('cu')} AS created_by_display_name,
                   o.title AS operation_title,
                   m.name  AS modpack_name,
                   c.id AS campaign_id, c.name AS campaign_name, c.color AS campaign_color
            FROM mission_projects mp
            LEFT JOIN users lu ON mp.lead_user_id = lu.id
            LEFT JOIN roster_members rm_lu ON rm_lu.discord_id = lu.discord_id
            LEFT JOIN users cu ON mp.created_by = cu.id
            LEFT JOIN roster_members rm_cu ON rm_cu.discord_id = cu.discord_id
            LEFT JOIN operations o ON mp.operation_id = o.id
            LEFT JOIN modpacks   m ON mp.modpack_id   = m.id
            LEFT JOIN mission_campaigns c ON mp.campaign_id = c.id
            WHERE mp.id = ?
        `, [req.params.id]);
        if (!project) return res.status(404).render('error', { title: 'Not Found', message: 'Mission Project Not Found', description: 'This mission project does not exist.', user: res.locals.user });

        const [assignees] = await db.query(`
            SELECT a.role, ${DISPLAY('u')} AS display_name, u.discord_id, u.discord_avatar
            FROM mission_project_assignees a
            JOIN users u ON a.user_id = u.id
            LEFT JOIN roster_members rm_u ON rm_u.discord_id = u.discord_id
            WHERE a.project_id = ?
            ORDER BY display_name ASC
        `, [req.params.id]);

        const [versions] = await db.query(`
            SELECT mf.*, ${DISPLAY('u')} AS uploaded_by_name
            FROM mission_files mf
            LEFT JOIN users u ON mf.uploaded_by = u.id
            LEFT JOIN roster_members rm_u ON rm_u.discord_id = u.discord_id
            WHERE mf.project_id = ?
            ORDER BY mf.version_number DESC
        `, [req.params.id]);

        const [attachments] = await db.query(`
            SELECT at.*, ${DISPLAY('u')} AS uploaded_by_name
            FROM mission_project_attachments at
            LEFT JOIN users u ON at.uploaded_by = u.id
            LEFT JOIN roster_members rm_u ON rm_u.discord_id = u.discord_id
            WHERE at.project_id = ?
            ORDER BY at.uploaded_at DESC
        `, [req.params.id]);
        attachments.forEach(a => { a.viewable = isInlineViewable(a.mime, a.original_name); });

        const [phases] = await db.query(
            'SELECT * FROM mission_phases WHERE project_id = ? ORDER BY display_order ASC, start_date ASC, id ASC',
            [req.params.id]
        );

        res.render('missions/view', {
            title: `${project.title} — Mission Board`,
            description: 'Mission project details.',
            project, assignees, versions, attachments, phases,
            statuses: STATUSES, priorities: PRIORITIES,
            canManage: req.user.permissions.includes('missions.manage'),
            success: req.query.success || null,
            error:   req.query.error   || null,
        });
    } catch (error) {
        console.error('Error loading mission project:', error);
        res.render('error', { title: 'Error', message: 'Error Loading Mission Project', description: 'Could not load mission project.', user: res.locals.user });
    }
});

// True for files browsers can render inline (open in-tab instead of downloading).
// SVG is intentionally excluded — served same-origin it can execute script.
function isInlineViewable(mime, name) {
    const m = (mime || '').toLowerCase();
    const ext = path.extname(name || '').toLowerCase();
    if (m === 'application/pdf' || ext === '.pdf') return true;
    if (/^image\//.test(m) && m !== 'image/svg+xml') return true;
    if (/^(video|audio)\//.test(m)) return true;
    if (!m || m === 'application/octet-stream') {
        return ['.png','.jpg','.jpeg','.gif','.webp','.avif','.bmp',
                '.mp4','.webm','.ogg','.ogv','.mov','.m4v',
                '.mp3','.wav','.m4a','.flac','.opus'].includes(ext);
    }
    return false;
}

// Sanitise a filename for a Content-Disposition header (strip quotes / control chars).
function headerFilename(name) {
    return (name || 'file').replace(/[\r\n"\\]/g, '_');
}

// Insert the version number before the file extension, e.g.
// "Mission.Malden.pbo" + v2 -> "Mission.Malden_v2.pbo".
function versionedName(original, version) {
    if (!original) return original;
    const ext = path.extname(original);
    const base = original.slice(0, original.length - ext.length);
    return `${base}_v${version}${ext}`;
}

// Resolve a stored file within the project dir (guard against traversal) and stream it.
function sendFile(res, dir, storedName, originalName) {
    const full = path.resolve(path.join(dir, storedName));
    if (!full.startsWith(path.resolve(dir) + path.sep)) return res.status(400).send('Bad path');
    if (!fs.existsSync(full)) return res.status(404).send('File missing on disk');
    return res.download(full, originalName || path.basename(full));
}

module.exports = router;
