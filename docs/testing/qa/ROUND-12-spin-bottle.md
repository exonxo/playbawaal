# Round 12: Spin the Bottle and the content library

Run order in the Supabase SQL editor: **0013 after 0012**. 0013 can be run twice safely. If 0012 is
ever run again, run 0013 again after it (0012 resets the kind check to its own list).

## What changed
- Spin the Bottle prompts (`bottle-prompts`) are a content-library kind: one row per truth or dare,
  category = the mood (kids, family, college, office), game `spin-bottle`.
- `/api/suggest` serves a game from the library first: up to 24 prompts this host hasn't seen in 30
  days, only if at least 12 are unseen. Otherwise it asks the AI, returns the batch, and saves it
  (marked as seen by this host). If every AI service fails, 6 or more unseen library prompts beat the
  built-in deck. Library rows are re-checked with the mood's rules before they're served.
- Kill switches: `suggest` off stops AI calls and the library (built-in deck only); `library` off
  skips reading and saving the library; `llm:<name>` skips one provider.
- Admin Library tab: counts per mood, a "Spin the Bottle prompts" list (Sach / Himmat / social),
  Generate more with a Mood picker (up to 60 prompts, up to 5 AI calls) and the CSV.
- Weekly top-up: one batch for one mood (a different mood each week), only when at least 25 s of the
  budget is left, before the emoji step.

## Tests (local)
| Suite | Result |
| --- | --- |
| `npx eslint`, `npx tsc --noEmit`, `next build` | pass |
| `spin-bottle.test.ts` (deck, rules, game flow, library helpers) | 14 of 14 |
| `content-library-sql.test.mjs` (0004 to 0013, PGlite) | 82 of 82 |
| `content-library-race.mjs` / `admin-lockout-race.mjs` (real local Postgres) | 4 of 4 / 4 of 4 |
| `admin-sql` / `admin-power-sql` | 53 of 53 / 72 of 72 |
| `admin-security` / `llm-chain` / `content-library` / `themed-generation` / `kbc-news` | 22 / 13 / 11 / 26 / 25, all pass |
| `admin-http` / `admin-power-http` / `content-library-http` / `content-review-http` (local server) | 27 / 19 / 43 / 19, all pass |
| `admin-ui.mjs` (local) | 9 pass, 0 fail |
| Browser run: host + 2 players at 360 and 390 px, 8 rounds, flip, pass, report, reactions | no overflow, no errors |

## Not verified locally
- Library reads and writes through Supabase, and real AI batches (no keys, no database locally).
