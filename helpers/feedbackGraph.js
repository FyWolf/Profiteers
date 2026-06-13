// Derives the 360° feedback relationship graph (who reviews whom, in which
// direction) from a fixed ORBAT template's slot assignments.
//
// Leadership is defined exactly as the rest of the app defines it: the user
// assigned to an `is_editor` role leads that squad (see isEditorOfSquadOrAncestor
// in routes/orbat.js). Squads nest via parent_squad_id.
//
// Relationship rules (one level of command each way, kept symmetric):
//   • A squad member's SUPERIORS  = that squad's leaders (or, if the squad has
//     none, the nearest ancestor squad that does).
//   • A squad leader's SUPERIORS  = the leaders of the nearest ancestor squad.
//   • A squad leader's SUBORDINATES = the squad's members + the leaders of its
//     direct child squads (their direct reports).
//   • A squad leader's PEERS      = co-leaders of the same squad + the leaders
//     of sibling squads (same parent).
// Only leaders review peers and subordinates; everyone reviews their superior(s).
const db = require('../config/database');

// Loads the template's squads, their leaders/members (resolved to user ids),
// and parent/child links.
async function loadOrbatStructure(templateId) {
    const [squads] = await db.query(
        'SELECT id, parent_squad_id FROM orbat_squads WHERE orbat_id = ?',
        [templateId]
    );
    if (squads.length === 0) return {};

    const squadIds = squads.map(s => s.id);
    const [roles] = await db.query(
        'SELECT id, squad_id, is_editor FROM orbat_roles WHERE squad_id IN (?)',
        [squadIds]
    );
    const roleById = {};
    roles.forEach(r => { roleById[r.id] = r; });

    const roleIds = roles.map(r => r.id);
    let assignments = [];
    if (roleIds.length > 0) {
        [assignments] = await db.query(
            'SELECT role_id, user_id FROM orbat_assignments WHERE role_id IN (?)',
            [roleIds]
        );
    }

    const squadInfo = {};
    squads.forEach(s => {
        squadInfo[s.id] = {
            id: s.id,
            parent_squad_id: s.parent_squad_id || null,
            leaders: new Set(),
            members: new Set(),
            childIds: []
        };
    });
    squads.forEach(s => {
        if (s.parent_squad_id && squadInfo[s.parent_squad_id]) {
            squadInfo[s.parent_squad_id].childIds.push(s.id);
        }
    });

    assignments.forEach(a => {
        const role = roleById[a.role_id];
        if (!role) return;
        const si = squadInfo[role.squad_id];
        if (!si) return;
        if (role.is_editor) si.leaders.add(a.user_id);
        else si.members.add(a.user_id);
    });

    return squadInfo;
}

// Leaders of the nearest ancestor squad (walking up parent_squad_id) that has any.
function ancestorLeaders(squadInfo, startParentId) {
    let cur = startParentId;
    const visited = new Set();
    while (cur && !visited.has(cur)) {
        visited.add(cur);
        const si = squadInfo[cur];
        if (!si) break;
        if (si.leaders.size > 0) return [...si.leaders];
        cur = si.parent_squad_id;
    }
    return [];
}

/**
 * Computes the feedback pairs for a fixed ORBAT template.
 * @param {number} templateId
 * @returns {Promise<Array<{reviewer_user_id:number, subject_user_id:number, direction:string}>>}
 */
async function computeFeedbackPairs(templateId) {
    const squadInfo = await loadOrbatStructure(templateId);

    const seen = new Set();
    const pairs = [];
    const add = (reviewer, subject, direction) => {
        if (!reviewer || !subject || reviewer === subject) return;
        const key = `${reviewer}-${subject}`;
        if (seen.has(key)) return; // a pair has a single direction; first wins
        seen.add(key);
        pairs.push({ reviewer_user_id: reviewer, subject_user_id: subject, direction });
    };

    // Group squads by parent so we can find siblings.
    const siblingsByParent = {};
    Object.values(squadInfo).forEach(s => {
        const key = s.parent_squad_id === null ? 'root' : s.parent_squad_id;
        (siblingsByParent[key] = siblingsByParent[key] || []).push(s.id);
    });

    for (const squad of Object.values(squadInfo)) {
        const leaders = [...squad.leaders];
        const members = [...squad.members];

        // SUPERIORS — members review this squad's leaders (or ancestor's).
        const memberSuperiors = leaders.length > 0
            ? leaders
            : ancestorLeaders(squadInfo, squad.parent_squad_id);
        members.forEach(m => memberSuperiors.forEach(sup => add(m, sup, 'superior')));

        // SUPERIORS — leaders review the nearest ancestor's leaders.
        if (leaders.length > 0) {
            const leaderSuperiors = ancestorLeaders(squadInfo, squad.parent_squad_id);
            leaders.forEach(l => leaderSuperiors.forEach(sup => add(l, sup, 'superior')));
        }

        if (leaders.length === 0) continue; // nothing below relies on a leader

        // SUBORDINATES — members + direct child-squad leaders are direct reports.
        const childLeaders = [];
        squad.childIds.forEach(cid => {
            const child = squadInfo[cid];
            if (child) child.leaders.forEach(id => childLeaders.push(id));
        });
        const subordinates = members.concat(childLeaders);
        leaders.forEach(l => subordinates.forEach(sub => add(l, sub, 'subordinate')));

        // PEERS — co-leaders of this squad + leaders of sibling squads.
        const parentKey = squad.parent_squad_id === null ? 'root' : squad.parent_squad_id;
        const siblingLeaders = [];
        (siblingsByParent[parentKey] || []).forEach(sid => {
            if (sid === squad.id) return;
            const sib = squadInfo[sid];
            if (sib) sib.leaders.forEach(id => siblingLeaders.push(id));
        });
        leaders.forEach(l => {
            leaders.filter(x => x !== l).forEach(co => add(l, co, 'peer'));
            siblingLeaders.forEach(p => add(l, p, 'peer'));
        });
    }

    return pairs;
}

module.exports = { computeFeedbackPairs };
