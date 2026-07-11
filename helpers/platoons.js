// Derives platoons from the Main ORBAT template. A "platoon" is a root squad
// (parent_squad_id IS NULL) of the main template — the top organizational
// grouping every assigned member nests under (see routes/orbat.js
// migrate-hierarchy, which normalizes each template to a root "Platoon"). Each
// platoon owns a shared fund and vehicle inventory in the economy.
//
// Squads nest via orbat_squads.parent_squad_id and members are the users on
// orbat_assignments → orbat_roles within a squad — the same shape
// helpers/feedbackGraph.js walks.
const db = require('../config/database');

// All squads (id + parent) for a template, keyed by id.
async function loadSquadMap(orbatId) {
    const [rows] = await db.query(
        `SELECT id, parent_squad_id, name, color, icon, display_order
           FROM orbat_squads WHERE orbat_id = ?`,
        [orbatId]
    );
    const byId = {};
    rows.forEach(s => { byId[s.id] = s; });
    return { rows, byId };
}

// Walk up parent_squad_id to the root squad (the platoon) within a squad map.
function rootOf(byId, squadId) {
    const visited = new Set();
    let cur = squadId;
    while (cur && byId[cur] && !visited.has(cur)) {
        visited.add(cur);
        const parent = byId[cur].parent_squad_id;
        if (!parent || !byId[parent]) return cur; // cur is a root
        cur = parent;
    }
    return null;
}

// The platoons (root squads) of the main template, in display order.
async function getPlatoons(mainOrbatId) {
    if (!mainOrbatId) return [];
    const [rows] = await db.query(
        `SELECT id, name, color, icon, display_order
           FROM orbat_squads
          WHERE orbat_id = ? AND parent_squad_id IS NULL
          ORDER BY display_order ASC, id ASC`,
        [mainOrbatId]
    );
    return rows;
}

// Which platoon a user sits under in the main template (null if unassigned).
async function getUserPlatoon(userId, mainOrbatId) {
    if (!userId || !mainOrbatId) return null;
    const { rows, byId } = await loadSquadMap(mainOrbatId);
    if (!rows.length) return null;

    const squadIds = rows.map(s => s.id);
    const [assigned] = await db.query(
        `SELECT DISTINCT orr.squad_id
           FROM orbat_assignments oa
           JOIN orbat_roles orr ON oa.role_id = orr.id
          WHERE oa.user_id = ? AND orr.squad_id IN (?)`,
        [userId, squadIds]
    );
    if (!assigned.length) return null;

    const rootId = rootOf(byId, assigned[0].squad_id);
    return rootId ? byId[rootId] : null;
}

// Every user assigned anywhere under a platoon (the platoon squad + descendants).
async function getPlatoonMembers(platoonSquadId) {
    if (!platoonSquadId) return [];
    const [[squadRow]] = await db.query(
        'SELECT orbat_id FROM orbat_squads WHERE id = ?',
        [platoonSquadId]
    );
    if (!squadRow || !squadRow.orbat_id) return [];

    const { rows } = await loadSquadMap(squadRow.orbat_id);
    const childrenByParent = {};
    rows.forEach(s => {
        const k = s.parent_squad_id || 'root';
        (childrenByParent[k] = childrenByParent[k] || []).push(s.id);
    });

    // BFS the subtree rooted at the platoon (including itself).
    const descendants = [];
    const queue = [platoonSquadId];
    const seen = new Set();
    while (queue.length) {
        const cur = queue.shift();
        if (seen.has(cur)) continue;
        seen.add(cur);
        descendants.push(cur);
        (childrenByParent[cur] || []).forEach(c => queue.push(c));
    }

    const [members] = await db.query(
        `SELECT DISTINCT oa.user_id
           FROM orbat_assignments oa
           JOIN orbat_roles orr ON oa.role_id = orr.id
          WHERE orr.squad_id IN (?)`,
        [descendants]
    );
    return members.map(m => m.user_id);
}

module.exports = { getPlatoons, getUserPlatoon, getPlatoonMembers };
