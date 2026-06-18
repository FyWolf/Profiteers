const express = require('express');
const router = express.Router();
const { auditStaffLoaRoles, fixStaffLoaRoles, fixOneStaffLoaRole } = require('../../helpers/staffLoa');

// Debug / maintenance tools for use in production. Mounted under the admin
// router, so access already requires the `admin.access` permission.

function render(res, extra = {}) {
    res.render('admin/debug', {
        title: 'Debug - Admin',
        staffLoaAudit: null,
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

module.exports = router;
