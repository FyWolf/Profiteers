const discordClient = require('./client');
const { startReminderScheduler } = require('./reminders');
const { updateOperationPost } = require('./operations');
const db = require('../config/database');

// Register interaction handler once at module level — never inside initializeDiscord()
// so it cannot stack up on reconnects or multiple initialisation calls.
discordClient.on('interactionCreate', async interaction => {
    if (!interaction.isButton()) return;

    if (!process.env.NODE_ENV) throw new Error('NODE_ENV environment variable is not set');
    const match = interaction.customId.match(new RegExp(`^att_${process.env.NODE_ENV}_(present|tentative|absent)_(\\d+)$`));
    if (!match) return;

    const [, status, operationIdStr] = match;
    const operationId = parseInt(operationIdStr, 10);
    const discordId   = interaction.user.id;

    console.log(`[ATT] Button click: status=${status} operationId=${operationId} discordId=${discordId}`);

    try {
        await interaction.deferReply({ ephemeral: true });
    } catch (err) {
        console.error(`[ATT] deferReply failed (interaction expired?):`, err.message);
        return;
    }

    const opUrl = `${process.env.WEBSITE_URL}/operations/${operationId}`;
    const fail = async (msg, logMsg) => {
        console.error(`[ATT] FAIL — ${logMsg}`);
        try { await interaction.editReply({ content: `${msg}\n\n🔗 View operation: <${opUrl}>` }); } catch { /* expired */ }
    };

    // 1. Check the operation exists
    let operation;
    try {
        const [operations] = await db.query('SELECT * FROM operations WHERE id = ?', [operationId]);
        console.log(`[ATT] Operation lookup for id=${operationId}: found ${operations.length} row(s)`);
        if (operations.length === 0) {
            return fail(
                `This operation no longer exists. It may have been cancelled or removed.`,
                `operation ${operationId} not found in DB`
            );
        }
        operation = operations[0];
    } catch (err) {
        return fail('Something went wrong looking up the operation. Please try on the website instead.', `operation lookup threw: ${err.message}`);
    }

    // 2. Look up linked website account
    let userId;
    try {
        const [users] = await db.query('SELECT id FROM users WHERE discord_id = ?', [discordId]);
        console.log(`[ATT] User lookup for discord_id=${discordId}: found ${users.length} row(s)`);
        if (users.length === 0) {
            return fail(
                `You don't have a linked account. Sign in with Discord on the website first: <${process.env.WEBSITE_URL}>`,
                `no user found for discord_id=${discordId}`
            );
        }
        userId = users[0].id;
    } catch (err) {
        return fail('Something went wrong looking up your account. Please try on the website instead.', `user lookup threw: ${err.message}`);
    }

    // 3. Write attendance
    try {
        const [result] = await db.query(`
            INSERT INTO operation_attendance (operation_id, user_id, status)
            VALUES (?, ?, ?)
            ON DUPLICATE KEY UPDATE status = ?, updated_at = NOW()
        `, [operationId, userId, status, status]);
        console.log(`[ATT] INSERT result: affectedRows=${result.affectedRows} changedRows=${result.changedRows} operationId=${operationId} userId=${userId} status=${status}`);
    } catch (err) {
        return fail('Something went wrong saving your attendance. Please try on the website instead.', `INSERT threw: ${err.message}`);
    }

    // 4. Refresh Discord embed (non-fatal if it fails)
    try {
        await updateOperationPost(discordClient, operation);
        console.log(`[ATT] Discord embed refreshed for operation ${operationId}`);
    } catch (err) {
        // Don't fail the whole interaction just because the embed update failed
        console.error(`[ATT] updateOperationPost failed (attendance was saved):`, err.message);
    }

    const labels = { present: '✅ Present', tentative: '❔ Tentative', absent: '❌ Absent' };
    try {
        await interaction.editReply({ content: `Marked as **${labels[status]}**!` });
    } catch (err) {
        console.error(`[ATT] editReply (success) failed:`, err.message);
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
