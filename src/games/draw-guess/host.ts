import {
  COLORS,
  MAX_BATCH,
  MAX_STROKE_POINTS,
  TAIL_OPS,
  WIDTHS,
  applyOp,
  canAddItem,
  encodeItem,
  encodePoints,
  pointsLeft,
  type Item,
  type LoggedOp,
  type Op,
} from "./shared";

/**
 * The host's drawing log, without React, so it can be tested on its own.
 * `DrawState` is the part of the game state it touches.
 */
export interface DrawState {
  items: Item[];
  undone: Item[];
  ops: LoggedOp[];
  opN: number;
}

function index(v: unknown, list: unknown[], fallback: number): number {
  if (typeof v === "number" && Number.isInteger(v) && v >= 0 && v < list.length) return v;
  if (typeof v === "string") {
    const i = list.indexOf(v);
    if (i >= 0) return i;
  }
  return fallback;
}

/** A game saved by older code has no `items`; start that page blank rather than crash. */
export const itemsOf = <S extends DrawState>(s: S): Item[] => (Array.isArray(s.items) ? s.items : []);
const undoneOf = <S extends DrawState>(s: S): Item[] => (Array.isArray(s.undone) ? s.undone : []);

function logOp<S extends DrawState>(s: S, op: Op, undone: Item[] = undoneOf(s)): S {
  return { ...s, items: applyOp(itemsOf(s), op), undone, ops: [...s.ops, { ...op, i: s.opN } as LoggedOp].slice(-TAIL_OPS), opN: s.opN + 1 };
}

function isPointList(v: unknown): v is number[] {
  return Array.isArray(v) && v.length % 2 === 0 && v.length <= MAX_BATCH && v.every((n) => Number.isInteger(n) && n >= 0 && n <= 1000);
}

const isCoord = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v) && v >= 0 && v <= 1000;

/**
 * Drawing actions from the drawer's phone. The phone checks the same limits
 * (canAddItem, pointsLeft, MAX_STROKE_POINTS) before sending, so a refusal here
 * only happens if something was tampered with or lost.
 */
export function reduceDrawing<S extends DrawState>(s: S, type: string, payload: unknown): S {
  const items = itemsOf(s);
  switch (type) {
    case "stroke": {
      const m = payload as { s?: unknown; c?: unknown; w?: unknown; e?: unknown; p?: unknown };
      if (!m || typeof m.s !== "number" || !isPointList(m.p) || m.p.length === 0) return s;
      if (m.p.length > pointsLeft(items)) return s;
      if (m.s === items.length) {
        if (!canAddItem(items, "s") || m.p.length > MAX_STROKE_POINTS) return s;
        return logOp(s, { k: "a", s: m.s, c: index(m.c, COLORS, 0), w: index(m.w, WIDTHS, 1), e: m.e === true || m.e === 1 ? 1 : 0, p: encodePoints(m.p) }, []);
      }
      const last = items[items.length - 1];
      if (m.s === items.length - 1 && last?.k === "s") {
        if (last.p.length + m.p.length > MAX_STROKE_POINTS) return s;
        return logOp(s, { k: "a", s: m.s, c: last.c, w: last.w, e: last.e ? 1 : 0, p: encodePoints(m.p) });
      }
      return s;
    }
    case "fill": {
      const m = payload as { c?: unknown; x?: unknown; y?: unknown };
      if (!m || !isCoord(m.x) || !isCoord(m.y) || !canAddItem(items, "f")) return s;
      return logOp(s, { k: "f", c: index(m.c, COLORS, 0), x: Math.round(m.x), y: Math.round(m.y) }, []);
    }
    case "undo": {
      if (!items.length) return s;
      return logOp(s, { k: "u" }, [...undoneOf(s), items[items.length - 1]].slice(-50));
    }
    case "redo": {
      const undone = undoneOf(s);
      const it = undone[undone.length - 1];
      if (!it || !canAddItem(items, it.k) || (it.k === "s" && it.p.length > pointsLeft(items))) return s;
      return logOp(s, { k: "i", d: encodeItem(it) }, undone.slice(0, -1));
    }
    case "clear":
      if (!items.length) return s;
      return logOp(s, { k: "x" }, []);
  }
  return s;
}


