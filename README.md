# BAWAAL 🎉

**Ghar mein sab hain? Toh BAWAAL karo!**

▶️ Play now: [playbawaal.vercel.app](https://playbawaal.vercel.app)

Desi party games for the whole family. Put the **big screen** on a TV or laptop and everyone joins from their **phones** with a 4-letter room code. No app to install, and players don't need an account. Only the host signs in with Google.

**What's new**
- 🍾 **Spin the Bottle (Sach ya Himmat)**: four moods (Bacche, Parivaar, College Gang, Office Party), two-sided cards you can flip, and passing is always free.
- ✨ **Fresh content every party**: an AI content library that skips anything the host *or anyone in the room* has seen in the last 30 days. Built-in decks remember what a device has shown, so they deal unseen cards first.
- 🎨 **Draw & Guess tools**: a phone toolbar with sizes, 12 colours, eraser, fill bucket, undo/redo and smooth lines.
- 🛡️ **Safer rooms**: phones trust only the host key the server holds, rooms have flood limits, room codes can't be guessed at speed, and every page sends security headers.
- 🧭 **Admin content engine**: rules for the AI, strictness per mood, a player reports queue, and player signals that retire weak content automatically.

## Games

| Game | Ages | Players |
|---|---|---|
| 🎬 Dumb Charades (no timer) | 7+ | 2 teams |
| 🎤 Antakshari Battle | 7+ | 2 teams |
| 🔔 Sound Guru | 6+ | 3–20 |
| 🧩 Emoji Picture | 7+ | 1–30 |
| 🎨 Draw & Guess | 7+ | 2–16 |
| 🕵️ Chor Kaun? | 8+ | 3–12 |
| 👑 Raja Mantri Chor Sipahi | 6+ | exactly 4 |
| 🤫 Odd Word Out | 9+ | 3–12 |
| 🏆 Kaun Banega Champion | 8+ | 1–20 |
| 🎟️ Housie (Tambola) | 6+ | 1–50 |
| 🎲 Ludo Yatra | 6+ | 2–4 |
| ⚡ Jaldi Bolo | 8+ | 1–20 |
| 🃏 Puno | 7+ | 2–10 |
| 🍾 Spin the Bottle | 6+ (by mood) | 3–20 |

The full rules for every game are in the app at `/games` (source: `src/games/catalog.ts`).

## How it works

```
 Phones (players)                       Big screen (host, signed in)
 ─────────────────                      ─────────────────────────────
 join / action  ──►  Supabase Realtime  ──►  game reducer runs here
                     channel room:CODE        │
 public view    ◄──  (broadcast)        ◄──  broadcasts public view
 private view   ◄──                     ◄──  + each player's secret view
```

- **The host device runs the game.** Each game is a module in `src/games/<id>/` with a pure `reduce()`, a `publicView()` for everyone and a `privateView()` for each player's secrets (roles, tickets, words). Its `Screen` component is for the TV and its `Controller` component is for phones.
- **Realtime** uses Supabase broadcast channels and presence. Game state is not stored in the database. The host keeps it in memory and in `localStorage`, so refreshing the TV page resumes the game.
- **Database:** `rooms` records which signed-in host owns which code. The **content library** (`content_library`, `content_seen`) holds AI-made items and what each host and player device has been shown. The **content engine** tables hold admin rules, strictness settings, player signals and reports. No player names or emails are stored with any of it.
- **Demo mode:** if the Supabase env vars are missing, login is skipped and rooms sync between tabs of the same browser using `BroadcastChannel`. This is useful for development: open `/host` in one tab and `/join` in others.

### Security model

- **Host updates are signed.** The host's device signs every room update (ECDSA P-256, WebCrypto). On the real site, phones accept **only** the key the server has on record for that room (`rooms.host_key`). They never trust a key seen on the channel. The host saves its key before its first broadcast, and old signed updates can't be replayed to a phone that just loaded.
- **Secrets are encrypted per player.** Each phone agrees a secret key with the host (ECDH → AES-GCM). Roles, tickets and words are encrypted for their owner, and a player's actions are encrypted with the same key, so players can't read each other's secrets or act as someone else.
- **One host device at a time.** A second device opening the host page is asked to take over; the first one then stops. A faked "another device is hosting" is ignored unless the server holds a different key.
- **Flood and guessing limits.** Player actions and sync requests are rate-limited per sender, and messages are capped at 64 KB. Room-code lookups are rate-limited per IP through a shared limiter in the database. Browsers can't call the room functions directly.
- **Rooms table is closed.** Room codes can't be listed; the app only looks them up one at a time through server-side database functions.
- **Player signals can't be gamed.** Each host account counts once per item, event and day, and only for items it was actually shown. Switching an item off needs several different hosts.
- **Admin panel:** a secret URL, password plus authenticator code (each code works once), lockout after failed attempts, revocable sessions, and an audit log written before every change.
- **Headers:** anti-framing, nosniff, a strict referrer policy and a permissions policy on every page.
- Still open: anyone with a room's code can join it and see what the TV shows (names, scores). Secrets stay encrypted. A plan for private channels is in `docs/realtime-private-channel.md`.

## Run locally

```bash
npm install
npm run dev            # demo mode, no setup needed
```

## Set up Supabase

1. Create a project at [supabase.com](https://supabase.com).
2. In **SQL Editor**, run every file in `supabase/migrations/` in number order (`0001` … `0016`). Each one is safe to run more than once. If you ever run `0012` again, run `0013` after it.
3. Go to **Authentication → Sign In / Providers → Google**, enable it and paste a Google OAuth client ID and secret:
   - Create the client in [Google Cloud Console](https://console.cloud.google.com/apis/credentials) under **Create credentials → OAuth client ID → Web application**.
   - Under **Authorized redirect URIs**, add `https://YOUR-PROJECT.supabase.co/auth/v1/callback`.
   - On the **OAuth consent screen**, add your app name and support email.
4. Go to **Authentication → URL Configuration**:
   - Set **Site URL** to your Vercel URL, e.g. `https://your-app.vercel.app`.
   - Under **Redirect URLs**, add `https://your-app.vercel.app/auth/callback`, `http://localhost:3000/auth/callback`, and `https://*-YOUR-TEAM.vercel.app/auth/callback` if you want preview deploys to work.
5. Go to **Project Settings → API** and copy the URL and the `anon` key into `.env.local` (see `.env.example`).
6. Make sure **Realtime** allows public channels. This is the default; check **Realtime → Settings** if phones can't connect.

## Deploy on Vercel

1. Import the GitHub repo in Vercel. The framework is detected as Next.js automatically.
2. Add the environment variables `NEXT_PUBLIC_SUPABASE_URL` and `NEXT_PUBLIC_SUPABASE_ANON_KEY`. The optional ones switch features on:
   - `SUPABASE_SERVICE_ROLE_KEY`: the content library, the content engine and shared rate limits.
   - `GROQ_API_KEY`, `GEMINI_API_KEY`, `OPENROUTER_API_KEY`, `CF_ACCOUNT_ID` + `CF_API_TOKEN`: AI content (tried in turn).
   - `TMDB_READ_TOKEN`: real movie titles and film certificates.
   - `NEWSAPI_KEY`: KBC news questions.
   - `ADMIN_PATH`, `ADMIN_USERNAME`, `ADMIN_PASSWORD_HASH`, `ADMIN_TOTP_SECRET`, `ADMIN_SESSION_SECRET`: the admin panel. Make them with `node scripts/admin-setup.mjs`.
   - `CRON_SECRET`: the daily cron.
   - `SIGNAL_SECRET`: a dedicated key for the one-way hashes used by player signals.
3. Deploy, then put the production URL into the Supabase URL Configuration (step 4 above).

## Keep-alive

Free Supabase projects pause after about a week without activity. `vercel.json` schedules a daily Vercel Cron call to `/api/keepalive`, which runs a tiny query. Optionally set a `CRON_SECRET` env var in Vercel; the endpoint then only accepts Vercel's authenticated cron calls.

## Adding a game

1. Write `src/games/<id>/index.tsx` exporting a `GameModule` (see `src/lib/types.ts` and `src/games/housie` for a complete example).
2. Register it in `src/games/modules.ts`.
3. Add its description to `src/games/catalog.ts`.

## Fresh content engine

Built-in content ships in `src/content/`. On top of it:

1. **The content library.** AI-made emoji puzzles, Chor Kaun topics, dares, KBC news questions and Spin the Bottle prompts are saved and served again. Nobody gets an item that the host, or any player in the room, has seen in the last 30 days.
2. **A weekly top-up.** It runs inside the daily cron and fills the library: real movie titles from TMDB, a mix of non-movie emoji categories, Chor Kaun topics, dares, Spin the Bottle prompts and fact-checked news questions.
3. **Safety in code, not just in the instructions.** Every AI item passes validators, the admin's rules and the per-mood strictness settings, both when it's saved and when it's served. Near-duplicates are skipped, and adult-certified films never become family puzzles.
4. **Player signals.** What gets flipped, passed, loved or reported feeds back. Weak items retire automatically, and the admin can undo that.

Games never wait for the AI during play. If it's slow or down, the built-in decks are used, so games stay fast, cheap and kid-safe.

## Contributing

BAWAAL is open source and contributions are very welcome! 🙌

- **Play and test:** try a game at [playbawaal.vercel.app](https://playbawaal.vercel.app) with family or friends and [open an issue](https://github.com/exonxo/playbawaal/issues) for any bug or idea.
- **Send a PR:** fork the repo, create a branch, run `npm install` and `npm run dev`, and open a pull request. Please run `npm run lint` and `npm run build` first.
- **New game ideas:** each game lives in `src/games/<id>/`; copy an existing one to get started.

Made by Proloy Karmakar, Product Designer. Questions: uxproloy@gmail.com
