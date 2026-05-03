const express = require('express');
const router = express.Router({ mergeParams: true });
const db = require('../config/database');
const { isAuthenticated } = require('../middleware/auth');

// Build a set of squad IDs the current user may submit attendance for.
// Returns { isLeader: bool, squadIds: Set<int> }
// NOTE: user→role link is in orbat_assignments (role_id UNIQUE), not orbat_roles.
//       orbat_id is on orbat_squads, not orbat_roles.
async function getLeaderScope(userId, operationId, db) {
    const [[op]] = await db.query(
        'SELECT orbat_template_id FROM operations WHERE id = ?',
        [operationId]
    );
    if (!op || !op.orbat_template_id) return { isLeader: false, squadIds: new Set() };

    // Roles this user holds in the template that carry the is_leader flag
    const [leaderRoles] = await db.query(`
        SELECT orr.squad_id
        FROM orbat_assignments oa
        JOIN orbat_roles   orr ON oa.role_id      = orr.id
        JOIN orbat_squads  os  ON orr.squad_id     = os.id
        JOIN slot_types    st  ON orr.slot_type_id = st.id
        WHERE os.orbat_id = ? AND oa.user_id = ? AND st.is_leader = 1
    `, [op.orbat_template_id, userId]);

    if (leaderRoles.length === 0) return { isLeader: false, squadIds: new Set() };

    // Load all squads in this template once; build parent → children map
    const [allSquads] = await db.query(
        'SELECT id, parent_squad_id FROM orbat_squads WHERE orbat_id = ?',
        [op.orbat_template_id]
    );

    const childMap = new Map();
    for (const s of allSquads) {
        const p = s.parent_squad_id ?? null;
        if (!childMap.has(p)) childMap.set(p, []);
        childMap.get(p).push(s.id);
    }

    function collectDescendants(squadId, result) {
        result.add(squadId);
        for (const childId of (childMap.get(squadId) || [])) {
            collectDescendants(childId, result);
        }
    }

    const squadIds = new Set();
    for (const { squad_id } of leaderRoles) {
        collectDescendants(squad_id, squadIds);
    }

    return { isLeader: true, squadIds };
}

// Shared roles query: all filled slots in a template, optionally restricted to a squad set.
// Returns rows with role_id, user_id, squad_id, slot_type_*, squad_name, username, discord_global_name.
function buildRolesQuery(templateId, squadIds) {
    let sql = `
        SELECT
            orr.id            AS role_id,
            oa.user_id,
            orr.squad_id,
            orr.slot_type_id,
            st.name           AS slot_type_name,
            st.abbreviation   AS slot_type_abbr,
            os.name           AS squad_name,
            u.username,
            u.discord_global_name
        FROM orbat_roles orr
        JOIN orbat_squads    os ON orr.squad_id     = os.id
        JOIN orbat_assignments oa ON orr.id          = oa.role_id
        LEFT JOIN slot_types st  ON orr.slot_type_id = st.id
        LEFT JOIN users      u   ON oa.user_id       = u.id
        WHERE os.orbat_id = ?
    `;
    const params = [templateId];

    if (squadIds && squadIds.size > 0) {
        sql += ` AND orr.squad_id IN (${[...squadIds].map(() => '?').join(',')})`;
        params.push(...squadIds);
    }

    sql += ' ORDER BY os.name ASC, st.display_order ASC';
    return { sql, params };
}

// GET /operations/:id/post-op
router.get('/', isAuthenticated, async (req, res) => {
    try {
        const opId = parseInt(req.params.id);
        if (isNaN(opId)) return res.status(404).render('error', { title: 'Not Found', message: 'Operation not found', description: '', user: res.locals.user });

        const [[op]] = await db.query(
            'SELECT id, title, start_time, orbat_type, orbat_template_id FROM operations WHERE id = ? AND is_published = 1',
            [opId]
        );
        if (!op) return res.status(404).render('error', { title: 'Not Found', message: 'Operation not found', description: '', user: res.locals.user });

        if (op.orbat_type !== 'fixed') return res.redirect(`/operations/${opId}`);
        if (!op.start_time || op.start_time > Math.floor(Date.now() / 1000)) return res.redirect(`/operations/${opId}`);

        const isAdmin = Array.isArray(res.locals.user?.permissions) && res.locals.user.permissions.includes('attendance.manage');
        const { isLeader, squadIds } = await getLeaderScope(req.session.userId, opId, db);

        if (!isLeader && !isAdmin) return res.status(403).render('error', { title: 'Forbidden', message: 'Access Denied', description: 'You do not have a leadership role in this operation.', user: res.locals.user });

        if (!isAdmin && squadIds.size === 0) return res.status(403).render('error', { title: 'Forbidden', message: 'Access Denied', description: 'No squads in scope.', user: res.locals.user });

        const { sql, params } = buildRolesQuery(op.orbat_template_id, isAdmin ? null : squadIds);
        const [roles] = await db.query(sql, params);

        // Existing attendance records for this operation
        const [existingRows] = await db.query(
            'SELECT user_id, status, notes FROM orbat_attendance WHERE operation_id = ?',
            [opId]
        );
        const existingMap = {};
        for (const r of existingRows) existingMap[r.user_id] = r;

        // LOA records active at the time of this operation
        const userIds = roles.map(r => r.user_id).filter(Boolean);
        const loaMap = {};
        if (userIds.length > 0) {
            const [loaRows] = await db.query(`
                SELECT user_id, start_date, end_date
                FROM leave_of_absence
                WHERE status = 'approved'
                  AND start_date <= ?
                  AND end_date   >= ?
                  AND user_id IN (${userIds.map(() => '?').join(',')})
            `, [op.start_time, op.start_time, ...userIds]);
            for (const l of loaRows) loaMap[l.user_id] = l;
        }

        // Group roles by squad
        const squadMap = new Map();
        for (const role of roles) {
            if (!squadMap.has(role.squad_id)) {
                squadMap.set(role.squad_id, { squad_name: role.squad_name, roles: [] });
            }
            squadMap.get(role.squad_id).roles.push(role);
        }

        res.render('orbat/post-op-attendance', {
            title: `Post-Op Attendance — ${op.title}`,
            operation: op,
            squads: [...squadMap.values()],
            existingMap,
            loaMap,
            success: req.query.success,
            error: req.query.error
        });
    } catch (err) {
        console.error('Error loading post-op attendance:', err);
        res.render('error', { title: 'Error', message: 'Could not load attendance form', description: '', user: res.locals.user });
    }
});

// POST /operations/:id/post-op
router.post('/', isAuthenticated, async (req, res) => {
    try {
        const opId = parseInt(req.params.id);
        if (isNaN(opId)) return res.redirect('/operations');

        const [[op]] = await db.query(
            'SELECT id, title, start_time, orbat_type, orbat_template_id FROM operations WHERE id = ? AND is_published = 1',
            [opId]
        );
        if (!op || op.orbat_type !== 'fixed') return res.redirect(`/operations/${opId}`);
        if (!op.start_time || op.start_time > Math.floor(Date.now() / 1000)) return res.redirect(`/operations/${opId}`);

        const isAdmin = Array.isArray(res.locals.user?.permissions) && res.locals.user.permissions.includes('attendance.manage');
        const { isLeader, squadIds } = await getLeaderScope(req.session.userId, opId, db);

        if (!isLeader && !isAdmin) return res.status(403).render('error', { title: 'Forbidden', message: 'Access Denied', description: '', user: res.locals.user });

        // Form keys use "u<id>" prefix to prevent qs from parsing numeric keys as a sparse array
        const rawEntries = req.body.entries || {};
        const entries = typeof rawEntries === 'object' && !Array.isArray(rawEntries) ? rawEntries : {};

        const VALID_STATUSES = new Set(['present', 'excused', 'awol']);

        if (!isAdmin && squadIds.size === 0) return res.redirect(`/operations/${opId}/post-op?error=No squads in scope`);

        const { sql, params } = buildRolesQuery(op.orbat_template_id, isAdmin ? null : squadIds);
        const [roles] = await db.query(sql, params);
        const roleByUserId = new Map(roles.map(r => [r.user_id, r]));

        const rows = [];
        for (const [key, entry] of Object.entries(entries)) {
            const userId = parseInt(key.replace(/^u/, ''));
            if (isNaN(userId)) continue;
            const { status, notes } = entry;
            if (!VALID_STATUSES.has(status)) continue;
            const role = roleByUserId.get(userId);
            if (!role) continue;

            rows.push([
                opId,
                userId,
                role.role_id,
                role.slot_type_id,
                role.squad_id,
                role.slot_type_name || 'Unknown',
                role.slot_type_abbr || null,
                role.squad_name,
                op.start_time,
                status,
                notes != null ? String(notes).trim() || null : null,
                req.session.userId
            ]);
        }

        if (rows.length > 0) {
            await db.query(`
                INSERT INTO orbat_attendance
                    (operation_id, user_id, role_id, slot_type_id, squad_id,
                     slot_type_name, slot_type_abbr, squad_name, operation_date,
                     status, notes, submitted_by)
                VALUES ?
                ON DUPLICATE KEY UPDATE
                    status       = VALUES(status),
                    notes        = VALUES(notes),
                    submitted_by = VALUES(submitted_by),
                    updated_at   = NOW()
            `, [rows]);
        }

        res.redirect(`/operations/${opId}/post-op?success=Attendance saved`);
    } catch (err) {
        console.error('Error saving post-op attendance:', err);
        res.redirect(`/operations/${req.params.id}/post-op?error=Failed to save attendance`);
    }
});

// GET /operations/:id/post-op/overview
router.get('/overview', isAuthenticated, async (req, res) => {
    try {
        const opId = parseInt(req.params.id);
        if (isNaN(opId)) return res.status(404).render('error', { title: 'Not Found', message: 'Operation not found', description: '', user: res.locals.user });

        const [[op]] = await db.query(
            'SELECT id, title, start_time, orbat_type FROM operations WHERE id = ? AND is_published = 1',
            [opId]
        );
        if (!op) return res.status(404).render('error', { title: 'Not Found', message: 'Operation not found', description: '', user: res.locals.user });

        const isAdmin = Array.isArray(res.locals.user?.permissions) && res.locals.user.permissions.includes('attendance.manage');
        const { isLeader, squadIds } = await getLeaderScope(req.session.userId, opId, db);

        if (!isLeader && !isAdmin) return res.status(403).render('error', { title: 'Forbidden', message: 'Access Denied', description: '', user: res.locals.user });

        let query = `
            SELECT
                oa.squad_id,
                oa.squad_name,
                oa.slot_type_name,
                oa.slot_type_abbr,
                oa.status,
                oa.notes,
                u.username,
                u.discord_global_name,
                su.username AS submitted_by_username
            FROM orbat_attendance oa
            LEFT JOIN users u  ON oa.user_id      = u.id
            LEFT JOIN users su ON oa.submitted_by = su.id
            WHERE oa.operation_id = ?
        `;
        const params = [opId];

        if (!isAdmin && squadIds.size > 0) {
            query += ` AND oa.squad_id IN (${[...squadIds].map(() => '?').join(',')})`;
            params.push(...squadIds);
        }

        query += ' ORDER BY oa.squad_name ASC, oa.slot_type_name ASC';
        const [records] = await db.query(query, params);

        const squadMap = new Map();
        for (const r of records) {
            const key = r.squad_name;
            if (!squadMap.has(key)) squadMap.set(key, { squad_name: r.squad_name, records: [] });
            squadMap.get(key).records.push(r);
        }

        res.render('orbat/post-op-overview', {
            title: `Attendance Overview — ${op.title}`,
            operation: op,
            squads: [...squadMap.values()]
        });
    } catch (err) {
        console.error('Error loading attendance overview:', err);
        res.render('error', { title: 'Error', message: 'Could not load overview', description: '', user: res.locals.user });
    }
});

module.exports = { router, getLeaderScope };
