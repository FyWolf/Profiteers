const express = require('express');
const router = express.Router();
const db = require('../config/database');

// Tools listing page
router.get('/', async (req, res) => {
    try {
        const [tools] = await db.query(
            'SELECT * FROM tools WHERE is_visible = TRUE ORDER BY order_index ASC, created_at DESC'
        );

        res.render('tools', {
            title: 'Internal Tools - Profiteers PMC',
            tools: tools
        });
    } catch (error) {
        console.error('Error fetching tools:', error);
        res.render('error', {
            title: 'Error Loading Tools',
            message: 'Error Loading Tools',
            description: 'Could not load the tools list.',
            user: res.locals.user
        });
    }
});

module.exports = router;
