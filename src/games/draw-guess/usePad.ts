"use client";
import { useRef } from "react";
import { PAD_VERSION, applyOp, decodeDrawing, type Item, type PadView } from "./shared";

interface Cache {
  turn: number;
  n: number;
  items: Item[];
  /** Waiting for a keyframe because an update was missed. */
  stale: boolean;
}

/** Rebuilds a drawing from a pad view, given what this phone already had. Pure; used by the hook and by tests. */
export function nextPad(c: Cache, pad: PadView): Cache {
  if (c.turn !== pad.turn) c = { turn: pad.turn, n: 0, items: [], stale: false };
  if (pad.full !== null) {
    if (c.n !== pad.n || c.stale) c = { turn: pad.turn, n: pad.n, items: decodeDrawing(pad.full), stale: false };
  } else if (pad.n > c.n) {
    const first = pad.tail[0]?.i ?? pad.n;
    if (first > c.n) {
      c = { ...c, stale: true };
    } else {
      let items = c.items;
      for (const op of pad.tail) if (op.i >= c.n) items = applyOp(items, op);
      c = { turn: pad.turn, n: pad.n, items, stale: false };
    }
  }
  return c;
}

export const emptyPad = (): Cache => ({ turn: -1, n: 0, items: [], stale: false });

/**
 * Rebuilds the drawing on a phone from the op tail in each update, falling back
 * to keyframes when it falls behind. Safe to call on every render: ops are only
 * applied once (tracked by their index).
 *
 * `mismatch` is true when the host runs a different version of the game, so the
 * screen can ask for a refresh instead of drawing garbage.
 */
export function usePadStrokes(pad: PadView | undefined): { items: Item[]; stale: boolean; mismatch: boolean } {
  const cache = useRef<Cache>(emptyPad());
  if (!pad || pad.v !== PAD_VERSION) return { items: [], stale: false, mismatch: true };
  const c = nextPad(cache.current, pad);
  cache.current = c;
  return { items: c.items, stale: c.stale, mismatch: false };
}
