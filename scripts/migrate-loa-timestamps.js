/**
 * One-time migration: convert leave_of_absence date columns from DATETIME to BIGINT (Unix seconds).
 *
 * Run with:  node scripts/migrate-loa-timestamps.js
 *
 * The script is safe to call multiple times — it detects the current DB state and
 * either completes remaining steps or exits cleanly if already done.
 */

require('dotenv').config({ quiet: true });
const mysql = require('mysql2/promise');

const DB = {
    host:     process.env.DB_HOST     || 'localhost',
    user:     process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME,
    port:     process.env.DB_PORT     || 3306,
    multipleStatements: false,
};

// ─── helpers ────────────────────────────────────────────────────────────────

function log(msg)  { console.log(`  ${msg}`); }
function ok(msg)   { console.log(`  ✅ ${msg}`); }
function warn(msg) { console.log(`  ⚠️  ${msg}`); }
function fail(msg) { console.error(`  ❌ ${msg}`); }

async function getColumnType(conn, column) {
    const [rows] = await conn.query(`
        SELECT DATA_TYPE FROM INFORMATION_SCHEMA.COLUMNS
        WHERE TABLE_SCHEMA = DATABASE()
          AND TABLE_NAME   = 'leave_of_absence'
          AND COLUMN_NAME  = ?
    `, [column]);
    return rows[0]?.DATA_TYPE ?? null;
}

async function indexExists(conn, indexName) {
    const [rows] = await conn.query(`
        SELECT COUNT(*) AS n FROM INFORMATION_SCHEMA.STATISTICS
        WHERE TABLE_SCHEMA = DATABASE()
          AND TABLE_NAME   = 'leave_of_absence'
          AND INDEX_NAME   = ?
    `, [indexName]);
    return rows[0].n > 0;
}

async function tempColumnExists(conn, column) {
    return (await getColumnType(conn, column)) !== null;
}

// ─── verification ────────────────────────────────────────────────────────────

async function verify(conn, rowCountBefore) {
    console.log('\n  Running data integrity checks…');

    const [[{ total }]] = await conn.query('SELECT COUNT(*) AS total FROM leave_of_absence');
    if (total !== rowCountBefore) {
        throw new Error(`Row count mismatch! Before: ${rowCountBefore}, After: ${total}`);
    }
    ok(`Row count preserved (${total} rows)`);

    const [[{ nulls }]] = await conn.query(`
        SELECT COUNT(*) AS nulls FROM leave_of_absence
        WHERE start_date IS NULL OR end_date IS NULL OR submitted_at IS NULL
    `);
    if (nulls > 0) throw new Error(`${nulls} rows have NULL in required date columns after migration`);
    ok('No NULL values in required date columns');

    const [[{ bad }]] = await conn.query(`
        SELECT COUNT(*) AS bad FROM leave_of_absence
        WHERE start_date < UNIX_TIMESTAMP('2020-01-01')
           OR start_date > UNIX_TIMESTAMP('2100-01-01')
           OR end_date   < UNIX_TIMESTAMP('2020-01-01')
           OR end_date   > UNIX_TIMESTAMP('2100-01-01')
    `);
    if (bad > 0) throw new Error(`${bad} rows have timestamps outside the expected range (2020–2100)`);
    ok('All timestamps are within a reasonable date range');

    const [[{ invalid }]] = await conn.query(`
        SELECT COUNT(*) AS invalid FROM leave_of_absence WHERE end_date <= start_date
    `);
    if (invalid > 0) warn(`${invalid} rows have end_date <= start_date (pre-existing data issue, not caused by migration)`);
    else ok('All LOAs have end_date > start_date');
}

// ─── migration steps ─────────────────────────────────────────────────────────

async function runStep1_AddTempColumns(conn) {
    log('Step 1/5 — Adding temporary BIGINT columns…');
    for (const [tmpCol, afterCol] of [
        ['start_date_new',   'start_date'],
        ['end_date_new',     'end_date'],
        ['submitted_at_new', 'submitted_at'],
        ['reviewed_at_new',  'reviewed_at'],
    ]) {
        if (!(await tempColumnExists(conn, tmpCol))) {
            await conn.query(`ALTER TABLE leave_of_absence ADD COLUMN ${tmpCol} BIGINT NULL AFTER ${afterCol}`);
        }
    }
    ok('Temporary columns ready');
}

async function runStep2_CopyData(conn) {
    log('Step 2/5 — Converting DATETIME values to Unix timestamps…');
    await conn.query(`
        UPDATE leave_of_absence SET
            start_date_new   = UNIX_TIMESTAMP(start_date),
            end_date_new     = UNIX_TIMESTAMP(end_date),
            submitted_at_new = UNIX_TIMESTAMP(submitted_at),
            reviewed_at_new  = IF(reviewed_at IS NOT NULL, UNIX_TIMESTAMP(reviewed_at), NULL)
    `);

    // Spot-check: ensure no temp column is 0 where the source wasn't NULL/zero
    const [[{ zeroes }]] = await conn.query(`
        SELECT COUNT(*) AS zeroes FROM leave_of_absence
        WHERE start_date_new = 0 OR end_date_new = 0 OR submitted_at_new = 0
    `);
    if (zeroes > 0) throw new Error(`${zeroes} rows converted to timestamp 0 — original DATETIME values may be invalid`);

    const [[{ nulls }]] = await conn.query(`
        SELECT COUNT(*) AS nulls FROM leave_of_absence
        WHERE start_date_new IS NULL OR end_date_new IS NULL OR submitted_at_new IS NULL
    `);
    if (nulls > 0) {
        // Show which rows are affected so the user can inspect/fix before continuing
        const [badRows] = await conn.query(`
            SELECT id, start_date_new, end_date_new, submitted_at_new
            FROM leave_of_absence
            WHERE start_date_new IS NULL OR end_date_new IS NULL OR submitted_at_new IS NULL
        `);
        warn(`${nulls} row(s) have NULL temp columns (original DATETIME was invalid):`);
        badRows.forEach(r => warn(`  id=${r.id}  start=${r.start_date_new}  end=${r.end_date_new}  submitted=${r.submitted_at_new}`));
        throw new Error('Fix the NULL rows above before continuing (update start_date_new / end_date_new / submitted_at_new directly, then re-run).');
    }
    ok('All values converted successfully');
}

async function runStep3_DropOldColumns(conn) {
    log('Step 3/5 — Dropping old DATETIME columns…');
    const colType = await getColumnType(conn, 'start_date');
    if (colType === 'datetime') {
        // idx_user_dates (user_id, start_date, end_date) may be the only index
        // supporting the FK on user_id. Add a temporary standalone index first
        // so MySQL doesn't block the drop.
        if (await indexExists(conn, 'idx_user_dates') && !(await indexExists(conn, 'idx_user_id_temp'))) {
            await conn.query('ALTER TABLE leave_of_absence ADD INDEX idx_user_id_temp (user_id)');
        }

        for (const idx of ['idx_user_dates', 'idx_dates']) {
            if (await indexExists(conn, idx)) {
                await conn.query(`ALTER TABLE leave_of_absence DROP INDEX ${idx}`);
            }
        }
        await conn.query(`
            ALTER TABLE leave_of_absence
                DROP COLUMN start_date,
                DROP COLUMN end_date,
                DROP COLUMN submitted_at,
                DROP COLUMN reviewed_at
        `);
    }
    ok('Old DATETIME columns removed');
}

async function runStep4_RenameColumns(conn) {
    log('Step 4/5 — Renaming temporary columns to final names…');

    // Rename with NULL allowed first to avoid strict-mode truncation errors,
    // then tighten the NOT NULL constraints in a second pass.
    const pairs = [
        ['start_date_new',   'start_date'],
        ['end_date_new',     'end_date'],
        ['submitted_at_new', 'submitted_at'],
        ['reviewed_at_new',  'reviewed_at'],
    ];
    for (const [oldName, newName] of pairs) {
        if (await tempColumnExists(conn, oldName)) {
            await conn.query(`ALTER TABLE leave_of_absence CHANGE COLUMN ${oldName} ${newName} BIGINT NULL`);
        }
    }

    // Apply final constraints now that all columns exist under their real names
    await conn.query(`ALTER TABLE leave_of_absence MODIFY COLUMN start_date   BIGINT NOT NULL`);
    await conn.query(`ALTER TABLE leave_of_absence MODIFY COLUMN end_date     BIGINT NOT NULL`);
    await conn.query(`ALTER TABLE leave_of_absence MODIFY COLUMN submitted_at BIGINT NOT NULL DEFAULT (UNIX_TIMESTAMP())`);
    // reviewed_at stays nullable — no MODIFY needed

    ok('Columns renamed');
}

async function runStep5_RebuildIndexesAndView(conn) {
    log('Step 5/5 — Rebuilding indexes and active_loas view…');

    for (const [idx, cols] of [
        ['idx_user_dates', '(user_id, start_date, end_date)'],
        ['idx_dates',      '(start_date, end_date)'],
    ]) {
        if (await indexExists(conn, idx)) {
            await conn.query(`ALTER TABLE leave_of_absence DROP INDEX ${idx}`);
        }
        await conn.query(`ALTER TABLE leave_of_absence ADD INDEX ${idx} ${cols}`);
    }

    // Drop the temporary user_id index now that idx_user_dates is back
    if (await indexExists(conn, 'idx_user_id_temp')) {
        await conn.query('ALTER TABLE leave_of_absence DROP INDEX idx_user_id_temp');
    }
    ok('Indexes rebuilt');

    await conn.query('DROP VIEW IF EXISTS active_loas');
    await conn.query(`
        CREATE VIEW active_loas AS
        SELECT
            loa.id, loa.user_id, loa.start_date, loa.end_date, loa.reason,
            loa.superior_id, loa.status, loa.submitted_at,
            loa.reviewed_by, loa.reviewed_at, loa.review_notes,
            u.username, u.discord_global_name, u.discord_avatar,
            sup.username            AS superior_username,
            sup.discord_global_name AS superior_display_name
        FROM leave_of_absence loa
        JOIN  users u   ON loa.user_id    = u.id
        LEFT JOIN users sup ON loa.superior_id = sup.id
        WHERE loa.status    = 'approved'
          AND loa.start_date <= UNIX_TIMESTAMP()
          AND loa.end_date   >= UNIX_TIMESTAMP()
    `);
    ok('active_loas view recreated');
}

// ─── main ─────────────────────────────────────────────────────────────────────

async function main() {
    console.log('\n🔄 LOA Unix Timestamp Migration\n');

    const conn = await mysql.createConnection(DB);

    try {
        // Detect current state
        const startType = await getColumnType(conn, 'start_date');
        const hasTempCols =
            (await tempColumnExists(conn, 'start_date_new'))   ||
            (await tempColumnExists(conn, 'end_date_new'))     ||
            (await tempColumnExists(conn, 'submitted_at_new')) ||
            (await tempColumnExists(conn, 'reviewed_at_new'));

        if (startType === null && !hasTempCols) {
            fail('Table leave_of_absence not found. Is the DB correct?');
            process.exit(1);
        }

        // Fully done: final column names are BIGINT, no temp cols, indexes exist
        if (!hasTempCols && startType === 'bigint' && await indexExists(conn, 'idx_user_dates')) {
            ok('Migration already complete — nothing to do.');
            process.exit(0);
        }

        // Partial run: some temp cols already renamed but not all, or indexes/view missing
        if (!hasTempCols && startType === 'bigint') {
            console.log('  Detected partial migration (columns done, indexes/view missing).');
            console.log('  Resuming from Step 5…\n');
            await runStep5_RebuildIndexesAndView(conn);
            const [[{ total }]] = await conn.query('SELECT COUNT(*) AS total FROM leave_of_absence');
            ok(`Done. ${total} LOA rows intact.`);
            process.exit(0);
        }

        if (hasTempCols && (startType === 'bigint' || startType === null)) {
            console.log('  Detected partial migration (some columns still need renaming).');
            console.log('  Resuming from Step 4…\n');
            const [[{ rowCount }]] = await conn.query('SELECT COUNT(*) AS rowCount FROM leave_of_absence');
            await runStep4_RenameColumns(conn);
            await runStep5_RebuildIndexesAndView(conn);
            await verify(conn, rowCount);
            console.log('\n✅ Migration complete. All data preserved.\n');
            process.exit(0);
        }

        // Full migration needed
        const [[{ rowCountBefore }]] = await conn.query('SELECT COUNT(*) AS rowCountBefore FROM leave_of_absence');
        log(`Found ${rowCountBefore} LOA rows to migrate.\n`);

        await runStep1_AddTempColumns(conn);
        await runStep2_CopyData(conn);
        await runStep3_DropOldColumns(conn);
        await runStep4_RenameColumns(conn);
        await runStep5_RebuildIndexesAndView(conn);
        await verify(conn, rowCountBefore);

        console.log('\n✅ Migration complete. All data preserved.\n');

    } catch (err) {
        console.log('');
        fail(`Migration failed: ${err.message}`);
        console.error(err);
        console.log('\n  The database has NOT been left in a broken state — run the script again to resume.\n');
        process.exit(1);
    } finally {
        await conn.end();
    }
}

main();
