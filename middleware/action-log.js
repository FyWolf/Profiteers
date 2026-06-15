const db = require('../config/database');

// ─────────────────────────────────────────────────────────────────────────────
// Admin Action Log
//
// A global audit trail that records *who did what, where and when* for every
// state-changing request on the website. It is implemented as a single
// app-level middleware that hooks the response 'finish' event, so it captures
// every current AND future mutating endpoint automatically — no per-route code.
//
// Only mutating methods are recorded (POST/PUT/PATCH/DELETE). GET requests are
// page views and are already tracked separately by middleware/analytics.js.
//
// Viewing the log requires the `logs.view` permission (seeded below).
// ─────────────────────────────────────────────────────────────────────────────

const TRACKED_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

// High-frequency real-time endpoints excluded by default so live collaborative
// editing (map planner autosave) does not flood the audit log with hundreds of
// rows per session. Remove an entry here to start logging it. Keys are
// "METHOD <mounted route pattern>".
const SKIP_ROUTES = new Set([
    // Live map-plan editor autosave
    'PATCH /plans/:id/world',
    'POST /plans/:id/layers',
    'PATCH /plans/:id/layers/:layerId',
    'DELETE /plans/:id/layers/:layerId',
    'POST /plans/:id/annotations',
    'PATCH /plans/:id/annotations/:annId',
    'DELETE /plans/:id/annotations/:annId',
    // Live operation-map editor autosave
    'PATCH /operations/:id/map/world',
    'POST /operations/:id/map/layers',
    'PATCH /operations/:id/map/layers/:layerId',
    'DELETE /operations/:id/map/layers/:layerId',
    'POST /operations/:id/map/annotations',
    'PATCH /operations/:id/map/annotations/:annId',
    'DELETE /operations/:id/map/annotations/:annId',
]);

// ─── Action registry ─────────────────────────────────────────────────────────
// The full catalogue of trackable actions on the site, keyed by
// "METHOD <mounted route pattern>". `label` is a human-readable description,
// `category` groups related actions, `target` names the kind of entity acted on.
// Endpoints not listed here still get logged with an auto-generated label.
const ACTIONS = {
    // ── Authentication ──────────────────────────────────────────────────────
    'POST /login': { label: 'Logged in (admin/local login)', category: 'Authentication', target: 'session' },

    // ── Users ───────────────────────────────────────────────────────────────
    'POST /admin/users/delete/:id':                       { label: 'Deleted a user', category: 'Users', target: 'user' },
    'POST /admin/users/:userId/medals/award':             { label: 'Awarded a medal to a user', category: 'Users', target: 'user' },
    'POST /admin/users/:userId/medals/revoke/:awardId':   { label: 'Revoked a medal from a user', category: 'Users', target: 'user' },
    'POST /admin/users/:userId/sync-trainings':           { label: "Synced a user's trainings", category: 'Users', target: 'user' },
    'POST /admin/users/:userId/roles/assign':             { label: 'Assigned a role to a user', category: 'Users', target: 'user' },
    'POST /admin/users/:userId/roles/revoke/:roleId':     { label: 'Revoked a role from a user', category: 'Users', target: 'user' },

    // ── Roles & permissions ─────────────────────────────────────────────────
    'POST /admin/roles/create':     { label: 'Created a role', category: 'Roles', target: 'role' },
    'POST /admin/roles/:id/edit':   { label: 'Edited a role', category: 'Roles', target: 'role' },
    'POST /admin/roles/:id/delete': { label: 'Deleted a role', category: 'Roles', target: 'role' },

    // ── Tools ───────────────────────────────────────────────────────────────
    'POST /admin/tools/add':        { label: 'Created a tool', category: 'Tools', target: 'tool' },
    'POST /admin/tools/edit/:id':   { label: 'Edited a tool', category: 'Tools', target: 'tool' },
    'POST /admin/tools/toggle/:id': { label: 'Toggled a tool', category: 'Tools', target: 'tool' },
    'POST /admin/tools/delete/:id': { label: 'Deleted a tool', category: 'Tools', target: 'tool' },

    // ── Medals ──────────────────────────────────────────────────────────────
    'POST /admin/medals/add':        { label: 'Created a medal', category: 'Medals', target: 'medal' },
    'POST /admin/medals/edit/:id':   { label: 'Edited a medal', category: 'Medals', target: 'medal' },
    'POST /admin/medals/delete/:id': { label: 'Deleted a medal', category: 'Medals', target: 'medal' },

    // ── Trainings ───────────────────────────────────────────────────────────
    'POST /admin/trainings/add':        { label: 'Created a training', category: 'Trainings', target: 'training' },
    'POST /admin/trainings/edit/:id':   { label: 'Edited a training', category: 'Trainings', target: 'training' },
    'POST /admin/trainings/delete/:id': { label: 'Deleted a training', category: 'Trainings', target: 'training' },

    // ── Slot types ──────────────────────────────────────────────────────────
    'POST /admin/slot-types/add':            { label: 'Created a slot type', category: 'Slot Types', target: 'slot_type' },
    'POST /admin/slot-types/edit/:id':       { label: 'Edited a slot type', category: 'Slot Types', target: 'slot_type' },
    'POST /admin/slot-types/delete/:id':     { label: 'Deleted a slot type', category: 'Slot Types', target: 'slot_type' },
    'POST /admin/slot-types/reorder':        { label: 'Reordered slot types', category: 'Slot Types', target: 'slot_type' },
    'POST /admin/slot-types/:id/superiors':  { label: 'Set slot type chain of command', category: 'Slot Types', target: 'slot_type' },

    // ── Information page ────────────────────────────────────────────────────
    'POST /admin/info/servers/add':         { label: 'Added a server', category: 'Info Page', target: 'server' },
    'POST /admin/info/servers/edit/:id':    { label: 'Edited a server', category: 'Info Page', target: 'server' },
    'POST /admin/info/servers/delete/:id':  { label: 'Deleted a server', category: 'Info Page', target: 'server' },
    'POST /admin/info/departments/add':        { label: 'Added a department', category: 'Info Page', target: 'department' },
    'POST /admin/info/departments/edit/:id':   { label: 'Edited a department', category: 'Info Page', target: 'department' },
    'POST /admin/info/departments/delete/:id': { label: 'Deleted a department', category: 'Info Page', target: 'department' },
    'POST /admin/info/staff/add':         { label: 'Added a staff member', category: 'Info Page', target: 'staff' },
    'POST /admin/info/staff/edit/:id':    { label: 'Edited a staff member', category: 'Info Page', target: 'staff' },
    'POST /admin/info/staff/delete/:id':  { label: 'Deleted a staff member', category: 'Info Page', target: 'staff' },
    'POST /admin/info/kit/roles/add':         { label: 'Added a kit role', category: 'Info Page', target: 'kit_role' },
    'POST /admin/info/kit/roles/edit/:id':    { label: 'Edited a kit role', category: 'Info Page', target: 'kit_role' },
    'POST /admin/info/kit/roles/delete/:id':  { label: 'Deleted a kit role', category: 'Info Page', target: 'kit_role' },
    'POST /admin/info/kit/slots/add':         { label: 'Added a kit slot', category: 'Info Page', target: 'kit_slot' },
    'POST /admin/info/kit/slots/edit/:id':    { label: 'Edited a kit slot', category: 'Info Page', target: 'kit_slot' },
    'POST /admin/info/kit/slots/delete/:id':  { label: 'Deleted a kit slot', category: 'Info Page', target: 'kit_slot' },

    // ── Gallery ─────────────────────────────────────────────────────────────
    'POST /admin/gallery/add-folder':        { label: 'Created a gallery folder', category: 'Gallery', target: 'folder' },
    'POST /admin/gallery/upload':            { label: 'Uploaded gallery image(s)', category: 'Gallery', target: 'image' },
    'POST /admin/gallery/delete-image/:id':  { label: 'Deleted a gallery image', category: 'Gallery', target: 'image' },
    'POST /admin/gallery/delete-folder/:id': { label: 'Deleted a gallery folder', category: 'Gallery', target: 'folder' },

    // ── Admin map plans & terrains ──────────────────────────────────────────
    'DELETE /admin/map-plans/:id':            { label: 'Deleted a map plan (admin)', category: 'Map Plans', target: 'plan' },
    'POST /admin/map-plans/:id/transfer':     { label: 'Transferred map plan ownership', category: 'Map Plans', target: 'plan' },
    'POST /admin/map-plans/terrains/import':  { label: 'Imported a terrain', category: 'Map Plans', target: 'terrain' },
    'DELETE /admin/map-plans/terrains/:world':{ label: 'Deleted a terrain', category: 'Map Plans', target: 'terrain' },

    // ── Leave of Absence ────────────────────────────────────────────────────
    'POST /loa/submit':      { label: 'Submitted an LOA request', category: 'LOA', target: 'loa' },
    'POST /loa/edit/:id':    { label: 'Edited an LOA request', category: 'LOA', target: 'loa' },
    'POST /loa/delete/:id':  { label: 'Deleted an LOA request', category: 'LOA', target: 'loa' },
    'POST /loa/review/:id':  { label: 'Reviewed an LOA request', category: 'LOA', target: 'loa' },

    // ── Lore terminal ───────────────────────────────────────────────────────
    'POST /lore/api/nodes/:id/files': { label: 'Added a lore file', category: 'Lore', target: 'lore_node' },
    'DELETE /lore/api/files/:id':     { label: 'Deleted a lore file', category: 'Lore', target: 'lore_file' },
    'POST /lore/api/nodes':           { label: 'Created a lore node', category: 'Lore', target: 'lore_node' },
    'PATCH /lore/api/nodes/:id':      { label: 'Edited a lore node', category: 'Lore', target: 'lore_node' },
    'DELETE /lore/api/nodes/:id':     { label: 'Deleted a lore node', category: 'Lore', target: 'lore_node' },

    // ── Modpacks ────────────────────────────────────────────────────────────
    'POST /modpacks/check-size':   { label: 'Checked a modpack size', category: 'Modpacks', target: 'modpack' },
    'POST /modpacks/upload':       { label: 'Uploaded a modpack', category: 'Modpacks', target: 'modpack' },
    'POST /modpacks/:id/pin':      { label: 'Pinned/unpinned a modpack', category: 'Modpacks', target: 'modpack' },
    'POST /modpacks/:id/reindex':  { label: 'Re-indexed a modpack', category: 'Modpacks', target: 'modpack' },
    'POST /modpacks/:id/delete':   { label: 'Deleted a modpack', category: 'Modpacks', target: 'modpack' },

    // ── Roster ──────────────────────────────────────────────────────────────
    'POST /roster/sync': { label: 'Ran a roster sync', category: 'Roster', target: 'roster' },

    // ── Operations ──────────────────────────────────────────────────────────
    'POST /operations/:id/attendance':          { label: 'Set operation attendance', category: 'Operations', target: 'operation' },
    'POST /operations/manage/blocks/create':    { label: 'Created a scheduling block', category: 'Operations', target: 'block' },
    'POST /operations/manage/blocks/delete/:id':{ label: 'Deleted a scheduling block', category: 'Operations', target: 'block' },
    'POST /operations/manage/create':           { label: 'Created an operation', category: 'Operations', target: 'operation' },
    'POST /operations/manage/edit/:id':         { label: 'Edited an operation', category: 'Operations', target: 'operation' },
    'POST /operations/manage/delete/:id':       { label: 'Deleted an operation', category: 'Operations', target: 'operation' },
    'POST /operations/:id/news/file':           { label: 'Uploaded an operation news file', category: 'Operations', target: 'operation' },
    'POST /operations/:id/news/image':          { label: 'Uploaded an operation news image', category: 'Operations', target: 'operation' },
    'POST /operations/:id/news':                { label: 'Posted operation news', category: 'Operations', target: 'operation' },
    'POST /operations/news/delete/:newsId':     { label: 'Deleted operation news', category: 'Operations', target: 'operation' },
    'POST /operations/:id/map/import-plan/:planId': { label: 'Imported a plan into an operation map', category: 'Operations', target: 'operation' },

    // ── Map plans (user) ────────────────────────────────────────────────────
    'POST /plans':                  { label: 'Created a map plan', category: 'Map Plans', target: 'plan' },
    'PATCH /plans/:id':             { label: 'Updated a map plan', category: 'Map Plans', target: 'plan' },
    'POST /plans/:id/edit':         { label: 'Edited a map plan', category: 'Map Plans', target: 'plan' },
    'DELETE /plans/:id':            { label: 'Deleted a map plan', category: 'Map Plans', target: 'plan' },
    'POST /plans/:id/duplicate':    { label: 'Duplicated a map plan', category: 'Map Plans', target: 'plan' },
    'POST /plans/:id/acl':          { label: 'Shared a map plan with a user', category: 'Map Plans', target: 'plan' },
    'PATCH /plans/:id/acl/:userId': { label: 'Changed a map plan share', category: 'Map Plans', target: 'plan' },
    'DELETE /plans/:id/acl/:userId':{ label: 'Removed a map plan share', category: 'Map Plans', target: 'plan' },
    'POST /plans/:id/share':        { label: 'Changed map plan share settings', category: 'Map Plans', target: 'plan' },

    // ── ORBAT (templates & operation order of battle) ───────────────────────
    'POST /orbat/templates/create':           { label: 'Created an ORBAT template', category: 'ORBAT', target: 'template' },
    'POST /orbat/templates/edit/:id':         { label: 'Edited an ORBAT template', category: 'ORBAT', target: 'template' },
    'POST /orbat/templates/delete/:id':       { label: 'Deleted an ORBAT template', category: 'ORBAT', target: 'template' },
    'POST /orbat/templates/:id/squads/add':   { label: 'Added a squad to an ORBAT', category: 'ORBAT', target: 'squad' },
    'POST /orbat/squads/delete/:id':          { label: 'Deleted an ORBAT squad', category: 'ORBAT', target: 'squad' },
    'POST /orbat/squads/edit/:id':            { label: 'Edited an ORBAT squad', category: 'ORBAT', target: 'squad' },
    'POST /orbat/squads/:id/roles/add':       { label: 'Added an ORBAT role', category: 'ORBAT', target: 'role' },
    'POST /orbat/roles/delete/:id':           { label: 'Deleted an ORBAT role', category: 'ORBAT', target: 'role' },
    'POST /orbat/roles/edit/:id':             { label: 'Edited an ORBAT role', category: 'ORBAT', target: 'role' },
    'POST /orbat/roles/:id/set-slot-type':    { label: 'Set an ORBAT role slot type', category: 'ORBAT', target: 'role' },
    'POST /orbat/claim/:roleId':              { label: 'Claimed an ORBAT slot', category: 'ORBAT', target: 'role' },
    'POST /orbat/unclaim/:roleId':            { label: 'Unclaimed an ORBAT slot', category: 'ORBAT', target: 'role' },
    'POST /orbat/assign/:roleId':             { label: 'Assigned a player to an ORBAT slot', category: 'ORBAT', target: 'role' },
    'POST /orbat/unassign/:roleId':           { label: 'Unassigned an ORBAT slot', category: 'ORBAT', target: 'role' },
    'POST /orbat/operation/:operationId/create-dynamic':   { label: 'Created a dynamic ORBAT', category: 'ORBAT', target: 'operation' },
    'POST /orbat/operation/:operationId/add-squad':        { label: 'Added a squad to an operation ORBAT', category: 'ORBAT', target: 'operation' },
    'POST /orbat/operation/:operationId/publish-orbat':    { label: 'Published an operation ORBAT', category: 'ORBAT', target: 'operation' },
    'POST /orbat/operation/:operationId/unpublish-orbat':  { label: 'Unpublished an operation ORBAT', category: 'ORBAT', target: 'operation' },
    'POST /orbat/squads/:squadId/add-role-dynamic':        { label: 'Added a dynamic ORBAT role', category: 'ORBAT', target: 'squad' },
    'POST /orbat/api/squads/:squadId/add-role':            { label: 'Added an ORBAT role', category: 'ORBAT', target: 'squad' },
    'POST /orbat/api/roles/:id/edit':                      { label: 'Edited an ORBAT role', category: 'ORBAT', target: 'role' },
    'POST /orbat/api/squads/:squadId/reorder-roles':       { label: 'Reordered ORBAT roles', category: 'ORBAT', target: 'squad' },
    'POST /orbat/api/roles/:id/delete':                    { label: 'Deleted an ORBAT role', category: 'ORBAT', target: 'role' },
    'POST /orbat/api/templates/:templateId/squads/add':    { label: 'Added a squad to an ORBAT template', category: 'ORBAT', target: 'template' },
    'POST /orbat/api/squads/:id/edit':                     { label: 'Edited an ORBAT squad', category: 'ORBAT', target: 'squad' },
    'POST /orbat/api/squads/:id/delete':                   { label: 'Deleted an ORBAT squad', category: 'ORBAT', target: 'squad' },
    'POST /orbat/api/squads/:squadId/add-team':            { label: 'Added an ORBAT team', category: 'ORBAT', target: 'team' },
    'POST /orbat/api/teams/:teamId/edit':                  { label: 'Edited an ORBAT team', category: 'ORBAT', target: 'team' },
    'POST /orbat/api/teams/:teamId/delete':                { label: 'Deleted an ORBAT team', category: 'ORBAT', target: 'team' },
    'POST /orbat/api/squads/:squadId/reorder-teams':       { label: 'Reordered ORBAT teams', category: 'ORBAT', target: 'squad' },
    'POST /orbat/api/squads/:squadId/reorder-siblings':    { label: 'Reordered ORBAT squads', category: 'ORBAT', target: 'squad' },
    'POST /orbat/api/squads/:squadId/reparent':            { label: 'Reparented an ORBAT squad', category: 'ORBAT', target: 'squad' },
    'POST /orbat/api/roles/:roleId/set-team':              { label: 'Set an ORBAT role team', category: 'ORBAT', target: 'role' },
    'POST /orbat/api/migrate-hierarchy':                   { label: 'Migrated ORBAT hierarchy', category: 'ORBAT', target: 'orbat' },
    'POST /orbat/api/squads/:squadId/set-frequencies':     { label: 'Set ORBAT squad frequencies', category: 'ORBAT', target: 'squad' },
    'POST /orbat/api/squads/:id/icon':                     { label: 'Set an ORBAT squad icon', category: 'ORBAT', target: 'squad' },
    'DELETE /orbat/api/squads/:id/icon':                   { label: 'Removed an ORBAT squad icon', category: 'ORBAT', target: 'squad' },
    'POST /orbat/api/teams/:teamId/set-frequencies':       { label: 'Set ORBAT team frequencies', category: 'ORBAT', target: 'team' },
};

// ─── Before/after row snapshots ──────────────────────────────────────────────
// For edit/delete endpoints that act on a single identifiable row, we snapshot
// that DB row *before* the handler runs and again *after*, then diff them — so
// the log can show exactly what changed. Keyed by "METHOD <mounted pattern>".
// `table` is the DB table, `idParam` is the route param holding the row id
// (the WHERE column is always `id`), and `op` is 'edit' or 'delete'.
const ROW_SOURCES = {
    // Users
    'POST /admin/users/delete/:id':                     { table: 'users', idParam: 'id', op: 'delete' },
    'POST /admin/users/:userId/medals/revoke/:awardId': { table: 'user_medals', idParam: 'awardId', op: 'delete' },

    // Roles
    'POST /admin/roles/:id/edit':   { table: 'roles', idParam: 'id', op: 'edit' },
    'POST /admin/roles/:id/delete': { table: 'roles', idParam: 'id', op: 'delete' },

    // Tools
    'POST /admin/tools/edit/:id':   { table: 'tools', idParam: 'id', op: 'edit' },
    'POST /admin/tools/toggle/:id': { table: 'tools', idParam: 'id', op: 'edit' },
    'POST /admin/tools/delete/:id': { table: 'tools', idParam: 'id', op: 'delete' },

    // Medals
    'POST /admin/medals/edit/:id':   { table: 'medals', idParam: 'id', op: 'edit' },
    'POST /admin/medals/delete/:id': { table: 'medals', idParam: 'id', op: 'delete' },

    // Trainings
    'POST /admin/trainings/edit/:id':   { table: 'trainings', idParam: 'id', op: 'edit' },
    'POST /admin/trainings/delete/:id': { table: 'trainings', idParam: 'id', op: 'delete' },

    // Slot types
    'POST /admin/slot-types/edit/:id':   { table: 'slot_types', idParam: 'id', op: 'edit' },
    'POST /admin/slot-types/delete/:id': { table: 'slot_types', idParam: 'id', op: 'delete' },

    // Info page
    'POST /admin/info/servers/edit/:id':       { table: 'info_servers', idParam: 'id', op: 'edit' },
    'POST /admin/info/servers/delete/:id':     { table: 'info_servers', idParam: 'id', op: 'delete' },
    'POST /admin/info/departments/edit/:id':   { table: 'info_departments', idParam: 'id', op: 'edit' },
    'POST /admin/info/departments/delete/:id': { table: 'info_departments', idParam: 'id', op: 'delete' },
    'POST /admin/info/staff/edit/:id':         { table: 'info_staff', idParam: 'id', op: 'edit' },
    'POST /admin/info/staff/delete/:id':       { table: 'info_staff', idParam: 'id', op: 'delete' },
    'POST /admin/info/kit/roles/edit/:id':     { table: 'kit_roles', idParam: 'id', op: 'edit' },
    'POST /admin/info/kit/roles/delete/:id':   { table: 'kit_roles', idParam: 'id', op: 'delete' },
    'POST /admin/info/kit/slots/edit/:id':     { table: 'kit_slots', idParam: 'id', op: 'edit' },
    'POST /admin/info/kit/slots/delete/:id':   { table: 'kit_slots', idParam: 'id', op: 'delete' },

    // Gallery
    'POST /admin/gallery/delete-image/:id':  { table: 'gallery_images', idParam: 'id', op: 'delete' },
    'POST /admin/gallery/delete-folder/:id': { table: 'gallery_folders', idParam: 'id', op: 'delete' },

    // LOA
    'POST /loa/edit/:id':   { table: 'leave_of_absence', idParam: 'id', op: 'edit' },
    'POST /loa/delete/:id': { table: 'leave_of_absence', idParam: 'id', op: 'delete' },
    'POST /loa/review/:id': { table: 'leave_of_absence', idParam: 'id', op: 'edit' },

    // Lore
    'PATCH /lore/api/nodes/:id':  { table: 'lore_nodes', idParam: 'id', op: 'edit' },
    'DELETE /lore/api/nodes/:id': { table: 'lore_nodes', idParam: 'id', op: 'delete' },
    'DELETE /lore/api/files/:id': { table: 'lore_files', idParam: 'id', op: 'delete' },

    // Modpacks
    'POST /modpacks/:id/pin':    { table: 'modpacks', idParam: 'id', op: 'edit' },
    'POST /modpacks/:id/delete': { table: 'modpacks', idParam: 'id', op: 'delete' },

    // Operations
    'POST /operations/manage/edit/:id':          { table: 'operations', idParam: 'id', op: 'edit' },
    'POST /operations/manage/delete/:id':        { table: 'operations', idParam: 'id', op: 'delete' },
    'POST /operations/manage/blocks/delete/:id': { table: 'locked_periods', idParam: 'id', op: 'delete' },
    'POST /operations/news/delete/:newsId':      { table: 'operation_news', idParam: 'newsId', op: 'delete' },

    // Map plans
    'PATCH /plans/:id':                   { table: 'map_plans', idParam: 'id', op: 'edit' },
    'POST /plans/:id/edit':               { table: 'map_plans', idParam: 'id', op: 'edit' },
    'DELETE /plans/:id':                  { table: 'map_plans', idParam: 'id', op: 'delete' },
    'POST /plans/:id/share':              { table: 'map_plans', idParam: 'id', op: 'edit' },
    'DELETE /admin/map-plans/:id':        { table: 'map_plans', idParam: 'id', op: 'delete' },
    'POST /admin/map-plans/:id/transfer': { table: 'map_plans', idParam: 'id', op: 'edit' },

    // ORBAT
    'POST /orbat/templates/edit/:id':                     { table: 'orbat_templates', idParam: 'id', op: 'edit' },
    'POST /orbat/templates/delete/:id':                   { table: 'orbat_templates', idParam: 'id', op: 'delete' },
    'POST /orbat/squads/edit/:id':                        { table: 'orbat_squads', idParam: 'id', op: 'edit' },
    'POST /orbat/squads/delete/:id':                      { table: 'orbat_squads', idParam: 'id', op: 'delete' },
    'POST /orbat/roles/edit/:id':                         { table: 'orbat_roles', idParam: 'id', op: 'edit' },
    'POST /orbat/roles/delete/:id':                       { table: 'orbat_roles', idParam: 'id', op: 'delete' },
    'POST /orbat/roles/:id/set-slot-type':                { table: 'orbat_roles', idParam: 'id', op: 'edit' },
    'POST /orbat/api/roles/:id/edit':                     { table: 'orbat_roles', idParam: 'id', op: 'edit' },
    'POST /orbat/api/roles/:id/delete':                   { table: 'orbat_roles', idParam: 'id', op: 'delete' },
    'POST /orbat/api/squads/:id/edit':                    { table: 'orbat_squads', idParam: 'id', op: 'edit' },
    'POST /orbat/api/squads/:id/delete':                  { table: 'orbat_squads', idParam: 'id', op: 'delete' },
    'POST /orbat/api/squads/:id/icon':                    { table: 'orbat_squads', idParam: 'id', op: 'edit' },
    'DELETE /orbat/api/squads/:id/icon':                  { table: 'orbat_squads', idParam: 'id', op: 'edit' },
    'POST /orbat/api/squads/:squadId/set-frequencies':    { table: 'orbat_squads', idParam: 'squadId', op: 'edit' },
    'POST /orbat/api/squads/:squadId/reparent':           { table: 'orbat_squads', idParam: 'squadId', op: 'edit' },
    'POST /orbat/api/teams/:teamId/edit':                 { table: 'orbat_teams', idParam: 'teamId', op: 'edit' },
    'POST /orbat/api/teams/:teamId/delete':               { table: 'orbat_teams', idParam: 'teamId', op: 'delete' },
    'POST /orbat/api/teams/:teamId/set-frequencies':      { table: 'orbat_teams', idParam: 'teamId', op: 'edit' },
    'POST /orbat/api/roles/:roleId/set-team':             { table: 'orbat_roles', idParam: 'roleId', op: 'edit' },
    'POST /orbat/operation/:operationId/publish-orbat':   { table: 'operations', idParam: 'operationId', op: 'edit' },
    'POST /orbat/operation/:operationId/unpublish-orbat': { table: 'operations', idParam: 'operationId', op: 'edit' },
};

// Whitelist of tables the logger is allowed to read (keys above are the source
// of truth; this Set guards the table name we interpolate into the snapshot SQL).
const ALLOWED_TABLES = new Set(Object.values(ROW_SOURCES).map(s => s.table));

// Compile a mounted route pattern (e.g. "/admin/tools/edit/:id") into a regex
// plus the ordered list of param names it captures.
function compilePattern(pattern) {
    const names = [];
    const body = pattern.split('/').map(seg => {
        if (seg.startsWith(':')) { names.push(seg.slice(1)); return '([^/]+)'; }
        return seg.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    }).join('/');
    return { re: new RegExp('^' + body + '/?$'), names };
}

const ROW_SOURCE_LIST = Object.entries(ROW_SOURCES).map(([key, cfg]) => {
    const sp = key.indexOf(' ');
    const method = key.slice(0, sp);
    const pattern = key.slice(sp + 1);
    const { re, names } = compilePattern(pattern);
    return { method, re, names, ...cfg };
});

// Match a request (method + raw path) to a row source and pull out the row id.
function findRowSource(method, pathname) {
    for (const s of ROW_SOURCE_LIST) {
        if (s.method !== method) continue;
        const m = s.re.exec(pathname);
        if (m) {
            const id = m[s.names.indexOf(s.idParam) + 1];
            return { source: s, id };
        }
    }
    return null;
}

async function fetchRow(table, id) {
    if (!ALLOWED_TABLES.has(table) || id == null) return null;
    try {
        const [rows] = await db.query(`SELECT * FROM \`${table}\` WHERE id = ? LIMIT 1`, [id]);
        return rows.length ? sanitizeBody(rows[0]) : null;
    } catch (_) {
        return null;
    }
}

// Shallow diff of two row snapshots → { field: { from, to } } for changed fields.
function diffRows(before, after) {
    if (!before || !after) return null;
    const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
    const changes = {};
    for (const k of keys) {
        const b = before[k] === undefined ? null : before[k];
        const a = after[k] === undefined ? null : after[k];
        if (JSON.stringify(b) !== JSON.stringify(a)) changes[k] = { from: b, to: a };
    }
    return Object.keys(changes).length ? changes : null;
}

// Sensitive keys that must never be written to the audit log (covers request
// bodies AND row snapshots — e.g. users.discord_access_token).
const REDACT_KEYS = /pass(word)?|token|secret|csrf|api[-_]?key|authorization/i;
const MAX_VALUE_LEN = 500;

function sanitizeBody(body) {
    if (!body || typeof body !== 'object') return null;
    const out = {};
    let count = 0;
    for (const [key, value] of Object.entries(body)) {
        if (count >= 40) { out['…'] = 'truncated'; break; }
        count++;
        if (REDACT_KEYS.test(key)) { out[key] = '[redacted]'; continue; }
        if (value == null) { out[key] = value; continue; }
        if (typeof value === 'string') {
            out[key] = value.length > MAX_VALUE_LEN ? value.slice(0, MAX_VALUE_LEN) + '…' : value;
        } else if (typeof value === 'number' || typeof value === 'boolean') {
            out[key] = value;
        } else {
            // arrays / nested objects → compact JSON, capped
            let s;
            try { s = JSON.stringify(value); } catch { s = String(value); }
            out[key] = s.length > MAX_VALUE_LEN ? s.slice(0, MAX_VALUE_LEN) + '…' : s;
        }
    }
    return Object.keys(out).length ? out : null;
}

function extractIp(req) {
    return (req.headers['x-forwarded-for'] || req.socket.remoteAddress || '')
        .split(',')[0].trim().substring(0, 45) || null;
}

function routePattern(req) {
    const base = req.baseUrl || '';
    let rp = '';
    if (req.route && typeof req.route.path === 'string') rp = req.route.path;
    else if (Array.isArray(req.route?.path)) rp = String(req.route.path[0]);
    // Normalise: avoid a doubled trailing slash when route path is '/'
    if (rp === '/') return base || '/';
    return base + rp;
}

// Auto-generate a label for endpoints not present in the registry.
function autoLabel(method, pattern) {
    const verb = { POST: 'Performed', PUT: 'Updated', PATCH: 'Updated', DELETE: 'Deleted' }[method] || method;
    return `${verb}: ${method} ${pattern}`;
}

function resolveAction(method, pattern) {
    const entry = ACTIONS[`${method} ${pattern}`];
    if (entry) return entry;
    const category = (pattern.split('/').filter(Boolean)[0] || 'other');
    return { label: autoLabel(method, pattern), category: category.charAt(0).toUpperCase() + category.slice(1), target: null, _auto: true };
}

async function actionLogger(req, res, next) {
    if (!TRACKED_METHODS.has(req.method)) return next();

    // Snapshot the body now — handlers may mutate req.body before 'finish'.
    const bodySnapshot = sanitizeBody(req.body);
    const ip = extractIp(req);
    const ua = (req.headers['user-agent'] || '').substring(0, 500) || null;

    // If this is a single-row edit/delete, snapshot the row *before* the handler
    // runs (req.params isn't populated yet at app level, so match the raw path).
    let rowSource = null, rowId = null, beforeData = null;
    try {
        const match = findRowSource(req.method, req.path);
        if (match && match.id != null) {
            rowSource = match.source;
            rowId = match.id;
            beforeData = await fetchRow(rowSource.table, rowId);
        }
    } catch (_) { /* snapshot is best-effort */ }

    res.on('finish', () => {
        (async () => {
            const pattern = routePattern(req);
            const key = `${req.method} ${pattern}`;
            if (SKIP_ROUTES.has(key)) return;

            const action = resolveAction(req.method, pattern);

            const userId = req.user ? req.user.id : null;
            // Prefer the user's Discord guild nickname (server display name) over
            // their global display name, and only fall back to the account
            // username (@handle) as a last resort.
            let username = null;
            if (req.user) {
                username = req.user.discord_global_name || req.user.username || null;
                if (req.user.discord_id) {
                    try {
                        const [rm] = await db.query(
                            'SELECT nickname FROM roster_members WHERE discord_id = ? LIMIT 1',
                            [req.user.discord_id]
                        );
                        if (rm.length && rm[0].nickname) username = rm[0].nickname;
                    } catch (_) { /* roster table may not exist yet */ }
                }
            }

            // Best-effort target id from the most specific route param.
            const params = req.params || {};
            const targetId = rowId || params.id || params.userId || params.roleId || params.squadId
                || params.teamId || params.operationId || params.templateId
                || params.layerId || params.annId || params.world || params.newsId
                || params.awardId || params.planId || null;

            const statusCode = res.statusCode;
            const success = statusCode < 400 ? 1 : 0;

            // Resolve after-state only when the action succeeded.
            let afterData = null, changes = null;
            if (rowSource && success) {
                if (rowSource.op === 'delete') {
                    afterData = null;                       // row is gone
                } else {
                    afterData = await fetchRow(rowSource.table, rowId);
                    changes = diffRows(beforeData, afterData);
                }
            }
            // Don't keep a before-snapshot for a failed action (nothing changed).
            const beforeOut = (rowSource && success) ? beforeData : null;

            db.query(
                `INSERT INTO admin_action_logs
                    (user_id, username, method, route, path, action_label, category,
                     target_type, target_id, status_code, success, ip, user_agent,
                     body, before_data, after_data, changes)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                [
                    userId,
                    username,
                    req.method,
                    pattern,
                    (req.originalUrl || req.url || '').substring(0, 500),
                    action.label,
                    action.category,
                    action.target,
                    targetId ? String(targetId).substring(0, 64) : null,
                    statusCode,
                    success,
                    ip,
                    ua,
                    bodySnapshot ? JSON.stringify(bodySnapshot) : null,
                    beforeOut ? JSON.stringify(beforeOut) : null,
                    afterData ? JSON.stringify(afterData) : null,
                    changes ? JSON.stringify(changes) : null,
                ]
            ).catch(() => {});
        })().catch(() => { /* never let logging break a response */ });
    });

    next();
}

// ─── Self-initialising schema + permission seed (mirrors analytics.js) ───────
(async () => {
    try {
        await db.query(`
            CREATE TABLE IF NOT EXISTS admin_action_logs (
                id           BIGINT NOT NULL AUTO_INCREMENT,
                user_id      INT NULL,
                username     VARCHAR(255) NULL,
                method       VARCHAR(10) NOT NULL,
                route        VARCHAR(255) NULL,
                path         VARCHAR(500) NOT NULL,
                action_label VARCHAR(255) NULL,
                category     VARCHAR(64) NULL,
                target_type  VARCHAR(64) NULL,
                target_id    VARCHAR(64) NULL,
                status_code  INT NULL,
                success      TINYINT(1) NOT NULL DEFAULT 1,
                ip           VARCHAR(45) NULL,
                user_agent   VARCHAR(500) NULL,
                body         JSON NULL,
                before_data  JSON NULL,
                after_data   JSON NULL,
                changes      JSON NULL,
                created_at   TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                PRIMARY KEY (id),
                INDEX idx_user       (user_id),
                INDEX idx_category   (category),
                INDEX idx_route      (route),
                INDEX idx_success    (success),
                INDEX idx_created_at (created_at)
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 DEFAULT COLLATE=uca1400_ai_ci
        `);

        // Add the before/after columns to pre-existing installs (no-op if present).
        await db.query(`ALTER TABLE admin_action_logs ADD COLUMN IF NOT EXISTS before_data JSON NULL`);
        await db.query(`ALTER TABLE admin_action_logs ADD COLUMN IF NOT EXISTS after_data  JSON NULL`);
        await db.query(`ALTER TABLE admin_action_logs ADD COLUMN IF NOT EXISTS changes     JSON NULL`);

        // Seed the logs.view permission (no-op if it already exists).
        await db.query(
            `INSERT INTO permissions (name, category, description)
             SELECT 'logs.view', 'admin', 'View the admin action log (audit trail)' FROM DUAL
             WHERE NOT EXISTS (SELECT 1 FROM permissions WHERE name = 'logs.view')`
        );
    } catch (err) {
        console.error('Failed to initialise admin action log:', err.message);
    }
})();

// ─── "Where it happened" link resolver ───────────────────────────────────────
// Maps a logged action back to the relevant *viewable* page so the log viewer
// can offer an "Open" button. The stored `path` is the mutation endpoint (often
// not viewable), so we map by mounted-route prefix to a sensible GET page,
// substituting ids pulled from the actual path. Returns a URL or null.
function paramsFromPath(route, path) {
    if (!route || !path) return {};
    try {
        const { re, names } = compilePattern(route);
        const m = re.exec(String(path).split('?')[0]);
        if (!m) return {};
        const out = {};
        names.forEach((n, i) => { out[n] = m[i + 1]; });
        return out;
    } catch (_) { return {}; }
}

function resolveDestination(log) {
    const route = log.route || '';
    const p = paramsFromPath(route, log.path);

    // Operation-scoped actions (ORBAT on an op, publish, etc.) → the op page.
    if (p.operationId) return `/operations/${p.operationId}`;

    if (route.startsWith('/operations')) {
        if (route.startsWith('/operations/manage/blocks')) return '/operations/manage/blocks';
        if (route.startsWith('/operations/manage/delete')) return '/operations/manage/list';
        if (route.includes('/news/delete')) return '/operations/all';
        return p.id ? `/operations/${p.id}` : '/operations/manage/list';
    }
    if (route.startsWith('/modpacks'))        return p.id ? `/modpacks/${p.id}` : '/modpacks';
    if (route.startsWith('/plans'))           return p.id ? `/plans/${p.id}` : '/plans';
    if (route.startsWith('/admin/map-plans')) return p.id ? `/plans/${p.id}` : '/admin/map-plans';
    if (route.startsWith('/orbat/templates')) return p.id ? `/orbat/templates/edit/${p.id}` : '/orbat/templates';
    if (route.startsWith('/orbat'))           return '/orbat/templates';
    if (route.startsWith('/admin/roles'))     return p.id ? `/admin/roles/${p.id}/edit` : '/admin/roles';
    if (route.startsWith('/admin/users'))     return '/admin/users';
    if (route.startsWith('/admin/tools'))     return '/admin/tools';
    if (route.startsWith('/admin/medals'))    return '/admin/medals';
    if (route.startsWith('/admin/trainings')) return '/admin/trainings';
    if (route.startsWith('/admin/slot-types'))return '/admin/slot-types';
    if (route.startsWith('/admin/gallery'))   return '/admin/gallery';
    if (route.startsWith('/admin/info'))      return '/admin/info/servers';
    if (route.startsWith('/loa'))             return '/loa/all';
    if (route.startsWith('/lore'))            return '/lore/admin';
    if (route.startsWith('/roster'))          return '/roster';

    return null;
}

module.exports = { actionLogger, ACTIONS, resolveDestination };
