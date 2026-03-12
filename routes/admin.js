const express = require('express');
const router = express.Router();
const { isAdmin } = require('../middleware/auth');

router.use(isAdmin);

router.use('/', require('./admin/dashboard'));
router.use('/tools', require('./admin/tools'));
router.use('/gallery', require('./admin/gallery'));
router.use('/users', require('./admin/users'));
router.use('/medals', require('./admin/medals'));
router.use('/trainings', require('./admin/trainings'));

module.exports = router;
