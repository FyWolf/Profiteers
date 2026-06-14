const { EmbedBuilder } = require('discord.js');

// Announces a newly opened leadership feedback round in the configured channel.
// Pings DISCORD_FEEDBACK_PING_ROLE_ID if set; otherwise posts without a mention
// to avoid an accidental mass ping.
async function announceFeedbackRound(client, cycle) {
    try {
        const channelId = process.env.DISCORD_FEEDBACK_CHANNEL_ID;
        if (!channelId) {
            console.warn('DISCORD_FEEDBACK_CHANNEL_ID not set');
            return null;
        }

        const channel = await client.channels.fetch(channelId);
        if (!channel) {
            console.error('Feedback channel not found');
            return null;
        }

        const url = `${process.env.WEBSITE_URL || ''}/feedback`;

        const embed = new EmbedBuilder()
            .setTitle(`📋 Leadership Feedback — ${cycle.title}`)
            .setColor(0xfcb00d)
            .setDescription(
                'A new leadership feedback round is open!\n\n' +
                'The recipients of this feedback will use this to improve their leadership. ' +
                'Honest feedback is crucial for leadership development.\n\n' +
                `🔗 **Fill it out here:** ${url}\n\n` +
                'Your responses are anonymous and will be used for self improvement. Leaders only ever see the combined, ' +
                'summarised results — never who said what.'
            )
            .setFooter({ text: 'Profiteers PMC' })
            .setTimestamp();

        const roleId = process.env.DISCORD_FEEDBACK_PING_ROLE_ID;
        const content = roleId ? `<@&${roleId}>` : null;

        return await channel.send({ content, embeds: [embed] });
    } catch (error) {
        console.error('Error sending feedback announcement:', error);
        return null;
    }
}

module.exports = { announceFeedbackRound };
