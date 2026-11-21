# Round 13: content engine core (rules, strictness, signals, reports)

First of four admin rounds. The app keeps making and picking content on its own; the admin steers it
from a new **Engine** tab instead of approving items one by one.

## What's new

**Migration `0014_content_rules_signals.sql`** (owner applies it, after 0013). Until it is applied,
everything below quietly does nothing and the app behaves as before.

| Table / function | What it holds |
|---|---|
| `content_rules` | Admin rules: block a word, ban a topic, or allow an exception. Scope = everything or one kind. |
| `content_policy` | Strictness settings, key `spin-bottle`: kinds of prompt switched off per mood. |
| `content_signals` | Per item (kind + mood/level + normalised text): shown, done, passed, flipped, skipped, loved, reported. |
| `content_reports` | One row per item per room (a one-way room hash), so one room can't report an item many times. |
| `content_library.off_reason`, `off_at` | Why an item was switched off automatically (`reports`, `signals`) or by the admin (`admin`). |
| `signal_add(...)` | Counts a batch of signals, returns totals and how many rooms reported each item. |
| `library_set_off(...)` | Switches library items off or on by text, with a reason. |

All service-role only, RLS on, no grants to `anon`/`authenticated`. No email, account id, player name
or room code is stored with signals or reports.

**Rules** (`src/lib/suggest/rules-core.ts`, `rules.ts`): applied in `runChain` to every AI request
(added to the instructions, and anything that still breaks a rule is dropped from the reply) and to
every library item when it's served, so a new rule also covers items saved before it. Cached one
minute per server instance; the admin's change clears the cache on that instance.

**Strictness** (`policy-core.ts`, `policy.ts`, `GET /api/policy?tone=`): kinds of Spin the Bottle prompt
(phone, social, dating, group picks, moving dares, roasts) can be switched off per mood. It can only
make a mood stricter. Applied to AI output, library items, and on the host's device to the built-in
deck (the game fetches it at start).

**Signals and reports** (`signals.ts`, `POST /api/signal`): the host's device sends what happened to
each Spin the Bottle card in batches (every 15 s, at 10 events, or when the page closes). Only the
signed-in host of an open room can send; per-room rate limit. A library item is switched off
automatically when **3 rooms** report it, or when it's been **shown 20+ times and flipped or passed
60%+** of the time. Built-in items are counted but can't be switched off (they're in the code).

**Admin Engine tab** (`EnginePanel.tsx`, `src/lib/admin/engine.ts`): reports queue (put back / remove
for good / ban similar), rules (add, pause, delete, test a sentence), strictness grid, and "what
players like" (skipped most, loved most, switched off automatically with undo). New audited actions:
`rule.add`, `rule.set_active`, `rule.delete`, `policy.set`, `report.resolve`, `signal.restore`.
New views: `rules`, `policy`, `reports`, `signals`.

## Tests

- `npx -y tsx docs/testing/qa/content-engine.test.ts`: 23 checks (rules, strictness, signals, game log).
- `node docs/testing/qa/content-rules-sql.test.mjs` (needs pglite): 19 checks on migration 0014
  (applies twice, access control, counting, one report per room, switch off/on).
- All earlier suites still pass (spin-bottle, llm-chain, content-library, kbc-news, themed-generation,
  admin-security, content-library-sql, admin-sql, admin-power-sql), plus lint, tsc and build.

## Not tested yet / for the owner

1. Apply `0014` in the Supabase SQL editor.
2. Open the Engine tab and check it by eye (it needs the live database; not checked in a browser here).
3. Signals only come from Spin the Bottle so far. Other games get hooks in round 14 (autopilot).
4. Real-world numbers (20 shows, 60%, 3 rooms) are first guesses; tune after a few weeks of data.
