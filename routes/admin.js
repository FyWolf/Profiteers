const express = require('express');
const router = express.Router();
const { isAuthenticated, hasPermission } = require('../middleware/auth');

// All admin routes require authentication
router.use(isAuthenticated);

// Base admin panel access required for all admin routes
router.use(hasPermission('admin.access'));

// Sub-routers — each guarded by its own permission on top of admin.access
router.use('/',           require('./admin/dashboard'));
router.use('/tools',      hasPermission('tools.manage'),     require('./admin/tools'));
router.use('/gallery',    hasPermission('gallery.manage'),   require('./admin/gallery'));
router.use('/users',      hasPermission('users.view'),       require('./admin/users'));
router.use('/medals',     hasPermission('medals.manage'),    require('./admin/medals'));
router.use('/trainings',  hasPermission('trainings.manage'), require('./admin/trainings'));
router.use('/roles',      hasPermission('roles.manage'),     require('./admin/roles'));
router.use('/info',       hasPermission('info.manage'),       require('./admin/info'));
router.use('/presence',   require('./admin/presence'));

module.exports = router;
