// Content rules, strictness, signals and reports (migration 0014, applied after 0004 to 0013) against an in-process Postgres.
// Simulates the parts of Supabase the migrations rely on (auth.users, anon / authenticated /
// service_role and Supabase's default privileges). Not a substitute for testing on the real project.
// Run after: npm i --no-save @electric-sql/pglite   (or set PGLITE_DIR to the package folder)
//   node docs/testing/qa/content-rules-sql.test.mjs
import { readFileSync } from "node:fs";
import path from "node:path";

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..", "..", "..");
const pglite = await import(
  process.env.PGLITE_DIR ? path.join(process.env.PGLITE_DIR, "dist/index.js") : "@electric-sql/pglite"
).catch(() => {
  console.log("Install the test database first: npm i --no-save @electric-sql/pglite (or set PGLITE_DIR).");
  process.exit(2);
});
const { PGlite } = pglite;

const results = [];
const check = (id, name, ok, detail = "") => results.push(`${ok ? "PASS" : "FAIL"} ${id} ${name}${!ok && detail ? `\n     ${detail}` : ""}`);
const migration = (f) => readFileSync(path.join(root, "supabase/migrations", f), "utf8");
const db = new PGlite();

// --- Simulated Supabase (same as admin-power-sql.test.mjs) --------------------------------------
await db.exec(`
  create role anon nologin;
  create role authenticated nologin;
  create role service_role nologin bypassrls;
  alter default privileges in schema public grant all on tables to anon, authenticated, service_role;
  alter default privileges in schema public grant all on sequences to anon, authenticated, service_role;
  alter default privileges in schema public grant all on functions to anon, authenticated, service_role;
  create schema auth;
  create table auth.users (
    id uuid primary key default gen_random_uuid(),
    email text,
    created_at timestamptz not null default now(),
    last_sign_in_at timestamptz,
    raw_app_meta_data jsonb not null default '{}'::jsonb,
    raw_user_meta_data jsonb not null default '{}'::jsonb
  );
  create table public.rooms (
    id uuid primary key default gen_random_uuid(),
    code text not null,
    host_id uuid not null references auth.users (id) on delete cascade,
    created_at timestamptz not null default now(),
    closed_at timestamptz
  );
  create table public.content_items (
    id uuid primary key default gen_random_uuid(),
    game_id text not null,
    level text not null check (level in ('kids', 'family', 'adults')),
    data jsonb not null,
    source text not null default 'manual',
    approved boolean not null default false,
    created_at timestamptz not null default now()
  );
  alter table public.content_items enable row level security;
  grant usage on schema public, auth to anon, authenticated, service_role;
  grant select, insert, update, delete on all tables in schema public to service_role;
  grant select on auth.users to service_role;
`);
const FILES = [
  "0004_admin_and_events.sql", "0005_admin_stats_and_retention.sql", "0006_lasting_room_counts_and_safe_stats.sql",
  "0007_power_admin.sql", "0008_review_followups.sql", "0009_session_revocation_and_atomic_lockout.sql", "0010_content_library.sql",
  "0011_library_theme.sql", "0012_kbc_news.sql", "0013_spin_bottle_library.sql", "0014_content_rules_signals.sql",
];
let migrationsOk = true;
for (const f of FILES) {
  try {
    await db.exec(migration(f));
  } catch (e) {
    migrationsOk = false;
    check("MIG", `migration ${f} applies cleanly`, false, e.message.split("\n")[0]);
  }
}
check("MIG-1", "migrations 0004 to 0014 apply cleanly in order", migrationsOk);
const rerun = await db.exec(migration("0014_content_rules_signals.sql")).then(() => null, (e) => e.message.split("\n")[0]);
check("MIG-2", "0014 can be run a second time", rerun === null, rerun ?? "");

const asRole = async (role, sql, params) => {
  try {
    await db.exec(`set role ${role}`);
    const r = await db.query(sql, params);
    return { ok: true, rows: r.rows };
  } catch (e) {
    return { ok: false, error: e.message };
  } finally {
    await db.exec("reset role");
  }
};
const svc = (sql, params) => asRole("service_role", sql, params);
const TABLES = ["content_rules", "content_policy", "content_signals", "content_reports"];

// --- Access control -----------------------------------------------------------------------------
const rls = (await db.query(`select relname, relrowsecurity from pg_class where relnamespace = 'public'::regnamespace and relname = any($1)`, [TABLES])).rows;
check("ACC-1", "row-level security is on for all four new tables", rls.length === 4 && rls.every((r) => r.relrowsecurity), JSON.stringify(rls));
const privs = (await db.query(`
  select c.relname, r.rolname, p.priv from pg_class c
  cross join (values ('anon'), ('authenticated')) r(rolname)
  cross join (values ('SELECT'), ('INSERT'), ('UPDATE'), ('DELETE'), ('TRUNCATE')) p(priv)
  where c.relnamespace = 'public'::regnamespace and c.relkind = 'r' and c.relname = any($1)
    and has_table_privilege(r.rolname, c.oid, p.priv)`, [TABLES])).rows;
check("ACC-2", "anon and authenticated hold no privilege on the new tables", privs.length === 0, JSON.stringify(privs));
for (const role of ["anon", "authenticated"]) {
  const a = await asRole(role, `select * from signal_add('bottle-prompts', 'college', null, '[{"key":"x y z","event":"shown"}]'::jsonb)`);
  const b = await asRole(role, `select library_set_off('bottle-prompts', array['x'], 'reports', true)`);
  check(`ACC-3-${role}`, `${role} can't run signal_add or library_set_off`, !a.ok && !b.ok, JSON.stringify([a.ok, b.ok]));
}

// --- Signals -------------------------------------------------------------------------------------
const items = JSON.stringify([
  { key: "Pitch a startup in 30 seconds!", event: "shown" },
  { key: "pitch a STARTUP in 30 seconds", event: "flipped" },
  { key: "Pitch a startup in 30 seconds", event: "passed" },
  { key: "Pitch a startup in 30 seconds", event: "bogus" },
  { key: "", event: "shown" },
]);
const s1 = await svc(`select * from signal_add('bottle-prompts', 'college', null, $1::jsonb)`, [items]);
const row = s1.ok ? s1.rows[0] : null;
check("SIG-1", "signals count by normalised text (case and punctuation ignored)", !!row && Number(row.shown) === 1 && Number(row.flipped) === 1 && Number(row.passed) === 1, JSON.stringify(s1));
check("SIG-2", "unknown events and empty keys are ignored", s1.ok && s1.rows.length === 1, JSON.stringify(s1.rows ?? s1.error));
const tooMany = await svc(`select * from signal_add('bottle-prompts', 'college', null, $1::jsonb)`, [JSON.stringify(Array.from({ length: 101 }, () => ({ key: "a b", event: "shown" })))]);
check("SIG-3", "a batch of more than 100 items is refused", !tooMany.ok, "accepted");
const badKind = await svc(`select * from signal_add('Bad Kind!', 'college', null, '[]'::jsonb)`);
check("SIG-4", "a malformed kind is refused", !badKind.ok, "accepted");

// --- Reports count once per room -------------------------------------------------------------------
const rep = (room) => svc(`select * from signal_add('bottle-prompts', 'college', $1, '[{"key":"Bad card here","event":"reported"}]'::jsonb)`, [room]);
await rep("a".repeat(32));
await rep("a".repeat(32));
const r3 = await rep("b".repeat(32));
check("REP-1", "the same room reporting twice counts once; a second room counts", r3.ok && Number(r3.rows[0]?.reported_rooms) === 2, JSON.stringify(r3.rows ?? r3.error));
const noRoom = await svc(`select * from signal_add('bottle-prompts', 'college', null, '[{"key":"Other card","event":"reported"}]'::jsonb)`);
check("REP-2", "a report without a room is ignored", noRoom.ok && noRoom.rows.length === 0, JSON.stringify(noRoom.rows ?? noRoom.error));
const leak = (await svc(`select count(*)::int n from content_reports where room_hash !~ '^[0-9a-f]+$'`)).rows[0].n;
check("REP-3", "reports store only a hash of the room", leak === 0, `got ${leak}`);

// --- Quarantine (switch off with a reason) ----------------------------------------------------------
await svc(`select library_add('bottle-prompts', 'spin-bottle', 'en', 'llm:test', '[{"category":"college","key":"Bad card here","data":{"kind":"dare","text":"Bad card here"}}]'::jsonb, null, null, false)`);
const off = await svc(`select library_set_off('bottle-prompts', array[library_norm('Bad card here')], 'reports', true) n`);
const st = (await svc(`select active, off_reason from content_library where text_key = 'Bad card here'`)).rows[0];
check("QUA-1", "library_set_off switches an item off with its reason", off.ok && off.rows[0].n === 1 && st.active === false && st.off_reason === "reports", JSON.stringify([off, st]));
const wrongUndo = await svc(`select library_set_off('bottle-prompts', array[library_norm('Bad card here')], 'signals', false) n`);
check("QUA-2", "undoing with a different reason doesn't switch it back on", wrongUndo.ok && wrongUndo.rows[0].n === 0, JSON.stringify(wrongUndo));
const undo = await svc(`select library_set_off('bottle-prompts', array[library_norm('Bad card here')], null, false) n`);
const st2 = (await svc(`select active, off_reason from content_library where text_key = 'Bad card here'`)).rows[0];
check("QUA-3", "the admin can switch it back on, which clears the reason", undo.ok && undo.rows[0].n === 1 && st2.active === true && st2.off_reason === null, JSON.stringify([undo, st2]));
const badReason = await svc(`select library_set_off('bottle-prompts', array['x'], 'Bad Reason!', true)`);
check("QUA-4", "a malformed reason is refused", !badReason.ok, "accepted");

// --- Rules and policy constraints --------------------------------------------------------------------
const goodRule = await svc(`insert into content_rules (rule_type, match_type, pattern, scope) values ('block', 'word', 'cricket', 'all') returning id`);
const badRule = await svc(`insert into content_rules (rule_type, match_type, pattern, scope) values ('nope', 'word', 'x', 'all')`);
const badScope = await svc(`insert into content_rules (rule_type, pattern, scope) values ('block', 'x', 'Not A Scope')`);
check("RUL-1", "a valid rule is stored; bad type or scope is refused", goodRule.ok && !badRule.ok && !badScope.ok, JSON.stringify([goodRule.ok, badRule.ok, badScope.ok]));
const pol = await svc(`insert into content_policy (key, value) values ('spin-bottle', '{"college":{"social":false}}') on conflict (key) do update set value = excluded.value returning key`);
const badPol = await svc(`insert into content_policy (key, value) values ('x', '[1,2]')`);
check("POL-1", "policy stores an object and refuses a non-object", pol.ok && !badPol.ok, JSON.stringify([pol.ok, badPol.ok]));

console.log(results.join("\n"));
const failed = results.filter((r) => r.startsWith("FAIL")).length;
console.log(`\n${results.length - failed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
