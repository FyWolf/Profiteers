const express = require('express');
const router = express.Router();
const db = require('../config/database');

let serverStatusCache = { data: null, fetchedAt: 0 };
const CACHE_TTL = 30 * 1000;

router.get('/', async (req, res) => {
    try {
        const [servers] = await db.query(
            'SELECT * FROM info_servers ORDER BY display_order ASC, name ASC'
        );

        const [kitRoles] = await db.query(
            'SELECT * FROM kit_roles ORDER BY display_order ASC, name ASC'
        );
        const [kitSlots] = await db.query(
            'SELECT * FROM kit_slots ORDER BY role_id ASC, display_order ASC, id ASC'
        );

        const slotsByRole = {};
        kitSlots.forEach(s => {
            if (!slotsByRole[s.role_id]) slotsByRole[s.role_id] = [];
            slotsByRole[s.role_id].push(s);
        });

        res.render('info', {
            title: 'Information - Profiteers PMC',
            servers,
            kitRoles,
            slotsByRole
        });
    } catch (error) {
        console.error('Error loading info page:', error);
        res.render('error', {
            title: 'Error',
            message: 'Error Loading Page',
            description: 'Could not load the information page.',
            user: res.locals.user
        });
    }
});

router.get('/api/server-status', async (req, res) => {
    const now = Date.now();
    if (serverStatusCache.data && now - serverStatusCache.fetchedAt < CACHE_TTL) {
        return res.json(serverStatusCache.data);
    }

    try {
        const [servers] = await db.query(
            'SELECT * FROM info_servers ORDER BY display_order ASC'
        );

        if (servers.length === 0) return res.json([]);

        let GameDig;
        try {
            GameDig = require('gamedig').GameDig;
        } catch {
            console.warn('gamedig not available');
            return res.json(servers.map(s => ({ id: s.id, name: s.name, online: false })));
        }

        const results = await Promise.allSettled(
            servers.map(async srv => {
                try {
                    const state = await Promise.race([
                        GameDig.query({ type: srv.game_type, host: srv.host, port: srv.port }),
                        new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), 6000))
                    ]);
                    return {
                        id: srv.id,
                        name: srv.name,
                        online: true,
                        serverName: state.name || srv.name,
                        map: state.map || '',
                        players: state.players?.length ?? 0,
                        maxPlayers: state.maxplayers ?? 0,
                        ping: state.ping ?? 0
                    };
                } catch {
                    return { id: srv.id, name: srv.name, online: false };
                }
            })
        );

        const data = results.map((r, i) =>
            r.status === 'fulfilled' ? r.value : { id: servers[i].id, name: servers[i].name, online: false }
        );

        serverStatusCache = { data, fetchedAt: now };
        res.json(data);
    } catch (error) {
        console.error('Error querying server status:', error);
        res.json([]);
    }
});

module.exports = router;
