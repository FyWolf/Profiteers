// Discord LOA Notifications
// Handles leave of absence notifications with superior pings

const { EmbedBuilder } = require('discord.js');
const db = require('../config/database');

/**
 * Send LOA notification to Discord
 */
async function sendLOANotification(client, loa, user, superior, action = 'submitted') {
    try {
        const channelId = process.env.DISCORD_LOA_CHANNEL_ID;
        if (!channelId) {
            console.warn('⚠️  DISCORD_LOA_CHANNEL_ID not set');
            return null;
        }

        const channel = await client.channels.fetch(channelId);
        if (!channel) {
            console.error('❌ LOA channel not found');
            return null;
        }

        // Calculate duration
        const startDate = new Date(loa.start_date);
        const endDate = new Date(loa.end_date);
        const durationMs = endDate - startDate;
        const days = Math.floor(durationMs / (1000 * 60 * 60 * 24));
        const hours = Math.floor((durationMs % (1000 * 60 * 60 * 24)) / (1000 * 60 * 60));
        
        let durationText = '';
        if (days > 0) durationText += `${days} day${days > 1 ? 's' : ''}`;
        if (hours > 0) {
            if (durationText) durationText += ' ';
            durationText += `${hours} hour${hours > 1 ? 's' : ''}`;
        }
        if (!durationText) durationText = 'Less than 1 hour';

        // Determine action title and color
        let title = '🛑 Leave of Absence Submitted';
        let color = 0xE74C3C; // Red
        
        if (action === 'updated') {
            title = '✏️ Leave of Absence Updated';
            color = 0xF39C12; // Orange
        } else if (action === 'deleted') {
            title = '🗑️ Leave of Absence Cancelled';
            color = 0x95A5A6; // Gray
        }

        // Create embed
        const embed = new EmbedBuilder()
            .setTitle(title)
            .setColor(color)
            .addFields(
                {
                    name: '👤 Player',
                    value: user.discord_global_name || user.username,
                    inline: true
                },
                {
                    name: '⏱️ Duration',
                    value: durationText,
                    inline: true
                },
                {
                    name: '\u200B',
                    value: '\u200B',
                    inline: true
                },
                {
                    name: '📅 Start',
                    value: `<t:${Math.floor(startDate.getTime() / 1000)}:F>`,
                    inline: false
                },
                {
                    name: '📅 End',
                    value: `<t:${Math.floor(endDate.getTime() / 1000)}:F>`,
                    inline: false
                }
            )
            .setTimestamp()
            .setFooter({ text: 'Profiteers PMC' });

        // Add superior if selected
        if (superior) {
            embed.addFields({
                name: '👥 Superior Notified',
                value: superior.discord_global_name || superior.username,
                inline: false
            });
        }

        // Build message content with ping
        let content = null;
        if (superior && superior.discord_id && action === 'submitted') {
            content = `<@${superior.discord_id}>`;
        }

        const message = await channel.send({
            content: content,
            embeds: [embed]
        });

        console.log(`✅ Sent LOA ${action} notification for: ${user.username}`);
        return message;

    } catch (error) {
        console.error('❌ Error sending LOA notification:', error);
        return null;
    }
}

/**
 * Send LOA expiring reminder
 */
async function sendLOAExpiringReminder(client, loa, user) {
    try {
        const channelId = process.env.DISCORD_LOA_CHANNEL_ID;
        if (!channelId) return null;

        const channel = await client.channels.fetch(channelId);
        if (!channel) return null;

        const endDate = new Date(loa.end_date);

        const embed = new EmbedBuilder()
            .setTitle('🔔 Leave of Absence Ending Soon')
            .setDescription(`${user.discord_global_name || user.username}'s leave is ending soon.`)
            .setColor(0x3498DB) // Blue
            .addFields(
                {
                    name: '📅 Return Date',
                    value: `<t:${Math.floor(endDate.getTime() / 1000)}:R>`,
                    inline: false
                }
            )
            .setTimestamp();

        // Ping the user if we have their Discord ID
        let content = null;
        if (user.discord_id) {
            content = `<@${user.discord_id}>`;
        }

        const message = await channel.send({
            content: content,
            embeds: [embed]
        });

        console.log(`✅ Sent LOA expiring reminder for: ${user.username}`);
        return message;

    } catch (error) {
        console.error('❌ Error sending LOA expiring reminder:', error);
        return null;
    }
}

module.exports = {
    sendLOANotification,
    sendLOAExpiringReminder
};
