const cron = require('node-cron');
const db = require('../config/database');
const { sendOperationReminder } = require('./operations');

let reminderTask = null;
let sentReminders = new Set();

function startReminderScheduler(client) {
    reminderTask = cron.schedule('*/5 * * * *', async () => {
        try {
            await checkUpcomingOperations(client);
        } catch (error) {
            console.error('❌ Error in reminder scheduler:', error);
        }
    });

    console.log('✅ Operation reminder scheduler started (runs every 5 minutes)');
}

function stopReminderScheduler() {
    if (reminderTask) {
        reminderTask.stop();
        console.log('⏹️  Operation reminder scheduler stopped');
    }
}

async function checkUpcomingOperations(client) {
    const now = Math.floor(Date.now() / 1000);
    const oneHourLater = now + (65 * 60);
    const fifteenMinLater = now + (20 * 60);

    try {
        const [operations] = await db.query(`
            SELECT * FROM operations
            WHERE is_published = TRUE
              AND discord_thread_id IS NOT NULL
              AND start_time BETWEEN ? AND ?
            ORDER BY start_time ASC
        `, [now, oneHourLater]);

        for (const operation of operations) {
            const timeUntilStart = operation.start_timestamp - now;
            const minutesUntil = Math.floor(timeUntilStart / 60);

            if (minutesUntil >= 55 && minutesUntil <= 65) {
                const reminderKey = `${operation.id}-1h`;
                if (!sentReminders.has(reminderKey)) {
                    await sendOperationReminder(client, operation, 'in 1 hour');
                    sentReminders.add(reminderKey);
                    
                    if (sentReminders.size > 1000) {
                        sentReminders.clear();
                    }
                }
            }

            if (minutesUntil >= 10 && minutesUntil <= 20) {
                const reminderKey = `${operation.id}-15m`;
                if (!sentReminders.has(reminderKey)) {
                    await sendOperationReminder(client, operation, 'in 15 minutes');
                    sentReminders.add(reminderKey);
                }
            }
        }

    } catch (error) {
        console.error('❌ Error checking upcoming operations:', error);
    }
}

function clearReminderCache() {
    sentReminders.clear();
    console.log('🗑️  Reminder cache cleared');
}

module.exports = {
    startReminderScheduler,
    stopReminderScheduler,
    clearReminderCache
};
