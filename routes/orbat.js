const express = require('express');
const router = express.Router();
const db = require('../config/database');
const { isAuthenticated, isAdmin } = require('../middleware/auth');
const { isZeus, checkZeusStatus } = require('../middleware/zeus');
const { EmbedBuilder } = require('discord.js');
const { discordClient } = require('../discord');

function buildTree(squads) {
    const byId = {};
    squads.forEach(s => { byId[s.id] = { ...s, children: [] }; });
    const roots = [];
    squads.forEach(s => {
        if (s.parent_squad_id && byId[s.parent_squad_id]) {
            byId[s.parent_squad_id].children.push(byId[s.id]);
        } else {
            roots.push(byId[s.id]);
        }
    });
    const sortNode = n => { n.children.sort((a, b) => a.display_order - b.display_order); n.children.forEach(sortNode); };
    roots.sort((a, b) => a.display_order - b.display_order);
    roots.forEach(sortNode);
    return roots;
}

// Check if userId is an editor of squadId OR any of its ancestors
async function isEditorOfSquadOrAncestor(userId, squadId) {
    if (!userId || !squadId) return false;
    const visited = new Set();
    let currentId = squadId;
    while (currentId && !visited.has(currentId)) {
        visited.add(currentId);
        const [check] = await db.query(`
            SELECT 1 FROM orbat_roles er
            JOIN orbat_assignments oa ON er.id = oa.role_id
            WHERE er.squad_id = ? AND er.is_editor = TRUE AND oa.user_id = ?
            LIMIT 1
        `, [currentId, userId]);
        if (check.length > 0) return true;
        const [sq] = await db.query('SELECT parent_squad_id FROM orbat_squads WHERE id = ?', [currentId]);
        currentId = sq[0]?.parent_squad_id || null;
    }
    return false;
}

async function isSquadEditor(userId, roleId) {
    if (!userId) return false;
    const [roleRows] = await db.query('SELECT squad_id FROM orbat_roles WHERE id = ?', [roleId]);
    if (!roleRows.length) return false;
    return isEditorOfSquadOrAncestor(userId, roleRows[0].squad_id);
}

async function isOperationHost(userId, operationId) {
    if (!userId || !operationId) return false;
    const [rows] = await db.query('SELECT host_id FROM operations WHERE id = ?', [operationId]);
    return rows.length > 0 && rows[0].host_id == userId;
}

async function isHostOfSquadOperation(userId, squadId) {
    if (!userId || !squadId) return false;
    const [rows] = await db.query(`
        SELECT o.host_id FROM orbat_squads os
        JOIN operations o ON o.id = os.operation_id
        WHERE os.id = ? AND os.operation_id IS NOT NULL
    `, [squadId]);
    return rows.length > 0 && rows[0].host_id == userId;
}

async function isHostOfRoleOperation(userId, roleId) {
    if (!userId || !roleId) return false;
    const [rows] = await db.query(`
        SELECT o.host_id FROM orbat_roles r
        JOIN orbat_squads os ON r.squad_id = os.id
        JOIN operations o ON o.id = os.operation_id
        WHERE r.id = ? AND os.operation_id IS NOT NULL
    `, [roleId]);
    return rows.length > 0 && rows[0].host_id == userId;
}

// Middleware: check if user is Zeus/Admin or the operation host
function canManageOperation(req, res, next) {
    (async () => {
        const userIsZeus = req.session.isAdmin || await checkZeusStatus(req.session.userId);
        if (userIsZeus || await isOperationHost(req.session.userId, req.params.operationId)) {
            return next();
        }
        return res.status(403).json({ success: false, error: 'Permission denied' });
    })().catch(next);
}

router.get('/api/templates', async (req, res) => {
    try {
        const [templates] = await db.query(`
            SELECT 
                ot.id,
                ot.name,
                COUNT(DISTINCT os.id) as squad_count
            FROM orbat_templates ot
            LEFT JOIN orbat_squads os ON ot.id = os.orbat_id
            WHERE ot.is_active = TRUE
            GROUP BY ot.id
            ORDER BY ot.name ASC
        `);
        
        res.json(templates);
    } catch (error) {
        console.error('Error loading templates:', error);
        res.status(500).json([]);
    }
});

router.get('/view-all', async (req, res) => {
    try {
        const [templates] = await db.query(`
            SELECT * FROM orbat_templates 
            WHERE is_active = TRUE
            ORDER BY name ASC
        `);
        
        res.render('orbat/public-view', {
            title: 'ORBAT Templates - Profiteers PMC',
            templates: templates
        });
    } catch (error) {
        console.error('Error loading ORBAT templates:', error);
        res.render('error', {
            title: 'Error',
            message: 'Error Loading ORBATs',
            description: 'Could not load ORBAT templates.',
            user: res.locals.user
        });
    }
});

router.get('/view/:templateId', async (req, res) => {
    try {
        const [templates] = await db.query(
            'SELECT * FROM orbat_templates WHERE id = ? AND is_active = TRUE',
            [req.params.templateId]
        );
        
        if (templates.length === 0) {
            return res.render('error', {
                title: 'ORBAT Not Found',
                message: 'ORBAT Not Found',
                description: 'This ORBAT template does not exist.',
                user: res.locals.user
            });
        }
        
        const template = templates[0];

        const [squads] = await db.query(`
            SELECT * FROM orbat_squads 
            WHERE orbat_id = ?
            ORDER BY display_order ASC
        `, [req.params.templateId]);
        
        const rolesBySquad = {};
        const assignments = {};
        const teamsBySquad = {};

        if (squads.length > 0) {
            const squadIds = squads.map(s => s.id);
            const [roles] = await db.query(`
                SELECT * FROM orbat_roles
                WHERE squad_id IN (?)
                ORDER BY display_order ASC
            `, [squadIds]);

            roles.forEach(role => {
                if (!rolesBySquad[role.squad_id]) {
                    rolesBySquad[role.squad_id] = [];
                }
                rolesBySquad[role.squad_id].push(role);
            });

            const [teams] = await db.query(
                'SELECT * FROM orbat_teams WHERE squad_id IN (?) ORDER BY display_order ASC',
                [squadIds]
            );
            teams.forEach(t => {
                if (!teamsBySquad[t.squad_id]) teamsBySquad[t.squad_id] = [];
                teamsBySquad[t.squad_id].push(t);
            });

            const roleIds = roles.map(r => r.id);
            if (roleIds.length > 0) {
                const [assignmentData] = await db.query(`
                    SELECT
                        oa.*,
                        u.username,
                        u.discord_global_name,
                        u.discord_avatar,
                        u.discord_id,
                        rm.nickname as roster_nickname
                    FROM orbat_assignments oa
                    JOIN users u ON oa.user_id = u.id
                    LEFT JOIN roster_members rm ON rm.discord_id = u.discord_id
                    WHERE oa.role_id IN (?)
                `, [roleIds]);

                assignmentData.forEach(assignment => {
                    assignments[assignment.role_id] = assignment;
                });
            }
        }

        const editorSquadIds = [];
        if (req.session.userId) {
            Object.values(rolesBySquad).forEach(roles => {
                roles.forEach(role => {
                    if (role.is_editor && assignments[role.id] && assignments[role.id].user_id === req.session.userId) {
                        editorSquadIds.push(role.squad_id);
                    }
                });
            });
            // Expand: editor of a squad = editor of all its descendants
            const editorSet = new Set(editorSquadIds);
            let changed = true;
            while (changed) {
                changed = false;
                for (const squad of squads) {
                    if (squad.parent_squad_id && editorSet.has(squad.parent_squad_id) && !editorSet.has(squad.id)) {
                        editorSet.add(squad.id);
                        changed = true;
                    }
                }
            }
            editorSquadIds.length = 0;
            editorSet.forEach(id => editorSquadIds.push(id));
        }

        res.render('orbat/public-template', {
            title: `${template.name} - Profiteers PMC`,
            template: template,
            squads: squads,
            squadTree: buildTree(squads),
            rolesBySquad: rolesBySquad,
            assignments: assignments,
            teamsBySquad: teamsBySquad,
            editorSquadIds: editorSquadIds
        });
    } catch (error) {
        console.error('Error loading ORBAT template:', error);
        res.render('error', {
            title: 'Error',
            message: 'Error Loading ORBAT',
            description: 'Could not load the ORBAT template.',
            user: res.locals.user
        });
    }
});

router.get('/templates', isAdmin, async (req, res) => {
    try {
        const [templates] = await db.query(`
            SELECT 
                ot.*,
                u.username as created_by_username,
                COUNT(DISTINCT os.id) as squad_count,
                COUNT(DISTINCT oper.id) as usage_count
            FROM orbat_templates ot
            LEFT JOIN users u ON ot.created_by = u.id
            LEFT JOIN orbat_squads os ON ot.id = os.orbat_id
            LEFT JOIN operations oper ON oper.orbat_template_id = ot.id
            GROUP BY ot.id
            ORDER BY ot.created_at DESC
        `);

        res.render('orbat/templates', {
            title: 'ORBAT Templates - Admin',
            templates: templates,
            success: req.query.success || null,
            error: req.query.error || null
        });
    } catch (error) {
        console.error('Error loading ORBAT templates:', error);
        res.render('error', {
            title: 'Error',
            message: 'Error Loading Templates',
            description: 'Could not load ORBAT templates.',
            user: res.locals.user
        });
    }
});

router.get('/templates/create', isAdmin, (req, res) => {
    res.render('orbat/template-form', {
        title: 'Create ORBAT Template - Admin',
        template: null,
        action: 'create'
    });
});

router.post('/templates/create', isAdmin, async (req, res) => {
    try {
        const { name, description } = req.body;

        const [result] = await db.query(
            'INSERT INTO orbat_templates (name, description, created_by) VALUES (?, ?, ?)',
            [name, description || null, req.session.userId]
        );

        res.redirect(`/orbat/templates/edit/${result.insertId}?success=Template created. Add squads and roles below.`);
    } catch (error) {
        console.error('Error creating template:', error);
        res.redirect('/orbat/templates?error=Failed to create template');
    }
});

router.get('/templates/edit/:id', isAdmin, async (req, res) => {
    try {
        const [templates] = await db.query('SELECT * FROM orbat_templates WHERE id = ?', [req.params.id]);
        
        if (templates.length === 0) {
            return res.redirect('/orbat/templates?error=Template not found');
        }

        const [squads] = await db.query(`
            SELECT 
                os.*,
                COUNT(DISTINCT orp.id) as role_count
            FROM orbat_squads os
            LEFT JOIN orbat_roles orp ON os.id = orp.squad_id
            WHERE os.orbat_id = ?
            GROUP BY os.id
            ORDER BY os.display_order ASC
        `, [req.params.id]);

        const [roles] = await db.query(`
            SELECT orp.*
            FROM orbat_roles orp
            JOIN orbat_squads os ON orp.squad_id = os.id
            WHERE os.orbat_id = ?
            ORDER BY orp.display_order ASC
        `, [req.params.id]);

        const rolesBySquad = {};
        roles.forEach(role => {
            if (!rolesBySquad[role.squad_id]) {
                rolesBySquad[role.squad_id] = [];
            }
            rolesBySquad[role.squad_id].push(role);
        });

        const squadIds = squads.map(s => s.id);
        const teamsBySquad = {};
        if (squadIds.length > 0) {
            const [teams] = await db.query(
                'SELECT * FROM orbat_teams WHERE squad_id IN (?) ORDER BY display_order ASC',
                [squadIds]
            );
            teams.forEach(t => {
                if (!teamsBySquad[t.squad_id]) teamsBySquad[t.squad_id] = [];
                teamsBySquad[t.squad_id].push(t);
            });
        }

        const roleIds = roles.map(r => r.id);
        const assignmentsByRole = {};

        if (roleIds.length > 0) {
            const [assignments] = await db.query(`
                SELECT
                    oa.*,
                    u.username,
                    u.discord_global_name,
                    u.discord_avatar,
                    u.discord_id,
                    rm.nickname as roster_nickname
                FROM orbat_assignments oa
                JOIN users u ON oa.user_id = u.id
                LEFT JOIN roster_members rm ON rm.discord_id = u.discord_id
                WHERE oa.role_id IN (?)
            `, [roleIds]);

            assignments.forEach(assignment => {
                assignmentsByRole[assignment.role_id] = assignment;
            });
        }

        res.render('orbat/template-edit', {
            title: `Edit ORBAT Template - ${templates[0].name}`,
            template: templates[0],
            squads: squads,
            squadTree: buildTree(squads),
            rolesBySquad: rolesBySquad,
            teamsBySquad: teamsBySquad,
            assignmentsByRole: assignmentsByRole,
            success: req.query.success || null,
            error: req.query.error || null
        });
    } catch (error) {
        console.error('Error loading template:', error);
        res.redirect('/orbat/templates?error=Failed to load template');
    }
});

router.post('/templates/edit/:id', isAdmin, async (req, res) => {
    try {
        const { name, description } = req.body;

        await db.query(
            'UPDATE orbat_templates SET name = ?, description = ? WHERE id = ?',
            [name, description || null, req.params.id]
        );

        res.redirect(`/orbat/templates/edit/${req.params.id}?success=Template updated`);
    } catch (error) {
        console.error('Error updating template:', error);
        res.redirect(`/orbat/templates/edit/${req.params.id}?error=Failed to update template`);
    }
});

router.post('/templates/delete/:id', isAdmin, async (req, res) => {
    try {
        await db.query('DELETE FROM orbat_templates WHERE id = ?', [req.params.id]);
        res.redirect('/orbat/templates?success=Template deleted');
    } catch (error) {
        console.error('Error deleting template:', error);
        res.redirect('/orbat/templates?error=Failed to delete template');
    }
});

router.post('/templates/:id/squads/add', isAdmin, async (req, res) => {
    try {
        const { name, color, display_order } = req.body;

        await db.query(
            'INSERT INTO orbat_squads (orbat_id, name, color, display_order) VALUES (?, ?, ?, ?)',
            [req.params.id, name, color || '#3498DB', display_order || 0]
        );

        res.redirect(`/orbat/templates/edit/${req.params.id}?success=Squad added`);
    } catch (error) {
        console.error('Error adding squad:', error);
        res.redirect(`/orbat/templates/edit/${req.params.id}?error=Failed to add squad`);
    }
});

router.post('/squads/delete/:id', isAdmin, async (req, res) => {
    try {
        const [squads] = await db.query('SELECT orbat_id FROM orbat_squads WHERE id = ?', [req.params.id]);
        const templateId = squads[0]?.orbat_id;

        await db.query('DELETE FROM orbat_squads WHERE id = ?', [req.params.id]);
        
        res.redirect(`/orbat/templates/edit/${templateId}?success=Squad deleted`);
    } catch (error) {
        console.error('Error deleting squad:', error);
        res.redirect('/orbat/templates?error=Failed to delete squad');
    }
});

router.post('/squads/edit/:id', isAdmin, async (req, res) => {
    try {
        const { name, color, display_order } = req.body;
        
        const [squads] = await db.query('SELECT orbat_id FROM orbat_squads WHERE id = ?', [req.params.id]);
        const templateId = squads[0]?.orbat_id;

        await db.query(
            'UPDATE orbat_squads SET name = ?, color = ?, display_order = ? WHERE id = ?',
            [name, color, display_order, req.params.id]
        );
        
        res.redirect(`/orbat/templates/edit/${templateId}?success=Squad updated`);
    } catch (error) {
        console.error('Error updating squad:', error);
        res.redirect('/orbat/templates?error=Failed to update squad');
    }
});

router.post('/squads/:id/roles/add', isAdmin, async (req, res) => {
    try {
        const { role_name, display_order, is_editor } = req.body;

        const [squads] = await db.query('SELECT orbat_id FROM orbat_squads WHERE id = ?', [req.params.id]);
        const templateId = squads[0]?.orbat_id;

        await db.query(
            'INSERT INTO orbat_roles (squad_id, role_name, display_order, is_editor) VALUES (?, ?, ?, ?)',
            [req.params.id, role_name, display_order || 0, is_editor ? 1 : 0]
        );

        res.redirect(`/orbat/templates/edit/${templateId}?success=Role added`);
    } catch (error) {
        console.error('Error adding role:', error);
        res.redirect('/orbat/templates?error=Failed to add role');
    }
});

router.post('/roles/delete/:id', isAdmin, async (req, res) => {
    try {
        const [roles] = await db.query(`
            SELECT os.orbat_id 
            FROM orbat_roles orp
            JOIN orbat_squads os ON orp.squad_id = os.id
            WHERE orp.id = ?
        `, [req.params.id]);
        const templateId = roles[0]?.orbat_id;

        await db.query('DELETE FROM orbat_roles WHERE id = ?', [req.params.id]);
        
        res.redirect(`/orbat/templates/edit/${templateId}?success=Role deleted`);
    } catch (error) {
        console.error('Error deleting role:', error);
        res.redirect('/orbat/templates?error=Failed to delete role');
    }
});

router.post('/roles/edit/:id', isAdmin, async (req, res) => {
    try {
        const { role_name, display_order, is_editor } = req.body;

        const [roles] = await db.query(`
            SELECT os.orbat_id
            FROM orbat_roles orp
            JOIN orbat_squads os ON orp.squad_id = os.id
            WHERE orp.id = ?
        `, [req.params.id]);
        const templateId = roles[0]?.orbat_id;

        await db.query(
            'UPDATE orbat_roles SET role_name = ?, display_order = ?, is_editor = ? WHERE id = ?',
            [role_name, display_order || 0, is_editor ? 1 : 0, req.params.id]
        );
        
        res.redirect(`/orbat/templates/edit/${templateId}?success=Role updated`);
    } catch (error) {
        console.error('Error updating role:', error);
        res.redirect('/orbat/templates?error=Failed to update role');
    }
});

router.get('/operation/:operationId', async (req, res) => {
    try {
        const [operations] = await db.query('SELECT * FROM operations WHERE id = ?', [req.params.operationId]);
        
        if (operations.length === 0) {
            return res.status(404).render('error', {
                title: 'Operation Not Found',
                message: 'Operation Not Found',
                description: 'This operation does not exist.',
                user: res.locals.user
            });
        }

        const operation = operations[0];
        const canManage = req.session.userId && (
            req.session.isAdmin ||
            (res.locals.user && res.locals.user.isZeus) ||
            await isOperationHost(req.session.userId, req.params.operationId)
        );

        const orbatPublished = !!operation.orbat_published;

        // If ORBAT is draft and user can't manage, show placeholder
        if (!orbatPublished && !canManage && operation.orbat_type === 'dynamic') {
            return res.render('orbat/view', {
                title: `ORBAT - ${operation.title}`,
                operation: operation,
                squads: [],
                squadTree: [],
                rolesBySquad: {},
                teamsBySquad: {},
                assignments: {},
                canManage: false,
                canClaim: false,
                orbatPublished: false
            });
        }

        let squads = [];
        let rolesBySquad = {};
        let assignments = {};
        let teamsBySquad = {};

        if (operation.orbat_type === 'fixed' && operation.orbat_template_id) {
            [squads] = await db.query(`
                SELECT * FROM orbat_squads
                WHERE orbat_id = ?
                ORDER BY display_order ASC
            `, [operation.orbat_template_id]);

        } else if (operation.orbat_type === 'dynamic') {
            [squads] = await db.query(`
                SELECT * FROM orbat_squads
                WHERE operation_id = ?
                ORDER BY display_order ASC
            `, [req.params.operationId]);
        }

        if (squads.length > 0) {
            const squadIds = squads.map(s => s.id);
            const [roles] = await db.query(`
                SELECT orp.*
                FROM orbat_roles orp
                WHERE orp.squad_id IN (?)
                ORDER BY orp.display_order ASC
            `, [squadIds]);

            roles.forEach(role => {
                if (!rolesBySquad[role.squad_id]) {
                    rolesBySquad[role.squad_id] = [];
                }
                rolesBySquad[role.squad_id].push(role);
            });

            const [teams] = await db.query(
                'SELECT * FROM orbat_teams WHERE squad_id IN (?) ORDER BY display_order ASC',
                [squadIds]
            );
            teams.forEach(t => {
                if (!teamsBySquad[t.squad_id]) teamsBySquad[t.squad_id] = [];
                teamsBySquad[t.squad_id].push(t);
            });

            const roleIds = roles.map(r => r.id);
            if (roleIds.length > 0) {
                const [assignmentData] = await db.query(`
                    SELECT
                        oa.*,
                        u.username,
                        u.discord_global_name,
                        u.discord_avatar,
                        u.discord_id,
                        rm.nickname as roster_nickname,
                        oat.status as attendance_status,
                        loa.id as loa_id,
                        loa.start_date as loa_start,
                        loa.end_date as loa_end,
                        loa.reason as loa_reason
                    FROM orbat_assignments oa
                    JOIN users u ON oa.user_id = u.id
                    LEFT JOIN roster_members rm ON rm.discord_id = u.discord_id
                    LEFT JOIN operation_attendance oat ON oat.operation_id = ? AND oat.user_id = u.id
                    LEFT JOIN leave_of_absence loa ON loa.user_id = u.id
                        AND loa.status = 'approved'
                        AND loa.start_date <= UNIX_TIMESTAMP()
                        AND loa.end_date >= UNIX_TIMESTAMP()
                    WHERE oa.role_id IN (?)
                `, [req.params.operationId, roleIds]);

                assignmentData.forEach(assignment => {
                    assignments[assignment.role_id] = assignment;
                });
            }
        }

        // Non-managers can only claim if ORBAT is published
        const canClaim = req.session.userId && operation.orbat_type === 'dynamic' && orbatPublished;

        const editorSquadIds = [];
        if (req.session.userId) {
            Object.values(rolesBySquad).forEach(roleList => {
                roleList.forEach(role => {
                    if (role.is_editor && assignments[role.id] && assignments[role.id].user_id === req.session.userId) {
                        editorSquadIds.push(role.squad_id);
                    }
                });
            });
            const editorSet = new Set(editorSquadIds);
            let changed = true;
            while (changed) {
                changed = false;
                for (const squad of squads) {
                    if (squad.parent_squad_id && editorSet.has(squad.parent_squad_id) && !editorSet.has(squad.id)) {
                        editorSet.add(squad.id);
                        changed = true;
                    }
                }
            }
            editorSquadIds.length = 0;
            editorSet.forEach(id => editorSquadIds.push(id));
        }

        res.render('orbat/view', {
            title: `ORBAT - ${operation.title}`,
            operation: operation,
            squads: squads,
            squadTree: buildTree(squads),
            rolesBySquad: rolesBySquad,
            teamsBySquad: teamsBySquad,
            assignments: assignments,
            canManage: canManage,
            canClaim: canClaim,
            orbatPublished: orbatPublished,
            editorSquadIds: editorSquadIds
        });
    } catch (error) {
        console.error('Error loading ORBAT:', error);
        res.render('error', {
            title: 'Error',
            message: 'Error Loading ORBAT',
            description: 'Could not load the ORBAT.',
            user: res.locals.user
        });
    }
});

router.post('/claim/:roleId', isAuthenticated, async (req, res) => {
    try {
        const [roles] = await db.query(`
            SELECT orp.*, os.operation_id, oper.orbat_type, oper.orbat_published
            FROM orbat_roles orp
            JOIN orbat_squads os ON orp.squad_id = os.id
            JOIN operations oper ON os.operation_id = oper.id
            WHERE orp.id = ?
        `, [req.params.roleId]);

        if (roles.length === 0) {
            return res.json({ success: false, error: 'Role not found' });
        }

        const role = roles[0];

        if (role.orbat_type !== 'dynamic') {
            return res.json({ success: false, error: 'Can only claim slots in dynamic ORBATs' });
        }

        if (!role.orbat_published) {
            return res.json({ success: false, error: 'ORBAT is not published yet' });
        }

        const [existing] = await db.query('SELECT * FROM orbat_assignments WHERE role_id = ?', [req.params.roleId]);

        if (existing.length > 0) {
            return res.json({ success: false, error: 'Slot already taken' });
        }

        // Remove any existing assignment this user has in the same operation
        await db.query(`
            DELETE oa FROM orbat_assignments oa
            JOIN orbat_roles orp ON oa.role_id = orp.id
            JOIN orbat_squads os ON orp.squad_id = os.id
            WHERE os.operation_id = ? AND oa.user_id = ?
        `, [role.operation_id, req.session.userId]);

        await db.query(
            'INSERT INTO orbat_assignments (role_id, user_id, assigned_by) VALUES (?, ?, ?)',
            [req.params.roleId, req.session.userId, req.session.userId]
        );

        res.json({ success: true });
    } catch (error) {
        console.error('Error claiming slot:', error);
        res.json({ success: false, error: 'Failed to claim slot' });
    }
});

router.post('/unclaim/:roleId', isAuthenticated, async (req, res) => {
    try {
        await db.query(
            'DELETE FROM orbat_assignments WHERE role_id = ? AND user_id = ?',
            [req.params.roleId, req.session.userId]
        );

        res.json({ success: true });
    } catch (error) {
        console.error('Error unclaiming slot:', error);
        res.json({ success: false, error: 'Failed to unclaim slot' });
    }
});

router.post('/assign/:roleId', isAuthenticated, async (req, res) => {
    try {
        const userIsZeus = req.session.isAdmin || await checkZeusStatus(req.session.userId);
        if (!userIsZeus) {
            const canEdit = await isSquadEditor(req.session.userId, req.params.roleId)
                || await isHostOfRoleOperation(req.session.userId, req.params.roleId);
            if (!canEdit) {
                return res.status(403).json({ success: false, error: 'Permission denied' });
            }
        }

        const { userId, discordId } = req.body;
        
        let finalUserId = userId;

        // If discordId provided without userId, create/find the user account from the roster
        if (!userId && discordId) {
            const [rosterMembers] = await db.query(
                'SELECT * FROM roster_members WHERE discord_id = ?',
                [discordId]
            );
            
            if (rosterMembers.length === 0) {
                return res.json({ success: false, error: 'Player not found in roster' });
            }
            
            const member = rosterMembers[0];

            const [existingUsers] = await db.query(
                'SELECT id FROM users WHERE discord_id = ?',
                [discordId]
            );

            if (existingUsers.length > 0) {
                finalUserId = existingUsers[0].id;
            } else {
                const [result] = await db.query(`
                    INSERT INTO users 
                    (discord_id, username, discord_global_name, discord_avatar, is_admin)
                    VALUES (?, ?, ?, ?, FALSE)
                `, [
                    member.discord_id,
                    member.discord_username,
                    member.discord_global_name,
                    member.discord_avatar
                ]);
                
                finalUserId = result.insertId;
            }
        }
        
        if (!finalUserId) {
            return res.json({ success: false, error: 'No user selected' });
        }

        await db.query('DELETE FROM orbat_assignments WHERE role_id = ?', [req.params.roleId]);

        await db.query(
            'INSERT INTO orbat_assignments (role_id, user_id, assigned_by) VALUES (?, ?, ?)',
            [req.params.roleId, finalUserId, req.session.userId]
        );

        res.json({ success: true });
    } catch (error) {
        console.error('Error assigning player:', error);
        res.json({ success: false, error: 'Failed to assign player' });
    }
});

router.post('/unassign/:roleId', isAuthenticated, async (req, res) => {
    try {
        const userIsZeus = req.session.isAdmin || await checkZeusStatus(req.session.userId);
        if (!userIsZeus) {
            const canEdit = await isSquadEditor(req.session.userId, req.params.roleId)
                || await isHostOfRoleOperation(req.session.userId, req.params.roleId);
            if (!canEdit) {
                return res.status(403).json({ success: false, error: 'Permission denied' });
            }
        }

        await db.query('DELETE FROM orbat_assignments WHERE role_id = ?', [req.params.roleId]);
        res.json({ success: true });
    } catch (error) {
        console.error('Error unassigning player:', error);
        res.json({ success: false, error: 'Failed to unassign player' });
    }
});

router.post('/operation/:operationId/create-dynamic', isAuthenticated, canManageOperation, async (req, res) => {
    try {
        const { squadName, squadColor, roleName } = req.body;

        const [result] = await db.query(
            'INSERT INTO orbat_squads (operation_id, name, color, display_order) VALUES (?, ?, ?, 0)',
            [req.params.operationId, squadName, squadColor || '#3498DB']
        );

        const squadId = result.insertId;

        await db.query(
            'INSERT INTO orbat_roles (squad_id, role_name, display_order) VALUES (?, ?, 0)',
            [squadId, roleName]
        );

        // Flag the operation as dynamic (draft) so the ORBAT view renders the correct mode
        await db.query(
            'UPDATE operations SET orbat_type = ?, orbat_published = 0 WHERE id = ?',
            ['dynamic', req.params.operationId]
        );

        res.json({ success: true });
    } catch (error) {
        console.error('Error creating dynamic ORBAT:', error);
        res.json({ success: false, error: 'Failed to create ORBAT' });
    }
});

router.post('/operation/:operationId/add-squad', isAuthenticated, canManageOperation, async (req, res) => {
    try {
        const { squadName, squadColor, parentSquadId } = req.body;

        const [maxOrder] = await db.query(
            'SELECT MAX(display_order) as max_order FROM orbat_squads WHERE operation_id = ?',
            [req.params.operationId]
        );

        const nextOrder = (maxOrder[0]?.max_order || 0) + 1;

        await db.query(
            'INSERT INTO orbat_squads (operation_id, name, color, display_order, parent_squad_id) VALUES (?, ?, ?, ?, ?)',
            [req.params.operationId, squadName, squadColor || '#3498DB', nextOrder, parentSquadId || null]
        );

        res.json({ success: true });
    } catch (error) {
        console.error('Error adding squad:', error);
        res.json({ success: false, error: 'Failed to add squad' });
    }
});

router.post('/squads/:squadId/add-role-dynamic', isAuthenticated, async (req, res) => {
    try {
        const userIsZeus = req.session.isAdmin || await checkZeusStatus(req.session.userId);
        if (!userIsZeus) {
            const canEdit = await isEditorOfSquadOrAncestor(req.session.userId, req.params.squadId)
                || await isHostOfSquadOperation(req.session.userId, req.params.squadId);
            if (!canEdit) {
                return res.status(403).json({ success: false, error: 'Permission denied' });
            }
        }

        const { roleName } = req.body;

        const [maxOrder] = await db.query(
            'SELECT MAX(display_order) as max FROM orbat_roles WHERE squad_id = ?',
            [req.params.squadId]
        );
        const nextOrder = (maxOrder[0]?.max ?? -1) + 1;

        await db.query(
            'INSERT INTO orbat_roles (squad_id, role_name, display_order) VALUES (?, ?, ?)',
            [req.params.squadId, roleName, nextOrder]
        );

        res.json({ success: true });
    } catch (error) {
        console.error('Error adding role:', error);
        res.json({ success: false, error: 'Failed to add role' });
    }
});

router.post('/api/squads/:squadId/add-role', isAuthenticated, async (req, res) => {
    try {
        const userIsZeus = req.session.isAdmin || await checkZeusStatus(req.session.userId);
        if (!userIsZeus) {
            const canEdit = await isEditorOfSquadOrAncestor(req.session.userId, req.params.squadId);
            if (!canEdit) {
                return res.status(403).json({ success: false, error: 'Permission denied' });
            }
        }

        const { roleName, isEditor } = req.body;
        if (!roleName || !roleName.trim()) {
            return res.json({ success: false, error: 'Role name is required' });
        }

        const isEditorValue = userIsZeus && isEditor ? 1 : 0;

        const [maxOrder] = await db.query(
            'SELECT MAX(display_order) as max FROM orbat_roles WHERE squad_id = ?',
            [req.params.squadId]
        );
        const nextOrder = (maxOrder[0]?.max ?? -1) + 1;

        const [result] = await db.query(
            'INSERT INTO orbat_roles (squad_id, role_name, display_order, is_editor) VALUES (?, ?, ?, ?)',
            [req.params.squadId, roleName.trim(), nextOrder, isEditorValue]
        );

        res.json({ success: true, roleId: result.insertId });
    } catch (error) {
        console.error('Error adding role:', error);
        res.json({ success: false, error: 'Failed to add role' });
    }
});

router.post('/api/roles/:id/edit', isAuthenticated, async (req, res) => {
    try {
        const userIsZeus = req.session.isAdmin || await checkZeusStatus(req.session.userId);
        if (!userIsZeus) {
            const canEdit = await isSquadEditor(req.session.userId, req.params.id);
            if (!canEdit) {
                return res.status(403).json({ success: false, error: 'Permission denied' });
            }
        }

        const { roleName, displayOrder, isEditor } = req.body;
        if (!roleName || !roleName.trim()) {
            return res.json({ success: false, error: 'Role name is required' });
        }

        if (userIsZeus) {
            await db.query(
                'UPDATE orbat_roles SET role_name = ?, display_order = ?, is_editor = ? WHERE id = ?',
                [roleName.trim(), displayOrder || 0, isEditor ? 1 : 0, req.params.id]
            );
        } else {
            await db.query(
                'UPDATE orbat_roles SET role_name = ?, display_order = ? WHERE id = ?',
                [roleName.trim(), displayOrder || 0, req.params.id]
            );
        }

        res.json({ success: true });
    } catch (error) {
        console.error('Error updating role:', error);
        res.json({ success: false, error: 'Failed to update role' });
    }
});

router.post('/api/squads/:squadId/reorder-roles', isAuthenticated, async (req, res) => {
    try {
        const userIsZeus = req.session.isAdmin || await checkZeusStatus(req.session.userId);
        if (!userIsZeus) {
            const canEdit = await isEditorOfSquadOrAncestor(req.session.userId, req.params.squadId)
                || await isHostOfSquadOperation(req.session.userId, req.params.squadId);
            if (!canEdit) {
                return res.status(403).json({ success: false, error: 'Permission denied' });
            }
        }

        const { roleIds } = req.body;
        if (!Array.isArray(roleIds) || roleIds.length === 0) {
            return res.json({ success: false, error: 'Invalid role order data' });
        }

        for (let i = 0; i < roleIds.length; i++) {
            await db.query(
                'UPDATE orbat_roles SET display_order = ? WHERE id = ? AND squad_id = ?',
                [i, roleIds[i], req.params.squadId]
            );
        }

        res.json({ success: true });
    } catch (error) {
        console.error('Error reordering roles:', error);
        res.json({ success: false, error: 'Failed to reorder roles' });
    }
});

router.post('/api/roles/:id/delete', isAuthenticated, async (req, res) => {
    try {
        const userIsZeus = req.session.isAdmin || await checkZeusStatus(req.session.userId);
        if (!userIsZeus) {
            const canEdit = await isSquadEditor(req.session.userId, req.params.id)
                || await isHostOfRoleOperation(req.session.userId, req.params.id);
            if (!canEdit) {
                return res.status(403).json({ success: false, error: 'Permission denied' });
            }
        }

        await db.query('DELETE FROM orbat_roles WHERE id = ?', [req.params.id]);
        res.json({ success: true });
    } catch (error) {
        console.error('Error deleting role:', error);
        res.json({ success: false, error: 'Failed to delete role' });
    }
});

router.post('/api/templates/:templateId/squads/add', isAuthenticated, async (req, res) => {
    try {
        const userIsZeus = req.session.isAdmin || await checkZeusStatus(req.session.userId);
        if (!userIsZeus) {
            // Squad editors may only add sub-groups under a squad they can edit
            const { parentSquadId } = req.body;
            if (!parentSquadId) return res.status(403).json({ success: false, error: 'Permission denied' });
            const canEdit = await isEditorOfSquadOrAncestor(req.session.userId, parentSquadId);
            if (!canEdit) return res.status(403).json({ success: false, error: 'Permission denied' });
        }

        const { name, color, displayOrder, parentSquadId } = req.body;
        if (!name || !name.trim()) return res.json({ success: false, error: 'Squad name is required' });

        const [result] = await db.query(
            'INSERT INTO orbat_squads (orbat_id, name, color, display_order, parent_squad_id) VALUES (?, ?, ?, ?, ?)',
            [req.params.templateId, name.trim(), color || '#3498DB', displayOrder || 0, parentSquadId || null]
        );

        res.json({ success: true, squadId: result.insertId });
    } catch (error) {
        console.error('Error adding squad:', error);
        res.json({ success: false, error: 'Failed to add squad' });
    }
});

router.post('/api/squads/:id/edit', isAuthenticated, async (req, res) => {
    try {
        const userIsZeus = req.session.isAdmin || await checkZeusStatus(req.session.userId);
        if (!userIsZeus && !await isHostOfSquadOperation(req.session.userId, req.params.id)) {
            return res.status(403).json({ success: false, error: 'Permission denied' });
        }

        const { name, color, displayOrder } = req.body;
        if (!name || !name.trim()) return res.json({ success: false, error: 'Squad name is required' });

        await db.query(
            'UPDATE orbat_squads SET name = ?, color = ?, display_order = ? WHERE id = ?',
            [name.trim(), color || '#3498DB', displayOrder || 0, req.params.id]
        );

        res.json({ success: true });
    } catch (error) {
        console.error('Error updating squad:', error);
        res.json({ success: false, error: 'Failed to update squad' });
    }
});

router.post('/api/squads/:id/delete', isAuthenticated, async (req, res) => {
    try {
        const userIsZeus = req.session.isAdmin || await checkZeusStatus(req.session.userId);
        if (!userIsZeus) {
            const isHost = await isHostOfSquadOperation(req.session.userId, req.params.id);
            if (!isHost) {
                // Editors can delete a squad only if they are an editor of its parent
                const [squadRows] = await db.query('SELECT parent_squad_id FROM orbat_squads WHERE id = ?', [req.params.id]);
                const parentId = squadRows[0]?.parent_squad_id;
                if (!parentId) return res.status(403).json({ success: false, error: 'Permission denied' });
                const canEdit = await isEditorOfSquadOrAncestor(req.session.userId, parentId);
                if (!canEdit) return res.status(403).json({ success: false, error: 'Permission denied' });
            }
        }

        // Recursively collect all descendant IDs so they are also deleted
        async function collectDescendantIds(id) {
            const [children] = await db.query('SELECT id FROM orbat_squads WHERE parent_squad_id = ?', [id]);
            let ids = [id];
            for (const child of children) {
                ids = ids.concat(await collectDescendantIds(child.id));
            }
            return ids;
        }
        const allIds = await collectDescendantIds(req.params.id);
        await db.query('DELETE FROM orbat_squads WHERE id IN (?)', [allIds]);
        res.json({ success: true });
    } catch (error) {
        console.error('Error deleting squad:', error);
        res.json({ success: false, error: 'Failed to delete squad' });
    }
});

// ── Team management ────────────────────────────────────────────────────────

router.post('/api/squads/:squadId/add-team', isAuthenticated, async (req, res) => {
    try {
        const userIsZeus = req.session.isAdmin || await checkZeusStatus(req.session.userId);
        if (!userIsZeus) {
            const canEdit = await isEditorOfSquadOrAncestor(req.session.userId, req.params.squadId)
                || await isHostOfSquadOperation(req.session.userId, req.params.squadId);
            if (!canEdit) return res.status(403).json({ success: false, error: 'Permission denied' });
        }
        const { name, color } = req.body;
        if (!name?.trim()) return res.json({ success: false, error: 'Team name is required' });
        const [maxOrder] = await db.query('SELECT MAX(display_order) as max FROM orbat_teams WHERE squad_id = ?', [req.params.squadId]);
        const nextOrder = (maxOrder[0]?.max ?? -1) + 1;
        const [result] = await db.query(
            'INSERT INTO orbat_teams (squad_id, name, color, display_order) VALUES (?, ?, ?, ?)',
            [req.params.squadId, name.trim(), color || '#6b8e23', nextOrder]
        );
        res.json({ success: true, teamId: result.insertId });
    } catch (error) {
        console.error('Error adding team:', error);
        res.json({ success: false, error: 'Failed to add team' });
    }
});

router.post('/api/teams/:teamId/edit', isAuthenticated, async (req, res) => {
    try {
        const [teamRows] = await db.query('SELECT squad_id FROM orbat_teams WHERE id = ?', [req.params.teamId]);
        if (!teamRows.length) return res.json({ success: false, error: 'Team not found' });
        const squadId = teamRows[0].squad_id;
        const userIsZeus = req.session.isAdmin || await checkZeusStatus(req.session.userId);
        if (!userIsZeus) {
            const canEdit = await isEditorOfSquadOrAncestor(req.session.userId, squadId)
                || await isHostOfSquadOperation(req.session.userId, squadId);
            if (!canEdit) return res.status(403).json({ success: false, error: 'Permission denied' });
        }
        const { name, color } = req.body;
        if (!name?.trim()) return res.json({ success: false, error: 'Team name is required' });
        await db.query('UPDATE orbat_teams SET name = ?, color = ? WHERE id = ?', [name.trim(), color || '#6b8e23', req.params.teamId]);
        res.json({ success: true });
    } catch (error) {
        console.error('Error editing team:', error);
        res.json({ success: false, error: 'Failed to edit team' });
    }
});

router.post('/api/teams/:teamId/delete', isAuthenticated, async (req, res) => {
    try {
        const [teamRows] = await db.query('SELECT squad_id FROM orbat_teams WHERE id = ?', [req.params.teamId]);
        if (!teamRows.length) return res.json({ success: false, error: 'Team not found' });
        const squadId = teamRows[0].squad_id;
        const userIsZeus = req.session.isAdmin || await checkZeusStatus(req.session.userId);
        if (!userIsZeus) {
            const canEdit = await isEditorOfSquadOrAncestor(req.session.userId, squadId)
                || await isHostOfSquadOperation(req.session.userId, squadId);
            if (!canEdit) return res.status(403).json({ success: false, error: 'Permission denied' });
        }
        await db.query('DELETE FROM orbat_teams WHERE id = ?', [req.params.teamId]);
        res.json({ success: true });
    } catch (error) {
        console.error('Error deleting team:', error);
        res.json({ success: false, error: 'Failed to delete team' });
    }
});

router.post('/api/squads/:squadId/reorder-teams', isAuthenticated, async (req, res) => {
    try {
        const userIsZeus = req.session.isAdmin || await checkZeusStatus(req.session.userId);
        if (!userIsZeus) {
            const canEdit = await isEditorOfSquadOrAncestor(req.session.userId, req.params.squadId)
                || await isHostOfSquadOperation(req.session.userId, req.params.squadId);
            if (!canEdit) return res.status(403).json({ success: false, error: 'Permission denied' });
        }
        const { teamIds } = req.body;
        if (!Array.isArray(teamIds)) return res.json({ success: false, error: 'Invalid data' });
        for (let i = 0; i < teamIds.length; i++) {
            await db.query('UPDATE orbat_teams SET display_order = ? WHERE id = ? AND squad_id = ?', [i, teamIds[i], req.params.squadId]);
        }
        res.json({ success: true });
    } catch (error) {
        console.error('Error reordering teams:', error);
        res.json({ success: false, error: 'Failed to reorder teams' });
    }
});

router.post('/api/roles/:roleId/set-team', isAuthenticated, async (req, res) => {
    try {
        const userIsZeus = req.session.isAdmin || await checkZeusStatus(req.session.userId);
        if (!userIsZeus) {
            const canEdit = await isSquadEditor(req.session.userId, req.params.roleId)
                || await isHostOfRoleOperation(req.session.userId, req.params.roleId);
            if (!canEdit) return res.status(403).json({ success: false, error: 'Permission denied' });
        }
        const { teamId } = req.body;
        if (teamId) {
            const [check] = await db.query(`
                SELECT 1 FROM orbat_teams t
                JOIN orbat_roles r ON r.squad_id = t.squad_id
                WHERE t.id = ? AND r.id = ?
            `, [teamId, req.params.roleId]);
            if (!check.length) return res.json({ success: false, error: 'Team not in same squad as role' });
        }
        await db.query('UPDATE orbat_roles SET team_id = ? WHERE id = ?', [teamId || null, req.params.roleId]);
        res.json({ success: true });
    } catch (error) {
        console.error('Error setting team:', error);
        res.json({ success: false, error: 'Failed to set team' });
    }
});

router.post('/api/migrate-hierarchy', isAdmin, async (req, res) => {
    try {
        // For each template with root-level squads, create a default platoon and nest existing squads under it
        const [templateGroups] = await db.query(
            'SELECT DISTINCT orbat_id FROM orbat_squads WHERE orbat_id IS NOT NULL AND parent_squad_id IS NULL'
        );
        for (const { orbat_id } of templateGroups) {
            const [existing] = await db.query(
                'SELECT id FROM orbat_squads WHERE orbat_id = ? AND parent_squad_id IS NULL',
                [orbat_id]
            );
            if (existing.length === 0) continue;
            const [result] = await db.query(
                'INSERT INTO orbat_squads (orbat_id, name, color, display_order) VALUES (?, ?, ?, ?)',
                [orbat_id, '1st Platoon', '#3498DB', 0]
            );
            await db.query(
                'UPDATE orbat_squads SET parent_squad_id = ? WHERE orbat_id = ? AND id != ? AND parent_squad_id IS NULL',
                [result.insertId, orbat_id, result.insertId]
            );
        }

        // Same for dynamic operation squads
        const [opGroups] = await db.query(
            'SELECT DISTINCT operation_id FROM orbat_squads WHERE operation_id IS NOT NULL AND parent_squad_id IS NULL'
        );
        for (const { operation_id } of opGroups) {
            const [existing] = await db.query(
                'SELECT id FROM orbat_squads WHERE operation_id = ? AND parent_squad_id IS NULL',
                [operation_id]
            );
            if (existing.length === 0) continue;
            const [result] = await db.query(
                'INSERT INTO orbat_squads (operation_id, name, color, display_order) VALUES (?, ?, ?, ?)',
                [operation_id, '1st Platoon', '#3498DB', 0]
            );
            await db.query(
                'UPDATE orbat_squads SET parent_squad_id = ? WHERE operation_id = ? AND id != ? AND parent_squad_id IS NULL',
                [result.insertId, operation_id, result.insertId]
            );
        }

        res.json({ success: true, message: 'Hierarchy migration complete' });
    } catch (error) {
        console.error('Migration error:', error);
        res.json({ success: false, error: error.message });
    }
});

// ── ORBAT publish / unpublish ──────────────────────────────────────────────

router.post('/operation/:operationId/publish-orbat', isAuthenticated, canManageOperation, async (req, res) => {
    try {
        await db.query('UPDATE operations SET orbat_published = 1 WHERE id = ?', [req.params.operationId]);

        // Optionally notify via Discord
        const { notify } = req.body;
        if (notify && process.env.DISCORD_BOT_TOKEN) {
            try {
                const [ops] = await db.query('SELECT * FROM operations WHERE id = ?', [req.params.operationId]);
                const op = ops[0];
                if (op && op.discord_thread_id) {
                    const thread = await discordClient.channels.fetch(op.discord_thread_id);
                    if (thread) {
                        const roleId = op.operation_type === 'side'
                            ? process.env.DISCORD_SIDE_OPS_ROLE_ID
                            : process.env.DISCORD_MAIN_OPS_ROLE_ID;
                        const mention = roleId ? `<@&${roleId}>` : '';
                        const websiteUrl = process.env.WEBSITE_URL;
                        if (!websiteUrl) throw new Error('WEBSITE_URL environment variable is not set');
                        const embed = new EmbedBuilder()
                            .setTitle('ORBAT Published')
                            .setDescription(`The ORBAT for **${op.title}** is now available!\n\n[View ORBAT](${websiteUrl}/orbat/operation/${op.id})`)
                            .setColor(0x6B8E23)
                            .setTimestamp();
                        await thread.send({ content: mention, embeds: [embed] });
                    }
                }
            } catch (discordError) {
                console.error('Discord ORBAT publish notification error:', discordError);
            }
        }

        res.json({ success: true });
    } catch (error) {
        console.error('Error publishing ORBAT:', error);
        res.json({ success: false, error: 'Failed to publish ORBAT' });
    }
});

router.post('/operation/:operationId/unpublish-orbat', isAuthenticated, canManageOperation, async (req, res) => {
    try {
        await db.query('UPDATE operations SET orbat_published = 0 WHERE id = ?', [req.params.operationId]);
        res.json({ success: true });
    } catch (error) {
        console.error('Error unpublishing ORBAT:', error);
        res.json({ success: false, error: 'Failed to unpublish ORBAT' });
    }
});

// ── Radio Frequency management ─────────────────────────────────────────────

router.post('/api/squads/:squadId/set-frequencies', isAuthenticated, async (req, res) => {
    try {
        const userIsZeus = req.session.isAdmin || await checkZeusStatus(req.session.userId);
        if (!userIsZeus) {
            const canEdit = await isEditorOfSquadOrAncestor(req.session.userId, req.params.squadId)
                || await isHostOfSquadOperation(req.session.userId, req.params.squadId);
            if (!canEdit) return res.status(403).json({ success: false, error: 'Permission denied' });
        }
        const { lr, sr } = req.body;
        await db.query(
            'UPDATE orbat_squads SET lr_frequency = ?, sr_frequency = ? WHERE id = ?',
            [lr || null, sr || null, req.params.squadId]
        );
        res.json({ success: true });
    } catch (error) {
        console.error('Error setting squad frequencies:', error);
        res.json({ success: false, error: 'Failed to set frequencies' });
    }
});

router.post('/api/teams/:teamId/set-frequencies', isAuthenticated, async (req, res) => {
    try {
        const [teamRows] = await db.query('SELECT squad_id FROM orbat_teams WHERE id = ?', [req.params.teamId]);
        if (!teamRows.length) return res.json({ success: false, error: 'Team not found' });
        const squadId = teamRows[0].squad_id;
        const userIsZeus = req.session.isAdmin || await checkZeusStatus(req.session.userId);
        if (!userIsZeus) {
            const canEdit = await isEditorOfSquadOrAncestor(req.session.userId, squadId)
                || await isHostOfSquadOperation(req.session.userId, squadId);
            if (!canEdit) return res.status(403).json({ success: false, error: 'Permission denied' });
        }
        const { lr, sr } = req.body;
        await db.query(
            'UPDATE orbat_teams SET lr_frequency = ?, sr_frequency = ? WHERE id = ?',
            [lr || null, sr || null, req.params.teamId]
        );
        res.json({ success: true });
    } catch (error) {
        console.error('Error setting team frequencies:', error);
        res.json({ success: false, error: 'Failed to set frequencies' });
    }
});

module.exports = router;