const express = require('express');
const router = express.Router();
const db = require('../../config/database');
const { resolveDestination } = require('../../middleware/action-log');

const PAGE_SIZE = 50;

function asObj(v) {
    if (v == null) return null;
    if (typeof v === 'object') return v;
    try { return JSON.parse(v); } catch (e) { return null; }
}

const snakeKey = (k) => String(k).replace(/([a-z0-9])([A-Z])/g, '$1_$2').toLowerCase();

// table → SQL expression that yields a human name for a row id. The table name
// and expression are hardcoded constants (safe to interpolate); ids are bound.
const NAME_SOURCES = {
    users:            'COALESCE(discord_global_name, username)',
    roles:            'name',
    orbat_roles:      'role_name',
    orbat_squads:     'name',
    orbat_teams:      'name',
    orbat_templates:  'name',
    roster_roles:     'name',
    operations:       'title',
    tools:            'title',
    medals:           'name',
    trainings:        'name',
    slot_types:       'name',
    info_servers:     'name',
    info_departments: 'name',
    kit_roles:        'name',
    kit_slots:        'slot_name',
    gallery_folders:  'name',
    map_plans:        'name',
    modpacks:         'name',
};

// target_type → table ('role' is disambiguated by category at the call site).
const TARGET_TABLES = {
    user: 'users', tool: 'tools', medal: 'medals', training: 'trainings', slot_type: 'slot_types',
    server: 'info_servers', department: 'info_departments', kit_role: 'kit_roles', kit_slot: 'kit_slots',
    folder: 'gallery_folders', plan: 'map_plans', modpack: 'modpacks', operation: 'operations',
    template: 'orbat_templates', squad: 'orbat_squads', team: 'orbat_teams',
};

// Foreign-key field name (snake_case) → table it points at.
const FK_FIELDS = {
    user_id: 'users', assigned_by: 'users', created_by: 'users', owner_id: 'users',
    host_id: 'users', reviewed_by: 'users',
    slot_type_id: 'slot_types', parent_squad_id: 'orbat_squads', squad_id: 'orbat_squads',
    team_id: 'orbat_teams', role_id: 'orbat_roles', highest_role_id: 'roster_roles',
    department_id: 'info_departments', orbat_template_id: 'orbat_templates', operation_id: 'operations',
};

function targetTable(log) {
    if (log.target_type === 'role') return log.category === 'Roles' ? 'roles' : 'orbat_roles';
    return TARGET_TABLES[log.target_type] || null;
}

// Look up readable names for every entity/FK id referenced on this page of logs,
// in one query per table. Returns { resolved, targetNameOf, nameForField }.
async function buildNameResolver(logs) {
    const need = {}; // table → Set(id)
    const add = (table, id) => {
        if (!table || !NAME_SOURCES[table]) return;
        const n = Number(id);
        if (Number.isInteger(n)) (need[table] || (need[table] = new Set())).add(n);
    };
    const scan = (obj, isChanges) => {
        if (!obj) return;
        for (const [k, v] of Object.entries(obj)) {
            const tbl = FK_FIELDS[snakeKey(k)];
            if (!tbl) continue;
            if (isChanges) { add(tbl, v && v.from); add(tbl, v && v.to); }
            else add(tbl, v);
        }
    };
    for (const log of logs) {
        add(targetTable(log), log.target_id);
        scan(asObj(log.changes), true);
        scan(asObj(log.before_data), false);
        scan(asObj(log.after_data), false);
        scan(asObj(log.body), false);
    }

    const resolved = {};
    for (const [table, ids] of Object.entries(need)) {
        if (!ids.size) continue;
        try {
            const [rows] = await db.query(
                `SELECT id, ${NAME_SOURCES[table]} AS name FROM \`${table}\` WHERE id IN (?)`,
                [[...ids]]
            );
            const map = {};
            rows.forEach(r => { map[r.id] = r.name; });
            resolved[table] = map;
        } catch (e) { /* table/column may differ in this install — skip */ }
    }

    const targetNameOf = (log) => {
        const tbl = targetTable(log);
        const n = Number(log.target_id);
        return tbl && resolved[tbl] && Number.isInteger(n) ? (resolved[tbl][n] || null) : null;
    };
    const nameForField = (key, value) => {
        const tbl = FK_FIELDS[snakeKey(key)];
        const n = Number(value);
        return tbl && resolved[tbl] && Number.isInteger(n) ? (resolved[tbl][n] || null) : null;
    };
    return { targetNameOf, nameForField };
}

// Find the ORBAT a squad belongs to → template (orbat_id) or operation.
async function squadOwner(squadId) {
    if (squadId == null) return null;
    const [rows] = await db.query(
        'SELECT orbat_id, operation_id FROM orbat_squads WHERE id = ? LIMIT 1',
        [squadId]
    );
    return rows.length ? rows[0] : null;
}

// What kind of entity the target_id refers to, per ORBAT route pattern. Mapping
// by exact route (rather than substring) avoids misreading e.g. the squad id in
// /orbat/squads/:id/roles/add as a role id.
const ORBAT_ENTITY = {
    '/orbat/squads/edit/:id':                    'squad',
    '/orbat/squads/delete/:id':                  'squad',
    '/orbat/squads/:id/roles/add':               'squad',
    '/orbat/squads/:squadId/add-role-dynamic':   'squad',
    '/orbat/api/squads/:squadId/add-role':       'squad',
    '/orbat/api/squads/:squadId/reorder-roles':  'squad',
    '/orbat/api/squads/:id/edit':                'squad',
    '/orbat/api/squads/:id/delete':              'squad',
    '/orbat/api/squads/:squadId/add-team':       'squad',
    '/orbat/api/squads/:squadId/reorder-teams':  'squad',
    '/orbat/api/squads/:squadId/reorder-siblings':'squad',
    '/orbat/api/squads/:squadId/reparent':       'squad',
    '/orbat/api/squads/:squadId/set-frequencies':'squad',
    '/orbat/api/squads/:id/icon':                'squad',
    '/orbat/roles/edit/:id':                     'role',
    '/orbat/roles/delete/:id':                   'role',
    '/orbat/roles/:id/set-slot-type':            'role',
    '/orbat/api/roles/:id/edit':                 'role',
    '/orbat/api/roles/:id/delete':               'role',
    '/orbat/api/roles/:roleId/set-team':         'role',
    '/orbat/assign/:roleId':                     'role',
    '/orbat/unassign/:roleId':                   'role',
    '/orbat/claim/:roleId':                      'role',
    '/orbat/unclaim/:roleId':                    'role',
    '/orbat/api/teams/:teamId/edit':             'team',
    '/orbat/api/teams/:teamId/delete':           'team',
    '/orbat/api/teams/:teamId/set-frequencies':  'team',
    '/orbat/api/templates/:templateId/squads/add':'template',
};

// Resolve an ORBAT action to its *specific* template/operation page by walking
// from the acted-on entity (squad / role / team) up to its owning ORBAT. Falls
// back to the row snapshot (before_data) when the entity was deleted. Returns a
// URL or null (keep the generic fallback).
async function orbatDestination(log) {
    const type = ORBAT_ENTITY[log.route || ''];
    const id = log.target_id;
    if (!type || id == null) return null;
    const before = asObj(log.before_data);
    let owner = null; // { orbat_id, operation_id }

    try {
        if (type === 'template') {
            owner = { orbat_id: id, operation_id: null };          // id IS the template
        } else if (type === 'squad') {
            owner = await squadOwner(id);
            if (!owner && before) owner = { orbat_id: before.orbat_id, operation_id: before.operation_id };
        } else if (type === 'role') {
            const [r] = await db.query('SELECT squad_id FROM orbat_roles WHERE id = ? LIMIT 1', [id]);
            owner = await squadOwner(r[0] ? r[0].squad_id : (before && before.squad_id));
        } else if (type === 'team') {
            const [t] = await db.query('SELECT squad_id FROM orbat_teams WHERE id = ? LIMIT 1', [id]);
            owner = await squadOwner(t[0] ? t[0].squad_id : (before && before.squad_id));
        }
    } catch (e) {
        return null;
    }

    if (owner) {
        if (owner.orbat_id)     return `/orbat/templates/edit/${owner.orbat_id}`;
        if (owner.operation_id) return `/operations/${owner.operation_id}`;
    }
    return null;
}

router.get('/', async (req, res) => {
    try {
        const page = Math.max(1, parseInt(req.query.page) || 1);
        const offset = (page - 1) * PAGE_SIZE;

        const search   = (req.query.q || '').trim();
        const category = (req.query.category || '').trim();
        const method   = (req.query.method || '').trim().toUpperCase();
        const userId   = (req.query.user || '').trim();
        const status   = (req.query.status || '').trim(); // 'success' | 'failed'

        const where = [];
        const params = [];

        if (search) {
            where.push('(l.action_label LIKE ? OR l.path LIKE ? OR l.username LIKE ?)');
            params.push(`%${search}%`, `%${search}%`, `%${search}%`);
        }
        if (category) { where.push('l.category = ?'); params.push(category); }
        if (['POST', 'PUT', 'PATCH', 'DELETE'].includes(method)) { where.push('l.method = ?'); params.push(method); }
        if (userId)   { where.push('l.user_id = ?'); params.push(userId); }
        if (status === 'success') where.push('l.success = 1');
        if (status === 'failed')  where.push('l.success = 0');

        const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';

        const [[{ total }]] = await db.query(
            `SELECT COUNT(*) AS total FROM admin_action_logs l ${whereSql}`,
            params
        );

        const [logs] = await db.query(
            `SELECT
                l.*,
                COALESCE(rm.nickname, u.discord_global_name, u.username, l.username) AS actor_name,
                u.discord_id   AS actor_discord_id,
                u.discord_avatar AS actor_avatar
             FROM admin_action_logs l
             LEFT JOIN users u ON l.user_id = u.id
             LEFT JOIN roster_members rm ON rm.discord_id = u.discord_id
             ${whereSql}
             ORDER BY l.created_at DESC, l.id DESC
             LIMIT ? OFFSET ?`,
            [...params, PAGE_SIZE, offset]
        );

        // Best-effort link to the page where each action can be viewed.
        for (const log of logs) {
            log.destination = resolveDestination(log);
            // ORBAT squad/role/team actions only resolve to the templates list by
            // default — walk the DB to point at the specific ORBAT instead.
            if (log.destination === '/orbat/templates') {
                const refined = await orbatDestination(log);
                if (refined) log.destination = refined;
            }
        }

        // Resolve entity/foreign-key ids to readable names for this page.
        const { targetNameOf, nameForField } = await buildNameResolver(logs);
        for (const log of logs) {
            log.targetName = targetNameOf(log);
        }

        // Filter option sources
        const [categories] = await db.query(
            `SELECT DISTINCT category FROM admin_action_logs WHERE category IS NOT NULL ORDER BY category ASC`
        );
        const [actors] = await db.query(
            `SELECT DISTINCT l.user_id, COALESCE(rm.nickname, u.discord_global_name, u.username, l.username) AS name
             FROM admin_action_logs l
             LEFT JOIN users u ON l.user_id = u.id
             LEFT JOIN roster_members rm ON rm.discord_id = u.discord_id
             WHERE l.user_id IS NOT NULL
             ORDER BY name ASC`
        );

        const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));

        res.render('admin/logs', {
            title: 'Action Log - Admin',
            logs,
            categories: categories.map(c => c.category),
            actors,
            total,
            page,
            totalPages,
            pageSize: PAGE_SIZE,
            filters: { search, category, method, user: userId, status },
            nameForField,
        });
    } catch (error) {
        console.error('Error loading action log:', error);
        res.render('error', {
            title: 'Error',
            message: 'Error Loading Action Log',
            description: 'Could not load the action log.',
            user: res.locals.user
        });
    }
});

module.exports = router;
