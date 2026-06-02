{ const levels = { log: 'INFO', warn: 'WARN', error: 'ERROR' };
  ['log', 'warn', 'error'].forEach(level => {
    const orig = console[level].bind(console);
    console[level] = (...args) => orig(`[${new Date().toISOString()}] [${levels[level]}]`, ...args);
  });
}

const express = require('express');
const http = require('http');
const helmet = require('helmet');
const session = require('express-session');
const MySQLStore = require('express-mysql-session')(session);
const fileUpload = require('express-fileupload');
const path = require('path');
require('dotenv').config({ quiet: true });

const requiredEnvVars = ['DISCORD_GUILD_ID', 'DISCORD_ZEUS_ROLE_ID'];
const missing = requiredEnvVars.filter(v => !process.env[v]);
if (missing.length > 0) {
    throw new Error(`Missing required environment variables: ${missing.join(', ')}`);
}

const { attachUser } = require('./middleware/auth');
const { trackPageView } = require('./middleware/analytics');
const { actionLogger } = require('./middleware/action-log');
const { attachSeoDefaults } = require('./middleware/seo');
const passport = require('./config/passport.js');


const homeRoutes = require('./routes/home');
const authRoutes = require('./routes/auth');
const toolsRoutes = require('./routes/tools');
const discordAuthRoutes = require('./routes/discord-auth');
const galleryRoutes = require('./routes/gallery');
const profileRoutes = require('./routes/profile');
const adminRoutes = require('./routes/admin');
const rosterRoutes = require('./routes/roster');
const orbatRoutes = require('./routes/orbat');
const loaRoutes = require('./routes/loa');
const operationsRoutes = require('./routes/operations');
const operationsMapRoutes = require('./routes/operations-map');
const mapPlansRoutes = require('./routes/map-plans');
const { discordClient, initializeDiscord } = require('./discord');
const modpacksRoutes = require('./routes/modpacks');
const infoRoutes = require('./routes/info');
const cron = require('node-cron');
const { runRosterSync } = require('./routes/roster');


const app = express();
const PORT = process.env.PORT || 3000;

app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
app.set('trust proxy', 1);

app.use(helmet({
    contentSecurityPolicy: false,
    crossOriginEmbedderPolicy: false
}));
app.use(express.static('public'));
app.use(express.urlencoded({ extended: true }));
app.use(express.json());
// Default file-upload middleware with a 10 MB cap. Routes that need to accept
// larger uploads (e.g. terrain zips) are listed here as exceptions and mount
// their own per-route fileUpload middleware with different limits.
const FILE_UPLOAD_EXCEPTIONS = [
    '/admin/map-plans/terrains/import',
];
const defaultFileUpload = fileUpload({
    limits: { fileSize: parseInt(process.env.MAX_FILE_SIZE) || 10 * 1024 * 1024 },
    abortOnLimit: true,
    createParentPath: false
});
app.use((req, res, next) => {
    if (FILE_UPLOAD_EXCEPTIONS.includes(req.path)) return next();
    return defaultFileUpload(req, res, next);
});

const sessionStore = new MySQLStore({
    host:     process.env.DB_HOST || 'localhost',
    port:     parseInt(process.env.DB_PORT) || 3306,
    user:     process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME,
    createDatabaseTable: true,
    clearExpired: true,
    checkExpirationInterval: 15 * 60 * 1000,
    expiration: 30 * 24 * 60 * 60 * 1000,
});

const sessionMiddleware = session({
    secret: process.env.SESSION_SECRET,
    resave: true,
    saveUninitialized: false,
    rolling: true,
    store: sessionStore,
    proxy: true,
    cookie: {
        secure: process.env.NODE_ENV === 'production',
        sameSite: 'lax',
        path: '/',
        httpOnly: true,
        maxAge: 30 * 24 * 60 * 60 * 1000
    }
});
app.use(sessionMiddleware);

const passportInit    = passport.initialize();
const passportSession = passport.session();
app.use(passportInit);
app.use(passportSession);

app.use(attachUser);
app.use(attachSeoDefaults);
app.use(trackPageView);
app.use(actionLogger);

app.use('/', require('./routes/sitemap'));
app.use('/', homeRoutes);
app.use('/', authRoutes);
app.use('/auth', discordAuthRoutes);
app.use('/tools', toolsRoutes);
app.use('/gallery', galleryRoutes);
app.use('/profile', profileRoutes);
app.use('/admin', adminRoutes);
app.use('/operations', operationsMapRoutes);
app.use('/operations', operationsRoutes);
app.use('/plans', mapPlansRoutes);
app.use('/orbat', orbatRoutes);
app.use('/loa', loaRoutes);
app.use('/roster', rosterRoutes);
app.use('/modpacks', modpacksRoutes);
const loreRoutes = require('./routes/lore');
app.use('/lore', loreRoutes);
app.use('/info', infoRoutes);

app.use((req, res) => {
    res.status(404).render('error', {
        title: '404 - Page Not Found',
        message: '404 - Page Not Found',
        description: 'The page you are looking for does not exist.',
        user: res.locals.user
    });
});

app.use((err, req, res, next) => {
    // Client disconnected mid-multipart-upload (busboy reports
    // "Unexpected end of form"). The connection is gone, so there is no
    // point rendering an error page. Log quietly and bail.
    if (err && err.message === 'Unexpected end of form') {
        console.warn('Aborted upload from', req.ip, req.method, req.originalUrl);
        if (!res.headersSent) {
            try { res.status(400).end(); } catch (_) {}
        }
        return;
    }

    console.error('Error:', err);
    if (res.headersSent) return next(err);
    res.status(500).render('error', {
        title: '500 - Internal Server Error',
        message: '500 - Internal Server Error',
        description: process.env.NODE_ENV === 'development' ? err.message : 'Something went wrong on our end.',
        user: res.locals.user
    });
});

const server = http.createServer(app);

// Real-time collaboration for the Map Plan editor (Socket.IO).
const plansCollab = require('./services/plans-collab');
plansCollab.init(server, sessionMiddleware, passportInit, passportSession);

server.listen(PORT, () => {
    console.log(`
╔═══════════════════════════════════════════════════╗
║         PROFITEERS PMC WEBSITE                    ║
║                                                   ║
║  Server running on: http://localhost:${PORT}         ║
║  Environment: ${process.env.NODE_ENV}                        ║
║                                                   ║
║  Ready to deploy!                                  ║
╚═══════════════════════════════════════════════════╝
Server running !
    `);
});

initializeDiscord();

// ── Scheduled Jobs ────────────────────────────────────────────────────────────
// Roster auto-sync — every hour at :00
cron.schedule('0 * * * *', async () => {
    try {
        await runRosterSync();
    } catch (error) {
        console.error('[CRON] Roster sync failed:', error.message);
    }
});

module.exports = app;
