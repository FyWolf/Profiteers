// Derives the 360° feedback relationship graph (who reviews whom, in which
// scope, and how far up/down the chain) from a fixed ORBAT template's slot
// assignments.
//
// Leadership is the user assigned to an `is_editor` role (same definition the
// rest of the app uses); squads nest via parent_squad_id.
//
// Each pair carries a questionnaire `direction` (superior/peer/subordinate, from
// the reviewer's perspective) and `is_indirect`:
//   • A squad member reviews their nearest leader(s) as a DIRECT superior.
//   • A leader reviews the WHOLE chain of command above them — the nearest
//     leader(s) directly, everyone higher up as indirect superiors.
//   • The mirror of every superior pair is a subordinate pair, so a leader also
//     sees every leader below them (direct reports directly, deeper leaders as
//     indirect subordinates). The indirect chain is leadership-only.
//   • Leaders also review co-leaders and sibling-squad leaders as peers.
const db = require('../config/database');

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
            members: new Set()
        };
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

// Ordered list of leader-groups walking up from a starting parent squad — one
// group per ancestor squad that has leaders, nearest first. groups[0] are the
// direct superiors; groups[1..] are progressively more senior (indirect).
function ancestorLeaderGroups(squadInfo, startParentId) {
    const groups = [];
    const visited = new Set();
    let cur = startParentId;
    while (cur && !visited.has(cur)) {
        visited.add(cur);
        const si = squadInfo[cur];
        if (!si) break;
        if (si.leaders.size > 0) groups.push([...si.leaders]);
        cur = si.parent_squad_id;
    }
    return groups;
}

/**
 * @param {number} templateId
 * @returns {Promise<Array<{reviewer_user_id:number, subject_user_id:number, direction:string, is_indirect:number}>>}
 */
async function computeFeedbackPairs(templateId) {
    const squadInfo = await loadOrbatStructure(templateId);

    const seen = new Set();
    const pairs = [];
    const add = (reviewer, subject, direction, isIndirect) => {
        if (!reviewer || !subject || reviewer === subject) return;
        const key = `${reviewer}-${subject}`;
        if (seen.has(key)) return; // one relationship per ordered pair; first wins
        seen.add(key);
        pairs.push({
            reviewer_user_id: reviewer,
            subject_user_id: subject,
            direction,
            is_indirect: isIndirect ? 1 : 0
        });
    };

    // Group squads by parent so we can find siblings for peer relationships.
    const siblingsByParent = {};
    Object.values(squadInfo).forEach(s => {
        const k = s.parent_squad_id === null ? 'root' : s.parent_squad_id;
        (siblingsByParent[k] = siblingsByParent[k] || []).push(s.id);
    });

    for (const squad of Object.values(squadInfo)) {
        const leaders = [...squad.leaders];
        const members = [...squad.members];
        const ancestorGroups = ancestorLeaderGroups(squadInfo, squad.parent_squad_id);

        // Members → their direct superior(s): this squad's leaders, or the
        // nearest ancestor leaders if the squad has none. (Members never review
        // the indirect chain.) Mirror = leader reviews member as direct report.
        const directSuperiors = leaders.length > 0 ? leaders : (ancestorGroups[0] || []);
        members.forEach(m => directSuperiors.forEach(sup => {
            add(m, sup, 'superior', 0);
            add(sup, m, 'subordinate', 0);
        }));

        // Leaders → the whole chain above (direct + indirect), mirrored down.
        leaders.forEach(l => {
            ancestorGroups.forEach((group, idx) => {
                const indirect = idx > 0 ? 1 : 0;
                group.forEach(sup => {
                    add(l, sup, 'superior', indirect);
                    add(sup, l, 'subordinate', indirect);
                });
            });
        });

        // Peers — co-leaders of this squad + leaders of sibling squads.
        const parentKey = squad.parent_squad_id === null ? 'root' : squad.parent_squad_id;
        const siblingLeaders = [];
        (siblingsByParent[parentKey] || []).forEach(sid => {
            if (sid === squad.id) return;
            const sib = squadInfo[sid];
            if (sib) sib.leaders.forEach(id => siblingLeaders.push(id));
        });
        leaders.forEach(l => {
            leaders.filter(x => x !== l).forEach(co => add(l, co, 'peer', 0));
            siblingLeaders.forEach(p => add(l, p, 'peer', 0));
        });
    }

    return pairs;
}

module.exports = { computeFeedbackPairs };
