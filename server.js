const express = require('express');
const session = require('express-session');
const fileUpload = require('express-fileupload');
const cookieParser = require('cookie-parser');
const { doubleCsrf } = require('csrf-csrf');
const path = require('path');
require('dotenv').config({ quiet: true });

const requiredEnvVars = ['DISCORD_GUILD_ID', 'DISCORD_ZEUS_ROLE_ID'];
const missing = requiredEnvVars.filter(v => !process.env[v]);
if (missing.length > 0) {
    throw new Error(`Missing required environment variables: ${missing.join(', ')}`);
}

const { attachUser } = require('./middleware/auth');
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
const { discordClient, initializeDiscord } = require('./discord');
const modpacksRoutes = require('./routes/modpacks');


const app = express();
const PORT = process.env.PORT || 3000;

app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
app.set('trust proxy', 1);

app.use(express.static('public'));
app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.use(fileUpload({
    limits: { fileSize: parseInt(process.env.MAX_FILE_SIZE) || 10 * 1024 * 1024 },
    abortOnLimit: true,
    createParentPath: false
}));

app.use(session({
    secret: process.env.SESSION_SECRET,
    resave: false,
    saveUninitialized: false,
    proxy: true,
    cookie: {
        secure: process.env.NODE_ENV === 'production',
        sameSite: 'lax',
        path: '/',
        httpOnly: true,
        maxAge: 24 * 60 * 60 * 1000
    }
}));

app.use(cookieParser(process.env.SESSION_SECRET));

const { doubleCsrfProtection, generateToken } = doubleCsrf({
    getSecret: () => process.env.SESSION_SECRET,
    cookieName: '__csrf',
    cookieOptions: {
        sameSite: 'lax',
        secure: process.env.NODE_ENV === 'production',
        signed: true
    },
    getTokenFromRequest: (req) => req.body._csrf || req.headers['x-csrf-token']
});

app.use(passport.initialize());
app.use(passport.session());

app.use((req, res, next) => {
    res.locals.csrfToken = generateToken(req, res);
    next();
});

app.use(attachUser);

app.use(doubleCsrfProtection);

app.use('/', homeRoutes);
app.use('/', authRoutes);
app.use('/auth', discordAuthRoutes);
app.use('/tools', toolsRoutes);
app.use('/gallery', galleryRoutes);
app.use('/profile', profileRoutes);
app.use('/admin', adminRoutes);
app.use('/operations', operationsRoutes);
app.use('/orbat', orbatRoutes);
app.use('/loa', loaRoutes);
app.use('/roster', rosterRoutes);
app.use('/modpacks', modpacksRoutes);

app.use((req, res) => {
    res.status(404).render('error', {
        title: '404 - Page Not Found',
        message: '404 - Page Not Found',
        description: 'The page you are looking for does not exist.',
        user: res.locals.user
    });
});

app.use((err, req, res, next) => {
    if (err.code === 'EBADCSRFTOKEN' || err.message === 'invalid csrf token') {
        return res.status(403).render('error', {
            title: '403 - Forbidden',
            message: 'Form Expired',
            description: 'Your form session has expired. Please go back and try again.',
            user: res.locals.user
        });
    }
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
║  Environment: ${process.env.NODE_ENV || 'development'}                        ║
║                                                   ║
║  Ready to deploy! 🎯                               ║
╚═══════════════════════════════════════════════════╝
Server running !
    `);
});

initializeDiscord();

module.exports = app;
