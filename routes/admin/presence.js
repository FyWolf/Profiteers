const express = require('express');
const router  = express.Router();
const db      = require('../../config/database');

router.get('/', async (req, res) => {
    let data = {
        // Summary chips
        joins_today: 0,
        leaves_today: 0,
        net_today: 0,
        joins_month: 0,
        leaves_month: 0,
        net_month: 0,
        dau: 0,
        wau: 0,
        mau: 0,

        // Charts
        daily_growth: [],       // last 30 days { date, joins, leaves, net }
        daily_active: [],       // last 30 days { date, users }
        weekly_active: [],      // last 12 weeks { week_label, users }
        peak_hours: Array.from({ length: 24 }, (_, i) => ({ hour: i, messages: 0 })),

        // Tables
        recent_joins: [],       // last 10 joins
        recent_leaves: [],      // last 10 leaves
        top_chatters: [],       // top 15 by message count (30d)
        top_channels: [],       // top 10 channels (30d)

        // Retention / engagement
        retention_weeks: [],    // 8 weeks WoW message retention
        new_member_engagement: { engaged: 0, total: 0, rate: 0 },
                                // % of members who joined in last 30d and sent ≥1 message
        avg_tenure_left: 0,     // avg days between join and leave (for members who left)
    };

    try {
        // ── Join / leave summary ────────────────────────────────────────────────
        const [[jlSummary]] = await db.query(`
            SELECT
                (SELECT COUNT(*) FROM member_join_leave WHERE event_type='join'  AND DATE(occurred_at)=CURDATE())                          AS joins_today,
                (SELECT COUNT(*) FROM member_join_leave WHERE event_type='leave' AND DATE(occurred_at)=CURDATE())                          AS leaves_today,
                (SELECT COUNT(*) FROM member_join_leave WHERE event_type='join'  AND occurred_at >= DATE_SUB(NOW(), INTERVAL 30 DAY))      AS joins_month,
                (SELECT COUNT(*) FROM member_join_leave WHERE event_type='leave' AND occurred_at >= DATE_SUB(NOW(), INTERVAL 30 DAY))      AS leaves_month
        `);
        data.joins_today  = jlSummary.joins_today;
        data.leaves_today = jlSummary.leaves_today;
        data.net_today    = jlSummary.joins_today - jlSummary.leaves_today;
        data.joins_month  = jlSummary.joins_month;
        data.leaves_month = jlSummary.leaves_month;
        data.net_month    = jlSummary.joins_month - jlSummary.leaves_month;

        // ── DAU / WAU / MAU (message-based) ────────────────────────────────────
        const [[activeSummary]] = await db.query(`
            SELECT
                (SELECT COUNT(DISTINCT discord_id) FROM message_activity WHERE DATE(sent_at) = CURDATE())                            AS dau,
                (SELECT COUNT(DISTINCT discord_id) FROM message_activity WHERE sent_at >= DATE_SUB(NOW(), INTERVAL 7  DAY))          AS wau,
                (SELECT COUNT(DISTINCT discord_id) FROM message_activity WHERE sent_at >= DATE_SUB(NOW(), INTERVAL 30 DAY))          AS mau
        `);
        Object.assign(data, activeSummary);

        // ── Daily member growth (last 30 days) ─────────────────────────────────
        const [rawGrowth] = await db.query(`
            SELECT
                DATE(occurred_at)                                  AS date,
                SUM(event_type = 'join')                           AS joins,
                SUM(event_type = 'leave')                          AS leaves
            FROM member_join_leave
            WHERE occurred_at >= DATE_SUB(CURDATE(), INTERVAL 29 DAY)
            GROUP BY DATE(occurred_at)
            ORDER BY date ASC
        `);
        const growthMap = {};
        rawGrowth.forEach(r => { growthMap[r.date.toISOString().slice(0, 10)] = r; });
        for (let i = 29; i >= 0; i--) {
            const d   = new Date();
            d.setDate(d.getDate() - i);
            const key = d.toISOString().slice(0, 10);
            const row = growthMap[key] || { joins: 0, leaves: 0 };
            data.daily_growth.push({
                date:   key,
                joins:  Number(row.joins),
                leaves: Number(row.leaves),
                net:    Number(row.joins) - Number(row.leaves)
            });
        }

        // ── Daily active users — messages (last 30 days) ────────────────────────
        const [rawActive] = await db.query(`
            SELECT DATE(sent_at) AS date, COUNT(DISTINCT discord_id) AS users
            FROM message_activity
            WHERE sent_at >= DATE_SUB(CURDATE(), INTERVAL 29 DAY)
            GROUP BY DATE(sent_at)
            ORDER BY date ASC
        `);
        const activeMap = {};
        rawActive.forEach(r => { activeMap[r.date.toISOString().slice(0, 10)] = r.users; });
        for (let i = 29; i >= 0; i--) {
            const d   = new Date();
            d.setDate(d.getDate() - i);
            const key = d.toISOString().slice(0, 10);
            data.daily_active.push({ date: key, users: activeMap[key] || 0 });
        }

        // ── Weekly active users (last 12 weeks) ─────────────────────────────────
        const [rawWeekly] = await db.query(`
            SELECT
                YEARWEEK(sent_at, 1)       AS yw,
                MIN(DATE(sent_at))         AS week_start,
                COUNT(DISTINCT discord_id) AS users
            FROM message_activity
            WHERE sent_at >= DATE_SUB(NOW(), INTERVAL 12 WEEK)
            GROUP BY yw
            ORDER BY yw ASC
        `);
        data.weekly_active = rawWeekly.map(r => ({
            week_label: (r.week_start instanceof Date ? r.week_start.toISOString() : String(r.week_start)).slice(5, 10),
            users: r.users
        }));

        // ── Peak message hours (last 30 days) ────────────────────────────────────
        const [rawHours] = await db.query(`
            SELECT HOUR(sent_at) AS hour, COUNT(*) AS messages
            FROM message_activity
            WHERE sent_at >= DATE_SUB(NOW(), INTERVAL 30 DAY)
            GROUP BY HOUR(sent_at)
        `);
        rawHours.forEach(r => { data.peak_hours[r.hour].messages = r.messages; });

        // ── Recent joins / leaves ────────────────────────────────────────────────
        const [recentJoins] = await db.query(`
            SELECT discord_name, occurred_at, account_age_days
            FROM member_join_leave
            WHERE event_type = 'join'
            ORDER BY occurred_at DESC
            LIMIT 10
        `);
        data.recent_joins = recentJoins;

        const [recentLeaves] = await db.query(`
            SELECT jl.discord_name, jl.occurred_at,
                   DATEDIFF(jl.occurred_at, j.occurred_at) AS days_stayed
            FROM member_join_leave jl
            LEFT JOIN member_join_leave j
                ON j.discord_id = jl.discord_id AND j.event_type = 'join'
                AND j.occurred_at = (
                    SELECT MAX(occurred_at) FROM member_join_leave
                    WHERE discord_id = jl.discord_id AND event_type = 'join' AND occurred_at <= jl.occurred_at
                )
            WHERE jl.event_type = 'leave'
            ORDER BY jl.occurred_at DESC
            LIMIT 10
        `);
        data.recent_leaves = recentLeaves;

        // ── Top chatters (last 30 days) ──────────────────────────────────────────
        const [topChatters] = await db.query(`
            SELECT discord_name, COUNT(*) AS messages,
                   COUNT(DISTINCT DATE(sent_at)) AS active_days,
                   MAX(sent_at) AS last_message
            FROM message_activity
            WHERE sent_at >= DATE_SUB(NOW(), INTERVAL 30 DAY)
            GROUP BY discord_id, discord_name
            ORDER BY messages DESC
            LIMIT 15
        `);
        data.top_chatters = topChatters;

        // ── Top channels (last 30 days) ──────────────────────────────────────────
        const [topChannels] = await db.query(`
            SELECT channel_name, COUNT(*) AS messages,
                   COUNT(DISTINCT discord_id) AS unique_users
            FROM message_activity
            WHERE sent_at >= DATE_SUB(NOW(), INTERVAL 30 DAY)
            GROUP BY channel_id, channel_name
            ORDER BY messages DESC
            LIMIT 10
        `);
        data.top_channels = topChannels;

        // ── Week-over-week message retention ─────────────────────────────────────
        // Of members active in week N, what % sent a message in week N+1?
        const [rawRetention] = await db.query(`
            SELECT
                w1.yw,
                w1.week_start,
                COUNT(DISTINCT w1.discord_id)  AS active,
                COUNT(DISTINCT w2.discord_id)  AS retained
            FROM (
                SELECT YEARWEEK(sent_at, 1) AS yw, MIN(DATE(sent_at)) AS week_start, discord_id
                FROM message_activity
                WHERE sent_at >= DATE_SUB(NOW(), INTERVAL 9 WEEK)
                GROUP BY yw, discord_id
            ) w1
            LEFT JOIN (
                SELECT YEARWEEK(sent_at, 1) AS yw, discord_id
                FROM message_activity
                GROUP BY yw, discord_id
            ) w2 ON w2.discord_id = w1.discord_id AND w2.yw = w1.yw + 1
            GROUP BY w1.yw, w1.week_start
            ORDER BY w1.yw ASC
            LIMIT 8
        `);
        data.retention_weeks = rawRetention.map(r => ({
            week_label: (r.week_start instanceof Date ? r.week_start.toISOString() : String(r.week_start)).slice(5, 10),
            active:   r.active,
            retained: r.retained,
            rate:     r.active > 0 ? Math.round((r.retained / r.active) * 100) : 0
        }));

        // ── New member engagement (last 30 days) ─────────────────────────────────
        // Of members who joined in the last 30 days, how many sent ≥1 message?
        const [[engRow]] = await db.query(`
            SELECT
                COUNT(DISTINCT j.discord_id)                        AS total,
                COUNT(DISTINCT m.discord_id)                        AS engaged
            FROM member_join_leave j
            LEFT JOIN message_activity m
                ON m.discord_id = j.discord_id
                AND m.sent_at   >= j.occurred_at
            WHERE j.event_type  = 'join'
              AND j.occurred_at >= DATE_SUB(NOW(), INTERVAL 30 DAY)
        `);
        data.new_member_engagement = {
            total:   engRow.total,
            engaged: engRow.engaged,
            rate:    engRow.total > 0 ? Math.round((engRow.engaged / engRow.total) * 100) : 0
        };

        // ── Average tenure of members who left ───────────────────────────────────
        const [[tenureRow]] = await db.query(`
            SELECT ROUND(AVG(DATEDIFF(l.occurred_at, j.occurred_at))) AS avg_days
            FROM member_join_leave l
            JOIN (
                SELECT discord_id, MAX(occurred_at) AS occurred_at
                FROM member_join_leave
                WHERE event_type = 'join'
                GROUP BY discord_id
            ) j ON j.discord_id = l.discord_id AND j.occurred_at <= l.occurred_at
            WHERE l.event_type = 'leave'
              AND l.occurred_at >= DATE_SUB(NOW(), INTERVAL 90 DAY)
        `);
        data.avg_tenure_left = tenureRow.avg_days || 0;

    } catch (err) {
        console.error('[PRESENCE] Stats query failed:', err.message);
    }

    res.render('admin/presence', {
        title: 'Member Activity — Profiteers PMC',
        user: res.locals.user,
        ...data
    });
});

module.exports = router;
