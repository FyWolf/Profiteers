// Discord Bot Configuration
// This file sets up the Discord.js client for notifications

const { Client, GatewayIntentBits, EmbedBuilder, AttachmentBuilder } = require('discord.js');

// Create Discord client
const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent
    ]
});

// Bot ready event
client.once('ready', () => {
    console.log(`✅ Discord bot logged in as ${client.user.tag}`);
});

// Error handling
client.on('error', error => {
    console.error('Discord client error:', error);
});

// Login to Discord
if (process.env.DISCORD_BOT_TOKEN) {
    client.login(process.env.DISCORD_BOT_TOKEN)
        .catch(error => {
            console.error('❌ Failed to login to Discord:', error);
        });
} else {
    console.warn('⚠️  DISCORD_BOT_TOKEN not set - Discord notifications disabled');
}

module.exports = client;
