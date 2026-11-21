import type { Level } from "@/lib/types";

/**
 * Draw & Guess wire format (version 2).
 *
 * The drawing is a list of items: strokes (pen or eraser) and fills. The host
 * keeps an append-only log of drawing ops for the turn, and each room update
 * carries only the last few ops plus a counter. Phones replay ops they haven't
 * seen. A full copy of the drawing ("keyframe") is included every few seconds,
 * and always at reveal, for phones that joined late or missed an update.
 *
 * Every phone turns the same items into the same picture (see raster.ts), so a
 * fill covers exactly the same area everywhere.
 */

export type Phase = "choosing" | "drawing" | "reveal" | "over";

/** Bumped when the drawing format changes; phones on a different version show a "refresh" note instead of a broken drawing. */
export const PAD_VERSION = 2;

/** A stroke: colour index, width index, eraser flag and flat [x0,y0,x1,y1,…] in 0–1000 units. */
export interface Stroke {
  k: "s";
  c: number;
  w: number;
  /** Eraser: paints the page colour. */
  e: boolean;
  p: number[];
}

/** A paint-bucket fill at (x, y) in 0–1000 units. */
export interface Fill {
  k: "f";
  c: number;
  x: number;
  y: number;
}

export type Item = Stroke | Fill;

/**
 * One drawing op.
 * "a" adds points to stroke `s` (a new stroke when s is the next index).
 * "f" adds a fill. "u" undoes the last item, "x" clears the page,
 * "i" puts back an undone item (redo); it carries the whole item so phones need no redo history.
 */
export type Op =
  | { k: "a"; s: number; c: number; w: number; e: 0 | 1; p: string }
  | { k: "f"; c: number; x: number; y: number }
  | { k: "u" }
  | { k: "x" }
  | { k: "i"; d: string };

/** An op with its position in the turn's log. */
export type LoggedOp = Op & { i: number };

export interface PadView {
  /** Drawing format version (PAD_VERSION). */
  v: number;
  /** Identifies the page; a new turn is a new page. */
  turn: number;
  /** Number of ops logged so far this turn. */
  n: number;
  /** The most recent ops (at most TAIL_OPS), oldest first. */
  tail: LoggedOp[];
  /** The whole drawing, encoded, when this update carries a keyframe; otherwise null. */
  full: string | null;
}

/** What the previous version read. Kept empty so phones still on old code show a blank page instead of a broken one. */
export interface LegacyPadView {
  turn: number;
  n: number;
  tail: never[];
  full: null;
}

export interface FeedEntry {
  playerId: string;
  /** null = guessed correctly (the text is hidden so nobody copies it). */
  text: string | null;
}

export interface Pub {
  drawerId: string | null;
  turn: number;
  totalTurns: number;
  phase: Phase;
  seconds: number;
  deadline: number;
  hintAt: number;
  mask: string;
  firstLetter: string;
  /** Old field, always empty (see LegacyPadView). */
  pad: LegacyPadView;
  /** The drawing. Missing when the host runs older code. */
  sketch?: PadView;
  correct: string[];
  feed: FeedEntry[];
  scores: Record<string, number>;
  /** Points gained this turn, per player. */
  gains: Record<string, number>;
  answer: string | null;
  /** When the reveal ends (host clock ms). */
  revealUntil: number | null;
  /** Set while the drawer's phone is disconnected (host clock ms); the turn is skipped after a while. */
  drawerAwaySince: number | null;
}

export interface Priv {
  choices?: string[];
  word?: string;
}

export interface Options {
  level: Level;
  roundsPerPlayer: number;
  seconds: number;
}

/** Paint colours. Index is what travels on the wire. Safed is the page colour, so it also works as a soft eraser. */
export const COLORS = ["#1e1a17", "#ffffff", "#d0342c", "#f07c1b", "#f5c518", "#2f9e44", "#1d4ed8", "#4dabf7", "#7b3fa0", "#e64980", "#8b5a2b", "#f1c27d"];
export const COLOR_NAMES = ["Kaala", "Safed", "Laal", "Narangi", "Peela", "Hara", "Neela", "Aasmani", "Jamuni", "Gulabi", "Bhoora", "Skin"];
export const PAGE = "#ffffff";
/** Line widths in 0–1000 units. */
export const WIDTHS = [5, 12, 24, 44];
export const WIDTH_NAMES = ["Patli", "Medium", "Moti", "Bahut moti"];
/** Old phones sent width 0–2 from [6, 14, 28]; they line up with the first three here. */

export const TAIL_OPS = 16;
/** How often the host includes a full keyframe while someone draws. */
export const KEYFRAME_EVERY = 4000;
/** How long a keyframe stays in updates (covers a couple of updates). */
export const KEYFRAME_FOR = 600;
/** Drawer disconnected this long → turn is skipped. */
export const DRAWER_AWAY_SKIP = 10_000;
/** Total coordinates kept per drawing, and per stroke. A longer stroke carries on as a new stroke. */
export const MAX_POINTS = 24_000;
export const MAX_STROKE_POINTS = 2_000;
/** Coordinates per "stroke" message. */
export const MAX_BATCH = 400;
/** Items (strokes + fills) per drawing, and fills per drawing. */
export const MAX_ITEMS = 600;
export const MAX_FILLS = 40;
/**
 * How often the drawer's phone sends new points. Every send makes the host broadcast a room update
 * to every phone, and realtime counts each delivery (Supabase free plan: 100 events/s for the whole
 * project, averaged over a minute). A room of 8 at 4 sends a second is already ~80 events/s while
 * someone draws, so this stays at 250 ms and viewers replay each batch gradually instead.
 */
export const SEND_EVERY = 250;
/** Viewers spread each batch of new points over this long, so lines grow smoothly instead of jumping. */
export const REPLAY_MS = 240;

/* --------------------------- limits (shared) --------------------------- */

export function pointCount(items: Item[]): number {
  let n = 0;
  for (const it of items) if (it.k === "s") n += it.p.length;
  return n;
}

export function fillCount(items: Item[]): number {
  let n = 0;
  for (const it of items) if (it.k === "f") n++;
  return n;
}

/** Room left on the page, in coordinates. The drawer's phone and the host use the same rule, so they never disagree. */
export function pointsLeft(items: Item[]): number {
  return Math.max(0, MAX_POINTS - pointCount(items));
}

export function canAddItem(items: Item[], kind: "s" | "f"): boolean {
  if (items.length >= MAX_ITEMS) return false;
  if (kind === "f") return fillCount(items) < MAX_FILLS;
  return pointsLeft(items) >= 2;
}

/* --------------------------- compact encoding --------------------------- */

/** Each coordinate (0–1000) as two base-36 characters. */
export function encodePoints(p: number[]): string {
  let out = "";
  for (const n of p) out += clampCoord(n).toString(36).padStart(2, "0");
  return out;
}

export function decodePoints(s: string): number[] {
  const out: number[] = [];
  for (let i = 0; i + 1 < s.length; i += 2) {
    const n = parseInt(s.slice(i, i + 2), 36);
    if (Number.isFinite(n)) out.push(Math.min(1000, n));
  }
  return out;
}

export function clampCoord(n: number): number {
  return Math.max(0, Math.min(1000, Math.round(n)));
}

const colourOk = (c: number) => (Number.isInteger(c) && c >= 0 && c < COLORS.length ? c : 0);
const widthOk = (w: number) => (Number.isInteger(w) && w >= 0 && w < WIDTHS.length ? w : 1);

/** One item: stroke "s<colour><width><eraser><points>", fill "f<colour><xy>". Colour is one base-36 digit. */
export function encodeItem(it: Item): string {
  if (it.k === "f") return `f${it.c.toString(36)}${encodePoints([it.x, it.y])}`;
  return `s${it.c.toString(36)}${it.w}${it.e ? 1 : 0}${encodePoints(it.p)}`;
}

export function decodeItem(s: string): Item | null {
  if (s[0] === "f" && s.length >= 6) {
    const xy = decodePoints(s.slice(2, 6));
    if (xy.length !== 2) return null;
    return { k: "f", c: colourOk(parseInt(s[1], 36)), x: xy[0], y: xy[1] };
  }
  if (s[0] === "s" && s.length >= 4) {
    const p = decodePoints(s.slice(4));
    if (!p.length || p.length % 2) return null;
    return { k: "s", c: colourOk(parseInt(s[1], 36)), w: widthOk(Number(s[2])), e: s[3] === "1", p };
  }
  return null;
}

/** Whole drawing: items joined by "|". */
export function encodeDrawing(items: Item[]): string {
  return items.map(encodeItem).join("|");
}

export function decodeDrawing(s: string): Item[] {
  if (!s) return [];
  const out: Item[] = [];
  for (const part of s.split("|")) {
    const it = decodeItem(part);
    if (it) out.push(it);
  }
  return out;
}

/** Applies one op to a drawing (returns a new array). Shared by host and phones. */
export function applyOp(items: Item[], op: Op): Item[] {
  switch (op.k) {
    case "x":
      return [];
    case "u":
      return items.slice(0, -1);
    case "f":
      return [...items, { k: "f", c: colourOk(op.c), x: clampCoord(op.x), y: clampCoord(op.y) }];
    case "i": {
      const it = decodeItem(op.d);
      return it ? [...items, it] : items;
    }
    case "a": {
      const p = decodePoints(op.p);
      if (op.s === items.length) return [...items, { k: "s", c: colourOk(op.c), w: widthOk(op.w), e: op.e === 1, p }];
      const last = items[items.length - 1];
      if (op.s === items.length - 1 && last?.k === "s") return [...items.slice(0, -1), { ...last, p: [...last.p, ...p] }];
      return items;
    }
  }
  return items;
}

/* --------------------------- point clean-up --------------------------- */

/**
 * Drops points that don't change the shape (Ramer–Douglas–Peucker, `tol` in 0–1000 units).
 * Keeps the first and last point. Fewer points = more drawing fits on a page and smaller updates.
 */
export function simplify(p: number[], tol = 1.5): number[] {
  const n = p.length / 2;
  if (n <= 2) return p.slice();
  const keep = new Uint8Array(n);
  keep[0] = 1;
  keep[n - 1] = 1;
  const stack: [number, number][] = [[0, n - 1]];
  const t2 = tol * tol;
  while (stack.length) {
    const [a, b] = stack.pop()!;
    const ax = p[a * 2], ay = p[a * 2 + 1], bx = p[b * 2], by = p[b * 2 + 1];
    const dx = bx - ax, dy = by - ay;
    const len2 = dx * dx + dy * dy;
    let best = -1, bestD = t2;
    for (let i = a + 1; i < b; i++) {
      const px = p[i * 2], py = p[i * 2 + 1];
      let d: number;
      if (len2 === 0) d = (px - ax) ** 2 + (py - ay) ** 2;
      else {
        const t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / len2));
        d = (px - ax - t * dx) ** 2 + (py - ay - t * dy) ** 2;
      }
      if (d > bestD) {
        bestD = d;
        best = i;
      }
    }
    if (best >= 0) {
      keep[best] = 1;
      stack.push([a, best], [best, b]);
    }
  }
  const out: number[] = [];
  for (let i = 0; i < n; i++) if (keep[i]) out.push(p[i * 2], p[i * 2 + 1]);
  return out;
}
