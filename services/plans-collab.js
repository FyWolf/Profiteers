// ─── Real-time collaboration for the Map Plan editor ─────────────────────
//
// Wraps a Socket.IO server, scoped to the `/plans` namespace, with:
//   • Session-based auth that reuses the plan ACL (resolveAccess)
//   • One room per plan (`plan:<id>`), joined on connection
//   • Presence tracking — each socket reports {userId, username, role, color}
//   • Cursor broadcast — peers see each other's cursor when toggled on
//   • Broadcast helpers used by routes/map-plans.js after a DB write
//
// Single export `init(server, sessionMiddleware, passportInit, passportSession)`
// must be called once from server.js after the HTTP server is created.
// `getIO()` / `broadcast(...)` are used by routes to push changes to peers.

const { Server } = require('socket.io');

// Lazy-required to avoid a circular dep (routes/map-plans → this module).
let _mapPlans = null;
function mapPlans() {
    if (!_mapPlans) _mapPlans = require('../routes/map-plans');
    return _mapPlans;
}

let io = null;

// Stable per-user color, derived from username — used for cursors / presence dots.
function colorFor(username) {
    let h = 0;
    const s = String(username || 'anon');
    for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
    const hue = h % 360;
    return `hsl(${hue}, 70%, 55%)`;
}

function init(server, sessionMiddleware, passportInit, passportSession) {
    io = new Server(server, {
        path: '/socket.io',
        cors: { origin: false }
    });

    const plansNs = io.of('/plans');

    // Reuse the express session + passport middleware so req.session.userId etc.
    // are populated on the handshake.
    const wrap = mw => (socket, next) => mw(socket.request, {}, next);
    plansNs.use(wrap(sessionMiddleware));
    if (passportInit)    plansNs.use(wrap(passportInit));
    if (passportSession) plansNs.use(wrap(passportSession));

    plansNs.on('connection', async socket => {
        const req = socket.request;

        // Plan ID and optional share token come in on the handshake query.
        const planId = parseInt(socket.handshake.query.planId);
        const shareToken = socket.handshake.query.t || null;
        if (!planId || Number.isNaN(planId)) { socket.disconnect(true); return; }

        // Reconstruct a minimal request for resolveAccess. It only reads
        // session.userId, user.permissions, isAuthenticated() and query.t.
        const fauxReq = {
            session: req.session || {},
            user:    req.user,
            isAuthenticated: () => !!(req.session && req.session.userId),
            query:   { t: shareToken }
        };

        const mp = mapPlans();
        let role, plan;
        try {
            ({ plan, role } = await mp.resolveAccess(fauxReq, planId));
        } catch (err) {
            socket.disconnect(true);
            return;
        }
        if (!plan || !mp.canRead(role)) { socket.disconnect(true); return; }

        // Resolve a display name. For viewers reaching via share link without
        // a session we fall back to "Guest".
        let username = 'Guest';
        if (req.session && req.session.username) username = req.session.username;
        else if (req.user && req.user.username) username = req.user.username;

        socket.data.planId   = planId;
        socket.data.userId   = req.session?.userId || null;
        socket.data.username = username;
        socket.data.role     = role;
        socket.data.color    = colorFor(username + ':' + (socket.data.userId || socket.id));
        socket.data.canEdit  = mp.canEdit(role);
        socket.data.cursorOn = false;

        const room = `plan:${planId}`;
        socket.join(room);

        // ─ Presence ─
        socket.emit('hello', {
            self: presenceEntry(socket),
            peers: roomPresence(plansNs, room).filter(p => p.sid !== socket.id)
        });
        socket.to(room).emit('presence:join', presenceEntry(socket));

        // ─ Cursor sharing ─
        socket.on('cursor:toggle', enabled => {
            socket.data.cursorOn = !!enabled;
            socket.to(room).emit('cursor:toggle', { sid: socket.id, enabled: !!enabled });
            // If they turn it off, clear any stale dot for them on peers.
            if (!enabled) socket.to(room).emit('cursor:leave', { sid: socket.id });
        });

        socket.on('cursor:move', pos => {
            if (!socket.data.cursorOn) return;
            if (!pos || typeof pos.x !== 'number' || typeof pos.y !== 'number') return;
            socket.to(room).emit('cursor:move', {
                sid: socket.id,
                username: socket.data.username,
                color:    socket.data.color,
                x: pos.x, y: pos.y
            });
        });

        socket.on('disconnect', () => {
            socket.to(room).emit('presence:leave', { sid: socket.id });
        });
    });

    return io;
}

function presenceEntry(socket) {
    return {
        sid:       socket.id,
        userId:    socket.data.userId,
        username:  socket.data.username,
        role:      socket.data.role,
        color:     socket.data.color,
        canEdit:   socket.data.canEdit,
        cursorOn:  !!socket.data.cursorOn
    };
}

function roomPresence(ns, room) {
    const sids = ns.adapter.rooms.get(room);
    if (!sids) return [];
    const out = [];
    for (const sid of sids) {
        const s = ns.sockets.get(sid);
        if (s) out.push(presenceEntry(s));
    }
    return out;
}

// ─── Broadcast helpers, called from REST routes after a DB write ──────────
//
// Usage from map-plans.js:
//   const collab = require('../services/plans-collab');
//   collab.broadcast(req, 'annotation:create', { ... });
//
// `req` is the Express request so we can derive the planId and exclude the
// originator's socket(s) via the optional `x-socket-id` header echoed by the
// client. (Excluding the originator avoids double-applying the change locally.)

function broadcast(req, event, payload) {
    if (!io) return;
    const planId = parseInt(req.params.id);
    if (!planId) return;
    const room = `plan:${planId}`;
    const ns = io.of('/plans');
    const originSid = req.get('x-socket-id') || null;

    const data = {
        ...payload,
        by: {
            userId:   req.session?.userId || null,
            username: req.session?.username
                      || (req.user && req.user.username)
                      || 'Someone'
        }
    };

    if (originSid && ns.sockets.get(originSid)) {
        ns.sockets.get(originSid).to(room).emit(event, data);
    } else {
        ns.to(room).emit(event, data);
    }
}

module.exports = { init, broadcast, colorFor };
