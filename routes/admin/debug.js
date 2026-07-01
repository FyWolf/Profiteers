const express = require('express');
const router = express.Router();
const db = require('../../config/database');
const { auditStaffLoaRoles, fixStaffLoaRoles, fixOneStaffLoaRole } = require('../../helpers/staffLoa');
const { fetchAllMembers, addRole, removeRole } = require('../../helpers/discordRoles');

// Debug / maintenance tools for use in production. Mounted under the admin
// router, so access already requires the `admin.access` permission.

function render(res, extra = {}) {
    res.render('admin/debug', {
        title: 'Debug - Admin',
        staffLoaAudit: null,
        orbatRolesAudit: null,
        success: null,
        error: null,
        ...extra
    });
}

router.get('/', (req, res) => render(res));

// Dry-run: report which members are missing / wrongly holding the staff-LOA role.
router.post('/staff-loa/audit', async (req, res) => {
    try {
        const audit = await auditStaffLoaRoles();
        render(res, { staffLoaAudit: audit });
    } catch (error) {
        console.error('Staff LOA audit failed:', error);
        render(res, { error: 'Staff LOA audit failed: ' + error.message });
    }
});

// Fix a single member (grant or revoke), then re-run the audit to refresh the lists.
router.post('/staff-loa/fix-one', async (req, res) => {
    try {
        const { discord_id, action } = req.body;
        const r = await fixOneStaffLoaRole(discord_id, action);
        const audit = await auditStaffLoaRoles();
        if (r.ok) {
            const verb = action === 'grant' ? 'Granted' : 'Revoked';
            render(res, { staffLoaAudit: audit, success: `${verb} the staff-LOA role for ${discord_id}.` });
        } else {
            render(res, { staffLoaAudit: audit, error: r.error || 'Could not update that member.' });
        }
    } catch (error) {
        console.error('Staff LOA single fix failed:', error);
        render(res, { error: 'Staff LOA fix failed: ' + error.message });
    }
});

// Apply the corrections from the audit (grant missing, revoke extra).
router.post('/staff-loa/fix', async (req, res) => {
    try {
        const r = await fixStaffLoaRoles();
        if (!r.configured) {
            return render(res, { error: 'DISCORD_STAFF_LOA_ROLE_ID is not configured.' });
        }
        if (r.available === false) {
            return render(res, { error: 'Could not reach Discord to enumerate members.' });
        }
        const parts = [`Granted ${r.added}`, `revoked ${r.removed}`];
        if (r.failed) parts.push(`${r.failed} failed`);
        render(res, { success: `Staff-LOA roles reconciled: ${parts.join(', ')}.` });
    } catch (error) {
        console.error('Staff LOA fix failed:', error);
        render(res, { error: 'Staff LOA fix failed: ' + error.message });
    }
});

// ── ORBAT Squad Discord Role Audit ────────────────────────────────────────

/**
 * POST /admin/debug/orbat-roles/audit
 * Compares Discord roles against ORBAT squad assignments.
 * Reports:
 *  - Members who have a squad Discord role but aren't assigned to that squad
 *  - Members assigned to a squad but missing the squad's Discord role
 */
router.post('/orbat-roles/audit', async (req, res) => {
    try {
        const configured = !!(process.env.DISCORD_BOT_TOKEN && process.env.DISCORD_GUILD_ID);
        if (!configured) {
            return render(res, { orbatRolesAudit: { configured: false } });
        }

        // Get all squads that have a Discord role configured
        const [squads] = await db.query(`
            SELECT os.id, os.name, os.discord_role_id, ot.name as template_name
            FROM orbat_squads os
            JOIN orbat_templates ot ON os.orbat_id = ot.id
            WHERE os.discord_role_id IS NOT NULL
            ORDER BY ot.name, os.name
        `);

        if (squads.length === 0) {
            return render(res, { orbatRolesAudit: { configured: true, squads: [], message: 'No squads have Discord roles configured.' } });
        }

        // Fetch all guild members
        const members = await fetchAllMembers();
        if (!members || members.length === 0) {
            return render(res, { orbatRolesAudit: { configured: true, available: false } });
        }

        // Build a map of discord_id -> member
        const memberMap = {};
        members.forEach(m => {
            if (m.user && !m.user.bot) {
                memberMap[m.user.id] = m;
            }
        });

        // For each squad, find who's assigned and who has the role
        const squadResults = [];
        for (const squad of squads) {
            // Get currently assigned users
            const [assignments] = await db.query(`
                SELECT u.discord_id, u.discord_global_name, u.username
                FROM orbat_assignments oa
                JOIN orbat_roles r ON oa.role_id = r.id
                JOIN users u ON oa.user_id = u.id
                WHERE r.squad_id = ?
                  AND u.discord_id IS NOT NULL
            `, [squad.id]);

            const assignedDiscordIds = new Set(assignments.map(a => a.discord_id));

            // Find members who have this role in Discord
            const membersWithRole = [];
            for (const m of members) {
                if (m.user && !m.user.bot && m.roles && m.roles.includes(squad.discord_role_id)) {
                    membersWithRole.push(m.user.id);
                }
            }

            // Members who have the role but aren't assigned to this squad
            const extra = membersWithRole
                .filter(did => !assignedDiscordIds.has(did))
                .map(did => {
                    const m = memberMap[did];
                    return {
                        discord_id: did,
                        name: m?.global_name || m?.user?.global_name || m?.user?.username || did
                    };
                });

            // Members assigned to the squad but missing the role
            const missing = [];
            for (const a of assignments) {
                if (!membersWithRole.includes(a.discord_id)) {
                    const m = memberMap[a.discord_id];
                    missing.push({
                        discord_id: a.discord_id,
                        name: a.discord_global_name || a.username || a.discord_id,
                        inGuild: !!m
                    });
                }
            }

            squadResults.push({
                squadId: squad.id,
                squadName: squad.name,
                templateName: squad.template_name,
                discordRoleId: squad.discord_role_id,
                assignedCount: assignments.length,
                roleHolderCount: membersWithRole.length,
                missing,
                extra
            });
        }

        render(res, { orbatRolesAudit: { configured: true, available: true, squads: squadResults } });
    } catch (error) {
        console.error('ORBAT roles audit failed:', error);
        render(res, { error: 'ORBAT roles audit failed: ' + error.message });
    }
});

/**
 * POST /admin/debug/orbat-roles/fix-missing
 * Grants the squad Discord role to assigned members who are missing it.
 */
router.post('/orbat-roles/fix-missing', async (req, res) => {
    try {
        const { squadId } = req.body;
        let discordIds = req.body.discordIds;
        if (!Array.isArray(discordIds)) discordIds = discordIds ? [discordIds] : [];
        if (!squadId || discordIds.length === 0) {
            return render(res, { error: 'Invalid request' });
        }

        const [squad] = await db.query('SELECT discord_role_id, name FROM orbat_squads WHERE id = ?', [squadId]);
        if (!squad.length || !squad[0].discord_role_id) {
            return render(res, { error: 'Squad not found or no Discord role configured' });
        }

        let granted = 0, failed = 0;
        for (const did of discordIds) {
            const r = await addRole(did, squad[0].discord_role_id);
            if (r.ok) granted++;
            else failed++;
        }

        // Re-run audit
        const auditReq = { method: 'POST' };
        // We'll just redirect to re-render with the audit
        const audit = await runOrbatRolesAudit();
        render(res, {
            orbatRolesAudit: audit,
            success: `Granted role "${squad[0].name}" to ${granted} member(s)${failed ? ` (${failed} failed)` : ''}`
        });
    } catch (error) {
        console.error('ORBAT roles fix missing failed:', error);
        render(res, { error: 'ORBAT roles fix failed: ' + error.message });
    }
});

/**
 * POST /admin/debug/orbat-roles/fix-extra
 * Revokes the squad Discord role from members who shouldn't have it.
 */
router.post('/orbat-roles/fix-extra', async (req, res) => {
    try {
        const { squadId } = req.body;
        let discordIds = req.body.discordIds;
        if (!Array.isArray(discordIds)) discordIds = discordIds ? [discordIds] : [];
        if (!squadId || discordIds.length === 0) {
            return render(res, { error: 'Invalid request' });
        }

        const [squad] = await db.query('SELECT discord_role_id, name FROM orbat_squads WHERE id = ?', [squadId]);
        if (!squad.length || !squad[0].discord_role_id) {
            return render(res, { error: 'Squad not found or no Discord role configured' });
        }

        let revoked = 0, failed = 0;
        for (const did of discordIds) {
            const r = await removeRole(did, squad[0].discord_role_id);
            if (r.ok) revoked++;
            else failed++;
        }

        const audit = await runOrbatRolesAudit();
        render(res, {
            orbatRolesAudit: audit,
            success: `Revoked role "${squad[0].name}" from ${revoked} member(s)${failed ? ` (${failed} failed)` : ''}`
        });
    } catch (error) {
        console.error('ORBAT roles fix extra failed:', error);
        render(res, { error: 'ORBAT roles fix failed: ' + error.message });
    }
});

async function runOrbatRolesAudit() {
    const configured = !!(process.env.DISCORD_BOT_TOKEN && process.env.DISCORD_GUILD_ID);
    if (!configured) return { configured: false };

    const [squads] = await db.query(`
        SELECT os.id, os.name, os.discord_role_id, ot.name as template_name
        FROM orbat_squads os
        JOIN orbat_templates ot ON os.orbat_id = ot.id
        WHERE os.discord_role_id IS NOT NULL
        ORDER BY ot.name, os.name
    `);

    if (squads.length === 0) {
        return { configured: true, squads: [], message: 'No squads have Discord roles configured.' };
    }

    const members = await fetchAllMembers();
    if (!members || members.length === 0) {
        return { configured: true, available: false };
    }

    const memberMap = {};
    members.forEach(m => {
        if (m.user && !m.user.bot) memberMap[m.user.id] = m;
    });

    const squadResults = [];
    for (const squad of squads) {
        const [assignments] = await db.query(`
            SELECT u.discord_id, u.discord_global_name, u.username
            FROM orbat_assignments oa
            JOIN orbat_roles r ON oa.role_id = r.id
            JOIN users u ON oa.user_id = u.id
            WHERE r.squad_id = ?
              AND u.discord_id IS NOT NULL
        `, [squad.id]);

        const assignedDiscordIds = new Set(assignments.map(a => a.discord_id));

        const membersWithRole = [];
        for (const m of members) {
            if (m.user && !m.user.bot && m.roles && m.roles.includes(squad.discord_role_id)) {
                membersWithRole.push(m.user.id);
            }
        }

        const extra = membersWithRole
            .filter(did => !assignedDiscordIds.has(did))
            .map(did => {
                const m = memberMap[did];
                return {
                    discord_id: did,
                    name: m?.global_name || m?.user?.global_name || m?.user?.username || did
                };
            });

        const missing = [];
        for (const a of assignments) {
            if (!membersWithRole.includes(a.discord_id)) {
                const m = memberMap[a.discord_id];
                missing.push({
                    discord_id: a.discord_id,
                    name: a.discord_global_name || a.username || a.discord_id,
                    inGuild: !!m
                });
            }
        }

        squadResults.push({
            squadId: squad.id,
            squadName: squad.name,
            templateName: squad.template_name,
            discordRoleId: squad.discord_role_id,
            assignedCount: assignments.length,
            roleHolderCount: membersWithRole.length,
            missing,
            extra
        });
    }

    return { configured: true, available: true, squads: squadResults };
}

module.exports = router;
