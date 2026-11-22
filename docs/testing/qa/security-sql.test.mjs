// Security hardening (migration 0015: shared rate limiter, room functions server-only, per-host signals)
// against an in-process Postgres, after 0002-0003 and 0004 to 0014.
// Simulates the parts of Supabase the migrations rely on (auth.users, anon / authenticated /
// service_role and Supabase's default privileges). Not a substitute for testing on the real project.
// Run after: npm i --no-save @electric-sql/pglite   (or set PGLITE_DIR to the package folder)
//   node docs/testing/qa/security-sql.test.mjs
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
// Supabase's auth.uid(), read from a setting the test can change.
await db.exec(`create or replace function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('test.uid', true), '')::uuid $$;
  grant execute on function auth.uid() to anon, authenticated, service_role;`);
const FILES = [
  "0002_room_security.sql", "0003_close_room.sql",
  "0004_admin_and_events.sql", "0005_admin_stats_and_retention.sql", "0006_lasting_room_counts_and_safe_stats.sql",
  "0007_power_admin.sql", "0008_review_followups.sql", "0009_session_revocation_and_atomic_lockout.sql", "0010_content_library.sql",
  "0011_library_theme.sql", "0012_kbc_news.sql", "0013_spin_bottle_library.sql", "0014_content_rules_signals.sql", "0015_security_hardening.sql",
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
check("MIG-1", "migrations 0002 to 0015 apply cleanly in order", migrationsOk);
const rerun = await db.exec(migration("0015_security_hardening.sql")).then(() => null, (e) => e.message.split("\n")[0]);
check("MIG-2", "0015 can be run a second time", rerun === null, rerun ?? "");

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

// --- Room functions are server-only now ---------------------------------------------------------
const [hostA, hostB, hostC, hostD] = (await db.query(`insert into auth.users (email) values ('a@x.test'),('b@x.test'),('c@x.test'),('d@x.test') returning id`)).rows.map((r) => r.id);
await db.query(`insert into public.rooms (code, host_id) values ('ABCD', $1)`, [hostA]);
for (const role of ["anon", "authenticated"]) {
  const a = await asRole(role, `select * from room_lookup('ABCD')`);
  const b = await asRole(role, `select room_is_ended('ABCD')`);
  check(`ROOM-1-${role}`, `${role} can no longer call room_lookup or room_is_ended directly (no code guessing at full speed)`, !a.ok && !b.ok, JSON.stringify([a.ok, b.ok]));
}
const s1 = await svc(`select * from room_lookup('ABCD')`);
check("ROOM-2", "the app's server (service role) can still look a room up", s1.ok && s1.rows.length === 1, JSON.stringify(s1));
for (const fn of ["create_room()", "set_room_key('ABCD', 'k')", "close_room('ABCD')"]) {
  const r = await asRole("anon", `select ${fn}`);
  check(`ROOM-3 ${fn.split("(")[0]}`, `anon can't call ${fn.split("(")[0]}`, !r.ok && /permission denied/i.test(r.error), r.error ?? "called");
}

// --- Shared rate limiter ----------------------------------------------------------------------------
let ok = 0;
for (let i = 0; i < 8; i++) if ((await svc(`select rate_hit('t:1', 60, 5) as ok`)).rows[0].ok) ok++;
check("RATE-1", "rate_hit allows the first 5 hits in a window and refuses the rest", ok === 5, `allowed ${ok}`);
const other = (await svc(`select rate_hit('t:2', 60, 5) as ok`)).rows[0].ok;
check("RATE-2", "a different key has its own count", other === true);
const badArgs = await svc(`select rate_hit('', 60, 5)`);
check("RATE-3", "bad arguments are refused", !badArgs.ok);
const anonRate = await asRole("anon", `select rate_hit('x', 60, 5)`);
check("RATE-4", "browsers can't call rate_hit or read the buckets", !anonRate.ok);

// --- Signals: per host, served items only, distinct hosts ---------------------------------------------
const voter = (u) => u.replace(/-/g, "").slice(0, 32);
await svc(`select library_add('bottle-prompts','spin-bottle','en','llm:test','[{"category":"college","key":"Pitch a startup in 30 seconds","data":{"kind":"dare","text":"Pitch a startup in 30 seconds"}}]'::jsonb,null,null,false)`);
const add = (u, items, builtin = []) => svc(`select * from signal_add_v2('bottle-prompts','college',$1,$2::uuid,$3::jsonb,$4::text[])`, [voter(u), u, JSON.stringify(items), builtin]);
const card = "Pitch a startup in 30 seconds";
const notServed = await add(hostA, [{ key: card, event: "reported" }, { key: "Some text that is not a card", event: "flipped" }]);
check("SIG-1", "an item this host was never served (and random text) is ignored", notServed.ok && notServed.rows.length === 0, JSON.stringify(notServed.rows ?? notServed.error));
// Serve the card to hosts A-D (as the library does when a game picks it).
for (const u of [hostA, hostB, hostC, hostD]) await svc(`select * from library_pick($1::uuid, null, 'bottle-prompts', array['college'], 'en', 5, 1, '{}'::text[], '{}'::text[])`, [u]);
let r = await add(hostA, [{ key: card, event: "shown" }, { key: card, event: "flipped" }, { key: card, event: "reported" }]);
for (let i = 0; i < 10; i++) r = await add(hostA, [{ key: card, event: "shown" }, { key: card, event: "flipped" }, { key: card, event: "reported" }]);
const lastA = (await svc(`select shown, flipped, reported from content_signals where text_norm = library_norm($1)`, [card])).rows[0];
check("SIG-2", "one host replaying a batch 11 times counts once per event per day", lastA && Number(lastA.shown) === 1 && Number(lastA.flipped) === 1 && Number(lastA.reported) === 1, JSON.stringify(lastA));
await add(hostB, [{ key: card, event: "reported" }]);
r = await add(hostC, [{ key: card, event: "reported" }]);
check("SIG-3", "reports are counted per host: three different hosts = 3", r.ok && Number(r.rows[0]?.reported_voters) === 3 && Number(r.rows[0]?.voters) === 3, JSON.stringify(r.rows ?? r.error));
const builtinRes = await add(hostD, [{ key: "Talk only in questions until your next turn.", event: "shown" }], ["talk only in questions until your next turn"]);
check("SIG-4", "built-in deck texts passed by the app are accepted without a library row", builtinRes.ok && builtinRes.rows.length === 1, JSON.stringify(builtinRes.rows ?? builtinRes.error));
const noVoter = await svc(`select * from signal_add_v2('bottle-prompts','college',null,null,'[]'::jsonb)`);
check("SIG-5", "a signal batch without a host is refused", !noVoter.ok);
const anonSig = await asRole("anon", `select * from signal_add_v2('bottle-prompts','college','${"a".repeat(32)}','${hostA}','[]'::jsonb)`);
check("SIG-6", "browsers can't call signal_add_v2 or read the votes", !anonSig.ok);
const leak = (await svc(`select count(*)::int n from content_votes where voter !~ '^[0-9a-f]+$'`)).rows[0].n;
check("SIG-7", "votes store only a one-way host hash", leak === 0);

console.log(results.join("\n"));
const failed = results.filter((x) => x.startsWith("FAIL")).length;
console.log(`\n${results.length - failed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
