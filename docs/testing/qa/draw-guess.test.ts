// Draw & Guess: drawing format, host drawing log (strokes, fill, undo, redo, clear, limits), phone
// replay and the shared pixel renderer. No network, no browser. Run from the repo root:
//   npx -y tsx docs/testing/qa/draw-guess.test.ts
import assert from "node:assert/strict";
import { reduceDrawing, type DrawState } from "../../../src/games/draw-guess/host";
import { RES, Raster, rasterize } from "../../../src/games/draw-guess/raster";
import {
  COLORS,
  COLOR_NAMES,
  MAX_FILLS,
  MAX_POINTS,
  MAX_STROKE_POINTS,
  PAD_VERSION,
  WIDTHS,
  applyOp,
  decodeDrawing,
  encodeDrawing,
  pointCount,
  simplify,
  type Item,
  type PadView,
} from "../../../src/games/draw-guess/shared";
import { emptyPad, nextPad } from "../../../src/games/draw-guess/usePad";

let passed = 0;
const results: string[] = [];
function check(id: string, name: string, fn: () => void) {
  try {
    fn();
    passed++;
    results.push(`PASS ${id} ${name}`);
  } catch (e) {
    results.push(`FAIL ${id} ${name}\n     ${(e as Error).message.split("\n")[0]}`);
  }
}

const blank = (): DrawState => ({ items: [], undone: [], ops: [], opN: 0 });
const act = (s: DrawState, type: string, payload?: unknown) => reduceDrawing(s, type, payload);
const sketch = (s: DrawState, full = false): PadView => ({ v: PAD_VERSION, turn: 0, n: s.opN, tail: s.ops, full: full ? encodeDrawing(s.items) : null });
const square = (x0: number, y0: number, x1: number, y1: number) => [x0, y0, x1, y0, x1, y1, x0, y1, x0, y0];
const px = (buf: Uint8Array, x: number, y: number) => buf[y * RES + x];
const sameBuf = (a: Uint8Array, b: Uint8Array) => a.length === b.length && a.every((v, i) => v === b[i]);

/** A drawing with every kind of item: lines in several colours and widths, an eraser line and fills. */
function sampleSession(): DrawState {
  let s = blank();
  s = act(s, "stroke", { s: 0, c: 0, w: 1, p: square(200, 200, 800, 800).slice(0, 6) });
  s = act(s, "stroke", { s: 0, p: square(200, 200, 800, 800).slice(6) });
  s = act(s, "fill", { c: 4, x: 500, y: 500 });
  s = act(s, "stroke", { s: 2, c: 11, w: 3, p: [300, 300, 340, 360, 400, 380, 460, 360] });
  s = act(s, "stroke", { s: 3, c: 0, w: 2, e: true, p: [450, 600, 500, 650, 550, 620] });
  s = act(s, "fill", { c: 7, x: 50, y: 50 });
  return s;
}

check("D1", "12 named colours and 4 widths; every colour fits the one-digit wire code", () => {
  assert.equal(COLORS.length, 12);
  assert.deepEqual(COLOR_NAMES, ["Kaala", "Safed", "Laal", "Narangi", "Peela", "Hara", "Neela", "Aasmani", "Jamuni", "Gulabi", "Bhoora", "Skin"]);
  assert.equal(WIDTHS.length, 4);
  assert.ok(COLORS.length <= 36);
});

check("D2", "drawing encodes and decodes back exactly (strokes, eraser, fills, colour 11)", () => {
  const items = sampleSession().items;
  assert.equal(items.length, 5);
  assert.deepEqual(decodeDrawing(encodeDrawing(items)), items);
  assert.deepEqual(decodeDrawing("garbage|s|f1|"), []);
});

check("D3", "host: stroke, extend, fill, undo, redo and clear all log ops phones can replay", () => {
  let s = sampleSession();
  const before = s.items;
  s = act(s, "undo");
  assert.equal(s.items.length, 4);
  assert.equal(s.undone.length, 1);
  s = act(s, "undo");
  s = act(s, "redo");
  s = act(s, "redo");
  assert.deepEqual(s.items, before);
  assert.equal(s.ops[s.ops.length - 1].k, "i");
  s = act(s, "redo");
  assert.deepEqual(s.items, before, "nothing left to redo");
  s = act(s, "clear");
  assert.deepEqual(s.items, []);
  assert.equal(act(s, "undo"), s, "undo on an empty page does nothing");
});

check("D4", "a new line or fill wipes the redo list (both on host)", () => {
  let s = sampleSession();
  s = act(s, "undo");
  s = act(s, "stroke", { s: s.items.length, c: 2, w: 0, p: [10, 10, 20, 20] });
  assert.equal(s.undone.length, 0);
  const n = s.items.length;
  s = act(s, "redo");
  assert.equal(s.items.length, n);
});

check("D5", "phones rebuild the same drawing from op tails, from keyframes, and after missing updates", () => {
  let s = blank();
  let phone = emptyPad();
  const steps: [string, unknown][] = [
    ["stroke", { s: 0, c: 0, w: 1, p: square(100, 100, 400, 400) }],
    ["fill", { c: 2, x: 250, y: 250 }],
    ["stroke", { s: 2, c: 5, w: 2, p: [500, 500, 600, 600] }],
    ["stroke", { s: 2, p: [650, 620, 700, 700] }],
    ["undo", null],
    ["redo", null],
    ["stroke", { s: 3, c: 0, w: 0, e: 1, p: [120, 120, 380, 380] }],
  ];
  for (const [t, p] of steps) {
    s = act(s, t, p);
    phone = nextPad(phone, sketch(s));
  }
  assert.deepEqual(phone.items, s.items);
  // A phone that missed everything: stale until a keyframe, then exact.
  let late = { turn: 0, n: 0, items: [] as Item[], stale: false };
  for (let i = 0; i < 20; i++) s = act(s, "stroke", { s: s.items.length, c: 1, w: 0, p: [i * 10, 900, i * 10 + 5, 905] });
  late = nextPad(late, sketch(s));
  assert.equal(late.stale, true);
  late = nextPad(late, sketch(s, true));
  assert.equal(late.stale, false);
  assert.deepEqual(late.items, s.items);
});

check("D6", "limits: long lines must be split, a full page refuses more, at most MAX_FILLS fills", () => {
  let s = blank();
  const line = (n: number, y: number) => Array.from({ length: n }, (_, i) => (i % 2 ? y : i % 1000));
  s = act(s, "stroke", { s: 0, c: 0, w: 0, p: line(400, 10) });
  for (let k = 0; k < 4; k++) s = act(s, "stroke", { s: 0, p: line(400, 10) });
  assert.equal(pointCount(s.items), MAX_STROKE_POINTS);
  const same = act(s, "stroke", { s: 0, p: [1, 1] });
  assert.equal(same, s, "stroke is full: the phone starts a new stroke instead");
  while (pointCount(s.items) + 400 <= MAX_POINTS) s = act(s, "stroke", { s: s.items.length, c: 0, w: 0, p: line(400, 20) });
  const left = MAX_POINTS - pointCount(s.items);
  assert.equal(act(s, "stroke", { s: s.items.length, c: 0, w: 0, p: line(left + 2, 30) }), s, "more points than the page has room for");
  let f = blank();
  for (let i = 0; i < MAX_FILLS + 5; i++) f = act(f, "fill", { c: 2, x: 10, y: 10 });
  assert.equal(f.items.length, MAX_FILLS);
  assert.equal(act(blank(), "fill", { c: 2, x: 2000, y: 10 }).items.length, 0, "fill outside the page is refused");
  assert.equal(act(blank(), "stroke", { s: 0, c: 0, w: 0, p: [1.5, 2] }).items.length, 0, "non-integer points refused");
});

check("D7", "old phones' stroke messages (no eraser flag, old width 0–2) still work", () => {
  const s = act(blank(), "stroke", { s: 0, c: 3, w: 2, p: [10, 10, 50, 50] });
  assert.deepEqual(s.items, [{ k: "s", c: 3, w: 2, e: false, p: [10, 10, 50, 50] }]);
});

check("D8", "a game saved by older code (no items) doesn't crash", () => {
  const old = { strokes: [{ c: 0, w: 1, p: [1, 2] }], ops: [], opN: 3 } as unknown as DrawState;
  const s = act(old, "stroke", { s: 0, c: 0, w: 1, p: [5, 5, 9, 9] });
  assert.equal(s.items.length, 1);
});

check("R1", "fill paints inside a closed shape only", () => {
  const items: Item[] = [
    { k: "s", c: 0, w: 0, e: false, p: square(200, 200, 600, 600) },
    { k: "f", c: 4, x: 400, y: 400 },
  ];
  const buf = rasterize(items);
  assert.equal(px(buf, 400, 400), 5, "inside is Peela (colour 4 → value 5)");
  assert.equal(px(buf, 100, 100), 0, "outside stays page");
  assert.equal(px(buf, 800, 800), 0);
  assert.equal(px(buf, 200, 400), 1, "the line itself stays Kaala");
});

check("R2", "a line drawn bit by bit gives the same pixels as the finished line (so fills match everywhere)", () => {
  const s = sampleSession();
  const whole = rasterize(s.items);
  // Grow every stroke two points at a time, like a viewer replaying updates.
  const r = new Raster();
  const built: Item[] = [];
  for (const it of s.items) {
    if (it.k === "f") {
      built.push(it);
      r.sync(built.slice());
      continue;
    }
    for (let n = 2; n <= it.p.length; n += 2) {
      const next = [...built, { ...it, p: it.p.slice(0, n) }];
      r.sync(next);
      if (n === it.p.length) built.push(next[next.length - 1]);
    }
  }
  const last = s.items[s.items.length - 1];
  assert.equal(last.k, "f", "sample ends with a fill so every end piece is settled");
  assert.ok(sameBuf(r.buf, whole), "incremental and one-shot pictures differ");
});

check("R3", "undo (snapshot) and redo give the same pixels as drawing from scratch", () => {
  const s = sampleSession();
  const r = new Raster();
  r.sync(s.items);
  const redraws = r.redraws;
  r.sync(s.items.slice(0, -1));
  assert.equal(r.redraws, redraws, "undo of the last item used a snapshot");
  const fresh = new Raster();
  fresh.sync(s.items.slice(0, -1));
  assert.ok(sameBuf(r.buf, fresh.buf));
  r.sync(s.items);
  assert.ok(sameBuf(r.buf, rasterize(s.items)));
});

check("R4", "keyframe (new objects) with the same drawing doesn't change pixels", () => {
  const s = sampleSession();
  const r = new Raster();
  r.sync(s.items);
  const a = r.buf.slice();
  r.sync(decodeDrawing(encodeDrawing(s.items)));
  assert.ok(sameBuf(r.buf, a));
});

check("R5", "eraser and Safed paint the page colour; fill on the page fills around the drawing", () => {
  const buf = rasterize(sampleSession().items);
  assert.equal(px(buf, 500, 640), 0, "erased spot inside the shape is page, and the outside fill didn't reach it");
  assert.equal(px(buf, 50, 50), 8, "outside filled Aasmani (colour 7 → value 8)");
  assert.equal(px(buf, 500, 500), 5, "inside still Peela");
});

check("R6", "random sessions: the live picture always matches a fresh one (300 random steps)", () => {
  let seed = 7;
  const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
  const ri = (n: number) => Math.floor(rnd() * n);
  let s = blank();
  const live = new Raster();
  let checks = 0;
  for (let step = 0; step < 300; step++) {
    const r = rnd();
    if (r < 0.45) {
      const n = 1 + ri(6);
      const p = Array.from({ length: n * 2 }, () => ri(1001));
      const extend = s.items[s.items.length - 1]?.k === "s" && rnd() < 0.5;
      s = act(s, "stroke", extend ? { s: s.items.length - 1, p } : { s: s.items.length, c: ri(12), w: ri(4), e: rnd() < 0.15, p });
    } else if (r < 0.6) s = act(s, "fill", { c: ri(12), x: ri(1001), y: ri(1001) });
    else if (r < 0.75) s = act(s, "undo");
    else if (r < 0.85) s = act(s, "redo");
    else if (r < 0.87) s = act(s, "clear");
    live.sync(s.items);
    if (step % 15 === 0) {
      const fresh = new Raster();
      fresh.sync(decodeDrawing(encodeDrawing(s.items)));
      assert.ok(sameBuf(live.buf, fresh.buf), `step ${step}: live picture drifted`);
      checks++;
    }
  }
  assert.ok(checks >= 20);
});

check("P1", "a heavy page redraws from scratch in reasonable time", () => {
  let s = blank();
  for (let i = 0; i < 40; i++) {
    const p = Array.from({ length: 200 }, (_, k) => (k % 2 ? 100 + ((i * 20) % 800) + Math.round(30 * Math.sin(k / 9)) : 50 + k * 4));
    s = act(s, "stroke", { s: s.items.length, c: i % 12, w: 3, p });
  }
  for (let i = 0; i < 20; i++) s = act(s, "fill", { c: i % 12, x: 20 + i * 45, y: 990 - i * 40 });
  const t0 = Date.now();
  rasterize(s.items);
  const ms = Date.now() - t0;
  results.push(`INFO P1 full redraw of ${s.items.length} items took ${ms} ms on this machine`);
  assert.ok(ms < 3000);
});

check("S1", "point clean-up keeps the ends and the shape, drops straight-line points", () => {
  const straight = Array.from({ length: 50 }, (_, i) => [i * 10, i * 10]).flat();
  assert.deepEqual(simplify(straight), [0, 0, 490, 490]);
  const corner = [0, 0, 50, 0, 100, 0, 100, 50, 100, 100];
  assert.deepEqual(simplify(corner), [0, 0, 100, 0, 100, 100]);
  assert.deepEqual(simplify([5, 5]), [5, 5]);
});

check("S2", "ops apply the same way everywhere (applyOp is pure)", () => {
  const items = sampleSession().items;
  const copy = JSON.parse(JSON.stringify(items));
  applyOp(items, { k: "u" });
  applyOp(items, { k: "a", s: items.length - 1, c: 0, w: 0, e: 0, p: "0000" });
  assert.deepEqual(items, copy);
});

for (const r of results) console.log(r);
const failed = results.filter((r) => r.startsWith("FAIL")).length;
console.log(`\n${passed}/${passed + failed} passed`);
if (failed) process.exit(1);
