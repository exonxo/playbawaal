"use client";
import type { RoomSnapshot, SignedRoom } from "./room";
import { verify } from "./secure";

/** Asks the server which signing key belongs to this room's host (null = unknown). */
export async function fetchHostKey(code: string): Promise<string | null> {
  try {
    const res = await fetch(`/api/rooms/${code}`, { cache: "no-store" });
    const data = (await res.json()) as { hostKey?: string | null };
    return data.hostKey ?? null;
  } catch {
    return null;
  }
}

/** A first snapshot older than this (by the host's wall clock) is an old one being replayed. */
export const MAX_FIRST_AGE_MS = 10 * 60_000;
/** How often a phone asks the server again while it doesn't know the host's key yet. */
const KEY_RETRY_MS = 1500;

/**
 * Accepts only genuine, fresh host snapshots.
 * - With a key from the server, only that key is trusted (re-checked if the host changes device).
 * - `strict` (the real site, with a database): a key seen only on the channel is NEVER trusted.
 *   Until the server knows the host's key (the first second of a new room, or while the server
 *   can't be reached), nothing is accepted and the server is asked again. Otherwise anyone with the
 *   room code could pose as the host in that window.
 * - Not strict (demo mode, no server): the first key seen is trusted, and replaced only after that
 *   host has been silent for a while.
 * - The first snapshot a phone accepts must be recent by the host's wall clock, so a snapshot
 *   recorded in an earlier session can't be replayed to a phone that has just loaded.
 */
export function createRoomReceiver(code: string, opts: { strict?: boolean } = {}) {
  const strict = !!opts.strict;
  let key: string | null = null;
  let fromServer = false;
  let epoch = 0;
  let seq = 0;
  let lastAccepted = 0;
  let lastKeyCheck = 0;
  let ready: Promise<void> | null = null;

  async function refreshKey() {
    lastKeyCheck = Date.now();
    const k = await fetchHostKey(code);
    if (k && k !== key) {
      key = k;
      fromServer = true;
      epoch = 0;
      seq = 0;
    } else if (k) {
      fromServer = true;
    }
  }

  return {
    get epoch() {
      return epoch;
    },
    async accept(msg: SignedRoom): Promise<RoomSnapshot | null> {
      if (!msg || typeof msg.d !== "string" || typeof msg.s !== "string" || typeof msg.k !== "string") return null;
      if (!ready) ready = refreshKey();
      await ready;
      if (strict && !fromServer) {
        // No key from the server yet: ask again (not too often) and accept nothing meanwhile.
        if (Date.now() - lastKeyCheck > KEY_RETRY_MS) {
          ready = refreshKey();
          await ready;
        }
        if (!fromServer) return null;
      }
      if (msg.k !== key) {
        if (!key && !strict) {
          key = msg.k; // first key seen (demo mode only)
        } else if (Date.now() - lastKeyCheck > 3000) {
          await refreshKey(); // the host may have moved to another device
        }
        if (msg.k !== key) {
          const hostSilent = Date.now() - lastAccepted > 9000;
          if (strict || fromServer || !hostSilent) return null;
          key = msg.k;
          epoch = 0;
          seq = 0;
        }
      }
      if (!key || !(await verify(key, msg.d, msg.s))) return null;
      let snap: RoomSnapshot;
      try {
        snap = JSON.parse(msg.d) as RoomSnapshot;
      } catch {
        return null;
      }
      if (snap.code !== code || typeof snap.epoch !== "number" || typeof snap.seq !== "number") return null;
      if (epoch === 0 && typeof snap.at === "number" && Date.now() - snap.at > MAX_FIRST_AGE_MS) return null; // replayed old session
      if (snap.epoch < epoch || (snap.epoch === epoch && snap.seq <= seq)) return null; // stale or replayed
      epoch = snap.epoch;
      seq = snap.seq;
      lastAccepted = Date.now();
      return snap;
    },
  };
}

/**
 * Estimates (host clock − my clock). Network delay only ever makes a sample
 * smaller, so the largest recent sample is the best one; a big jump (the host
 * paused the game clock) resets the estimate.
 */
export function createClockSync() {
  let samples: number[] = [];
  let current = 0;
  return (hostNow: number): number => {
    const sample = hostNow - Date.now();
    if (samples.length && Math.abs(sample - current) > 1500) samples = [];
    samples.push(sample);
    if (samples.length > 12) samples.shift();
    const best = Math.max(...samples);
    if (Math.abs(best - current) > 40 || samples.length === 1) current = best;
    return current;
  };
}
