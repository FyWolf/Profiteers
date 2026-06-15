const express = require('express');
const router = express.Router();
const db = require('../config/database');

router.get('/ping', (req, res) => res.sendStatus(204));

router.get('/', (req, res) => {
    const siteUrl = (process.env.WEBSITE_URL || '').replace(/\/$/, '');
    const orgJsonLd = {
        '@context': 'https://schema.org',
        '@type':    'Organization',
        name:       'Profiteers PMC',
        url:        siteUrl || undefined,
        logo:       (siteUrl || '') + '/logo.png',
        description:'LGBTQ+ inclusive Arma 3 tactical unit running scheduled cooperative operations.',
    };
    res.render('index', {
        title: 'Profiteers PMC — LGBTQ+ Arma 3 Tactical Unit',
        description: 'Profiteers PMC is an LGBTQ+ inclusive Arma 3 tactical unit. Join our scheduled operations, browse our ORBAT, modpacks and tools.',
        jsonLd: orgJsonLd,
    });
});

router.get('/about', (req, res) => {
    res.render('about', {
        title: 'About — Profiteers PMC',
        description: 'About Profiteers PMC: who we are, our values, and how we run our Arma 3 operations.',
    });
});

router.get('/join', async (req, res) => {
    try {
        const [trainings] = await db.query(`
            SELECT * FROM trainings
            ORDER BY display_order ASC, name ASC
        `);

        res.render('join', {
            title: 'Join Profiteers PMC',
            description: 'How to join Profiteers PMC — requirements, training pipeline, and the application process for our LGBTQ+ Arma 3 tactical unit.',
            trainings: trainings
        });
    } catch (error) {
        console.error('Error loading trainings:', error);
        res.render('join', {
            title: 'Join Profiteers PMC',
            description: 'How to join Profiteers PMC — requirements, training pipeline, and the application process for our LGBTQ+ Arma 3 tactical unit.',
            trainings: []
        });
    }
});

module.exports = router;