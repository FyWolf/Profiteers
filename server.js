const express = require('express');
const session = require('express-session');
const fileUpload = require('express-fileupload');
const path = require('path');
require('dotenv').config();

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
    createParentPath: true
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

app.use(attachUser);

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

app.use(passport.initialize());
app.use(passport.session());

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
║  Environment: ${process.env.NODE_ENV || 'development'}                        ║
║                                                   ║
║  Ready to deploy! 🎯                               ║
╚═══════════════════════════════════════════════════╝
Server running !
    `);
});

initializeDiscord();

module.exports = app;
