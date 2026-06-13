const express = require('express');
const router = express.Router();
const db = require('../config/database');
const { isAuthenticated } = require('../middleware/auth');

// Minimum responses in a direction before that direction's breakdown is shown,
// so a leader with a single subordinate can't de-anonymise the feedback.
const MIN_GROUP = 3;

const DIRECTION_LABELS = {
    superior: 'Your Leaders',
    peer: 'Your Peers',
    subordinate: 'Your Team'
};
const DIRECTION_VERB = {
    superior: 'superior',
    peer: 'peer',
    subordinate: 'subordinate'
};

function getOpenCycle() {
    return db.query(
        "SELECT * FROM feedback_cycles WHERE status = 'open' ORDER BY opened_at DESC LIMIT 1"
    ).then(([rows]) => rows[0] || null);
}

// ── Landing: the forms this user needs to fill in the open round ────────────
router.get('/', isAuthenticated, async (req, res) => {
    try {
        const cycle = await getOpenCycle();
        const groups = { superior: [], peer: [], subordinate: [] };

        if (cycle) {
            const [pairs] = await db.query(`
                SELECT fp.id, fp.direction, fp.status,
                       u.username, u.discord_global_name, u.discord_avatar, u.discord_id
                FROM feedback_pairs fp
                JOIN users u ON fp.subject_user_id = u.id
                WHERE fp.cycle_id = ? AND fp.reviewer_user_id = ?
                ORDER BY u.discord_global_name ASC, u.username ASC
            `, [cycle.id, req.session.userId]);
            pairs.forEach(p => { if (groups[p.direction]) groups[p.direction].push(p); });
        }

        const [[{ cnt }]] = await db.query(
            "SELECT COUNT(*) AS cnt FROM feedback_pairs WHERE subject_user_id = ? AND status = 'submitted'",
            [req.session.userId]
        );

        // Holders of feedback.review_any can give feedback to anyone in the open
        // round, regardless of their ORBAT assignment.
        const canReviewAny = Array.isArray(req.user.permissions)
            && req.user.permissions.includes('feedback.review_any');
        let reviewableUsers = [];
        if (cycle && canReviewAny) {
            [reviewableUsers] = await db.query(`
                SELECT id, username, discord_global_name
                FROM users
                WHERE id != ?
                ORDER BY discord_global_name ASC, username ASC
            `, [req.session.userId]);
        }

        res.render('feedback/index', {
            title: 'Leadership Feedback - Profiteers PMC',
            cycle,
            groups,
            DIRECTION_LABELS,
            hasResults: cnt > 0,
            canReviewAny,
            reviewableUsers,
            success: req.query.success,
            error: req.query.error
        });
    } catch (error) {
        console.error('Error loading feedback landing:', error);
        res.render('error', {
            title: 'Error',
            message: 'Error Loading Feedback',
            description: 'Could not load the feedback page.',
            user: res.locals.user
        });
    }
});

// ── Privileged: start a feedback form about anyone (feedback.review_any) ─────
router.post('/review', isAuthenticated, async (req, res) => {
    try {
        if (!Array.isArray(req.user.permissions) || !req.user.permissions.includes('feedback.review_any')) {
            return res.redirect('/feedback?error=You do not have permission to do that');
        }
        const cycle = await getOpenCycle();
        if (!cycle) {
            return res.redirect('/feedback?error=No feedback round is open');
        }
        const subjectId = parseInt(req.body.subject_id, 10);
        const direction = req.body.direction;
        if (!subjectId || subjectId === req.session.userId
            || !['superior', 'peer', 'subordinate'].includes(direction)) {
            return res.redirect('/feedback?error=Pick a valid person and relationship');
        }
        const [[subject]] = await db.query('SELECT id FROM users WHERE id = ?', [subjectId]);
        if (!subject) {
            return res.redirect('/feedback?error=That person was not found');
        }

        // Create the pair if one doesn't already exist (the unique constraint keeps
        // it to one form per subject, so an existing ORBAT-derived pair is reused).
        await db.query(
            'INSERT IGNORE INTO feedback_pairs (cycle_id, reviewer_user_id, subject_user_id, direction) VALUES (?, ?, ?, ?)',
            [cycle.id, req.session.userId, subjectId, direction]
        );
        const [[pair]] = await db.query(
            'SELECT id FROM feedback_pairs WHERE cycle_id = ? AND reviewer_user_id = ? AND subject_user_id = ?',
            [cycle.id, req.session.userId, subjectId]
        );
        return res.redirect('/feedback/pair/' + pair.id);
    } catch (error) {
        console.error('Error starting ad-hoc feedback:', error);
        return res.redirect('/feedback?error=Could not start that feedback form');
    }
});

// ── A single feedback form for one subject ──────────────────────────────────
router.get('/pair/:pairId', isAuthenticated, async (req, res) => {
    try {
        const [[pair]] = await db.query(`
            SELECT fp.*, c.status AS cycle_status, c.title AS cycle_title,
                   u.username, u.discord_global_name, u.discord_avatar, u.discord_id
            FROM feedback_pairs fp
            JOIN feedback_cycles c ON fp.cycle_id = c.id
            JOIN users u ON fp.subject_user_id = u.id
            WHERE fp.id = ?
        `, [req.params.pairId]);

        if (!pair || pair.reviewer_user_id !== req.session.userId) {
            return res.redirect('/feedback?error=That feedback form was not found');
        }
        if (pair.cycle_status !== 'open') {
            return res.redirect('/feedback?error=This feedback round is closed');
        }
        if (pair.status === 'submitted') {
            return res.redirect('/feedback?error=You have already submitted that form');
        }

        const [questions] = await db.query(`
            SELECT * FROM feedback_questions
            WHERE direction = ? AND is_active = 1
            ORDER BY FIELD(type,'rating','text'), display_order ASC, id ASC
        `, [pair.direction]);

        res.render('feedback/form', {
            title: 'Give Feedback - Profiteers PMC',
            pair,
            questions,
            subjectName: pair.discord_global_name || pair.username,
            directionVerb: DIRECTION_VERB[pair.direction]
        });
    } catch (error) {
        console.error('Error loading feedback form:', error);
        res.redirect('/feedback?error=Could not load the feedback form');
    }
});

router.post('/pair/:pairId', isAuthenticated, async (req, res) => {
    const conn = await db.getConnection();
    try {
        const [[pair]] = await conn.query('SELECT * FROM feedback_pairs WHERE id = ?', [req.params.pairId]);
        if (!pair || pair.reviewer_user_id !== req.session.userId) {
            conn.release();
            return res.redirect('/feedback?error=That feedback form was not found');
        }
        const [[cycle]] = await conn.query('SELECT status FROM feedback_cycles WHERE id = ?', [pair.cycle_id]);
        if (!cycle || cycle.status !== 'open') {
            conn.release();
            return res.redirect('/feedback?error=This feedback round is closed');
        }
        if (pair.status === 'submitted') {
            conn.release();
            return res.redirect('/feedback?error=You have already submitted that form');
        }

        const [questions] = await conn.query(
            'SELECT * FROM feedback_questions WHERE direction = ? AND is_active = 1',
            [pair.direction]
        );

        await conn.beginTransaction();
        for (const q of questions) {
            const raw = req.body['q_' + q.id];
            let rating = null;
            let text = null;
            if (q.type === 'rating') {
                const n = parseInt(raw, 10);
                if (!isNaN(n) && n >= 1 && n <= 5) rating = n;
            } else {
                text = (raw && raw.trim()) ? raw.trim() : null;
            }
            await conn.query(
                'INSERT INTO feedback_answers (pair_id, question_id, question_prompt, rating, answer_text) VALUES (?, ?, ?, ?, ?)',
                [pair.id, q.id, q.prompt, rating, text]
            );
        }
        await conn.query("UPDATE feedback_pairs SET status = 'submitted', submitted_at = NOW() WHERE id = ?", [pair.id]);
        await conn.commit();
        conn.release();
        res.redirect('/feedback?success=Feedback submitted. Thank you!');
    } catch (error) {
        try { await conn.rollback(); } catch (_) {}
        conn.release();
        console.error('Error submitting feedback:', error);
        res.redirect('/feedback?error=Failed to submit feedback');
    }
});

// ── Aggregated, anonymised results ──────────────────────────────────────────
router.get('/results', isAuthenticated, (req, res) => renderResults(req, res, req.session.userId));
router.get('/results/:userId', isAuthenticated, (req, res) =>
    renderResults(req, res, parseInt(req.params.userId, 10)));

function canViewResults(req, subjectUserId) {
    if (req.session.userId === subjectUserId) return true;
    return Array.isArray(req.user.permissions) && req.user.permissions.includes('feedback.manage');
}

async function renderResults(req, res, subjectUserId) {
    try {
        if (!subjectUserId || !canViewResults(req, subjectUserId)) {
            return res.status(403).render('error', {
                title: 'Access Denied - Profiteers PMC',
                message: 'Access Denied',
                description: 'You can only view your own feedback results.',
                user: res.locals.user
            });
        }

        const [[subject]] = await db.query(
            'SELECT id, username, discord_global_name, discord_avatar, discord_id FROM users WHERE id = ?',
            [subjectUserId]
        );
        if (!subject) return res.redirect('/feedback?error=User not found');

        const [cycles] = await db.query(`
            SELECT DISTINCT c.id, c.title, c.opened_at
            FROM feedback_cycles c
            JOIN feedback_pairs fp ON fp.cycle_id = c.id
            WHERE fp.subject_user_id = ? AND fp.status = 'submitted'
            ORDER BY c.opened_at DESC
        `, [subjectUserId]);

        const selectedCycleId = req.query.cycle
            ? parseInt(req.query.cycle, 10)
            : (cycles[0] ? cycles[0].id : null);

        const results = selectedCycleId
            ? await aggregateResults(subjectUserId, selectedCycleId)
            : null;

        res.render('feedback/results', {
            title: 'Feedback Results - Profiteers PMC',
            subject,
            cycles,
            selectedCycleId,
            results,
            isOwn: req.session.userId === subjectUserId,
            MIN_GROUP,
            DIRECTION_LABELS
        });
    } catch (error) {
        console.error('Error loading feedback results:', error);
        res.redirect('/feedback?error=Could not load results');
    }
}

async function aggregateResults(subjectUserId, cycleId) {
    // Per-direction response counts (submitted pairs).
    const [pairRows] = await db.query(`
        SELECT direction, COUNT(*) AS n
        FROM feedback_pairs
        WHERE subject_user_id = ? AND cycle_id = ? AND status = 'submitted'
        GROUP BY direction
    `, [subjectUserId, cycleId]);
    const directionCounts = { superior: 0, peer: 0, subordinate: 0 };
    pairRows.forEach(r => { directionCounts[r.direction] = r.n; });
    const totalResponses = directionCounts.superior + directionCounts.peer + directionCounts.subordinate;

    const suppressed = {
        superior: directionCounts.superior > 0 && directionCounts.superior < MIN_GROUP,
        peer: directionCounts.peer > 0 && directionCounts.peer < MIN_GROUP,
        subordinate: directionCounts.subordinate > 0 && directionCounts.subordinate < MIN_GROUP
    };

    // Rating answers.
    const [ratingRows] = await db.query(`
        SELECT fa.question_prompt, fp.direction, fa.rating
        FROM feedback_answers fa
        JOIN feedback_pairs fp ON fa.pair_id = fp.id
        WHERE fp.subject_user_id = ? AND fp.cycle_id = ?
          AND fp.status = 'submitted' AND fa.rating IS NOT NULL
        ORDER BY fa.question_prompt
    `, [subjectUserId, cycleId]);

    const ratingsMap = new Map();
    ratingRows.forEach(r => {
        if (!ratingsMap.has(r.question_prompt)) {
            ratingsMap.set(r.question_prompt, {
                prompt: r.question_prompt,
                dist: [0, 0, 0, 0, 0],
                sum: 0,
                n: 0,
                byDir: { superior: { sum: 0, n: 0 }, peer: { sum: 0, n: 0 }, subordinate: { sum: 0, n: 0 } }
            });
        }
        const agg = ratingsMap.get(r.question_prompt);
        agg.dist[r.rating - 1]++;
        agg.sum += r.rating;
        agg.n++;
        if (agg.byDir[r.direction]) {
            agg.byDir[r.direction].sum += r.rating;
            agg.byDir[r.direction].n++;
        }
    });

    const ratings = [...ratingsMap.values()].map(a => ({
        prompt: a.prompt,
        dist: a.dist,
        n: a.n,
        avg: a.n ? (a.sum / a.n) : 0,
        byDirection: ['superior', 'peer', 'subordinate'].reduce((o, d) => {
            const dd = a.byDir[d];
            o[d] = (dd.n >= MIN_GROUP) ? { n: dd.n, avg: dd.sum / dd.n } : null;
            return o;
        }, {})
    }));

    // Text answers, grouped by direction (only directions at/above the threshold).
    const [textRows] = await db.query(`
        SELECT fp.direction, fa.answer_text
        FROM feedback_answers fa
        JOIN feedback_pairs fp ON fa.pair_id = fp.id
        WHERE fp.subject_user_id = ? AND fp.cycle_id = ?
          AND fp.status = 'submitted' AND fa.answer_text IS NOT NULL AND fa.answer_text <> ''
    `, [subjectUserId, cycleId]);

    const texts = { superior: [], peer: [], subordinate: [] };
    textRows.forEach(r => { if (texts[r.direction]) texts[r.direction].push(r.answer_text); });
    // Drop text for suppressed directions.
    ['superior', 'peer', 'subordinate'].forEach(d => { if (suppressed[d]) texts[d] = []; });

    return { totalResponses, directionCounts, suppressed, ratings, texts };
}

module.exports = router;
