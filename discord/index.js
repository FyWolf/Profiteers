// Discord Integration Initialization
// Import this in server.js to enable Discord notifications

const discordClient = require('./client');
const { startReminderScheduler } = require('./reminders');

// Initialize Discord integration
function initializeDiscord() {
    // Wait for bot to be ready before starting schedulers
    discordClient.once('ready', () => {
        console.log('🤖 Discord bot ready - Initializing notification system...');
        
        // Start operation reminder scheduler
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
