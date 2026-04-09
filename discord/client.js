const { Client, GatewayIntentBits, EmbedBuilder, AttachmentBuilder } = require('discord.js');

const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent
    ]
});

client.once('ready', () => {
    console.log(`Discord bot logged in as ${client.user.tag}`);
});

client.on('error', error => {
    console.error('Discord client error:', error);
});

if (process.env.DISCORD_BOT_TOKEN) {
    client.login(process.env.DISCORD_BOT_TOKEN)
        .catch(error => {
            console.error('Failed to login to Discord:', error);
        });
} else {
    console.warn('DISCORD_BOT_TOKEN not set - Discord notifications disabled');
}

module.exports = client;
