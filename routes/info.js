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
    const useSSE = req.headers.accept && req.headers.accept.includes('text/event-stream');

    // Only serve from cache for JSON requests — SSE always streams fresh
    if (!useSSE && serverStatusCache.data && now - serverStatusCache.fetchedAt < CACHE_TTL) {
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

        // Check if the client wants SSE streaming (Accept: text/event-stream)
        const useSSE = req.headers.accept && req.headers.accept.includes('text/event-stream');

        if (useSSE) {
            // ── SSE: stream each server result as it resolves ──────────────
            res.writeHead(200, {
                'Content-Type': 'text/event-stream',
                'Cache-Control': 'no-cache',
                'Connection': 'keep-alive',
                'X-Accel-Buffering': 'no'
            });

            const allResults = [];
            let completed = 0;

            for (const srv of servers) {
                const promise = (async () => {
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
                })();

                promise.then(result => {
                    allResults.push(result);
                    completed++;
                    res.write(`data: ${JSON.stringify(result)}\n\n`);
                    if (completed === servers.length) {
                        serverStatusCache = { data: allResults, fetchedAt: Date.now() };
                        res.write('event: done\ndata: {}\n\n');
                        res.end();
                    }
                });
            }
        } else {
            // ── JSON: wait for all (legacy / cache-refresh path) ───────────
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
        }
    } catch (error) {
        console.error('Error querying server status:', error);
        if (!res.headersSent) res.json([]);
        else res.end();
    }
});

module.exports = router;
