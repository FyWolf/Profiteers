// Discord Operation Reminders
// Scheduled task to send operation reminders

const cron = require('node-cron');
const db = require('../config/database');
const { sendOperationReminder } = require('./operations');

let reminderTask = null;
let sentReminders = new Set(); // Track sent reminders to avoid duplicates

/**
 * Start the reminder scheduler
 */
function startReminderScheduler(client) {
    // Run every 5 minutes
    reminderTask = cron.schedule('*/5 * * * *', async () => {
        try {
            await checkUpcomingOperations(client);
        } catch (error) {
            console.error('❌ Error in reminder scheduler:', error);
        }
    });

    console.log('✅ Operation reminder scheduler started (runs every 5 minutes)');
}

/**
 * Stop the reminder scheduler
 */
function stopReminderScheduler() {
    if (reminderTask) {
        reminderTask.stop();
        console.log('⏹️  Operation reminder scheduler stopped');
    }
}

/**
 * Check for upcoming operations and send reminders
 */
async function checkUpcomingOperations(client) {
    const now = Math.floor(Date.now() / 1000); // Current unix timestamp
    const oneHourLater = now + (65 * 60); // 65 minutes from now
    const fifteenMinLater = now + (20 * 60); // 20 minutes from now

    try {
        // Get published operations with forum threads in the next 1 hour and 5 minutes
        const [operations] = await db.query(`
            SELECT * FROM operations
            WHERE is_published = TRUE
              AND discord_thread_id IS NOT NULL
              AND start_timestamp BETWEEN ? AND ?
            ORDER BY start_timestamp ASC
        `, [now, oneHourLater]);

        for (const operation of operations) {
            const timeUntilStart = operation.start_timestamp - now;
            const minutesUntil = Math.floor(timeUntilStart / 60);

            // 1 hour reminder (send between 55-65 minutes before)
            if (minutesUntil >= 55 && minutesUntil <= 65) {
                const reminderKey = `${operation.id}-1h`;
                if (!sentReminders.has(reminderKey)) {
                    await sendOperationReminder(client, operation, 'in 1 hour');
                    sentReminders.add(reminderKey);
                    
                    // Clean up old reminders from set
                    if (sentReminders.size > 1000) {
                        sentReminders.clear();
                    }
                }
            }

            // 15 minute reminder (send between 10-20 minutes before)
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

/**
 * Clear reminder cache (useful for testing)
 */
function clearReminderCache() {
    sentReminders.clear();
    console.log('🗑️  Reminder cache cleared');
}

module.exports = {
    startReminderScheduler,
    stopReminderScheduler,
    clearReminderCache
};
