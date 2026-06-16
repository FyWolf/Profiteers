const { EmbedBuilder } = require('discord.js');
const client = require('./client');

// Posts a congratulations message to DISCORD_REWARDS_CHANNEL_ID when a member
// reaches an attendance milestone and is newly granted role(s). Best-effort:
// failures are logged, never thrown. Only the member is pinged — role mentions
// render as names without notifying everyone in those roles.
async function sendRewardCongrats({ discordUserId, ruleName, threshold, awardedRoleIds }) {
    try {
        const channelId = process.env.DISCORD_REWARDS_CHANNEL_ID;
        if (!channelId) {
            console.warn('DISCORD_REWARDS_CHANNEL_ID not set — skipping reward notification');
            return null;
        }

        const channel = await client.channels.fetch(channelId);
        if (!channel) {
            console.error('[REWARDS] notification channel not found');
            return null;
        }

        const roleMentions = (awardedRoleIds || []).map(id => `<@&${id}>`).join(' ');
        const plural = Number(threshold) === 1 ? '' : 's';

        const embed = new EmbedBuilder()
            .setTitle('🎖️ Attendance Milestone Reached!')
            .setColor(0x6b8e23)
            .setDescription(
                `<@${discordUserId}> has reached **${threshold}** confirmed attendance${plural}` +
                (roleMentions ? ` and has been awarded ${roleMentions}!` : '!')
            )
            .setFooter({ text: ruleName })
            .setTimestamp();

        return await channel.send({
            content: `Congratulations <@${discordUserId}>! 🎉`,
            embeds: [embed],
            // Ping only the member; do not mass-ping the awarded roles.
            allowedMentions: { users: [discordUserId], roles: [] }
        });
    } catch (error) {
        console.error('[REWARDS] Failed to send congrats notification:', error.message);
        return null;
    }
}

module.exports = { sendRewardCongrats };
