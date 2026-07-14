export {};
'use strict';

// ── RLS regression guard ────────────────────────────────────────────────────
// This is why the credential leak happened at all: a table (server_*,
// webauthn_credentials, email_codes, …) shipped in a migration with no
// ALTER TABLE … ENABLE ROW LEVEL SECURITY, so with the publishable anon key it
// was world-readable over PostgREST. And separately, `users` carried a
// USING (true) policy that made RLS on it decorative.
//
// This test parses supabase/migrations/*.sql statically (no live database — it
// runs in CI where none exists) and fails if either mistake is reintroduced:
//   1. every CREATE TABLE in public must have RLS enabled by some migration;
//   2. no policy anywhere may be USING (true) / USING(true) — a blanket
//      "everyone can read every row".
//
// The rule for the codebase: authorization lives in the API layer, and every
// table is RLS-on with no permissive policy. If a table ever genuinely needs
// direct browser access, add a narrow policy AND relax this guard for it
// explicitly (with a comment), rather than loosening the whole check.

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const MIGRATIONS_DIR = path.join(__dirname, '../../supabase/migrations');

function allMigrationSql(): string {
  return fs
    .readdirSync(MIGRATIONS_DIR)
    .filter((f: string) => f.endsWith('.sql'))
    .sort()
    .map((f: string) => fs.readFileSync(path.join(MIGRATIONS_DIR, f), 'utf8'))
    .join('\n');
}

// Strip line (`-- …`) and block (`/* … */`) comments so a table name mentioned
// only in prose can't be mistaken for a real DDL statement.
function stripSqlComments(sql: string): string {
  return sql.replace(/\/\*[\s\S]*?\*\//g, '').replace(/--[^\n]*/g, '');
}

describe('RLS coverage across migrations', () => {
  const sql = stripSqlComments(allMigrationSql());

  // public.<name> or bare <name>, optional quotes, after CREATE TABLE.
  const createdTables = new Set<string>();
  for (const m of sql.matchAll(/create\s+table\s+(?:if\s+not\s+exists\s+)?(?:public\.)?"?([a-z_][a-z0-9_]*)"?/gi)) {
    createdTables.add(m[1]!.toLowerCase());
  }

  const rlsEnabled = new Set<string>();
  for (const m of sql.matchAll(/alter\s+table\s+(?:if\s+exists\s+)?(?:public\.)?"?([a-z_][a-z0-9_]*)"?\s+enable\s+row\s+level\s+security/gi)) {
    rlsEnabled.add(m[1]!.toLowerCase());
  }

  it('finds a non-trivial set of tables (sanity check the parser)', () => {
    // If this ever drops to near zero the regex broke and the guard is empty.
    assert.ok(createdTables.size >= 20, `only parsed ${createdTables.size} tables — parser likely broken`);
  });

  it('every created table has RLS enabled by some migration', () => {
    const missing = [...createdTables].filter((t) => !rlsEnabled.has(t)).sort();
    assert.deepEqual(
      missing,
      [],
      `these tables are created but never get ENABLE ROW LEVEL SECURITY:\n  ${missing.join('\n  ')}\n` +
        'Add an ALTER TABLE … ENABLE ROW LEVEL SECURITY for each (see migration 031).',
    );
  });

  it('no live policy grants blanket USING (true) read access', () => {
    // A policy that a later migration DROPs is not live — e.g. the original
    // users."Public profiles readable" (migration 001) is removed by 032, and
    // must not be reported here.
    const dropped = new Set<string>();
    for (const m of sql.matchAll(/drop\s+policy\s+(?:if\s+exists\s+)?"?([^"\n]+?)"?\s+on/gi)) {
      dropped.add(m[1]!.trim().toLowerCase());
    }

    // Matches USING (true), USING(true), USING ( TRUE ), etc.
    const offenders: string[] = [];
    for (const m of sql.matchAll(/create\s+policy\s+([\s\S]*?);/gi)) {
      const stmt = m[0];
      if (!/using\s*\(\s*true\s*\)/i.test(stmt)) continue;
      const name = ((stmt.match(/create\s+policy\s+"?([^"\n]+?)"?\s+on/i) || [])[1] || '(unnamed)').trim();
      if (!dropped.has(name.toLowerCase())) offenders.push(name);
    }
    assert.deepEqual(
      offenders,
      [],
      `these live policies grant unrestricted read access (USING (true)):\n  ${offenders.join('\n  ')}\n` +
        'A permissive policy makes RLS decorative — this is exactly the users.* leak fixed in migration 032.',
    );
  });
});
