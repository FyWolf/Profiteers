const db = require('../config/database');
const axios = require('axios');

// Zeus Discord Role ID
const ZEUS_ROLE_ID = '1413651879304495255';
const GUILD_ID = '1172956513069973596';

// Check if user has Zeus permissions (Zeus role OR admin)
async function isZeus(req, res, next) {
    if (!req.session.userId) {
        return res.redirect('/login');
    }

    try {
        // Check if user is admin (admins always have Zeus permissions)
        if (req.session.isAdmin) {
            return next();
        }

        // Get user's Discord ID
        const [users] = await db.query('SELECT discord_id FROM users WHERE id = ?', [req.session.userId]);
        
        if (users.length === 0 || !users[0].discord_id) {
            return res.status(403).render('error', {
                title: 'Access Denied',
                message: 'Zeus Permissions Required',
                description: 'You need Zeus permissions to access this page. Only Zeus role holders and admins can manage operations.',
                user: res.locals.user
            });
        }

        const discordId = users[0].discord_id;

        // Check cached Zeus permission
        const [cachedPerms] = await db.query(
            'SELECT has_zeus_role, last_synced FROM zeus_permissions WHERE user_id = ?',
            [req.session.userId]
        );

        // If cached and recent (less than 1 hour old), use cache
        if (cachedPerms.length > 0) {
            const cacheAge = Date.now() - new Date(cachedPerms[0].last_synced).getTime();
            if (cacheAge < 3600000 && cachedPerms[0].has_zeus_role) { // 1 hour
                return next();
            }
        }

        // Fetch fresh data from Discord
        const botToken = process.env.DISCORD_BOT_TOKEN;
        if (!botToken) {
            console.error('❌ DISCORD_BOT_TOKEN not set');
            return res.status(500).render('error', {
                title: 'Configuration Error',
                message: 'Bot Token Not Configured',
                description: 'Discord bot token is not configured. Please contact an administrator.',
                user: res.locals.user
            });
        }

        const response = await axios.get(
            `https://discord.com/api/v10/guilds/${GUILD_ID}/members/${discordId}`,
            {
                headers: {
                    Authorization: `Bot ${botToken}`
                }
            }
        );

        const userRoles = response.data.roles || [];
        const hasZeusRole = userRoles.includes(ZEUS_ROLE_ID);

        // Update cache
        await db.query(`
            INSERT INTO zeus_permissions (user_id, has_zeus_role)
            VALUES (?, ?)
            ON DUPLICATE KEY UPDATE has_zeus_role = ?, last_synced = NOW()
        `, [req.session.userId, hasZeusRole, hasZeusRole]);

        if (hasZeusRole) {
            return next();
        }

        // Access denied
        return res.status(403).render('error', {
            title: 'Access Denied',
            message: 'Zeus Permissions Required',
            description: 'You need the Zeus role in Discord or admin permissions to access this page.',
            user: res.locals.user
        });

    } catch (error) {
        console.error('Error checking Zeus permissions:', error);
        return res.status(500).render('error', {
            title: 'Error',
            message: 'Permission Check Failed',
            description: 'Could not verify your permissions. Please try again.',
            user: res.locals.user
        });
    }
}

// Helper function to check Zeus status without blocking
async function checkZeusStatus(userId) {
    try {
        const [users] = await db.query('SELECT is_admin, discord_id FROM users WHERE id = ?', [userId]);
        
        if (users.length === 0) return false;
        if (users[0].is_admin) return true;
        if (!users[0].discord_id) return false;

        // Check cache
        const [cachedPerms] = await db.query(
            'SELECT has_zeus_role FROM zeus_permissions WHERE user_id = ?',
            [userId]
        );

        if (cachedPerms.length > 0) {
            return cachedPerms[0].has_zeus_role;
        }

        return false;
    } catch (error) {
        console.error('Error checking Zeus status:', error);
        return false;
    }
}

module.exports = {
    isZeus,
    checkZeusStatus,
    ZEUS_ROLE_ID
};
