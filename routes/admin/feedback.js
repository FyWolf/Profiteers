const express = require('express');
const router = express.Router();
const db = require('../../config/database');
const { computeFeedbackPairs } = require('../../helpers/feedbackGraph');

const DIRECTIONS = ['superior', 'peer', 'subordinate'];

// ── Cycles overview ─────────────────────────────────────────────────────────
router.get('/', async (req, res) => {
    try {
        const [cycles] = await db.query(`
            SELECT c.*, t.name AS template_name, u.username AS created_by_username,
                   (SELECT COUNT(*) FROM feedback_pairs p WHERE p.cycle_id = c.id AND p.is_adhoc = 0) AS total_pairs,
                   (SELECT COUNT(*) FROM feedback_pairs p WHERE p.cycle_id = c.id AND p.is_adhoc = 0 AND p.status = 'submitted') AS submitted_pairs
            FROM feedback_cycles c
            LEFT JOIN orbat_templates t ON c.orbat_template_id = t.id
            LEFT JOIN users u ON c.created_by = u.id
            ORDER BY c.opened_at DESC
        `);
        const [templates] = await db.query(
            'SELECT id, name FROM orbat_templates WHERE is_active = TRUE ORDER BY name ASC'
        );
        const [[{ qcount }]] = await db.query(
            'SELECT COUNT(*) AS qcount FROM feedback_questions WHERE is_active = 1'
        );

        res.render('admin/feedback/cycles', {
            title: 'Leadership Feedback - Admin',
            cycles,
            templates,
            questionCount: qcount,
            hasOpen: cycles.some(c => c.status === 'open'),
            success: req.query.success,
            error: req.query.error
        });
    } catch (error) {
        console.error('Error loading feedback admin:', error);
        res.render('error', {
            title: 'Error',
            message: 'Error Loading Feedback Admin',
            description: 'Could not load feedback management.',
            user: res.locals.user
        });
    }
});

router.post('/open', async (req, res) => {
    try {
        const { title, template_id } = req.body;
        const templateId = parseInt(template_id, 10);
        if (!title || !title.trim() || !templateId) {
            return res.redirect('/admin/feedback?error=A title and an ORBAT template are required');
        }

        const [openCycles] = await db.query("SELECT id FROM feedback_cycles WHERE status = 'open'");
        if (openCycles.length > 0) {
            return res.redirect('/admin/feedback?error=Close the current round before opening a new one');
        }

        const pairs = await computeFeedbackPairs(templateId);
        if (pairs.length === 0) {
            return res.redirect('/admin/feedback?error=That ORBAT template has no slot assignments to build feedback from');
        }

        const [result] = await db.query(
            "INSERT INTO feedback_cycles (title, orbat_template_id, status, created_by) VALUES (?, ?, 'open', ?)",
            [title.trim(), templateId, req.session.userId]
        );
        const cycleId = result.insertId;

        // Freeze the active question set into this round (one snapshot row per
        // scope a question applies to) so later bank edits can't change an open
        // round. A multi-scope question therefore appears on each scope's form.
        const [activeQuestions] = await db.query(
            'SELECT prompt, type, scopes, direction, display_order FROM feedback_questions WHERE is_active = 1'
        );
        const cqRows = [];
        for (const q of activeQuestions) {
            const scopes = String(q.scopes || q.direction || '').split(',').map(s => s.trim()).filter(Boolean);
            for (const sc of scopes) cqRows.push([cycleId, q.prompt, q.type, sc, q.display_order]);
        }
        if (cqRows.length > 0) {
            await db.query(
                'INSERT INTO feedback_cycle_questions (cycle_id, prompt, type, direction, display_order) VALUES ?',
                [cqRows]
            );
        }

        const values = pairs.map(p => [cycleId, p.reviewer_user_id, p.subject_user_id, p.direction, p.is_indirect]);
        await db.query(
            'INSERT IGNORE INTO feedback_pairs (cycle_id, reviewer_user_id, subject_user_id, direction, is_indirect) VALUES ?',
            [values]
        );

        if (process.env.DISCORD_BOT_TOKEN) {
            try {
                const { announceFeedbackRound } = require('../../discord/feedback');
                const { discordClient } = require('../../discord');
                await announceFeedbackRound(discordClient, { id: cycleId, title: title.trim() });
            } catch (discordError) {
                console.error('Feedback announcement error:', discordError);
            }
        }

        res.redirect('/admin/feedback?success=Feedback round opened and announced');
    } catch (error) {
        console.error('Error opening feedback round:', error);
        res.redirect('/admin/feedback?error=Failed to open feedback round');
    }
});

router.post('/close/:id', async (req, res) => {
    try {
        await db.query(
            "UPDATE feedback_cycles SET status = 'closed', closed_at = NOW() WHERE id = ?",
            [req.params.id]
        );
        res.redirect('/admin/feedback?success=Feedback round closed');
    } catch (error) {
        console.error('Error closing feedback round:', error);
        res.redirect('/admin/feedback?error=Failed to close feedback round');
    }
});

// ── Round detail: completion + subjects ─────────────────────────────────────
router.get('/round/:id', async (req, res) => {
    try {
        const [[cycle]] = await db.query(`
            SELECT c.*, t.name AS template_name
            FROM feedback_cycles c
            LEFT JOIN orbat_templates t ON c.orbat_template_id = t.id
            WHERE c.id = ?
        `, [req.params.id]);
        if (!cycle) return res.redirect('/admin/feedback?error=Round not found');

        const [reviewers] = await db.query(`
            SELECT u.id, u.username, u.discord_global_name,
                   COUNT(*) AS total,
                   SUM(p.status = 'submitted') AS done
            FROM feedback_pairs p
            JOIN users u ON p.reviewer_user_id = u.id
            WHERE p.cycle_id = ? AND p.is_adhoc = 0
            GROUP BY u.id
            ORDER BY (SUM(p.status = 'submitted') = COUNT(*)) ASC, u.discord_global_name ASC
        `, [req.params.id]);

        const [subjects] = await db.query(`
            SELECT u.id, u.username, u.discord_global_name,
                   SUM(p.status = 'submitted') AS responses,
                   SUM(p.is_adhoc = 0)         AS expected
            FROM feedback_pairs p
            JOIN users u ON p.subject_user_id = u.id
            WHERE p.cycle_id = ?
            GROUP BY u.id
            ORDER BY u.discord_global_name ASC
        `, [req.params.id]);

        res.render('admin/feedback/round', {
            title: `Round: ${cycle.title} - Admin`,
            cycle,
            reviewers,
            subjects
        });
    } catch (error) {
        console.error('Error loading feedback round:', error);
        res.redirect('/admin/feedback?error=Failed to load round');
    }
});

// ── Question bank ───────────────────────────────────────────────────────────
function parseScopes(body) {
    return [].concat(body.scopes || []).filter(s => DIRECTIONS.includes(s));
}

router.get('/questions', async (req, res) => {
    try {
        const [questions] = await db.query(
            'SELECT * FROM feedback_questions ORDER BY display_order ASC, id ASC'
        );
        questions.forEach(q => {
            q.scopeList = String(q.scopes || q.direction || '').split(',').map(s => s.trim()).filter(Boolean);
        });

        res.render('admin/feedback/questions', {
            title: 'Feedback Questions - Admin',
            questions,
            success: req.query.success,
            error: req.query.error
        });
    } catch (error) {
        console.error('Error loading feedback questions:', error);
        res.redirect('/admin/feedback?error=Failed to load questions');
    }
});

router.get('/questions/add', (req, res) => {
    res.render('admin/feedback/question-form', {
        title: 'Add Question - Admin',
        question: null,
        action: 'add'
    });
});

router.post('/questions/add', async (req, res) => {
    try {
        const { prompt, type, display_order } = req.body;
        const scopes = parseScopes(req.body);
        if (!prompt || !prompt.trim() || scopes.length === 0) {
            return res.redirect('/admin/feedback/questions?error=A prompt and at least one scope are required');
        }
        const isActive = req.body.is_active ? 1 : 0;
        await db.query(
            'INSERT INTO feedback_questions (prompt, type, direction, scopes, display_order, is_active, created_by) VALUES (?, ?, ?, ?, ?, ?, ?)',
            [prompt.trim(), type === 'text' ? 'text' : 'rating', scopes[0], scopes.join(','), parseInt(display_order, 10) || 0, isActive, req.session.userId]
        );
        res.redirect('/admin/feedback/questions?success=Question created');
    } catch (error) {
        console.error('Error creating question:', error);
        res.redirect('/admin/feedback/questions?error=Failed to create question');
    }
});

router.get('/questions/edit/:id', async (req, res) => {
    try {
        const [[question]] = await db.query('SELECT * FROM feedback_questions WHERE id = ?', [req.params.id]);
        if (!question) return res.redirect('/admin/feedback/questions?error=Question not found');
        question.scopeList = String(question.scopes || question.direction || '').split(',').map(s => s.trim()).filter(Boolean);
        res.render('admin/feedback/question-form', {
            title: 'Edit Question - Admin',
            question,
            action: 'edit'
        });
    } catch (error) {
        console.error('Error loading question:', error);
        res.redirect('/admin/feedback/questions?error=Failed to load question');
    }
});

router.post('/questions/edit/:id', async (req, res) => {
    try {
        const { prompt, type, display_order } = req.body;
        const scopes = parseScopes(req.body);
        if (!prompt || !prompt.trim() || scopes.length === 0) {
            return res.redirect('/admin/feedback/questions?error=A prompt and at least one scope are required');
        }
        const isActive = req.body.is_active ? 1 : 0;
        await db.query(
            'UPDATE feedback_questions SET prompt = ?, type = ?, direction = ?, scopes = ?, display_order = ?, is_active = ? WHERE id = ?',
            [prompt.trim(), type === 'text' ? 'text' : 'rating', scopes[0], scopes.join(','), parseInt(display_order, 10) || 0, isActive, req.params.id]
        );
        res.redirect('/admin/feedback/questions?success=Question updated');
    } catch (error) {
        console.error('Error updating question:', error);
        res.redirect('/admin/feedback/questions?error=Failed to update question');
    }
});

router.post('/questions/delete/:id', async (req, res) => {
    try {
        await db.query('DELETE FROM feedback_questions WHERE id = ?', [req.params.id]);
        res.redirect('/admin/feedback/questions?success=Question deleted');
    } catch (error) {
        console.error('Error deleting question:', error);
        res.redirect('/admin/feedback/questions?error=Failed to delete question');
    }
});

module.exports = router;
