const express = require('express');
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
const { discordClient, initializeDiscord } = require('./discord');
const modpacksRoutes = require('./routes/modpacks');


const app = express();
const PORT = process.env.PORT || 3000;

app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
app.set('trust proxy', 1);

app.use(helmet({
    contentSecurityPolicy: false, // CSP managed separately due to inline scripts in EJS
    crossOriginEmbedderPolicy: false
}));
app.use(express.static('public'));
app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.use(fileUpload({
    limits: { fileSize: parseInt(process.env.MAX_FILE_SIZE) || 10 * 1024 * 1024 },
    abortOnLimit: true,
    createParentPath: false
}));

const sessionStore = new MySQLStore({
    host:     process.env.DB_HOST || 'localhost',
    port:     parseInt(process.env.DB_PORT) || 3306,
    user:     process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME,
    createDatabaseTable: true,
    clearExpired: true,
    checkExpirationInterval: 15 * 60 * 1000, // clean up expired sessions every 15 min
    expiration: 30 * 24 * 60 * 60 * 1000,    // max session lifetime: 30 days
});

app.use(session({
    secret: process.env.SESSION_SECRET,
    resave: true,            // must be true with rolling:true so the store record expiry is updated
    saveUninitialized: false,
    rolling: true,   // reset expiry on every request while the user is active
    store: sessionStore,
    proxy: true,
    cookie: {
        secure: process.env.NODE_ENV === 'production',
        sameSite: 'lax',
        path: '/',
        httpOnly: true,
        maxAge: 30 * 24 * 60 * 60 * 1000 // 30 days
    }
}));

app.use(passport.initialize());
app.use(passport.session());

app.use(attachUser);
app.use(trackPageView);

app.use('/', homeRoutes);
app.use('/', authRoutes);
app.use('/auth', discordAuthRoutes);
app.use('/tools', toolsRoutes);
app.use('/gallery', galleryRoutes);
app.use('/profile', profileRoutes);
app.use('/admin', adminRoutes);
app.use('/operations', operationsMapRoutes);
app.use('/operations', operationsRoutes);
app.use('/orbat', orbatRoutes);
app.use('/loa', loaRoutes);
app.use('/roster', rosterRoutes);
app.use('/modpacks', modpacksRoutes);
const loreRoutes = require('./routes/lore');
app.use('/lore', loreRoutes);

app.use((req, res) => {
    res.status(404).render('error', {
        title: '404 - Page Not Found',
        message: '404 - Page Not Found',
        description: 'The page you are looking for does not exist.',
        user: res.locals.user
    });
});

app.use((err, req, res, next) => {
    console.error('Error:', err);
    res.status(500).render('error', {
        title: '500 - Internal Server Error',
        message: '500 - Internal Server Error',
        description: process.env.NODE_ENV === 'development' ? err.message : 'Something went wrong on our end.',
        user: res.locals.user
    });
});

app.listen(PORT, () => {
    console.log(`
╔═══════════════════════════════════════════════════╗
║         PROFITEERS PMC WEBSITE                    ║
║                                                   ║
║  Server running on: http://localhost:${PORT}         ║
║  Environment: ${process.env.NODE_ENV}                        ║
║                                                   ║
║  Ready to deploy! 🎯                               ║
╚═══════════════════════════════════════════════════╝
Server running !
    `);
});

initializeDiscord();

module.exports = app;
