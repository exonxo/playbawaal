import { NextResponse } from "next/server";
import { isSupabaseConfigured } from "@/lib/env";
import { findOwnRoom } from "@/lib/rooms";
import { getUser } from "@/lib/supabase/server";
import { allow } from "@/lib/shared-limit";
import { BOTTLE_PROMPTS, isBottleTone } from "@/content/spin-bottle";
import { normText } from "@/lib/suggest/library";
import { cleanEvents, recordSignals, SIGNAL_KINDS } from "@/lib/suggest/signals";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const preferredRegion = "bom1";

const noStore = { "cache-control": "no-store" };
const reply = (body: Record<string, unknown>, status = 200) => NextResponse.json(body, { status, headers: noStore });

/**
 * Player signals from a game, sent by the host's device in small batches: what was shown, done,
 * passed, flipped, loved or reported. Only the signed-in host of an open room can send them.
 * No player names, ids or room codes are stored. Each host account counts once per card, event and
 * day, and only for cards it was actually served (migration 0015).
 */
export async function POST(req: Request) {
  let body: { roomCode?: unknown; kind?: unknown; category?: unknown; events?: unknown };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return reply({ ok: false, error: "bad_json" }, 400);
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) return reply({ ok: false, error: "bad_json" }, 400);
  const kind = typeof body.kind === "string" ? body.kind : "";
  if (!(SIGNAL_KINDS as readonly string[]).includes(kind)) return reply({ ok: false, error: "bad_kind" }, 400);
  const category = typeof body.category === "string" && /^[a-z0-9_-]{1,32}$/.test(body.category) ? body.category : "any";
  const roomCode = typeof body.roomCode === "string" ? body.roomCode.trim().toUpperCase() : "";
  if (!/^[A-Z]{4}$/.test(roomCode)) return reply({ ok: false, error: "bad_room" }, 400);
  const events = cleanEvents(body.events);
  if (!events.length) return reply({ ok: true, counted: 0 });

  if (!isSupabaseConfigured) return reply({ ok: false, error: "auth_required" }, 401);
  // Per-room limit before anything else touches the auth server or database.
  if (!(await allow(`signal-room:${roomCode}`, 60, 12))) return reply({ ok: false, error: "slow_down" }, 429);
  const user = await getUser();
  if (!user) return reply({ ok: false, error: "auth_required" }, 401);
  if (!(await allow(`signal-user:${user.id}`, 60, 20))) return reply({ ok: false, error: "slow_down" }, 429);
  const room = await findOwnRoom(roomCode, user.id);
  if (!room) return reply({ ok: false, error: "forbidden" }, 403);
  // The built-in deck's texts count as real cards too (they aren't in the library).
  const builtin = kind === "bottle-prompts" && isBottleTone(category) ? BOTTLE_PROMPTS[category].map((p) => normText(p.text)) : [];

  try {
    const r = await recordSignals(kind, category, user.id, events, builtin);
    return reply({ ok: true, ...(r ?? { counted: 0 }) });
  } catch {
    return reply({ ok: false, error: "signal_failed" }, 500);
  }
}
