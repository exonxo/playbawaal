// Fresh for the host and their regulars (migration 0016: library_pick_group) against an in-process Postgres.
// Simulates the parts of Supabase the migrations rely on (auth.users, anon / authenticated /
// service_role and Supabase's default privileges). Not a substitute for testing on the real project.
// Run after: npm i --no-save @electric-sql/pglite   (or set PGLITE_DIR to the package folder)
//   node docs/testing/qa/freshness-sql.test.mjs
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
  "0011_library_theme.sql", "0012_kbc_news.sql", "0013_spin_bottle_library.sql", "0014_content_rules_signals.sql", "0015_security_hardening.sql", "0016_regulars_freshness.sql",
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
check("MIG-1", "migrations 0002 to 0016 apply cleanly in order", migrationsOk);
const rerun = await db.exec(migration("0016_regulars_freshness.sql")).then(() => null, (e) => e.message.split("\n")[0]);
check("MIG-2", "0016 can be run a second time", rerun === null, rerun ?? "");

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

const [host, host2] = (await db.query(`insert into auth.users (email) values ('h@x.test'), ('h2@x.test') returning id`)).rows.map((r) => r.id);
const items = Array.from({ length: 30 }, (_, i) => ({ category: "family", key: `Answer ${i}`, data: { emojis: "🎬", answer: `Answer ${i}`, hint: "h", category: "Movie", level: "family" } }));
await svc(`select library_add('emoji-puzzle','emoji-picture','en','llm:t',$1::jsonb,null,null,false)`, [JSON.stringify(items)]);
const P1 = "a".repeat(32), P2 = "b".repeat(32);
const pickGroup = (u, players, n = 10, min = 10) => svc(`select * from library_pick_group($1::uuid, $2::text[], 'emoji-puzzle', array['family'], 'en', ${n}, ${min}, '{}'::text[], '{}'::text[])`, [u, players]);
const pickHost = (u, n = 10) => svc(`select * from library_pick($1::uuid, null, 'emoji-puzzle', array['family'], 'en', ${n}, ${n}, '{}'::text[], '{}'::text[])`, [u]);
const answers = (r) => r.rows.map((x) => x.data.answer);
// Player 1 played at host2's party: saw 10 items there.
const atOther = answers(await pickGroup(host2, [P1]));
check("GRP-1", "a group pick serves items and records them for the host and every player", atOther.length === 10 && (await svc(`select count(*)::int n from content_seen where viewer = 'a:${P1}'`)).rows[0].n === 10);
// Now player 1 joins host 1's party: host 1 never saw those, but player 1 did.
const atHome = answers(await pickGroup(host, [P1, P2]));
check("GRP-2", "items any player in the room has seen (even at another host's party) are skipped", atHome.length === 10 && !atHome.some((a) => atOther.includes(a)), JSON.stringify(atHome));
const third = answers(await pickGroup(host, [P2], 10, 10));
check("GRP-3", "and items the host has seen are skipped too", third.length === 10 && !third.some((a) => atHome.includes(a)));
const none = await pickGroup(host, [P1, P2], 10, 10);
check("GRP-4", "when nothing is fresh for the whole room, nothing is served (the AI is asked instead)", none.ok && none.rows.length === 0);
const junk = await pickGroup(host2, ["x", "bad id!", "c".repeat(32)], 5, 1);
check("GRP-5", "malformed player ids are ignored, valid ones still work", junk.ok);
const leak = (await svc(`select count(*)::int n from content_seen where viewer like 'a:%' and user_id is not null`)).rows[0].n;
check("GRP-6", "player rows carry no account id", leak === 0);
const anon = await asRole("anon", `select * from library_pick_group('${host}', array['${P1}'], 'emoji-puzzle', array['family'])`);
check("GRP-7", "browsers can't call library_pick_group", !anon.ok);
const solo = answers(await pickHost(host2, 5));
check("GRP-8", "the old host-only pick still works alongside", solo.length === 5);

console.log(results.join("\n"));
const failed = results.filter((x) => x.startsWith("FAIL")).length;
console.log(`\n${results.length - failed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
