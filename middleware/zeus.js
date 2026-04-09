const db = require('../config/database');
const axios = require('axios');

const ZEUS_ROLE_ID = process.env.DISCORD_ZEUS_ROLE_ID;
const GUILD_ID = process.env.DISCORD_GUILD_ID;

async function isZeus(req, res, next) {
    if (!req.isAuthenticated()) {
        return res.redirect('/login');
    }

    try {
        if (Array.isArray(req.user.permissions) && req.user.permissions.includes('operations.create')) {
            return next();
        }

        const [users] = await db.query('SELECT discord_id FROM users WHERE id = ?', [req.user.id]);
        
        if (users.length === 0 || !users[0].discord_id) {
            return res.status(403).render('error', {
                title: 'Access Denied',
                message: 'Zeus Permissions Required',
                description: 'You need Zeus permissions to access this page. Only Zeus role holders and admins can manage operations.',
                user: res.locals.user
            });
        }

        const discordId = users[0].discord_id;

        const [cachedPerms] = await db.query(
            'SELECT has_zeus_role, last_synced FROM zeus_permissions WHERE user_id = ?',
            [req.user.id]
        );

        if (cachedPerms.length > 0) {
            const cacheAge = Date.now() - new Date(cachedPerms[0].last_synced).getTime();
            if (cacheAge < 3600000 && cachedPerms[0].has_zeus_role) {
                return next();
            }
        }

        const botToken = process.env.DISCORD_BOT_TOKEN;
        if (!botToken) {
            console.error('DISCORD_BOT_TOKEN not set');
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

        await db.query(`
            INSERT INTO zeus_permissions (user_id, has_zeus_role)
            VALUES (?, ?)
            ON DUPLICATE KEY UPDATE has_zeus_role = ?, last_synced = NOW()
        `, [req.user.id, hasZeusRole, hasZeusRole]);

        if (hasZeusRole) {
            return next();
        }

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

async function checkZeusStatus(userId) {
    try {
        const [users] = await db.query('SELECT discord_id FROM users WHERE id = ?', [userId]);

        if (users.length === 0) return false;

        const [perms] = await db.query(`
            SELECT 1
            FROM user_roles ur
            JOIN role_permissions rp ON ur.role_id = rp.role_id
            JOIN permissions p ON rp.permission_id = p.id
            WHERE ur.user_id = ? AND p.name = 'operations.create'
            LIMIT 1
        `, [userId]);
        if (perms.length > 0) return true;

        if (!users[0].discord_id) return false;

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
