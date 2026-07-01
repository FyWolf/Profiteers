const db = require('../config/database');

/**
 * Log an ORBAT change to the change_log table.
 *
 * @param {Object} params
 * @param {number}  [params.templateId]    - orbat_templates.id (if template-level)
 * @param {number}  [params.operationId]   - operations.id (if operation-level)
 * @param {number}  [params.squadId]       - orbat_squads.id
 * @param {number}  [params.roleId]        - orbat_roles.id
 * @param {string}   params.actionType     - one of: assign|unassign|claim|unclaim|role_added|role_deleted|role_edited|squad_added|squad_deleted|roster_auto_remove
 * @param {number}  [params.performedBy]   - users.id of who did it (null = automated)
 * @param {number}  [params.targetUserId]  - users.id of affected player
 * @param {*}       [params.oldValue]      - previous state (will be JSON-stringified)
 * @param {*}       [params.newValue]      - new state (will be JSON-stringified)
 * @param {string}  [params.description]   - human-readable summary
 */
async function logOrbatChange(params) {
    try {
        const {
            templateId,
            operationId,
            squadId,
            roleId,
            actionType,
            performedBy,
            targetUserId,
            oldValue,
            newValue,
            description
        } = params;

        await db.query(
            `INSERT INTO orbat_change_log
                (template_id, operation_id, squad_id, role_id, action_type,
                 performed_by, target_user_id, old_value, new_value, description)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [
                templateId || null,
                operationId || null,
                squadId || null,
                roleId || null,
                actionType,
                performedBy || null,
                targetUserId || null,
                oldValue != null ? JSON.stringify(oldValue) : null,
                newValue != null ? JSON.stringify(newValue) : null,
                description || null
            ]
        );
    } catch (err) {
        console.error('Error logging ORBAT change:', err);
    }
}

/**
 * Resolve template_id and operation_id from a role_id or squad_id.
 * Returns { templateId, operationId } or null if not found.
 */
async function resolveOrbatContext(roleId, squadId) {
    let result = { templateId: null, operationId: null };

    if (roleId) {
        const [rows] = await db.query(`
            SELECT os.orbat_id, os.operation_id
            FROM orbat_roles r
            JOIN orbat_squads os ON r.squad_id = os.id
            WHERE r.id = ?
        `, [roleId]);
        if (rows.length) {
            result.templateId = rows[0].orbat_id;
            result.operationId = rows[0].operation_id;
        }
    } else if (squadId) {
        const [rows] = await db.query(`
            SELECT orbat_id, operation_id FROM orbat_squads WHERE id = ?
        `, [squadId]);
        if (rows.length) {
            result.templateId = rows[0].orbat_id;
            result.operationId = rows[0].operation_id;
        }
    }

    return result;
}

module.exports = { logOrbatChange, resolveOrbatContext };
