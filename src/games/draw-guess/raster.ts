import { COLORS, type Item, type Stroke, WIDTHS } from "./shared";

/**
 * Turns drawing items into pixels, the same way on every phone.
 *
 * The picture lives in a 1000×1000 grid of colour numbers (one per pixel, 0 =
 * page). Lines are drawn with plain arithmetic (no browser anti-aliasing), so
 * the grid is identical on every device, and a paint-bucket fill covers exactly
 * the same pixels everywhere. Screens then show the grid scaled to their size.
 *
 * Lines get rounded corners (quadratic curves, at most CORNER units long).
 * The very last piece of the newest stroke (last corner → finger) changes as the
 * stroke grows, so it is kept out of the grid and drawn on top by the screen;
 * it is added to the grid once another item follows. This keeps a growing
 * stroke and a keyframe of the same stroke pixel-identical.
 */

export const RES = 1000;

/** Grid value for a stroke or fill: 0 = page (eraser and Safed), else colour index + 1. */
export function inkOf(it: Item): number {
  if (it.k === "s" && it.e) return 0;
  return it.c === 1 ? 0 : it.c + 1;
}

/** RGBA for each grid value. */
export const PALETTE: [number, number, number][] = [[255, 255, 255], ...COLORS.map(hexRgb)];

function hexRgb(h: string): [number, number, number] {
  const n = parseInt(h.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

export interface Rect {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

/** Paints every pixel whose centre is within r of segment a→b. */
function capsule(buf: Uint8Array, ax: number, ay: number, bx: number, by: number, r: number, v: number, d: Rect) {
  const x0 = Math.max(0, Math.floor(Math.min(ax, bx) - r));
  const x1 = Math.min(RES - 1, Math.ceil(Math.max(ax, bx) + r));
  const y0 = Math.max(0, Math.floor(Math.min(ay, by) - r));
  const y1 = Math.min(RES - 1, Math.ceil(Math.max(ay, by) + r));
  if (x0 > x1 || y0 > y1) return;
  const dx = bx - ax, dy = by - ay;
  const len2 = dx * dx + dy * dy;
  const r2 = r * r;
  for (let y = y0; y <= y1; y++) {
    const py = y + 0.5;
    const row = y * RES;
    for (let x = x0; x <= x1; x++) {
      const px = x + 0.5;
      let t = len2 === 0 ? 0 : ((px - ax) * dx + (py - ay) * dy) / len2;
      if (t < 0) t = 0;
      else if (t > 1) t = 1;
      const ex = px - ax - t * dx, ey = py - ay - t * dy;
      if (ex * ex + ey * ey <= r2) buf[row + x] = v;
    }
  }
  if (x0 < d.x0) d.x0 = x0;
  if (y0 < d.y0) d.y0 = y0;
  if (x1 > d.x1) d.x1 = x1;
  if (y1 > d.y1) d.y1 = y1;
}

/** Corners are rounded over at most this many units, so long straight lines keep their shape. */
export const CORNER = 10;

type Seg = (ax: number, ay: number, bx: number, by: number) => void;

/** Where segment j (point j → j+1) starts and ends once its corners are rounded off. */
function segEnds(p: number[], j: number) {
  const ax = p[j * 2], ay = p[j * 2 + 1], bx = p[j * 2 + 2], by = p[j * 2 + 3];
  const len = Math.hypot(bx - ax, by - ay);
  const d = Math.min(len / 2, CORNER);
  const ux = len ? (bx - ax) / len : 0, uy = len ? (by - ay) / len : 0;
  return { sx: j === 0 ? ax : ax + ux * d, sy: j === 0 ? ay : ay + uy * d, ex: bx - ux * d, ey: by - uy * d };
}

/**
 * The settled part of a stroke: straight segments with rounded corners. For a
 * stroke growing from `from` to `n` points this emits only what was added, and
 * the result never changes later, so drawing it bit by bit or all at once gives
 * the same pixels. A one-point stroke is a dot (covered by the first segment's
 * round end once there is a second point).
 */
function settledSegments(p: number[], from: number, n: number, seg: Seg) {
  if (n === 1) {
    if (from === 0) seg(p[0], p[1], p[0], p[1]);
    return;
  }
  for (let j = Math.max(0, from - 1); j <= n - 2; j++) {
    const e = segEnds(p, j);
    seg(e.sx, e.sy, e.ex, e.ey);
    if (j >= 1) {
      // Rounded corner at point j: from the end of segment j-1 to the start of segment j.
      const prev = segEnds(p, j - 1);
      const cx = p[j * 2], cy = p[j * 2 + 1];
      const len = Math.hypot(cx - prev.ex, cy - prev.ey) + Math.hypot(e.sx - cx, e.sy - cy);
      const steps = Math.max(1, Math.ceil(len / 3));
      let lx = prev.ex, ly = prev.ey;
      for (let k = 1; k <= steps; k++) {
        const t = k / steps, u = 1 - t;
        const x = u * u * prev.ex + 2 * u * t * cx + t * t * e.sx;
        const y = u * u * prev.ey + 2 * u * t * cy + t * t * e.sy;
        seg(lx, ly, x, y);
        lx = x;
        ly = y;
      }
    }
  }
}

/** The end piece: the short stub from the last rounded-off segment end to the last point. */
function endSegments(p: number[], seg: Seg) {
  const n = p.length / 2;
  if (n < 2) return;
  const e = segEnds(p, n - 2);
  seg(e.ex, e.ey, p[(n - 1) * 2], p[(n - 1) * 2 + 1]);
}

/** Every segment of a whole stroke, settled part and end piece (used for the live line on screen). */
export function allSegments(s: Stroke): number[][] {
  const out: number[][] = [];
  const push: Seg = (ax, ay, bx, by) => out.push([ax, ay, bx, by]);
  settledSegments(s.p, 0, s.p.length / 2, push);
  endSegments(s.p, push);
  return out;
}

function paintSettled(buf: Uint8Array, s: Stroke, from: number, n: number, d: Rect) {
  const r = (WIDTHS[s.w] ?? WIDTHS[1]) / 2;
  const v = inkOf(s);
  settledSegments(s.p, from, n, (ax, ay, bx, by) => capsule(buf, ax, ay, bx, by, r, v, d));
}

function paintEnd(buf: Uint8Array, s: Stroke, d: Rect) {
  const r = (WIDTHS[s.w] ?? WIDTHS[1]) / 2;
  const v = inkOf(s);
  endSegments(s.p, (ax, ay, bx, by) => capsule(buf, ax, ay, bx, by, r, v, d));
}

/** Segments of a stroke's end piece, for drawing on top of the grid. */
export function endPieceSegments(s: Stroke): number[][] {
  const out: number[][] = [];
  endSegments(s.p, (ax, ay, bx, by) => out.push([ax, ay, bx, by]));
  return out;
}

/** Paint-bucket: 4-way flood from (x, y) over pixels of the same value. */
export function floodFill(buf: Uint8Array, x: number, y: number, v: number, d: Rect) {
  x = Math.max(0, Math.min(RES - 1, Math.floor(x)));
  y = Math.max(0, Math.min(RES - 1, Math.floor(y)));
  const target = buf[y * RES + x];
  if (target === v) return;
  const stack: number[] = [x, y];
  while (stack.length) {
    const sy = stack.pop()!;
    const sx = stack.pop()!;
    let lx = sx;
    const row = sy * RES;
    if (buf[row + lx] !== target) continue;
    while (lx > 0 && buf[row + lx - 1] === target) lx--;
    let rx = sx;
    while (rx < RES - 1 && buf[row + rx + 1] === target) rx++;
    for (let i = lx; i <= rx; i++) buf[row + i] = v;
    if (lx < d.x0) d.x0 = lx;
    if (rx > d.x1) d.x1 = rx;
    if (sy < d.y0) d.y0 = sy;
    if (sy > d.y1) d.y1 = sy;
    for (const ny of [sy - 1, sy + 1]) {
      if (ny < 0 || ny >= RES) continue;
      const nrow = ny * RES;
      let i = lx;
      while (i <= rx) {
        if (buf[nrow + i] === target) {
          stack.push(i, ny);
          while (i <= rx && buf[nrow + i] === target) i++;
        } else i++;
      }
    }
  }
}

function sameStrokeStyle(a: Stroke, b: Stroke) {
  return a.c === b.c && a.w === b.w && a.e === b.e;
}

/** True when b is a (possibly longer) copy of a. */
function extends_(a: Item, b: Item): boolean {
  if (a === b) return true;
  if (a.k === "f" || b.k === "f") return a.k === b.k && a.c === b.c && (a as { x: number }).x === (b as { x: number }).x && (a as { y: number }).y === (b as { y: number }).y;
  if (!sameStrokeStyle(a, b) || b.p.length < a.p.length) return false;
  for (let i = 0; i < a.p.length; i++) if (a.p[i] !== b.p[i]) return false;
  return true;
}

function same(a: Item, b: Item): boolean {
  return extends_(a, b) && (a.k === "f" || (b.k === "s" && a.p.length === b.p.length));
}

const EMPTY = (): Rect => ({ x0: RES, y0: RES, x1: -1, y1: -1 });

/**
 * Keeps a grid in step with a list of items, drawing only what changed when it
 * can (a stroke growing, new items) and starting over otherwise (undo, clear,
 * a keyframe that differs). A few snapshots make the common undo instant.
 */
export class Raster {
  buf = new Uint8Array(RES * RES);
  /** What the grid shows: items, with the last stroke's end piece left out. */
  private shown: Item[] = [];
  /** Snapshots: grid before item `at` was added (with item at-1's end piece still left out). */
  private snaps: { at: number; buf: Uint8Array }[] = [];
  dirty: Rect = { x0: 0, y0: 0, x1: RES - 1, y1: RES - 1 };
  /** Full redraws so far (for tests). */
  redraws = 0;

  /** The newest stroke, whose end piece the screen draws on top. */
  get tail(): Stroke | null {
    const last = this.shown[this.shown.length - 1];
    return last?.k === "s" ? last : null;
  }

  takeDirty(): Rect | null {
    const d = this.dirty;
    this.dirty = EMPTY();
    return d.x1 < d.x0 ? null : d;
  }

  sync(items: Item[]) {
    const shown = this.shown;
    // Common case 1: nothing changed.
    if (items.length === shown.length && (items.length === 0 || (items[items.length - 1] === shown[shown.length - 1] && items[0] === shown[0]))) {
      return;
    }
    let ok = items.length >= shown.length;
    for (let i = 0; ok && i < shown.length - 1; i++) if (!same(shown[i], items[i])) ok = false;
    if (ok && shown.length) ok = extends_(shown[shown.length - 1], items[shown.length - 1]);
    if (ok) {
      this.grow(items);
      return;
    }
    // One item fewer and the rest unchanged (undo): use the snapshot if we have it.
    const snap = this.snaps.find((s) => s.at === items.length);
    if (snap && items.length === shown.length - 1) {
      let same_ = true;
      for (let i = 0; same_ && i < items.length; i++) if (!same(shown[i], items[i])) same_ = false;
      if (same_) {
        this.buf.set(snap.buf);
        this.snaps = this.snaps.filter((s) => s.at < items.length);
        this.shown = items.slice();
        this.dirty = { x0: 0, y0: 0, x1: RES - 1, y1: RES - 1 };
        return;
      }
    }
    this.reset();
    this.redraws++;
    this.grow(items);
  }

  reset() {
    this.buf.fill(0);
    this.shown = [];
    this.snaps = [];
    this.dirty = { x0: 0, y0: 0, x1: RES - 1, y1: RES - 1 };
  }

  private grow(items: Item[]) {
    const d = this.dirty;
    const start = this.shown.length;
    // The previously-last item may have grown.
    if (start > 0) {
      const old = this.shown[start - 1];
      const now = items[start - 1];
      if (old.k === "s" && now.k === "s") {
        paintSettled(this.buf, now, old.p.length / 2, now.p.length / 2, d);
      }
    }
    for (let i = start; i < items.length; i++) {
      // Before adding item i, keep a snapshot (bounded), then settle the previous stroke's end piece.
      if (items.length - i <= 3) {
        this.snaps.push({ at: i, buf: this.buf.slice() });
        if (this.snaps.length > 3) this.snaps.shift();
      }
      const prev = items[i - 1];
      if (prev?.k === "s") {
        paintEnd(this.buf, prev, d);
      }
      const it = items[i];
      if (it.k === "f") floodFill(this.buf, it.x, it.y, inkOf(it), d);
      else paintSettled(this.buf, it, 0, it.p.length / 2, d);
    }
    this.shown = items.slice();
  }
}

/**
 * The finished picture as a grid (end pieces included). Used by tests to check
 * that every route to the same items gives the same pixels.
 */
export function rasterize(items: Item[]): Uint8Array {
  const r = new Raster();
  r.sync(items);
  const last = items[items.length - 1];
  if (last?.k === "s") paintEnd(r.buf, last, EMPTY());
  return r.buf;
}
