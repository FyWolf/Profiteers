const passport = require('passport');
const DiscordStrategy = require('passport-discord').Strategy;
const axios = require('axios');
const db = require('./database');

const DISCORD_CONFIG = {
    clientID: process.env.DISCORD_CLIENT_ID,
    clientSecret: process.env.DISCORD_CLIENT_SECRET,
    callbackURL: process.env.DISCORD_CALLBACK_URL,
    scope: ['identify'],
    requiredGuildId: process.env.DISCORD_GUILD_ID,
    requiredRoles: (process.env.DISCORD_REQUIRED_ROLE_IDS || '').split(',').filter(Boolean),
    botToken: process.env.DISCORD_BOT_TOKEN
};

passport.serializeUser((user, done) => {
    done(null, user.id);
});

passport.deserializeUser(async (id, done) => {
    try {
        const [users] = await db.query('SELECT * FROM users WHERE id = ?', [id]);
        if (users.length > 0) {
            const user = users[0];
            // Load RBAC permissions for this user
            const [perms] = await db.query(`
                SELECT DISTINCT p.name
                FROM user_roles ur
                JOIN role_permissions rp ON ur.role_id = rp.role_id
                JOIN permissions p ON rp.permission_id = p.id
                WHERE ur.user_id = ?
            `, [user.id]);
            user.permissions = perms.map(p => p.name);
            done(null, user);
        } else {
            done(null, false);
        }
    } catch (error) {
        done(error, null);
    }
});

async function checkUserAccess(discordUserId, guildId, requiredRoles, botToken) {
    if (!botToken) {
        console.error('Discord bot token not configured - authentication will fail');
        console.error('   Add DISCORD_BOT_TOKEN to your .env file');
        return { inGuild: false, hasRole: false, error: 'Bot token not configured' };
    }

    try {
        const response = await axios.get(
            `https://discord.com/api/v10/guilds/${guildId}/members/${discordUserId}`,
            {
                headers: {
                    Authorization: `Bot ${botToken}`
                }
            }
        );
        
        const member = response.data;
        const userRoles = member.roles || [];
        
        const hasRole = requiredRoles.some(roleId => userRoles.includes(roleId));
        
        if (!hasRole) {
            console.log(`User missing required roles`);
            console.log(`   Has: ${userRoles.join(', ') || 'none'}`);
            console.log(`   Needs one of: ${requiredRoles.join(', ')}`);
        }
        
        return { 
            inGuild: true, 
            hasRole: hasRole,
            roles: userRoles 
        };
    } catch (error) {
        const status = error.response?.status;
        
        if (status === 404) {
            console.log(`User ${discordUserId} not in guild ${guildId}`);
            return { inGuild: false, hasRole: false, error: 'Not in guild' };
        } else if (status === 403) {
            console.error('Bot missing SERVER MEMBERS INTENT permission!');
            console.error('   Enable it in Discord Developer Portal → Bot');
            return { inGuild: false, hasRole: false, error: 'Bot permission denied' };
        } else if (status === 401) {
            console.error('Invalid bot token!');
            console.error('   Check DISCORD_BOT_TOKEN in .env');
            return { inGuild: false, hasRole: false, error: 'Invalid bot token' };
        } else {
            console.error('Error checking user access:', status, error.message);
            return { inGuild: false, hasRole: false, error: 'API error' };
        }
    }
}

if (!DISCORD_CONFIG.clientID || !DISCORD_CONFIG.clientSecret || !DISCORD_CONFIG.callbackURL) {
    throw new Error(
        'Missing required Discord OAuth2 environment variables.\n' +
        'Ensure DISCORD_CLIENT_ID, DISCORD_CLIENT_SECRET, and DISCORD_CALLBACK_URL are set.'
    );
}

if (!DISCORD_CONFIG.requiredGuildId) {
    throw new Error(
        'Missing DISCORD_GUILD_ID environment variable.\n' +
        'This is required for guild membership checks during authentication.'
    );
}

if (DISCORD_CONFIG.requiredRoles.length === 0) {
    console.warn('Warning: DISCORD_REQUIRED_ROLE_IDS is not set. No role checks will be enforced during login.');
}

passport.use(new DiscordStrategy({
    clientID: DISCORD_CONFIG.clientID,
    clientSecret: DISCORD_CONFIG.clientSecret,
    callbackURL: DISCORD_CONFIG.callbackURL,
    scope: DISCORD_CONFIG.scope
}, async (accessToken, refreshToken, profile, done) => {
    try {
        console.log(`\nDiscord login attempt: ${profile.username}#${profile.discriminator} (${profile.id})`);
        
        const access = await checkUserAccess(
            profile.id, 
            DISCORD_CONFIG.requiredGuildId, 
            DISCORD_CONFIG.requiredRoles,
            DISCORD_CONFIG.botToken
        );
        
        if (!access.inGuild) {
            console.log(`Access denied: Not in guild\n`);
            return done(null, false, { 
                message: 'You must be a member of the Profiteers PMC Discord server to register.' 
            });
        }

        if (!access.hasRole) {
            console.log(`Access denied: Missing required role\n`);
            return done(null, false, { 
                message: 'You must have the required role in the Profiteers PMC Discord server to register.' 
            });
        }

        const [existingUsers] = await db.query(
            'SELECT * FROM users WHERE discord_id = ?',
            [profile.id]
        );

        let userId;

        if (existingUsers.length > 0) {
            const user = existingUsers[0];
            userId = user.id;
            
            const newUsername = user.username?.startsWith('@') ? user.username : `@${profile.username}`;
            
            await db.query(
                `UPDATE users SET 
                    username = ?,
                    discord_username = ?,
                    discord_global_name = ?,
                    discord_avatar = ?,
                    discord_access_token = ?,
                    discord_refresh_token = ?,
                    auth_type = 'discord',
                    last_login = NOW()
                WHERE id = ?`,
                [
                    newUsername,
                    profile.username,
                    profile.global_name || profile.username,
                    profile.avatar,
                    accessToken,
                    refreshToken,
                    user.id
                ]
            );
            
        } else {
            const displayName = profile.global_name || profile.username;
            const username = `@${profile.username}`;
            
            const [result] = await db.query(
                `INSERT INTO users (
                    username,
                    discord_id,
                    discord_username,
                    discord_global_name,
                    discord_avatar,
                    discord_access_token,
                    discord_refresh_token,
                    auth_type
                ) VALUES (?, ?, ?, ?, ?, ?, ?, 'discord')`,
                [
                    username,
                    profile.id,
                    profile.username,
                    profile.global_name || profile.username,
                    profile.avatar,
                    accessToken,
                    refreshToken
                ]
            );
            
            userId = result.insertId;
        }

        try {
            const [trainings] = await db.query('SELECT id, discord_role_id FROM trainings');
            
            if (trainings.length > 0 && access.roles) {
                await db.query('DELETE FROM user_trainings WHERE user_id = ?', [userId]);
                
                let syncedCount = 0;
                for (const training of trainings) {
                    if (access.roles.includes(training.discord_role_id)) {
                        await db.query(
                            'INSERT IGNORE INTO user_trainings (user_id, training_id) VALUES (?, ?)',
                            [userId, training.id]
                        );
                        syncedCount++;
                    }
                }
                
                console.log(`Synced ${syncedCount} training(s)`);
            }
        } catch (syncError) {
            console.error('Error syncing trainings:', syncError.message);
        }

        const [updatedUsers] = await db.query('SELECT * FROM users WHERE id = ?', [userId]);
        return done(null, updatedUsers[0]);
    } catch (error) {
        console.error('Discord authentication error:', error);
        return done(error, null);
    }
}));

module.exports = passport;