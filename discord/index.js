const discordClient = require('./client');
const { startReminderScheduler } = require('./reminders');
const { updateOperationPost } = require('./operations');
const db = require('../config/database');

// Register interaction handler once at module level — never inside initializeDiscord()
// so it cannot stack up on reconnects or multiple initialisation calls.
discordClient.on('interactionCreate', async interaction => {
    if (!interaction.isButton()) return;

    const match = interaction.customId.match(/^att_(present|tentative|absent)_(\d+)$/);
    if (!match) return;

    const [, status, operationIdStr] = match;
    const operationId = parseInt(operationIdStr, 10);
    const discordId   = interaction.user.id;

    try {
        await interaction.deferReply({ ephemeral: true });
    } catch {
        // Interaction already expired or acknowledged — nothing we can do
        return;
    }

    try {
        const [users] = await db.query(
            'SELECT id FROM users WHERE discord_id = ?',
            [discordId]
        );

        if (users.length === 0) {
            return interaction.editReply({
                content: `You don't have a linked account. Sign in with Discord on the website first: <${process.env.WEBSITE_URL}>`
            });
        }

        const userId = users[0].id;

        await db.query(`
            INSERT INTO operation_attendance (operation_id, user_id, status)
            VALUES (?, ?, ?)
            ON DUPLICATE KEY UPDATE status = ?, updated_at = NOW()
        `, [operationId, userId, status, status]);

        const [operations] = await db.query(
            'SELECT * FROM operations WHERE id = ?',
            [operationId]
        );

        if (operations.length > 0) {
            await updateOperationPost(discordClient, operations[0]);
        }

        const labels = { present: '✅ Present', tentative: '❔ Tentative', absent: '❌ Absent' };
        await interaction.editReply({ content: `Marked as **${labels[status]}**!` });

    } catch (error) {
        console.error('❌ Error handling attendance button:', error);
        try {
            await interaction.editReply({ content: 'Something went wrong. Please try on the website instead.' });
        } catch { /* interaction may have expired */ }
    }
});

function initializeDiscord() {
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
