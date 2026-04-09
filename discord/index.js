const discordClient = require('./client');
const { startReminderScheduler } = require('./reminders');
const { updateOperationPost } = require('./operations');
const db = require('../config/database');

discordClient.on('interactionCreate', async interaction => {
    if (!interaction.isButton()) return;

    if (!process.env.NODE_ENV) throw new Error('NODE_ENV environment variable is not set');
    const env = process.env.NODE_ENV;

    const match =
        interaction.customId.match(new RegExp(`^att_${env}_(present|tentative|absent)_(\\d+)$`)) ||
        interaction.customId.match(/^att_(present|tentative|absent)_(\d+)$/);
    if (!match) return;

    const [, status, operationIdStr] = match;
    const operationId = parseInt(operationIdStr, 10);
    const discordId   = interaction.user.id;


    try {
        await interaction.deferReply({ ephemeral: true });
    } catch (err) {
        console.error(`[ATT] deferReply failed (interaction expired?):`, err.message);
        return;
    }

    const opUrl = `${process.env.WEBSITE_URL}/operations/${operationId}`;
    const fail = async (msg, logMsg) => {
        console.error(`[ATT] FAIL — ${logMsg}`);
        try { await interaction.editReply({ content: `${msg}\n\n🔗 View operation: <${opUrl}>` }); } catch {}
    };

    let operation;
    try {
        const [operations] = await db.query('SELECT * FROM operations WHERE id = ?', [operationId]);
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

    let userId;
    try {
        const [users] = await db.query('SELECT id FROM users WHERE discord_id = ?', [discordId]);
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

    try {
        await db.query(`
            INSERT INTO operation_attendance (operation_id, user_id, status)
            VALUES (?, ?, ?)
            ON DUPLICATE KEY UPDATE status = ?, updated_at = NOW()
        `, [operationId, userId, status, status]);
    } catch (err) {
        return fail('Something went wrong saving your attendance. Please try on the website instead.', `INSERT threw: ${err.message}`);
    }

    try {
        await updateOperationPost(discordClient, operation);
    } catch (err) {
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
        if (process.env.DISCORD_ENABLE_REMINDERS === 'true') {
            startReminderScheduler(discordClient);
        }
    });
}

module.exports = {
    discordClient,
    initializeDiscord
};
