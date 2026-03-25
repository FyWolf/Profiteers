const { EmbedBuilder, AttachmentBuilder, ChannelType } = require('discord.js');
const fs = require('fs');
const path = require('path');
const db = require('../config/database');

function htmlToMarkdown(html) {
    if (!html) return '';
    
    let text = html;
    
    text = text.replace(/<br\s*\/?>/gi, '\n');
    text = text.replace(/<\/p>/gi, '\n\n');
    text = text.replace(/<p[^>]*>/gi, '');
    
    text = text.replace(/<strong[^>]*>(.*?)<\/strong>/gi, '**$1**');
    text = text.replace(/<b[^>]*>(.*?)<\/b>/gi, '**$1**');
    
    text = text.replace(/<em[^>]*>(.*?)<\/em>/gi, '*$1*');
    text = text.replace(/<i[^>]*>(.*?)<\/i>/gi, '*$1*');
    
    // Underline (Discord uses __ for underline)
    text = text.replace(/<u[^>]*>(.*?)<\/u>/gi, '__$1__');
    
    text = text.replace(/<s[^>]*>(.*?)<\/s>/gi, '~~$1~~');
    text = text.replace(/<strike[^>]*>(.*?)<\/strike>/gi, '~~$1~~');
    text = text.replace(/<del[^>]*>(.*?)<\/del>/gi, '~~$1~~');
    
    text = text.replace(/<a[^>]*href=["']([^"']*)["'][^>]*>(.*?)<\/a>/gi, '[$2]($1)');
    
    text = text.replace(/<h1[^>]*>(.*?)<\/h1>/gi, '**$1**\n');
    text = text.replace(/<h2[^>]*>(.*?)<\/h2>/gi, '**$1**\n');
    text = text.replace(/<h3[^>]*>(.*?)<\/h3>/gi, '**$1**\n');
    
    text = text.replace(/<li[^>]*>(.*?)<\/li>/gi, '• $1\n');
    text = text.replace(/<\/ul>/gi, '\n');
    text = text.replace(/<ul[^>]*>/gi, '');
    text = text.replace(/<\/ol>/gi, '\n');
    text = text.replace(/<ol[^>]*>/gi, '');
    
    text = text.replace(/<code[^>]*>(.*?)<\/code>/gi, '`$1`');
    text = text.replace(/<pre[^>]*>(.*?)<\/pre>/gi, '```\n$1\n```');
    
    text = text.replace(/<[^>]*>/g, '');
    
    text = text.replace(/&nbsp;/g, ' ');
    text = text.replace(/&amp;/g, '&');
    text = text.replace(/&lt;/g, '<');
    text = text.replace(/&gt;/g, '>');
    text = text.replace(/&quot;/g, '"');
    text = text.replace(/&#39;/g, "'");
    text = text.replace(/&apos;/g, "'");
    
    text = text.replace(/\n{3,}/g, '\n\n');
    text = text.trim();
    
    // Limit length for Discord (2000 char limit for embed description)
    if (text.length > 1900) {
        text = text.substring(0, 1897) + '...';
    }
    
    return text;
}

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

        const [attendance] = await db.query(`
            SELECT status, COUNT(*) as count
            FROM operation_attendance
            WHERE operation_id = ?
            GROUP BY status
        `, [operation.id]);

        const counts = { present: 0, tentative: 0, absent: 0 };
        attendance.forEach(a => counts[a.status] = a.count);

        const cleanDescription = htmlToMarkdown(operation.description) || 'No description provided.';

        const embed = new EmbedBuilder()
            .setTitle(operation.title)
            .setDescription(cleanDescription)
            .setColor(0x6B8E23) // Olive green
            .addFields(
                {
                    name: '📅 Date & Time',
                    value: `<t:${operation.start_time}:F>`,
                    inline: false
                },
                {
                    name: '⏰ Duration',
                    value: `<t:${operation.start_time}:t> - <t:${operation.end_time}:t>`,
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

        const mainOpsRoleId = process.env.DISCORD_MAIN_OPS_ROLE_ID;
        const sideOpsRoleId = process.env.DISCORD_SIDE_OPS_ROLE_ID;

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

async function updateOperationPost(client, operation) {
    try {
        if (!operation.discord_message_id) {
            console.log('ℹ️  Operation has no Discord message ID, creating new post...');
            return await createOperationPost(client, operation);
        }

        const thread = await client.channels.fetch(operation.discord_thread_id);
        if (!thread) {
            console.warn('⚠️  Thread not found, creating new post...');
            return await createOperationPost(client, operation);
        }

        const embedMessage = await thread.messages.fetch(operation.discord_message_id);
        if (!embedMessage) {
            console.warn('⚠️  Embed message not found, creating new post...');
            return await createOperationPost(client, operation);
        }

        const [attendance] = await db.query(`
            SELECT status, COUNT(*) as count
            FROM operation_attendance
            WHERE operation_id = ?
            GROUP BY status
        `, [operation.id]);

        const counts = { present: 0, tentative: 0, absent: 0 };
        attendance.forEach(a => counts[a.status] = a.count);

        const cleanDescription = htmlToMarkdown(operation.description) || 'No description provided.';

        const embed = new EmbedBuilder()
            .setTitle(operation.title)
            .setDescription(cleanDescription)
            .setColor(0x6B8E23)
            .addFields(
                {
                    name: '📅 Date & Time',
                    value: `<t:${operation.start_time}:F>`,
                    inline: false
                },
                {
                    name: '⏰ Duration',
                    value: `<t:${operation.start_time}:t> - <t:${operation.end_time}:t>`,
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

        await embedMessage.edit({ embeds: [embed] });
        console.log(`✅ Updated forum post for operation: ${operation.title}`);

        return thread;

    } catch (error) {
        console.error('❌ Error updating operation forum post:', error);
        return null;
    }
}

async function postOperationNews(client, operation, newsContent, author, attachments = []) {
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

        const cleanContent = htmlToMarkdown(newsContent) || null;

        const embed = new EmbedBuilder()
            .setTitle('📰 Operation Update')
            .setDescription(cleanContent)
            .setColor(0x3498DB) // Blue
            .setTimestamp()
            .setFooter({ text: `Posted by ${author}` });

        // Extract inline images from HTML content (Quill editor uploads)
        const imgRegex = /<img[^>]*src=["']([^"']+)["'][^>]*>/gi;
        const inlineImages = [];
        let imgMatch;
        while ((imgMatch = imgRegex.exec(newsContent)) !== null) {
            const src = imgMatch[1];
            if (src.startsWith('/images/news/')) {
                try {
                    const filePath = path.join(__dirname, '../public', src);
                    const buffer = fs.readFileSync(filePath);
                    inlineImages.push({ buffer, name: path.basename(src) });
                } catch (e) { /* file not found, skip */ }
            }
        }

        // Combine inline images with explicit attachments (avoid duplicates by name)
        const inlineNames = new Set(inlineImages.map(f => f.name));
        const explicitFiles = attachments.filter(a => a.buffer && !inlineNames.has(a.name));
        const allFiles = [...inlineImages, ...explicitFiles];

        const discordFiles = allFiles.map(f => new AttachmentBuilder(f.buffer, { name: f.name }));

        const firstImage = allFiles[0];
        if (firstImage) {
            embed.setImage(`attachment://${firstImage.name}`);
        }

        const message = await thread.send({ embeds: [embed], files: discordFiles });
        console.log(`✅ Posted news to operation thread: ${operation.title}`);

        return message;

    } catch (error) {
        console.error('❌ Error posting operation news:', error);
        return null;
    }
}

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
        const mainOpsRoleId = process.env.DISCORD_MAIN_OPS_ROLE_ID;
        const sideOpsRoleId = process.env.DISCORD_SIDE_OPS_ROLE_ID;

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
