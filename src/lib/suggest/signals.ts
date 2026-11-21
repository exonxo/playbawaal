import { createHmac } from "node:crypto";
import { getServiceClient } from "../supabase/service";

/**
 * Player signals (migration 0014), the server part. The host's device sends what happened to each
 * item in a game (shown, done, passed, flipped, skipped, loved, reported). They're counted per item,
 * and library items that players clearly don't want are switched off automatically:
 *
 * - reported in REPORT_ROOMS different rooms  → off, reason "reports"
 * - shown at least MIN_SHOWN times and flipped or passed RETIRE_RATE of the time → off, reason "signals"
 *
 * The admin sees both in the panel and can switch an item back on. Built-in items are counted too
 * (so the admin can see which ones to rewrite) but can't be switched off: they live in the code.
 */

export const SIGNAL_EVENTS = ["shown", "done", "passed", "flipped", "skipped", "loved", "reported"] as const;
export type SignalEvent = (typeof SIGNAL_EVENTS)[number];
export const SIGNAL_KINDS = ["bottle-prompts", "emoji-puzzle", "chor-kaun-topic", "kbc-question", "dare"] as const;
export const REPORT_ROOMS = 3;
export const MIN_SHOWN = 20;
export const RETIRE_RATE = 0.6;
export const MAX_EVENTS = 100;

export interface SignalItem {
  key: string;
  event: SignalEvent;
}

/** Cleans what a browser sent: known events only, short text, each event once per card, at most MAX_EVENTS. */
export function cleanEvents(raw: unknown): SignalItem[] {
  if (!Array.isArray(raw)) return [];
  const out: SignalItem[] = [];
  const seen = new Set<string>();
  for (const e of raw.slice(0, MAX_EVENTS)) {
    if (!e || typeof e !== "object") continue;
    const key = typeof (e as { key?: unknown }).key === "string" ? (e as { key: string }).key.replace(/\s+/g, " ").trim().slice(0, 300) : "";
    const event = (e as { event?: unknown }).event;
    if (key.length < 2 || !(SIGNAL_EVENTS as readonly unknown[]).includes(event)) continue;
    // One batch counts each event once per card, so a single request can't push an item over the
    // switch-off line on its own.
    const id = `${event}|${key.toLowerCase()}`;
    if (seen.has(id)) continue;
    seen.add(id);
    out.push({ key, event: event as SignalEvent });
  }
  return out;
}

/** The secret that keys the one-way hashes. A dedicated SIGNAL_SECRET is best (rotating the
 *  service-role key then doesn't reset vote counts); the service-role key is the fallback. */
function signalSecret(): string {
  return process.env.SIGNAL_SECRET?.trim() || process.env.SUPABASE_SERVICE_ROLE_KEY?.trim() || "bawaal-signals";
}

/** A one-way hash of the room. Kept for older code paths; votes are counted per host account now. */
export function roomHash(roomId: string): string {
  return createHmac("sha256", signalSecret()).update(`room:${roomId}`).digest("hex").slice(0, 32);
}

/** A one-way hash of the host's account: each host counts once per item, event and day. */
export function voterHash(userId: string): string {
  return createHmac("sha256", signalSecret()).update(`voter:${userId}`).digest("hex").slice(0, 32);
}

/** Different hosts needed before the flip/pass rule switches an item off. */
export const MIN_VOTERS = 5;

export interface Totals {
  text_norm: string;
  shown: number;
  done: number;
  passed: number;
  flipped: number;
  /** Different host accounts that reported it. */
  reported_rooms: number;
  /** Different host accounts that sent any signal for it (absent = not known). */
  voters?: number;
}

/**
 * Which items should be switched off, and why. Both rules need several different hosts, so one host
 * (however many rooms they open or batches they send) can't switch an item off alone.
 */
export function retireDecisions(rows: Totals[]): { reports: string[]; signals: string[] } {
  const reports: string[] = [];
  const signals: string[] = [];
  for (const r of rows) {
    if (r.reported_rooms >= REPORT_ROOMS) reports.push(r.text_norm);
    else if (r.shown >= MIN_SHOWN && (r.voters ?? 0) >= MIN_VOTERS && (r.flipped + r.passed) / r.shown >= RETIRE_RATE) signals.push(r.text_norm);
  }
  return { reports, signals };
}

/**
 * Records signals from one host and switches off what crossed a line. Only real cards count: items
 * in `builtin` (the built-in deck's texts) or library items this host was served. Before migration
 * 0015 nothing is recorded (the old per-room counting could be gamed). Null without a database.
 */
export async function recordSignals(kind: string, category: string, userId: string, items: SignalItem[], builtin: string[] = []) {
  const db = getServiceClient();
  if (!db || !items.length) return null;
  const { data, error } = await db.rpc("signal_add_v2", {
    p_kind: kind,
    p_category: category,
    p_voter: voterHash(userId),
    p_user: userId,
    p_items: items,
    p_builtin: builtin.slice(0, 500),
  });
  if (error || !Array.isArray(data)) return null;
  const rows: Totals[] = (data as Record<string, unknown>[]).map((r) => ({
    text_norm: String(r.text_norm),
    shown: Number(r.shown) || 0,
    done: Number(r.done) || 0,
    passed: Number(r.passed) || 0,
    flipped: Number(r.flipped) || 0,
    reported_rooms: Number(r.reported_voters) || 0,
    voters: Number(r.voters) || 0,
  }));
  const d = retireDecisions(rows);
  let off = 0;
  for (const [reason, norms] of [["reports", d.reports], ["signals", d.signals]] as const) {
    if (!norms.length) continue;
    const r = await db.rpc("library_set_off", { p_kind: kind, p_norms: norms, p_reason: reason, p_off: true });
    off += Number(r.data) || 0;
  }
  return { counted: rows.length, switchedOff: off };
}
