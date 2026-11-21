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

/** A one-way hash of the room, so reports from one room count once. The room itself isn't stored. */
export function roomHash(roomId: string): string {
  const secret = process.env.SUPABASE_SERVICE_ROLE_KEY?.trim() || "bawaal-signals";
  return createHmac("sha256", secret).update(`room:${roomId}`).digest("hex").slice(0, 32);
}

export interface Totals {
  text_norm: string;
  shown: number;
  done: number;
  passed: number;
  flipped: number;
  reported_rooms: number;
}

/** Which items should be switched off, and why. */
export function retireDecisions(rows: Totals[]): { reports: string[]; signals: string[] } {
  const reports: string[] = [];
  const signals: string[] = [];
  for (const r of rows) {
    if (r.reported_rooms >= REPORT_ROOMS) reports.push(r.text_norm);
    else if (r.shown >= MIN_SHOWN && (r.flipped + r.passed) / r.shown >= RETIRE_RATE) signals.push(r.text_norm);
  }
  return { reports, signals };
}

/** Records signals and switches off what crossed a line. Returns counts, or null without a database. */
export async function recordSignals(kind: string, category: string, roomId: string, items: SignalItem[]) {
  const db = getServiceClient();
  if (!db || !items.length) return null;
  const { data, error } = await db.rpc("signal_add", { p_kind: kind, p_category: category, p_room_hash: roomHash(roomId), p_items: items });
  if (error || !Array.isArray(data)) return null;
  const rows = (data as Record<string, unknown>[]).map((r) => ({
    text_norm: String(r.text_norm),
    shown: Number(r.shown) || 0,
    done: Number(r.done) || 0,
    passed: Number(r.passed) || 0,
    flipped: Number(r.flipped) || 0,
    reported_rooms: Number(r.reported_rooms) || 0,
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
