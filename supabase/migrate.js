// ── Migration runner ─────────────────────────────────────────────────────────
// Applies pending .sql files from supabase/migrations/ in filename order,
// tracking what's been applied in a `schema_migrations` table so re-running
// `npm run migrate` is always safe.
//
// Requires SUPABASE_DB_URL (or DATABASE_URL) in .env — the direct Postgres
// connection string, NOT the https API URL. Find it in the Supabase
// Dashboard: Project Settings → Database → Connection string (URI), e.g.
//   postgresql://postgres:<db-password>@db.<project-ref>.supabase.co:5432/postgres
// (supabase-js can't run DDL through the REST API, hence the direct wire.)
//
// First run against a database whose earlier migrations were applied by hand
// (the README's "paste into SQL Editor" flow): tell the runner what's
// already in place, e.g. everything up to and including 014:
//   node supabase/migrate.js --baseline 014
// That records 001..014 as applied WITHOUT executing them, after which a
// plain `npm run migrate` applies only the genuinely new ones.

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { Client } = require('pg');

const MIGRATIONS_DIR = path.join(__dirname, 'migrations');

// Thrown after a human-readable explanation has already been printed —
// signals "abort with a non-zero exit code, no extra noise".
class MigrateError extends Error {}

function listMigrations() {
  return fs.readdirSync(MIGRATIONS_DIR)
    .filter((f) => /^\d+_.+\.sql$/.test(f))
    .sort(); // zero-padded numeric prefixes -> lexicographic == numeric order
}

function parseArgs() {
  const args = process.argv.slice(2);
  const i = args.indexOf('--baseline');
  return { baseline: i !== -1 ? args[i + 1] : null };
}

async function main() {
  const dbUrl = process.env.SUPABASE_DB_URL || process.env.DATABASE_URL;
  if (!dbUrl) {
    console.error(
      'SUPABASE_DB_URL is not set.\n\n' +
      'Add the direct Postgres connection string to .env (this is different\n' +
      'from SUPABASE_URL): Supabase Dashboard → Project Settings → Database →\n' +
      'Connection string (URI). Example:\n' +
      '  SUPABASE_DB_URL=postgresql://postgres:<db-password>@db.<ref>.supabase.co:5432/postgres\n\n' +
      'Alternative without any setup: open the SQL Editor in the Supabase\n' +
      'Dashboard and paste each pending file from supabase/migrations/ by hand.'
    );
    throw new MigrateError();
  }

  const { baseline } = parseArgs();
  const isLocal = /localhost|127\.0\.0\.1/.test(dbUrl);
  const client = new Client({ connectionString: dbUrl, ssl: isLocal ? undefined : { rejectUnauthorized: false } });
  await client.connect();

  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version    TEXT PRIMARY KEY,
        applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `);

    const files = listMigrations();
    const { rows } = await client.query('SELECT version FROM schema_migrations');
    const applied = new Set(rows.map((r) => r.version));

    if (baseline) {
      const upTo = files.filter((f) => f.split('_')[0] <= baseline);
      for (const f of upTo) {
        if (applied.has(f)) continue;
        await client.query('INSERT INTO schema_migrations (version) VALUES ($1)', [f]);
        console.log(`baseline: recorded ${f} as already applied (not executed)`);
      }
      applied.clear();
      (await client.query('SELECT version FROM schema_migrations')).rows.forEach((r) => applied.add(r.version));
    }

    // Guard against the classic first-run footgun: schema exists (manual SQL
    // Editor era) but nothing is recorded — running 001_init.sql on top of a
    // live schema would fail halfway at best. Force an explicit baseline.
    if (applied.size === 0) {
      const { rows: t } = await client.query(
        "SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'users'"
      );
      if (t.length > 0) {
        console.error(
          'This database already has a schema (users table exists) but no\n' +
          'schema_migrations history — earlier migrations were likely applied\n' +
          'manually via the SQL Editor. Tell the runner what is already in\n' +
          'place, e.g. if everything up to 014 is applied:\n\n' +
          '  node supabase/migrate.js --baseline 014\n\n' +
          'Then re-run `npm run migrate` to apply the rest.'
        );
        throw new MigrateError();
      }
    }

    const pending = files.filter((f) => !applied.has(f));
    if (pending.length === 0) {
      console.log('Nothing to apply — database is up to date.');
      return;
    }

    for (const f of pending) {
      const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, f), 'utf8');
      process.stdout.write(`applying ${f} ... `);
      try {
        await client.query('BEGIN');
        await client.query(sql);
        await client.query('INSERT INTO schema_migrations (version) VALUES ($1)', [f]);
        await client.query('COMMIT');
        console.log('ok');
      } catch (err) {
        await client.query('ROLLBACK');
        console.log('FAILED');
        console.error(`\n${f}: ${err.message}\n`);
        console.error('Migration rolled back; nothing after it was attempted.');
        throw new MigrateError();
      }
    }
    console.log(`Done — ${pending.length} migration(s) applied.`);
  } finally {
    await client.end();
  }
}

main().catch((err) => {
  // MigrateError means the explanation was already printed above.
  if (!(err instanceof MigrateError)) console.error(err.message || err);
  process.exitCode = 1;
});
