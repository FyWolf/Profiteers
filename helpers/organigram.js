// Shared helpers for the unit organigram (chain-of-command chart above the roster).

// Normalise a stored member_discord_ids value into an array of id strings.
// The JSON column may come back already parsed (array) or as a string.
function parseMemberIds(val) {
    if (!val) return [];
    if (Array.isArray(val)) return val.map(String);
    try {
        const arr = JSON.parse(val);
        return Array.isArray(arr) ? arr.map(String) : [];
    } catch {
        return [];
    }
}

// Build a parent→children tree from a flat node list (roots = parent_id NULL).
function buildTree(nodes) {
    const byId = new Map();
    nodes.forEach(n => byId.set(n.id, { ...n, children: [] }));
    const roots = [];
    byId.forEach(node => {
        if (node.parent_id && byId.has(node.parent_id)) {
            byId.get(node.parent_id).children.push(node);
        } else {
            roots.push(node);
        }
    });
    return roots;
}

// Load all organigram nodes and attach the resolved members for each.
// Each node gets:
//   - memberIds: string[] of assigned discord ids (preserves ids that no longer resolve)
//   - members:   resolved roster rows in assignment order (name/avatar + user_id when registered)
async function loadNodesWithMembers(db) {
    const [nodes] = await db.query(`
        SELECT id, parent_id, title, member_discord_ids, color, display_order
        FROM organigram_nodes
        ORDER BY display_order ASC, id ASC
    `);

    const allIds = [];
    nodes.forEach(n => {
        n.memberIds = parseMemberIds(n.member_discord_ids);
        allIds.push(...n.memberIds);
    });

    const memberMap = {};
    if (allIds.length > 0) {
        const unique = [...new Set(allIds)];
        const [rows] = await db.query(`
            SELECT
                rm.discord_id,
                rm.nickname AS roster_nickname,
                rm.discord_global_name,
                rm.discord_username AS username,
                rm.discord_avatar,
                u.id AS user_id
            FROM roster_members rm
            LEFT JOIN users u ON u.discord_id = rm.discord_id
            WHERE rm.discord_id IN (?)
        `, [unique]);
        rows.forEach(r => { memberMap[r.discord_id] = r; });

        // Attach any currently-active approved LOA to the (registered) members.
        const userIds = [...new Set(rows.map(r => r.user_id).filter(Boolean))];
        if (userIds.length > 0) {
            const [loaRows] = await db.query(`
                SELECT user_id, start_date, end_date
                FROM leave_of_absence
                WHERE status = 'approved'
                  AND start_date <= UNIX_TIMESTAMP()
                  AND end_date   >= UNIX_TIMESTAMP()
                  AND user_id IN (?)
            `, [userIds]);
            const loaByUser = {};
            loaRows.forEach(l => { loaByUser[l.user_id] = l; });
            Object.values(memberMap).forEach(m => {
                if (m.user_id && loaByUser[m.user_id]) m.loa = loaByUser[m.user_id];
            });
        }
    }

    nodes.forEach(n => {
        n.members = n.memberIds.map(id => memberMap[id]).filter(Boolean);
    });

    return nodes;
}

module.exports = { parseMemberIds, buildTree, loadNodesWithMembers };
