const db = require('../config/database');

// ── Server join / leave ────────────────────────────────────────────────────────

async function recordMemberJoin(member) {
    try {
        const discordId   = member.id;
        const discordName = (member.displayName || member.user?.username || 'Unknown').substring(0, 100);

        // Calculate account age in days
        const createdAt    = member.user?.createdTimestamp;
        const accountAgeDays = createdAt
            ? Math.floor((Date.now() - createdAt) / 86_400_000)
            : null;

        await db.query(
            `INSERT INTO member_join_leave (discord_id, discord_name, event_type, account_age_days, occurred_at)
             VALUES (?, ?, 'join', ?, NOW())`,
            [discordId, discordName, accountAgeDays]
        );
        console.log(`[ACTIVITY] ${discordName} joined the server`);
    } catch (err) {
        console.error('[ACTIVITY] Failed to record join:', err.message);
    }
}

async function recordMemberLeave(member) {
    try {
        const discordId   = member.id;
        const discordName = (member.displayName || member.user?.username || 'Unknown').substring(0, 100);

        await db.query(
            `INSERT INTO member_join_leave (discord_id, discord_name, event_type, occurred_at)
             VALUES (?, ?, 'leave', NOW())`,
            [discordId, discordName]
        );
        console.log(`[ACTIVITY] ${discordName} left the server`);
    } catch (err) {
        console.error('[ACTIVITY] Failed to record leave:', err.message);
    }
}

// ── Message activity ───────────────────────────────────────────────────────────

async function recordMessage(message) {
    try {
        const discordId   = message.author.id;
        const discordName = (message.member?.displayName || message.author.username).substring(0, 100);
        const channelId   = message.channelId;
        const channelName = (message.channel?.name || 'unknown').substring(0, 100);

        await db.query(
            `INSERT INTO message_activity (discord_id, discord_name, channel_id, channel_name, sent_at)
             VALUES (?, ?, ?, ?, NOW())`,
            [discordId, discordName, channelId, channelName]
        );
    } catch (err) {
        console.error('[ACTIVITY] Failed to record message:', err.message);
    }
}

// ── Event registration ─────────────────────────────────────────────────────────

function registerActivityHandlers(client) {
    client.on('guildMemberAdd',    member => recordMemberJoin(member));
    client.on('guildMemberRemove', member => recordMemberLeave(member));

    client.on('messageCreate', message => {
        // Ignore bots and DMs
        if (message.author.bot || !message.guild) return;
        recordMessage(message);
    });
}

module.exports = { registerActivityHandlers };
