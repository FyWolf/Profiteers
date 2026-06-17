const db = require('../config/database');

// Operation management ("Zeus") access is governed entirely by RBAC permissions:
//   operations.create  - create new operations (+ scheduling: locked periods, overlaps)
//   operations.edit    - edit existing operations (details, ORBAT, news updates)
//   operations.delete  - delete operations
// "Zeus" is the Arma term for the operation gamemaster/host; here it simply means
// a user who can manage operations. (The previous Discord Zeus-role check has been
// removed — access is now driven purely by the web permissions above.)

// True if the user holds ANY of the given permissions (looked up via their roles).
async function hasOpsPermission(userId, permNames) {
    if (!userId || permNames.length === 0) return false;
    try {
        const placeholders = permNames.map(() => '?').join(', ');
        const [rows] = await db.query(`
            SELECT 1
            FROM user_roles ur
            JOIN role_permissions rp ON ur.role_id = rp.role_id
            JOIN permissions p ON rp.permission_id = p.id
            WHERE ur.user_id = ? AND p.name IN (${placeholders})
            LIMIT 1
        `, [userId, ...permNames]);
        return rows.length > 0;
    } catch (error) {
        console.error('Error checking operations permission:', error);
        return false;
    }
}

// Broad "operations staff": can create OR edit operations.
const checkZeusStatus   = (userId) => hasOpsPermission(userId, ['operations.create', 'operations.edit']);
// Can create new operations.
const checkCreateStatus = (userId) => hasOpsPermission(userId, ['operations.create']);
// Can edit existing operations (separate from creating them).
const checkEditStatus   = (userId) => hasOpsPermission(userId, ['operations.edit']);

// Route middleware gating on operations permissions already loaded onto req.user
// (set in passport deserialize), so no extra query is needed per request.
function requireOpsPermission(...permNames) {
    return function (req, res, next) {
        if (!req.isAuthenticated()) {
            return res.redirect('/login?redirect=' + encodeURIComponent(req.originalUrl));
        }
        const perms = Array.isArray(req.user.permissions) ? req.user.permissions : [];
        if (permNames.some(p => perms.includes(p))) {
            return next();
        }
        return res.status(403).render('error', {
            title: 'Access Denied',
            message: 'Operations Permission Required',
            description: 'You need operation management permissions to access this page.',
            user: res.locals.user
        });
    };
}

// Create new operations (and scheduling pages).
const isZeus = requireOpsPermission('operations.create');
// View the operations management list: create OR edit capability.
const canManageOps = requireOpsPermission('operations.create', 'operations.edit');

module.exports = {
    isZeus,
    canManageOps,
    checkZeusStatus,
    checkCreateStatus,
    checkEditStatus
};
