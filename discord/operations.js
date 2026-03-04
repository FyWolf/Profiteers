// Discord Operation Notifications
// Handles forum posts, updates, and reminders for operations

const { EmbedBuilder, AttachmentBuilder, ChannelType } = require('discord.js');
const db = require('../config/database');

/**
 * Convert HTML content to Discord-friendly markdown
 */
function htmlToMarkdown(html) {
    if (!html) return '';
    
    let text = html;
    
    // Convert common HTML tags to markdown
    text = text.replace(/<br\s*\/?>/gi, '\n');
    text = text.replace(/<\/p>/gi, '\n\n');
    text = text.replace(/<p[^>]*>/gi, '');
    
    // Bold
    text = text.replace(/<strong[^>]*>(.*?)<\/strong>/gi, '**$1**');
    text = text.replace(/<b[^>]*>(.*?)<\/b>/gi, '**$1**');
    
    // Italic
    text = text.replace(/<em[^>]*>(.*?)<\/em>/gi, '*$1*');
    text = text.replace(/<i[^>]*>(.*?)<\/i>/gi, '*$1*');
    
    // Underline (Discord uses __ for underline)
    text = text.replace(/<u[^>]*>(.*?)<\/u>/gi, '__$1__');
    
    // Strikethrough
    text = text.replace(/<s[^>]*>(.*?)<\/s>/gi, '~~$1~~');
    text = text.replace(/<strike[^>]*>(.*?)<\/strike>/gi, '~~$1~~');
    text = text.replace(/<del[^>]*>(.*?)<\/del>/gi, '~~$1~~');
    
    // Links
    text = text.replace(/<a[^>]*href=["']([^"']*)["'][^>]*>(.*?)<\/a>/gi, '[$2]($1)');
    
    // Headers
    text = text.replace(/<h1[^>]*>(.*?)<\/h1>/gi, '**$1**\n');
    text = text.replace(/<h2[^>]*>(.*?)<\/h2>/gi, '**$1**\n');
    text = text.replace(/<h3[^>]*>(.*?)<\/h3>/gi, '**$1**\n');
    
    // Lists
    text = text.replace(/<li[^>]*>(.*?)<\/li>/gi, '• $1\n');
    text = text.replace(/<\/ul>/gi, '\n');
    text = text.replace(/<ul[^>]*>/gi, '');
    text = text.replace(/<\/ol>/gi, '\n');
    text = text.replace(/<ol[^>]*>/gi, '');
    
    // Code blocks
    text = text.replace(/<code[^>]*>(.*?)<\/code>/gi, '`$1`');
    text = text.replace(/<pre[^>]*>(.*?)<\/pre>/gi, '```\n$1\n```');
    
    // Remove any remaining HTML tags
    text = text.replace(/<[^>]*>/g, '');
    
    // Decode common HTML entities
    text = text.replace(/&nbsp;/g, ' ');
    text = text.replace(/&amp;/g, '&');
    text = text.replace(/&lt;/g, '<');
    text = text.replace(/&gt;/g, '>');
    text = text.replace(/&quot;/g, '"');
    text = text.replace(/&#39;/g, "'");
    text = text.replace(/&apos;/g, "'");
    
    // Clean up excessive newlines
    text = text.replace(/\n{3,}/g, '\n\n');
    text = text.trim();
    
    // Limit length for Discord (2000 char limit for embed description)
    if (text.length > 1900) {
        text = text.substring(0, 1897) + '...';
    }
    
    return text;
}

/**
 * Create or update operation forum post
 */
async function createOperationPost(client, operation) {
    try {
        const forumChannelId = process.env.DISCORD_OPERATIONS_FORUM_ID;
        if (!forumChannelId) {
            console.warn('⚠️  DISCORD_OPERATIONS_FORUM_ID not set');
            return null;
        }

        const forumChannel = await client.channels.fetch(forumChannelId);
        if (!forumChannel || forumChannel.type !== ChannelType.GuildForum) {
            console.error('❌ Operations forum channel not found or not a forum');
            return null;
        }

        // Get attendance counts
        const [attendance] = await db.query(`
            SELECT status, COUNT(*) as count
            FROM operation_attendance
            WHERE operation_id = ?
            GROUP BY status
        `, [operation.id]);

        const counts = { present: 0, tentative: 0, absent: 0 };
        attendance.forEach(a => counts[a.status] = a.count);

        // Clean description from HTML
        const cleanDescription = htmlToMarkdown(operation.description) || 'No description provided.';

        // Create embed
        const embed = new EmbedBuilder()
            .setTitle(operation.title)
            .setDescription(cleanDescription)
            .setColor(0x6B8E23) // Olive green
            .addFields(
                {
                    name: '📅 Date & Time',
                    value: `<t:${operation.start_timestamp}:F>`,
                    inline: false
                },
                {
                    name: '⏰ Duration',
                    value: `<t:${operation.start_timestamp}:t> - <t:${operation.end_timestamp}:t>`,
                    inline: false
                },
                {
                    name: '👥 Attendance',
                    value: `✅ Present: ${counts.present}\n❔ Tentative: ${counts.tentative}\n❌ Absent: ${counts.absent}`,
                    inline: true
                },
                {
                    name: '🔗 View Online',
                    value: `[Operation Page](${process.env.WEBSITE_URL}/operations/${operation.id})`,
                    inline: true
                }
            )
            .setTimestamp()
            .setFooter({ text: 'Profiteers PMC' });

        // Add banner if available
        if (operation.banner_url && !operation.banner_url.startsWith('/')) {
            embed.setImage(operation.banner_url);
        } else if (operation.banner_url) {
            embed.setImage(`${process.env.WEBSITE_URL}${operation.banner_url}`);
        }

        // Create forum thread with just the title (no initial message content)
        const thread = await forumChannel.threads.create({
            name: operation.title,
            message: {
                content: '📋 **Operation Details**'
            }
        });

        // Now post the embed as the second message (first real message)
        const embedMessage = await thread.send({ embeds: [embed] });

        // Send role ping based on operation type
        const mainOpsRoleId = process.env.DISCORD_MAIN_OPS_ROLE_ID || '1176606401850773546';
        const sideOpsRoleId = process.env.DISCORD_SIDE_OPS_ROLE_ID || '1252355020012257301';
        
        const roleId = operation.operation_type === 'side' ? sideOpsRoleId : mainOpsRoleId;
        const opType = operation.operation_type === 'side' ? 'Side Operation' : 'Main Operation';
        
        await thread.send({
            content: `<@&${roleId}> **New ${opType} Posted!**\nCheck the details above and mark your attendance on the website.`
        });

        // Store both thread ID and the embed message ID
        await db.query(`
            UPDATE operations 
            SET discord_forum_post_id = ?, discord_thread_id = ?, discord_message_id = ?
            WHERE id = ?
        `, [thread.id, thread.id, embedMessage.id, operation.id]);

        console.log(`✅ Created forum post for operation: ${operation.title} (${opType})`);
        return { thread, embedMessage };

    } catch (error) {
        console.error('❌ Error creating operation forum post:', error);
        return null;
    }
}

/**
 * Update existing operation forum post
 */
async function updateOperationPost(client, operation) {
    try {
        // Check if we have the message ID
        if (!operation.discord_message_id) {
            console.log('ℹ️  Operation has no Discord message ID, creating new post...');
            return await createOperationPost(client, operation);
        }

        // Fetch the thread
        const thread = await client.channels.fetch(operation.discord_thread_id);
        if (!thread) {
            console.warn('⚠️  Thread not found, creating new post...');
            return await createOperationPost(client, operation);
        }

        // Fetch the specific embed message
        const embedMessage = await thread.messages.fetch(operation.discord_message_id);
        if (!embedMessage) {
            console.warn('⚠️  Embed message not found, creating new post...');
            return await createOperationPost(client, operation);
        }

        // Get updated attendance
        const [attendance] = await db.query(`
            SELECT status, COUNT(*) as count
            FROM operation_attendance
            WHERE operation_id = ?
            GROUP BY status
        `, [operation.id]);

        const counts = { present: 0, tentative: 0, absent: 0 };
        attendance.forEach(a => counts[a.status] = a.count);

        // Clean description from HTML
        const cleanDescription = htmlToMarkdown(operation.description) || 'No description provided.';

        // Update embed
        const embed = new EmbedBuilder()
            .setTitle(operation.title)
            .setDescription(cleanDescription)
            .setColor(0x6B8E23)
            .addFields(
                {
                    name: '📅 Date & Time',
                    value: `<t:${operation.start_timestamp}:F>`,
                    inline: false
                },
                {
                    name: '⏰ Duration',
                    value: `<t:${operation.start_timestamp}:t> - <t:${operation.end_timestamp}:t>`,
                    inline: false
                },
                {
                    name: '👥 Attendance',
                    value: `✅ Present: ${counts.present}\n❔ Tentative: ${counts.tentative}\n❌ Absent: ${counts.absent}`,
                    inline: true
                },
                {
                    name: '🔗 View Online',
                    value: `[Operation Page](${process.env.WEBSITE_URL}/operations/${operation.id})`,
                    inline: true
                }
            )
            .setTimestamp()
            .setFooter({ text: 'Profiteers PMC • Updated' });

        if (operation.banner_url && !operation.banner_url.startsWith('/')) {
            embed.setImage(operation.banner_url);
        } else if (operation.banner_url) {
            embed.setImage(`${process.env.WEBSITE_URL}${operation.banner_url}`);
        }

        // Edit the specific message
        await embedMessage.edit({ embeds: [embed] });
        console.log(`✅ Updated forum post for operation: ${operation.title}`);

        return thread;

    } catch (error) {
        console.error('❌ Error updating operation forum post:', error);
        return null;
    }
}

/**
 * Post news update to operation thread
 */
async function postOperationNews(client, operation, newsContent, author) {
    try {
        if (!operation.discord_thread_id) {
            console.warn('⚠️  Operation has no forum thread');
            return null;
        }

        const thread = await client.channels.fetch(operation.discord_thread_id);
        if (!thread) {
            console.warn('⚠️  Thread not found');
            return null;
        }

        // Convert HTML to clean markdown
        const cleanContent = htmlToMarkdown(newsContent);

        const embed = new EmbedBuilder()
            .setTitle('📰 Operation Update')
            .setDescription(cleanContent)
            .setColor(0x3498DB) // Blue
            .setTimestamp()
            .setFooter({ text: `Posted by ${author}` });

        const message = await thread.send({ embeds: [embed] });
        console.log(`✅ Posted news to operation thread: ${operation.title}`);

        return message;

    } catch (error) {
        console.error('❌ Error posting operation news:', error);
        return null;
    }
}

/**
 * Send operation reminder
 */
async function sendOperationReminder(client, operation, timeUntil) {
    try {
        if (!operation.discord_thread_id) {
            console.warn('⚠️  Operation has no forum thread');
            return null;
        }

        const thread = await client.channels.fetch(operation.discord_thread_id);
        if (!thread) {
            console.warn('⚠️  Thread not found');
            return null;
        }
        // Send role ping based on operation type
        const mainOpsRoleId = process.env.DISCORD_MAIN_OPS_ROLE_ID || '1176606401850773546';
        const sideOpsRoleId = process.env.DISCORD_SIDE_OPS_ROLE_ID || '1252355020012257301';
        
        const roleId = operation.operation_type === 'side' ? sideOpsRoleId : mainOpsRoleId;

        const embed = new EmbedBuilder()
            .setTitle(`⏰ Operation Starting ${timeUntil}!`)
            .setDescription(`**${operation.title}** is starting soon!`)
            .setColor(0xF39C12) // Orange
            .addFields(
                {
                    name: '🕐 Start Time',
                    value: `<t:${operation.start_timestamp}:R>`,
                    inline: false
                },
                {
                    name: '🔗 Join Now',
                    value: `[View Operation](${process.env.WEBSITE_URL}/operations/${operation.id})`,
                    inline: false
                }
            )
            .setTimestamp();

        const message = await thread.send({
            content: `<@&${roleId}>`,
            embeds: [embed]
        });

        console.log(`✅ Sent ${timeUntil} reminder for: ${operation.title}`);
        return message;

    } catch (error) {
        console.error('❌ Error sending operation reminder:', error);
        return null;
    }
}

module.exports = {
    createOperationPost,
    updateOperationPost,
    postOperationNews,
    sendOperationReminder
};
