const discordClient = require('./client');
const { startReminderScheduler } = require('./reminders');

function initializeDiscord() {
    // Wait for bot to be ready before starting schedulers
    discordClient.once('ready', () => {
        console.log('🤖 Discord bot ready - Initializing notification system...');
        
        if (process.env.DISCORD_ENABLE_REMINDERS === 'true') {
            startReminderScheduler(discordClient);
        } else {
            console.log('ℹ️  Operation reminders disabled (set DISCORD_ENABLE_REMINDERS=true to enable)');
        }
    });
}

module.exports = {
    discordClient,
    initializeDiscord
};
