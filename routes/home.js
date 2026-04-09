const express = require('express');
const router = express.Router();
const db = require('../config/database');

// Session keep-alive — clients ping this periodically so rolling sessions stay active
router.get('/ping', (req, res) => res.sendStatus(204));

router.get('/', (req, res) => {
    res.render('index', {
        title: 'Home - Profiteers PMC'
    });
});

router.get('/about', (req, res) => {
    res.render('about', {
        title: 'About & Lore - Profiteers PMC'
    });
});

router.get('/join', async (req, res) => {
    try {
        const [trainings] = await db.query(`
            SELECT * FROM trainings 
            ORDER BY display_order ASC, name ASC
        `);
        
        res.render('join', {
            title: 'Join Us - Profiteers PMC',
            trainings: trainings
        });
    } catch (error) {
        console.error('Error loading trainings:', error);
        res.render('join', {
            title: 'Join Us - Profiteers PMC',
            trainings: []
        });
    }
});

module.exports = router;