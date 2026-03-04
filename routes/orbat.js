const express = require('express');
const router = express.Router();
const db = require('../config/database');
const { isAuthenticated, isAdmin } = require('../middleware/auth');
const { isZeus, checkZeusStatus } = require('../middleware/zeus');

// Returns true if userId is the editor of the squad that contains roleId
async function isSquadEditor(userId, roleId) {
    if (!userId) return false;
    const [result] = await db.query(`
        SELECT 1
        FROM orbat_roles editor_role
        JOIN orbat_assignments oa ON editor_role.id = oa.role_id
        WHERE editor_role.squad_id = (SELECT squad_id FROM orbat_roles WHERE id = ?)
          AND editor_role.is_editor = TRUE
          AND oa.user_id = ?
        LIMIT 1
    `, [roleId, userId]);
    return result.length > 0;
}

// ====== API ENDPOINTS ======

// Get all templates (for operation form)
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

// ====== PUBLIC ROUTES ======

// Public view of all ORBAT templates
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

// Public view of a single ORBAT template
router.get('/view/:templateId', async (req, res) => {
    try {
        // Get template
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
        
        // Get squads
        const [squads] = await db.query(`
            SELECT * FROM orbat_squads 
            WHERE orbat_id = ?
            ORDER BY display_order ASC
        `, [req.params.templateId]);
        
        // Get roles
        const rolesBySquad = {};
        const assignments = {};
        
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
            
            // Get assignments
            const roleIds = roles.map(r => r.id);
            if (roleIds.length > 0) {
                const [assignmentData] = await db.query(`
                    SELECT 
                        oa.*,
                        u.username,
                        u.discord_global_name,
                        u.discord_avatar,
                        u.discord_id
                    FROM orbat_assignments oa
                    JOIN users u ON oa.user_id = u.id
                    WHERE oa.role_id IN (?)
                `, [roleIds]);
                
                assignmentData.forEach(assignment => {
                    assignments[assignment.role_id] = assignment;
                });
            }
        }
        
        // Determine which squads the current user is editor of
        const editorSquadIds = [];
        if (req.session.userId) {
            Object.values(rolesBySquad).forEach(roles => {
                roles.forEach(role => {
                    if (role.is_editor && assignments[role.id] && assignments[role.id].user_id === req.session.userId) {
                        editorSquadIds.push(role.squad_id);
                    }
                });
            });
        }

        res.render('orbat/public-template', {
            title: `${template.name} - Profiteers PMC`,
            template: template,
            squads: squads,
            rolesBySquad: rolesBySquad,
            assignments: assignments,
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

// ====== ADMIN ROUTES - FIXED ORBAT TEMPLATES ======

// List all ORBAT templates
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

// Create template form
router.get('/templates/create', isAdmin, (req, res) => {
    res.render('orbat/template-form', {
        title: 'Create ORBAT Template - Admin',
        template: null,
        action: 'create'
    });
});

// Create template
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

// Edit template (with squads and roles)
router.get('/templates/edit/:id', isAdmin, async (req, res) => {
    try {
        // Get template
        const [templates] = await db.query('SELECT * FROM orbat_templates WHERE id = ?', [req.params.id]);
        
        if (templates.length === 0) {
            return res.redirect('/orbat/templates?error=Template not found');
        }

        // Get squads with roles
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

        // Get all roles for all squads
        const [roles] = await db.query(`
            SELECT orp.*
            FROM orbat_roles orp
            JOIN orbat_squads os ON orp.squad_id = os.id
            WHERE os.orbat_id = ?
            ORDER BY orp.display_order ASC
        `, [req.params.id]);

        // Group roles by squad
        const rolesBySquad = {};
        roles.forEach(role => {
            if (!rolesBySquad[role.squad_id]) {
                rolesBySquad[role.squad_id] = [];
            }
            rolesBySquad[role.squad_id].push(role);
        });

        // Get player assignments for this template (default assignments)
        const roleIds = roles.map(r => r.id);
        const assignmentsByRole = {};
        
        if (roleIds.length > 0) {
            const [assignments] = await db.query(`
                SELECT 
                    oa.*,
                    u.username,
                    u.discord_global_name,
                    u.discord_avatar,
                    u.discord_id
                FROM orbat_assignments oa
                JOIN users u ON oa.user_id = u.id
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
            rolesBySquad: rolesBySquad,
            assignmentsByRole: assignmentsByRole,
            success: req.query.success || null,
            error: req.query.error || null
        });
    } catch (error) {
        console.error('Error loading template:', error);
        res.redirect('/orbat/templates?error=Failed to load template');
    }
});

// Update template info
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

// Delete template
router.post('/templates/delete/:id', isAdmin, async (req, res) => {
    try {
        await db.query('DELETE FROM orbat_templates WHERE id = ?', [req.params.id]);
        res.redirect('/orbat/templates?success=Template deleted');
    } catch (error) {
        console.error('Error deleting template:', error);
        res.redirect('/orbat/templates?error=Failed to delete template');
    }
});

// Add squad to template
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

// Delete squad
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

// Edit squad
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

// Add role to squad
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

// Delete role
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

// Edit role
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

// ====== OPERATION ORBAT ROUTES ======

// View ORBAT for an operation (public)
router.get('/operation/:operationId', async (req, res) => {
    try {
        // Get operation
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
        const canManage = req.session.userId && (req.session.isAdmin || (res.locals.user && res.locals.user.isZeus));

        // Get squads and roles based on ORBAT type
        let squads = [];
        let rolesBySquad = {};
        let assignments = {};

        if (operation.orbat_type === 'fixed' && operation.orbat_template_id) {
            // Get template squads
            [squads] = await db.query(`
                SELECT * FROM orbat_squads 
                WHERE orbat_id = ?
                ORDER BY display_order ASC
            `, [operation.orbat_template_id]);

        } else if (operation.orbat_type === 'dynamic') {
            // Get dynamic squads for this operation
            [squads] = await db.query(`
                SELECT * FROM orbat_squads 
                WHERE operation_id = ?
                ORDER BY display_order ASC
            `, [req.params.operationId]);
        }

        // Get roles for all squads
        if (squads.length > 0) {
            const squadIds = squads.map(s => s.id);
            const [roles] = await db.query(`
                SELECT orp.*
                FROM orbat_roles orp
                WHERE orp.squad_id IN (?)
                ORDER BY orp.display_order ASC
            `, [squadIds]);

            // Group roles by squad
            roles.forEach(role => {
                if (!rolesBySquad[role.squad_id]) {
                    rolesBySquad[role.squad_id] = [];
                }
                rolesBySquad[role.squad_id].push(role);
            });

            // Get assignments with user info
            const roleIds = roles.map(r => r.id);
            if (roleIds.length > 0) {
                const [assignmentData] = await db.query(`
                    SELECT 
                        oa.*,
                        u.username,
                        u.discord_global_name,
                        u.discord_avatar,
                        u.discord_id,
                        oat.status as attendance_status,
                        loa.id as loa_id,
                        loa.start_date as loa_start,
                        loa.end_date as loa_end,
                        loa.reason as loa_reason
                    FROM orbat_assignments oa
                    JOIN users u ON oa.user_id = u.id
                    LEFT JOIN operation_attendance oat ON oat.operation_id = ? AND oat.user_id = u.id
                    LEFT JOIN leave_of_absence loa ON loa.user_id = u.id 
                        AND loa.status = 'approved'
                        AND loa.start_date <= NOW()
                        AND loa.end_date >= NOW()
                    WHERE oa.role_id IN (?)
                `, [req.params.operationId, roleIds]);

                assignmentData.forEach(assignment => {
                    assignments[assignment.role_id] = assignment;
                });
            }
        }

        // Check if user can claim slots (dynamic ORBAT only, and must be logged in)
        const canClaim = req.session.userId && operation.orbat_type === 'dynamic';

        res.render('orbat/view', {
            title: `ORBAT - ${operation.title}`,
            operation: operation,
            squads: squads,
            rolesBySquad: rolesBySquad,
            assignments: assignments,
            canManage: canManage,
            canClaim: canClaim
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

// Claim slot (dynamic ORBAT, users)
router.post('/claim/:roleId', isAuthenticated, async (req, res) => {
    try {
        // Get role and check if it's from a dynamic ORBAT
        const [roles] = await db.query(`
            SELECT orp.*, os.operation_id, oper.orbat_type
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

        // Check if slot is already taken
        const [existing] = await db.query('SELECT * FROM orbat_assignments WHERE role_id = ?', [req.params.roleId]);
        
        if (existing.length > 0) {
            return res.json({ success: false, error: 'Slot already taken' });
        }

        // Assign user to slot
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

// Unclaim slot (dynamic ORBAT, users - own slot only)
router.post('/unclaim/:roleId', isAuthenticated, async (req, res) => {
    try {
        // Delete only if the user owns this assignment
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

// Assign player to slot (admin/zeus OR squad editor)
router.post('/assign/:roleId', isAuthenticated, async (req, res) => {
    try {
        const userIsZeus = req.session.isAdmin || await checkZeusStatus(req.session.userId);
        if (!userIsZeus) {
            const canEdit = await isSquadEditor(req.session.userId, req.params.roleId);
            if (!canEdit) {
                return res.status(403).json({ success: false, error: 'Permission denied' });
            }
        }

        const { userId, discordId } = req.body;
        
        let finalUserId = userId;
        
        // If no userId but we have discordId, create/find the user account
        if (!userId && discordId) {
            // Get Discord info from roster
            const [rosterMembers] = await db.query(
                'SELECT * FROM roster_members WHERE discord_id = ?',
                [discordId]
            );
            
            if (rosterMembers.length === 0) {
                return res.json({ success: false, error: 'Player not found in roster' });
            }
            
            const member = rosterMembers[0];
            
            // Check if user already exists
            const [existingUsers] = await db.query(
                'SELECT id FROM users WHERE discord_id = ?',
                [discordId]
            );
            
            if (existingUsers.length > 0) {
                finalUserId = existingUsers[0].id;
            } else {
                // Create user account automatically
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

        // Remove existing assignment for this role
        await db.query('DELETE FROM orbat_assignments WHERE role_id = ?', [req.params.roleId]);

        // Assign new user
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

// Unassign player from slot (admin/zeus OR squad editor)
router.post('/unassign/:roleId', isAuthenticated, async (req, res) => {
    try {
        const userIsZeus = req.session.isAdmin || await checkZeusStatus(req.session.userId);
        if (!userIsZeus) {
            const canEdit = await isSquadEditor(req.session.userId, req.params.roleId);
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

// Create dynamic ORBAT for operation (Zeus)
router.post('/operation/:operationId/create-dynamic', isZeus, async (req, res) => {
    try {
        const { squadName, squadColor, roleName } = req.body;

        // Create squad
        const [result] = await db.query(
            'INSERT INTO orbat_squads (operation_id, name, color, display_order) VALUES (?, ?, ?, 0)',
            [req.params.operationId, squadName, squadColor || '#3498DB']
        );

        const squadId = result.insertId;

        // Add initial role
        await db.query(
            'INSERT INTO orbat_roles (squad_id, role_name, display_order) VALUES (?, ?, 0)',
            [squadId, roleName]
        );

        // Update operation to use dynamic ORBAT
        await db.query(
            'UPDATE operations SET orbat_type = ? WHERE id = ?',
            ['dynamic', req.params.operationId]
        );

        res.json({ success: true });
    } catch (error) {
        console.error('Error creating dynamic ORBAT:', error);
        res.json({ success: false, error: 'Failed to create ORBAT' });
    }
});

// Add squad to dynamic ORBAT
router.post('/operation/:operationId/add-squad', isZeus, async (req, res) => {
    try {
        const { squadName, squadColor } = req.body;
        
        // Get current max display_order
        const [maxOrder] = await db.query(
            'SELECT MAX(display_order) as max_order FROM orbat_squads WHERE operation_id = ?',
            [req.params.operationId]
        );
        
        const nextOrder = (maxOrder[0]?.max_order || 0) + 1;

        await db.query(
            'INSERT INTO orbat_squads (operation_id, name, color, display_order) VALUES (?, ?, ?, ?)',
            [req.params.operationId, squadName, squadColor || '#3498DB', nextOrder]
        );

        res.json({ success: true });
    } catch (error) {
        console.error('Error adding squad:', error);
        res.json({ success: false, error: 'Failed to add squad' });
    }
});

// Add role to squad (dynamic ORBAT - zeus/admin OR squad editor)
router.post('/squads/:squadId/add-role-dynamic', isAuthenticated, async (req, res) => {
    try {
        const userIsZeus = req.session.isAdmin || await checkZeusStatus(req.session.userId);
        if (!userIsZeus) {
            // Squad editor can only add roles to their own squad
            const [editorCheck] = await db.query(`
                SELECT 1
                FROM orbat_roles er
                JOIN orbat_assignments oa ON er.id = oa.role_id
                WHERE er.squad_id = ?
                  AND er.is_editor = TRUE
                  AND oa.user_id = ?
                LIMIT 1
            `, [req.params.squadId, req.session.userId]);
            if (editorCheck.length === 0) {
                return res.status(403).json({ success: false, error: 'Permission denied' });
            }
        }

        const { roleName, displayOrder } = req.body;

        await db.query(
            'INSERT INTO orbat_roles (squad_id, role_name, display_order) VALUES (?, ?, ?)',
            [req.params.squadId, roleName, displayOrder || 0]
        );

        res.json({ success: true });
    } catch (error) {
        console.error('Error adding role:', error);
        res.json({ success: false, error: 'Failed to add role' });
    }
});

// ====== SQUAD EDITOR API ROUTES (JSON, used from public template view) ======

// Add role to any squad (squad editor or admin/zeus)
router.post('/api/squads/:squadId/add-role', isAuthenticated, async (req, res) => {
    try {
        const userIsZeus = req.session.isAdmin || await checkZeusStatus(req.session.userId);
        if (!userIsZeus) {
            const [editorCheck] = await db.query(`
                SELECT 1
                FROM orbat_roles er
                JOIN orbat_assignments oa ON er.id = oa.role_id
                WHERE er.squad_id = ?
                  AND er.is_editor = TRUE
                  AND oa.user_id = ?
                LIMIT 1
            `, [req.params.squadId, req.session.userId]);
            if (editorCheck.length === 0) {
                return res.status(403).json({ success: false, error: 'Permission denied' });
            }
        }

        const { roleName, displayOrder } = req.body;
        if (!roleName || !roleName.trim()) {
            return res.json({ success: false, error: 'Role name is required' });
        }

        const [result] = await db.query(
            'INSERT INTO orbat_roles (squad_id, role_name, display_order) VALUES (?, ?, ?)',
            [req.params.squadId, roleName.trim(), displayOrder || 0]
        );

        res.json({ success: true, roleId: result.insertId });
    } catch (error) {
        console.error('Error adding role:', error);
        res.json({ success: false, error: 'Failed to add role' });
    }
});

// Edit role name/order (squad editor or admin/zeus)
router.post('/api/roles/:id/edit', isAuthenticated, async (req, res) => {
    try {
        const userIsZeus = req.session.isAdmin || await checkZeusStatus(req.session.userId);
        if (!userIsZeus) {
            const canEdit = await isSquadEditor(req.session.userId, req.params.id);
            if (!canEdit) {
                return res.status(403).json({ success: false, error: 'Permission denied' });
            }
        }

        const { roleName, displayOrder } = req.body;
        if (!roleName || !roleName.trim()) {
            return res.json({ success: false, error: 'Role name is required' });
        }

        await db.query(
            'UPDATE orbat_roles SET role_name = ?, display_order = ? WHERE id = ?',
            [roleName.trim(), displayOrder || 0, req.params.id]
        );

        res.json({ success: true });
    } catch (error) {
        console.error('Error updating role:', error);
        res.json({ success: false, error: 'Failed to update role' });
    }
});

// Delete role (squad editor or admin/zeus)
router.post('/api/roles/:id/delete', isAuthenticated, async (req, res) => {
    try {
        const userIsZeus = req.session.isAdmin || await checkZeusStatus(req.session.userId);
        if (!userIsZeus) {
            const canEdit = await isSquadEditor(req.session.userId, req.params.id);
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

module.exports = router;