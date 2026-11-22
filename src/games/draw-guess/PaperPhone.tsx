"use client";
import confetti from "canvas-confetti";
import { Check, Eraser, Eye, PaintBucket, Pencil, Redo2, Send, SkipForward, Trash2, Trophy, Undo2, WifiOff } from "lucide-react";
import { AnimatePresence, MotionConfig, motion, useReducedMotion } from "motion/react";
import { useEffect, useId, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { CountUp, PaperButton, PaperSheet, Sticker } from "@/components/paper/Paper";
import { dur, ease, screenIn, spring } from "@/components/paper/motion";
import { InkDefs, Stamp } from "@/components/paper/objects";
import { celebrate } from "@/lib/celebrate";
import { playerColor } from "@/lib/colors";
import { useOnChange, useSfx } from "@/lib/roomAudio";
import type { PhoneProps, Player } from "@/lib/types";
import { PadCanvas, PadDrawing, type LiveInk } from "./pad";
import {
  COLORS,
  COLOR_NAMES,
  DRAWER_AWAY_SKIP,
  MAX_BATCH,
  MAX_STROKE_POINTS,
  SEND_EVERY,
  WIDTHS,
  WIDTH_NAMES,
  canAddItem,
  clampCoord,
  fillCount,
  pointCount,
  pointsLeft,
  simplify,
  type FeedEntry,
  type Item,
  type Priv,
  type Pub,
  type Stroke,
} from "./shared";
import { usePadStrokes } from "./usePad";

const PENCIL = "#6b6258";
const NOTE = "#fff3a8";

const nameOf = (players: Player[], id: string | null) => players.find((p) => p.id === id)?.name ?? "Koi";

function ranked(players: Player[], scores: Record<string, number>) {
  return players
    .filter((p) => p.id in scores)
    .map((p) => ({ p, s: scores[p.id] ?? 0 }))
    .sort((a, b) => b.s - a.s);
}

function smallConfetti(color: string) {
  try {
    confetti({ particleCount: 26, spread: 55, startVelocity: 24, gravity: 1.1, scalar: 0.8, ticks: 90, origin: { x: 0.5, y: 0.7 }, colors: [color, "#f2b632", "#1e1a17"], disableForReducedMotion: true });
  } catch {}
}

/* ------------------------------------------------------------------ */
/* Top bar and timer                                                    */
/* ------------------------------------------------------------------ */

function ScoreTick({ score }: { score: number }) {
  const prev = useRef(score);
  const from = prev.current;
  useEffect(() => {
    prev.current = score;
  }, [score]);
  return <CountUp key={score} from={from} to={score} />;
}

function TopBar({ view, players, me, onScores }: { view: Pub; players: Player[]; me: Player; onScores: () => void }) {
  const drawer = players.find((p) => p.id === view.drawerId);
  const iDraw = view.drawerId === me.id;
  return (
    <div className="flex min-h-11 items-center justify-between gap-3">
      <div className="flex min-w-0 items-center gap-2.5">
        {drawer && <Sticker id={drawer.avatar} size={36} tilt={-4} />}
        <div className="min-w-0">
          <div className="font-display truncate text-p-lead font-extrabold leading-tight">{iDraw ? "Aapki baari!" : `${drawer?.name ?? "Koi"} ki baari`}</div>
          <div className="text-p-note font-semibold text-muted">
            Baari {Math.min(view.turn + 1, view.totalTurns)} / {view.totalTurns}
          </div>
        </div>
      </div>
      <button
        onClick={onScores}
        aria-label={`Your score: ${view.scores[me.id] ?? 0}. Show all scores`}
        className="press flex h-11 shrink-0 items-center gap-1.5 rounded-cut border-[1.5px] border-ink/25 px-2.5 text-p-body font-bold"
      >
        <Trophy className="h-4 w-4 text-turmeric-ink" strokeWidth={2.4} /> <ScoreTick score={view.scores[me.id] ?? 0} />
      </button>
    </div>
  );
}

/** A pencil-line timer that shortens; calm until the last five seconds. */
function TimeStrip({ deadline, total, now, label }: { deadline: number; total: number; now: number; label: string }) {
  const left = Math.max(0, deadline - now);
  const secs = Math.ceil(left / 1000);
  const pct = Math.max(0, Math.min(100, (left / total) * 100));
  const low = secs <= 5;
  return (
    <div role="timer" aria-label={`${label}: ${secs} seconds left`} className="flex items-center gap-3">
      <span className="w-24 shrink-0 text-p-note font-semibold text-muted">{label}</span>
      <div className="h-3 flex-1 overflow-hidden rounded-full border-[1.5px] border-ink bg-paper">
        <div className="h-full" style={{ width: `${pct}%`, background: low ? "var(--vermilion)" : PENCIL, transition: "width 0.3s linear, background-color 0.3s" }} />
      </div>
      <span className={`font-display w-9 text-right text-p-title font-extrabold tabular-nums ${low ? "text-vermilion" : ""}`}>{secs}</span>
    </div>
  );
}

/** Compact round timer for the drawer's one-screen layout. */
function DrawClock({ deadline, total, now }: { deadline: number; total: number; now: number }) {
  const left = Math.max(0, deadline - now);
  const secs = Math.ceil(left / 1000);
  const frac = Math.max(0, Math.min(1, left / total));
  const low = secs <= 10;
  const r = 19, c = 2 * Math.PI * r;
  return (
    <div role="timer" aria-label={`${secs} seconds left`} className="relative h-11 w-11 shrink-0">
      <svg viewBox="0 0 44 44" className="h-11 w-11 -rotate-90" aria-hidden>
        <circle cx="22" cy="22" r={r} fill="var(--paper)" stroke="var(--line)" strokeWidth="4" />
        <circle cx="22" cy="22" r={r} fill="none" stroke={low ? "var(--vermilion)" : PENCIL} strokeWidth="4" strokeDasharray={c} strokeDashoffset={c * (1 - frac)} style={{ transition: "stroke-dashoffset 0.3s linear" }} />
      </svg>
      <span className={`font-display absolute inset-0 flex items-center justify-center text-p-body font-extrabold tabular-nums ${low ? "text-vermilion" : ""}`}>{secs}</span>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* The sketch pad                                                       */
/* ------------------------------------------------------------------ */

/** Spiral binding: a row of wire loops along the top edge. */
function Spiral() {
  return (
    <svg aria-hidden viewBox="0 0 300 26" preserveAspectRatio="none" className="absolute inset-x-3 -top-3 h-7 w-[calc(100%-1.5rem)]">
      {Array.from({ length: 15 }, (_, i) => {
        const x = 10 + i * 20;
        return (
          <g key={i}>
            <circle cx={x} cy="19" r="3" fill="#1e1a17" opacity="0.18" />
            <path d={`M${x - 3} 19 C ${x - 4} 2, ${x + 4} 2, ${x + 3} 19`} fill="none" stroke="#1e1a17" strokeWidth="2.2" strokeLinecap="round" />
          </g>
        );
      })}
    </svg>
  );
}

/**
 * The sketch pad with spiral binding. Each turn is a new page: when the turn
 * changes the old page tears off upwards and a fresh one sits underneath.
 */
function SketchPad({ pageKey, children, footer }: { pageKey: string; children: React.ReactNode; footer?: React.ReactNode }) {
  const reduce = useReducedMotion();
  return (
    <div className="cut relative mt-4 rounded-soft bg-paper px-3 pb-3 pt-5">
      <Spiral />
      {/* Pages underneath peek out at the bottom. */}
      <div aria-hidden className="absolute inset-x-4 -bottom-[5px] h-2 rounded-b-cut border-[1.5px] border-t-0 border-ink bg-paper" />
      {/* On short phones the page shrinks so the drawer's crayons stay on screen. */}
      <div className="relative mx-auto aspect-square w-full" style={{ maxWidth: "min(100%, calc(100dvh - 22rem))" }}>
        <AnimatePresence initial={false}>
          <motion.div
            key={pageKey}
            className="absolute inset-0 overflow-hidden rounded-cut border-[1.5px] border-ink/25 bg-white"
            style={{ transformOrigin: "20% 0%" }}
            initial={reduce ? { opacity: 0 } : { opacity: 0, y: 6 }}
            animate={{ opacity: 1, y: 0, rotate: 0, transition: { duration: dur.screen, ease: ease.out } }}
            exit={reduce ? { opacity: 0, transition: { duration: 0.15 } } : { y: -60, rotate: -7, opacity: 0, transition: { duration: 0.34, ease: ease.in } }}
          >
            {/* Perforation under the binding. */}
            <div aria-hidden className="absolute inset-x-0 top-1.5 border-t-[1.5px] border-dashed border-ink/15" />
            {children}
          </motion.div>
        </AnimatePresence>
      </div>
      {footer}
    </div>
  );
}

/** What guessers (and everyone at reveal) see on the page. */
function ViewerPage({ view, label }: { view: Pub; label: string }) {
  const { items, stale, mismatch } = usePadStrokes(view.sketch);
  return (
    <>
      <PadDrawing items={items} label={label} className="h-full" />
      {stale && <span className="absolute bottom-2 right-2 rounded-cut bg-paper/90 px-2 py-0.5 text-p-note font-semibold text-muted">Drawing aa rahi hai…</span>}
      {mismatch && <VersionNote />}
    </>
  );
}

/** Shown when this phone and the host run different versions of the game. */
function VersionNote() {
  return (
    <div role="status" className="absolute inset-x-3 top-1/2 -translate-y-1/2 rounded-cut border-[1.5px] border-ink bg-paper px-3 py-2 text-center text-p-body font-semibold">
      Game ka naya version aaya hai. Drawing dekhne ke liye page refresh karein.
    </div>
  );
}

type Tool = "pen" | "eraser" | "fill";
type Popup = null | "size" | "color" | "clear";

/** Dot that previews line size and colour. */
function SizeDot({ w, color, max = 18 }: { w: number; color: string; max?: number }) {
  const px = Math.min(max, Math.round(3 + (WIDTHS[w] ?? 12) * 0.32));
  return <span aria-hidden className="block rounded-full border border-ink/40" style={{ width: px, height: px, background: color }} />;
}

function ToolButton({
  label,
  on = false,
  disabled = false,
  onClick,
  children,
  danger = false,
  expanded,
}: {
  label: string;
  on?: boolean;
  disabled?: boolean;
  onClick: () => void;
  children: React.ReactNode;
  danger?: boolean;
  expanded?: boolean;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      aria-pressed={expanded === undefined ? on : undefined}
      aria-expanded={expanded}
      disabled={disabled}
      onClick={onClick}
      className={`press relative flex h-12 min-w-0 items-center justify-center rounded-cut border-[1.5px] disabled:opacity-35 ${
        on ? "border-ink bg-turmeric shadow-[2px_2px_0_0_var(--ink)]" : "border-ink/25 bg-paper"
      } ${danger ? "text-vermilion" : ""}`}
    >
      {children}
    </button>
  );
}

/**
 * The drawer's page. Lines are smoothed, points are cleaned up before sending,
 * and the phone checks the same limits as the host, so what the drawer sees is
 * what everyone sees. Points go to the host every SEND_EVERY ms.
 */
function DrawerPad({
  turn,
  hostItems,
  hostStale,
  send,
  header,
  guesses,
}: {
  turn: number;
  hostItems: Item[];
  hostStale: boolean;
  send: (t: string, p?: unknown) => void;
  header: React.ReactNode;
  guesses: React.ReactNode;
}) {
  const [items, setItemsState] = useState<Item[]>(hostItems);
  const [redoN, setRedoN] = useState(0);
  const [tool, setTool] = useState<Tool>("pen");
  const [color, setColor] = useState(0);
  const [width, setWidth] = useState(1);
  const [popup, setPopup] = useState<Popup>(null);
  const [full, setFull] = useState(false);
  const [touched, setTouched] = useState(false);
  const itemsRef = useRef<Item[]>(hostItems);
  const redo = useRef<Item[]>([]);
  const live = useRef<LiveInk>({ s: null, v: 0 });
  const raw = useRef<number[]>([]);
  const cur = useRef<{ index: number; started: boolean; c: number; w: number; e: boolean } | null>(null);
  const pointer = useRef<number | null>(null);
  const lastSend = useRef(0);
  const hostRef = useRef({ items: hostItems, stale: hostStale });
  hostRef.current = { items: hostItems, stale: hostStale };
  const sendRef = useRef(send);
  sendRef.current = send;

  const setItems = (next: Item[]) => {
    itemsRef.current = next;
    setItemsState(next);
  };
  const bump = (s: Stroke | null) => {
    live.current = { s, v: live.current.v + 1 };
  };
  const out = (t: string, p?: unknown) => {
    lastSend.current = Date.now();
    sendRef.current(t, p);
  };

  // A fresh page each turn (or the host's copy, if this phone reloaded mid-drawing).
  useEffect(() => {
    setItems(hostRef.current.items);
    redo.current = [];
    setRedoN(0);
    raw.current = [];
    cur.current = null;
    pointer.current = null;
    setFull(false);
    setPopup(null);
    setTouched(false);
    bump(null);
  }, [turn]);

  const endStroke = () => {
    cur.current = null;
    pointer.current = null;
    raw.current = [];
    bump(null);
  };

  /** Sends the points waiting to go, cleaned up and split to fit the limits. */
  const flush = () => {
    const c = cur.current;
    if (!c || !raw.current.length) return;
    let list = itemsRef.current;
    let pts: number[];
    if (c.started) {
      const last = list[c.index] as Stroke;
      const bx = last.p[last.p.length - 2], by = last.p[last.p.length - 1];
      pts = simplify([bx, by, ...raw.current]).slice(2);
    } else {
      c.index = list.length;
      pts = simplify(raw.current);
    }
    raw.current = [];
    while (pts.length >= 2) {
      const left = pointsLeft(list) - (pointsLeft(list) % 2);
      if (left < 2) {
        setFull(true);
        endStroke();
        break;
      }
      if (!c.started) {
        if (!canAddItem(list, "s")) {
          setFull(true);
          endStroke();
          break;
        }
        const chunk = pts.splice(0, Math.min(MAX_BATCH, MAX_STROKE_POINTS, left));
        out("stroke", { s: c.index, c: c.c, w: c.w, e: c.e, p: chunk });
        list = [...list, { k: "s", c: c.c, w: c.w, e: c.e, p: chunk }];
        c.started = true;
        redo.current = [];
        setRedoN(0);
        continue;
      }
      const last = list[c.index] as Stroke;
      const room = MAX_STROKE_POINTS - last.p.length;
      if (room < 2) {
        // A very long line carries on as a new stroke from the same spot.
        c.index = list.length;
        c.started = false;
        pts.unshift(last.p[last.p.length - 2], last.p[last.p.length - 1]);
        continue;
      }
      const chunk = pts.splice(0, Math.min(MAX_BATCH, room, left));
      out("stroke", { s: c.index, c: c.c, w: c.w, e: c.e, p: chunk });
      list = [...list.slice(0, -1), { ...last, p: [...last.p, ...chunk] }];
    }
    setItems(list);
  };

  useEffect(() => {
    const t = setInterval(() => {
      flush();
      // Safety net: if the host's copy differs once things are quiet, follow the host.
      const h = hostRef.current;
      if (!cur.current && !h.stale && Date.now() - lastSend.current > 1500) {
        const mine = itemsRef.current;
        if (h.items.length !== mine.length || pointCount(h.items) !== pointCount(mine) || fillCount(h.items) !== fillCount(mine)) {
          setItems(h.items);
          redo.current = [];
          setRedoN(0);
        }
      }
    }, SEND_EVERY);
    return () => clearInterval(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- reads refs only
  }, []);

  const toUnits = (e: { clientX: number; clientY: number }, el: Element) => {
    const r = el.getBoundingClientRect();
    return [clampCoord(((e.clientX - r.left) / r.width) * 1000), clampCoord(((e.clientY - r.top) / r.height) * 1000)];
  };

  const down = (e: ReactPointerEvent<HTMLCanvasElement>) => {
    if (e.button > 0 || pointer.current !== null) return;
    e.preventDefault();
    setPopup(null);
    setTouched(true);
    const [x, y] = toUnits(e, e.currentTarget);
    const list = itemsRef.current;
    if (tool === "fill") {
      if (!canAddItem(list, "f")) {
        setFull(true);
        return;
      }
      setItems([...list, { k: "f", c: color, x, y }]);
      redo.current = [];
      setRedoN(0);
      out("fill", { c: color, x, y });
      return;
    }
    if (!canAddItem(list, "s")) {
      setFull(true);
      return;
    }
    e.currentTarget.setPointerCapture(e.pointerId);
    pointer.current = e.pointerId;
    const c = { index: list.length, started: false, c: color, w: width, e: tool === "eraser" };
    cur.current = c;
    raw.current = [x, y];
    bump({ k: "s", c: c.c, w: c.w, e: c.e, p: [x, y] });
  };

  const move = (e: ReactPointerEvent<HTMLCanvasElement>) => {
    if (pointer.current !== e.pointerId || !cur.current || !live.current.s) return;
    const el = e.currentTarget;
    const evs = typeof e.nativeEvent.getCoalescedEvents === "function" ? e.nativeEvent.getCoalescedEvents() : [];
    const list = evs.length ? evs : [e.nativeEvent];
    const p = live.current.s.p.slice();
    let added = false;
    for (const ev of list) {
      const [x, y] = toUnits(ev, el);
      const lx = p[p.length - 2], ly = p[p.length - 1];
      if (Math.abs(lx - x) + Math.abs(ly - y) < 2) continue;
      p.push(x, y);
      raw.current.push(x, y);
      added = true;
    }
    if (added) bump({ ...live.current.s, p });
  };

  const up = (e: ReactPointerEvent<HTMLCanvasElement>) => {
    if (pointer.current !== e.pointerId) return;
    flush();
    endStroke();
  };

  const undo = () => {
    flush();
    endStroke();
    const list = itemsRef.current;
    if (!list.length) return;
    redo.current = [...redo.current, list[list.length - 1]];
    setRedoN(redo.current.length);
    setItems(list.slice(0, -1));
    setFull(false);
    out("undo");
  };
  const redoIt = () => {
    flush();
    endStroke();
    const it = redo.current[redo.current.length - 1];
    const list = itemsRef.current;
    if (!it || !canAddItem(list, it.k) || (it.k === "s" && it.p.length > pointsLeft(list))) return;
    redo.current = redo.current.slice(0, -1);
    setRedoN(redo.current.length);
    setItems([...list, it]);
    out("redo");
  };
  const clear = () => {
    flush();
    endStroke();
    setItems([]);
    redo.current = [];
    setRedoN(0);
    setFull(false);
    setPopup(null);
    out("clear");
  };

  // Close a pop-up on Escape.
  useEffect(() => {
    if (!popup) return;
    const k = (e: KeyboardEvent) => e.key === "Escape" && setPopup(null);
    window.addEventListener("keydown", k);
    return () => window.removeEventListener("keydown", k);
  }, [popup]);

  const fit = useFitSquare();
  const pageFull = full || !canAddItem(items, "s");
  const ink = COLORS[color];

  const popupBody =
    popup === "color" ? (
      <div role="group" aria-label="Colours" className="grid grid-cols-6 justify-items-center gap-2">
        {COLORS.map((c, i) => (
          <button
            key={c}
            type="button"
            aria-label={COLOR_NAMES[i]}
            aria-pressed={color === i}
            onClick={() => {
              setColor(i);
              if (tool === "eraser") setTool("pen");
              setPopup(null);
            }}
            className={`press flex h-11 w-11 items-center justify-center rounded-full ${color === i ? "ring-[3px] ring-ink ring-offset-2 ring-offset-paper" : ""}`}
          >
            <span className="block h-9 w-9 rounded-full border-[1.5px] border-ink" style={{ background: c }} />
          </button>
        ))}
        <div className="col-span-6 -mb-1 text-p-note font-semibold text-muted">{COLOR_NAMES[color]}</div>
      </div>
    ) : popup === "size" ? (
      <div role="group" aria-label="Line thickness" className="grid grid-cols-4 gap-2">
        {WIDTHS.map((w, i) => (
          <button
            key={w}
            type="button"
            aria-label={`${WIDTH_NAMES[i]} line`}
            aria-pressed={width === i}
            onClick={() => {
              setWidth(i);
              setPopup(null);
            }}
            className={`press flex h-14 flex-col items-center justify-center gap-1 rounded-cut border-[1.5px] ${width === i ? "border-ink bg-turmeric" : "border-ink/25 bg-paper"}`}
          >
            <SizeDot w={i} color={tool === "eraser" ? "#ffffff" : ink} max={22} />
            <span className="text-p-note font-semibold">{WIDTH_NAMES[i]}</span>
          </button>
        ))}
      </div>
    ) : popup === "clear" ? (
      <div className="space-y-2">
        <p className="font-display text-p-lead font-extrabold">Pakka saaf karein?</p>
        <p className="-mt-1 text-p-body text-muted">Poora page mit jayega. Undo se wapas nahi aayega.</p>
        <div className="grid grid-cols-2 gap-2">
          <PaperButton tone="paper" onClick={() => setPopup(null)}>
            Rehne do
          </PaperButton>
          <PaperButton tone="vermilion" onClick={clear}>
            <Trash2 className="h-4 w-4" strokeWidth={2.4} /> Saaf karo
          </PaperButton>
        </div>
      </div>
    ) : null;

  return (
    <section aria-label="Your drawing" className="space-y-2">
      {header}
      {guesses}
      <div ref={fit.ref} className="cut relative mx-auto rounded-soft bg-paper px-2 pb-2 pt-4" style={{ width: fit.size ? fit.size + 16 : undefined, maxWidth: "100%" }}>
        <Spiral />
        <div className="relative overflow-hidden rounded-cut border-[1.5px] border-ink/25 bg-white">
          <div aria-hidden className="pointer-events-none absolute inset-x-0 top-1.5 z-10 border-t-[1.5px] border-dashed border-ink/15" />
          <PadCanvas
            items={items}
            live={live}
            dataPad="draw"
            label="Your drawing pad. Draw with your finger."
            className={tool === "fill" ? "cursor-cell" : "cursor-crosshair"}
            onPointerDown={down}
            onPointerMove={move}
            onPointerUp={up}
          >
            {!items.length && !touched && (
              <span className="pointer-events-none absolute inset-0 flex items-center justify-center text-p-lead font-semibold text-ink/30">Yahan banao…</span>
            )}
            {pageFull && (
              <div role="status" className="pointer-events-none absolute inset-x-2 top-3 rounded-cut border-[1.5px] border-vermilion bg-paper/95 px-2 py-1 text-center text-p-note font-bold">
                Page bhar gaya! Undo karo ya page saaf karo.
              </div>
            )}
          </PadCanvas>
        </div>
      </div>

      <div ref={fit.toolsRef} className="relative">
        {popup && (
          <>
            <button type="button" aria-label="Close" tabIndex={-1} className="fixed inset-0 z-30 cursor-default" onClick={() => setPopup(null)} />
            <div
              role="dialog"
              aria-label={popup === "color" ? "Choose a colour" : popup === "size" ? "Choose line thickness" : "Clear the page?"}
              className="cut absolute inset-x-0 bottom-full z-40 mb-2 rounded-cut bg-paper p-3"
            >
              {popupBody}
            </div>
          </>
        )}
        <div role="toolbar" aria-label="Drawing tools" className="grid grid-cols-7 gap-0.5">
          <ToolButton
            label={`Pencil, ${WIDTH_NAMES[width]} line${tool === "pen" ? ". Tap again for line size" : ""}`}
            on={tool === "pen"}
            onClick={() => {
              if (tool === "pen") setPopup(popup === "size" ? null : "size");
              else {
                setTool("pen");
                setPopup(null);
              }
            }}
          >
            <Pencil className="h-5 w-5" strokeWidth={2.3} />
            <span className="absolute bottom-1 right-1 flex h-[18px] w-[18px] items-center justify-center">
              <SizeDot w={width} color={ink} max={14} />
            </span>
          </ToolButton>
          <ToolButton label={`Colour: ${COLOR_NAMES[color]}`} expanded={popup === "color"} onClick={() => setPopup(popup === "color" ? null : "color")}>
            <span className="block h-7 w-7 rounded-full border-[1.5px] border-ink" style={{ background: ink }} />
          </ToolButton>
          <ToolButton
            label={`Eraser${tool === "eraser" ? ". Tap again for size" : ""}`}
            on={tool === "eraser"}
            onClick={() => {
              if (tool === "eraser") setPopup(popup === "size" ? null : "size");
              else {
                setTool("eraser");
                setPopup(null);
              }
            }}
          >
            <Eraser className="h-5 w-5" strokeWidth={2.3} />
          </ToolButton>
          <ToolButton
            label="Fill with colour"
            on={tool === "fill"}
            onClick={() => {
              setTool("fill");
              setPopup(null);
            }}
          >
            <PaintBucket className="h-5 w-5" strokeWidth={2.3} />
            <span aria-hidden className="absolute bottom-1.5 right-1.5 h-2.5 w-2.5 rounded-full border border-ink/50" style={{ background: ink }} />
          </ToolButton>
          <ToolButton label="Undo" disabled={!items.length} onClick={undo}>
            <Undo2 className="h-5 w-5" strokeWidth={2.4} />
          </ToolButton>
          <ToolButton label="Redo" disabled={!redoN} onClick={redoIt}>
            <Redo2 className="h-5 w-5" strokeWidth={2.4} />
          </ToolButton>
          <ToolButton label="Clear the page" danger disabled={!items.length} expanded={popup === "clear"} onClick={() => setPopup(popup === "clear" ? null : "clear")}>
            <Trash2 className="h-5 w-5" strokeWidth={2.3} />
          </ToolButton>
        </div>
      </div>
    </section>
  );
}

/**
 * Sizes the drawer's page so the page and the toolbar fit on one screen
 * (from 360×640 up), without scrolling while drawing.
 */
function useFitSquare() {
  const ref = useRef<HTMLDivElement>(null);
  const toolsRef = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState<number | null>(null);
  useEffect(() => {
    const measure = () => {
      const el = ref.current;
      const parent = el?.parentElement;
      if (!el || !parent) return;
      const top = el.getBoundingClientRect().top + window.scrollY;
      const tools = toolsRef.current?.getBoundingClientRect().height ?? 48;
      // Frame padding (24) + gap above the toolbar (8) + toolbar + room at the bottom (12).
      const avail = window.innerHeight - top - 24 - 8 - tools - 12;
      const maxW = parent.getBoundingClientRect().width - 16;
      setSize(Math.round(Math.max(200, Math.min(maxW, avail))));
    };
    measure();
    const ro = new ResizeObserver(measure);
    if (ref.current?.parentElement) ro.observe(ref.current.parentElement);
    window.addEventListener("resize", measure);
    window.addEventListener("orientationchange", measure);
    return () => {
      ro.disconnect();
      window.removeEventListener("resize", measure);
      window.removeEventListener("orientationchange", measure);
    };
  }, []);
  return { ref, toolsRef, size };
}

/* ------------------------------------------------------------------ */
/* Word, guesses                                                        */
/* ------------------------------------------------------------------ */

/** The hidden word as letter boxes; the first letter appears halfway through. */
function MaskTiles({ mask, first }: { mask: string; first: string }) {
  const letters = [...mask].filter((c) => c === "_").length;
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5" aria-label={`The word has ${letters} letters${first ? `, starting with ${first}` : ""}`}>
      {mask.split(" ").map((word, wi) => (
        <div key={wi} className="flex gap-1">
          {[...word].map((c, i) => {
            const shown = wi === 0 && i === 0 && first ? first : c === "_" ? "" : c;
            const box = c === "_";
            return (
              <span
                key={i}
                aria-hidden
                className={`font-display flex h-9 items-center justify-center text-p-title font-extrabold uppercase leading-none ${
                  box ? `w-7 rounded-[6px] border-2 border-ink ${shown ? "bg-turmeric" : "bg-paper"} shadow-[1.5px_1.5px_0_0_var(--ink)]` : "w-3"
                }`}
              >
                {shown}
              </span>
            );
          })}
        </div>
      ))}
      <span className="rounded-full bg-ink px-2 py-0.5 text-p-note font-bold text-paper">{letters} akshar</span>
    </div>
  );
}

/** The newest guesses on one line, so the drawer sees them without scrolling. */
function GuessTicker({ feed, players, correct }: { feed: FeedEntry[]; players: Player[]; correct: number }) {
  const items = feed.slice(-3).reverse();
  return (
    <div aria-live="polite" className="flex h-8 min-w-0 items-center gap-2 overflow-hidden rounded-cut border-[1.5px] border-ink/20 bg-card px-2 text-p-note font-semibold">
      <span className="shrink-0 rounded-full bg-leaf/15 px-1.5 font-bold text-leaf">{correct} ✓</span>
      {items.length ? (
        items.map((f, i) => {
          const p = players.find((x) => x.id === f.playerId);
          return (
            <span key={feed.length - i} className={`flex min-w-0 shrink items-center gap-1 truncate ${i ? "opacity-60" : ""}`}>
              <b className="truncate">{p?.name ?? "?"}</b>
              <span className="truncate">{f.text === null ? "bujh gaye!" : f.text}</span>
            </span>
          );
        })
      ) : (
        <span className="truncate text-muted">Guesses yahan dikhenge…</span>
      )}
    </div>
  );
}

function GuessStrip({ tries, onSubmit }: { tries: number; onSubmit: (t: string) => void }) {
  const [text, setText] = useState("");
  const [shake, setShake] = useState(0);
  const id = useId();
  const prev = useRef(tries);
  useEffect(() => {
    if (tries > prev.current) setShake((n) => n + 1);
    prev.current = tries;
  }, [tries]);
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        const t = text.trim();
        if (!t) return;
        onSubmit(t);
        setText("");
      }}
      className="flex items-stretch gap-2"
    >
      <label htmlFor={id} className="sr-only">
        Your guess
      </label>
      <motion.div key={shake} className="cut min-w-0 flex-1 rounded-cut bg-paper" animate={shake ? { x: [0, -7, 7, -4, 0] } : undefined} transition={{ duration: 0.36 }}>
        <input
          id={id}
          value={text}
          onChange={(e) => setText(e.target.value.slice(0, 40))}
          placeholder="Kya hai yeh?"
          autoComplete="off"
          autoCorrect="off"
          enterKeyHint="send"
          onFocus={(e) => {
            const el = e.currentTarget;
            // Keep the box above the phone keyboard once it slides up.
            setTimeout(() => el.scrollIntoView({ block: "center", behavior: "smooth" }), 300);
          }}
          className="font-display h-14 w-full bg-transparent px-3 text-p-lead font-bold outline-none placeholder:font-semibold placeholder:text-ink/30"
        />
      </motion.div>
      <button type="submit" aria-label="Send guess" disabled={!text.trim()} className="cut press flex w-14 shrink-0 items-center justify-center rounded-cut bg-me text-ink disabled:opacity-45">
        <Send className="h-5 w-5" strokeWidth={2.4} />
      </button>
    </form>
  );
}

const NOTE_TILT = [-3, 2, -1.5, 3, -2.5, 1.5];

/** Recent guesses as small sticky notes. Correct guesses don't show the word. */
function GuessNotes({ view, players, me }: { view: Pub; players: Player[]; me: Player }) {
  const items = view.feed.slice(-6);
  if (!items.length) {
    return <p className="text-p-body text-muted">{view.drawerId === me.id ? "Sabke guesses yahan dikhenge." : "Pehla guess aap karo!"}</p>;
  }
  const base = view.feed.length - items.length;
  return (
    <ul className="flex flex-wrap gap-2" aria-label="Recent guesses">
      <AnimatePresence initial={false}>
        {items.map((f, i) => {
          const p = players.find((x) => x.id === f.playerId);
          const ok = f.text === null;
          return (
            <motion.li
              key={base + i}
              layout
              initial={{ opacity: 0, y: -8, scale: 0.9 }}
              animate={{ opacity: 1, y: 0, scale: 1, rotate: NOTE_TILT[(base + i) % NOTE_TILT.length] }}
              transition={spring.select}
              className="cut-drop flex max-w-[11rem] items-center gap-1.5 px-2 py-1.5 text-p-note font-semibold"
              style={{ background: ok ? "#cfe9d6" : NOTE }}
            >
              <Sticker id={p?.avatar} size={22} />
              <span className="min-w-0 truncate">
                <b>{p?.id === me.id ? "Aap" : (p?.name ?? "?")}</b> {ok ? "· Bujh liya!" : `· ${f.text}`}
              </span>
              {ok && <Check className="h-3.5 w-3.5 shrink-0 text-leaf" strokeWidth={3} />}
            </motion.li>
          );
        })}
      </AnimatePresence>
    </ul>
  );
}

/* ------------------------------------------------------------------ */
/* Choosing                                                             */
/* ------------------------------------------------------------------ */

const CHIT_TILT = [-1.2, 0.9, -0.6];

function WordChits({ choices, onPick }: { choices: string[]; onPick: (i: number) => void }) {
  return (
    <div data-word-choices className="grid gap-4" role="group" aria-label="Pick a word to draw">
      {choices.map((c, i) => (
        <motion.button
          key={c}
          type="button"
          onClick={() => onPick(i)}
          initial={{ opacity: 0, y: 12 }}
          animate={{ opacity: 1, y: 0, rotate: CHIT_TILT[i % 3], transition: { ...spring.settle, delay: i * 0.06 } }}
          whileTap={{ scale: 0.96 }}
          className="cut relative flex min-h-16 items-center justify-between gap-3 rounded-cut bg-paper px-4 text-left"
        >
          <span aria-hidden className="absolute inset-y-0 left-1/2 border-l-[1.5px] border-dashed border-ink/15" />
          <span className="font-display relative text-p-title font-extrabold">{c}</span>
          <Pencil className="relative h-5 w-5 shrink-0 text-muted" strokeWidth={2.2} />
        </motion.button>
      ))}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Reveal and results                                                   */
/* ------------------------------------------------------------------ */

function TurnResult({ view, players, me }: { view: Pub; players: Player[]; me: Player }) {
  const winners = players.filter((p) => (view.gains[p.id] ?? 0) > 0).sort((a, b) => (view.gains[b.id] ?? 0) - (view.gains[a.id] ?? 0));
  const myGain = view.gains[me.id] ?? 0;
  const iDrew = view.drawerId === me.id;
  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between gap-3">
        <div>
          <div className="text-p-note font-bold uppercase tracking-[0.16em] text-muted">Jawab tha</div>
          <div className="font-display text-p-title font-extrabold">{view.answer}</div>
        </div>
        <Stamp tone={view.correct.length ? "leaf" : "vermilion"} className="!text-p-lead -rotate-6">
          {view.correct.length ? "Bujh gaye!" : "Koi nahi!"}
        </Stamp>
      </div>
      <p className={`text-p-body font-semibold ${myGain ? "text-leaf" : "text-muted"}`}>
        {myGain ? `Shabash! +${myGain} points.` : iDrew ? "Kisi ne nahi bujha — agli baar thoda bada banao!" : "Is baar nahi. Agli baari aapki!"}
      </p>
      {winners.length > 0 && (
        <ul className="flex flex-wrap gap-2" aria-label="Points this turn">
          {winners.map((p) => (
            <li key={p.id} className="flex items-center gap-1.5 rounded-full border-[1.5px] border-line bg-card py-0.5 pl-0.5 pr-2.5 text-p-body font-bold">
              <Sticker id={p.avatar} size={28} />
              {p.id === me.id ? "Aap" : p.name}
              <span className="text-leaf">
                +<CountUp from={0} to={view.gains[p.id] ?? 0} />
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function Crown() {
  return (
    <svg aria-hidden width="34" height="20" viewBox="0 0 34 20" className="mb-0.5">
      <path d="M2 18 L5 5 L12 12 L17 2 L22 12 L29 5 L32 18 Z" fill="#f2b632" stroke="#1e1a17" strokeWidth="1.6" strokeLinejoin="round" />
    </svg>
  );
}

function ScoreList({ rows, meId, from = 0 }: { rows: { p: Player; s: number }[]; meId: string; from?: number }) {
  return (
    <ol className="divide-y-[1.5px] divide-line border-y-[1.5px] border-ink">
      {rows.map(({ p, s }, i) => (
        <li key={p.id} className="flex min-h-12 items-center gap-3 py-1.5">
          <span className="w-6 text-right text-p-body font-bold text-muted tabular-nums">{from + i + 1}</span>
          <Sticker id={p.avatar} size={32} />
          <span className={`min-w-0 flex-1 truncate text-p-lead font-bold ${p.id === meId ? "text-me-ink" : ""}`}>
            {p.name}
            {p.id === meId && <span className="ml-1.5 text-p-note font-semibold text-muted">you</span>}
          </span>
          <span className="font-display text-p-title font-extrabold tabular-nums">{s}</span>
        </li>
      ))}
    </ol>
  );
}

function Results({ view, players, me, isHost }: { view: Pub; players: Player[]; me: Player; isHost: boolean }) {
  const rows = useMemo(() => ranked(players, view.scores), [players, view.scores]);
  const top = rows.slice(0, 3);
  const winner = rows[0];
  const myPlace = rows.findIndex((r) => r.p.id === me.id) + 1;
  const iWon = myPlace === 1 && (winner?.s ?? 0) > 0;
  const [announced, setAnnounced] = useState(false);
  const winnerColor = winner ? playerColor(winner.p.avatar) : "#f2b632";
  useEffect(() => {
    const t = setTimeout(() => {
      setAnnounced(true);
      celebrate([winnerColor, "#fffdf8", "#1e1a17"]);
    }, 1750);
    return () => clearTimeout(t);
  }, [winnerColor]);
  const slots = [
    { r: top[1], place: 2, h: 92, delay: 0.75, bg: "var(--paper)" },
    { r: top[0], place: 1, h: 128, delay: 1.3, bg: "#f2b632" },
    { r: top[2], place: 3, h: 64, delay: 0.2, bg: "var(--paper)" },
  ];
  return (
    <div className="space-y-6">
      <div className="text-center">
        <div className="text-p-note font-bold uppercase tracking-[0.2em] text-muted">Saare page bhar gaye</div>
        <div className="relative mt-1 min-h-[5.75rem]">
          <AnimatePresence mode="wait" initial={false}>
            {announced ? (
              <motion.div key="winner" initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: dur.screen, ease: ease.out }}>
                <h2 className="text-p-show font-extrabold text-balance">{iWon ? "Aap jeet gaye!" : winner ? `Jeet: ${winner.p.name}!` : "Khel khatam!"}</h2>
                <p className="mt-1 text-p-lead text-muted">{myPlace > 0 ? `Aap #${myPlace} — ${view.scores[me.id] ?? 0} points.` : "Thanks for watching."}</p>
              </motion.div>
            ) : (
              <motion.h2 key="wait" className="text-p-show font-extrabold" exit={{ opacity: 0, y: -8, transition: { duration: dur.screenExit, ease: ease.in } }}>
                Sabse achha artist…?
              </motion.h2>
            )}
          </AnimatePresence>
        </div>
      </div>
      <div className="flex items-end justify-center gap-2.5 border-b-[1.5px] border-ink px-1" style={{ height: 250 }}>
        {slots.map(({ r, place, h, delay, bg }) =>
          r ? (
            <div key={r.p.id} className="flex w-[30%] max-w-28 flex-col items-center overflow-hidden" style={{ height: "100%", justifyContent: "flex-end" }}>
              <motion.div className="flex w-full flex-col items-center" initial={{ y: h + 110, opacity: 0 }} animate={{ y: 0, opacity: 1 }} transition={{ y: { ...spring.settle, delay }, opacity: { duration: 0.15, delay } }}>
                {place === 1 && <Crown />}
                <Sticker id={r.p.avatar} size={place === 1 ? 56 : 46} tilt={place === 1 ? -5 : place === 2 ? 4 : -3} />
                <div className={`mt-1 w-full truncate text-center text-p-body font-bold ${r.p.id === me.id ? "text-me-ink" : ""}`}>{r.p.id === me.id ? "You" : r.p.name}</div>
                <div className="mt-1.5 flex w-full flex-col items-center rounded-t-cut border-[1.5px] border-b-0 border-ink pt-1.5" style={{ height: h, background: bg, boxShadow: "2px 0 0 0 var(--ink)" }}>
                  <CountUp from={0} to={r.s} delay={delay + 0.2} className="font-display text-p-title font-extrabold" />
                  <span className="text-p-note font-bold uppercase tracking-[0.14em] text-ink/60">{place === 1 ? "1st" : place === 2 ? "2nd" : "3rd"}</span>
                </div>
              </motion.div>
            </div>
          ) : (
            <div key={place} className="w-[30%] max-w-28" />
          ),
        )}
      </div>
      {rows.length > 3 && <ScoreList rows={rows.slice(3)} meId={me.id} from={3} />}
      <p className="text-center text-p-body text-muted">{isHost ? "Agla game? Tap the home button at the top." : "Host agla game chun rahe hain…"}</p>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Phone                                                                */
/* ------------------------------------------------------------------ */

export function Phone({ view, priv, me, players, send, now, isHost, hostAct }: PhoneProps<Pub, Priv>) {
  const { shared, mine } = useSfx();
  const [showScores, setShowScores] = useState(false);
  const [confirmSkip, setConfirmSkip] = useState(false);
  const iDraw = view.drawerId === me.id;
  const drawerName = nameOf(players, view.drawerId);
  const got = view.correct.includes(me.id);
  const myWrong = view.feed.filter((f) => f.playerId === me.id && f.text !== null).length;
  const live = view.phase === "choosing" || view.phase === "drawing";
  const secsLeft = live ? Math.ceil(Math.max(0, view.deadline - now) / 1000) : -1;
  const hint = view.phase === "drawing" && now >= view.hintAt ? view.firstLetter : "";
  const { items: hostItems, stale: hostStale } = usePadStrokes(view.sketch);
  const drawingNow = view.phase === "drawing" && iDraw;
  const awayLeft = view.drawerAwaySince ? Math.max(0, Math.ceil((view.drawerAwaySince + DRAWER_AWAY_SKIP - now) / 1000)) : null;

  useOnChange(view.turn, () => {
    if (view.phase !== "over") shared("whoosh");
  });
  useOnChange(secsLeft, (n) => {
    if (n > 0 && n <= 5) shared("tick");
  });
  useOnChange(got, (n) => {
    if (n) {
      mine("ding", [40]);
      smallConfetti(playerColor(me.avatar));
    }
  });
  useOnChange(myWrong, (n, p) => {
    if (n > p && !got) mine("buzz", [120]);
  });
  useOnChange(!!hint, (n) => {
    if (n) shared("pop");
  });
  useOnChange(view.phase, (n) => {
    if (n === "drawing" && iDraw) mine("turn", [60]);
    if (n === "reveal") shared("reveal");
    if (n === "over") {
      const top = ranked(players, view.scores)[0];
      if (top?.p.id === me.id) mine("fanfare", [60, 40, 120]);
      else shared("fanfare");
    }
  });
  useEffect(() => setConfirmSkip(false), [view.turn, view.phase]);
  // The drawer's page and tools fit one screen; start at the top so nothing is hidden.
  useEffect(() => {
    if (drawingNow) window.scrollTo({ top: 0 });
  }, [drawingNow]);
  useEffect(() => {
    if (!confirmSkip) return;
    const t = setTimeout(() => setConfirmSkip(false), 3500);
    return () => clearTimeout(t);
  }, [confirmSkip]);

  const announce =
    view.phase === "over"
      ? "Game over. Final scores are shown."
      : view.phase === "reveal"
        ? `The word was ${view.answer}.`
        : got
          ? `Correct! Plus ${view.gains[me.id] ?? 0} points.`
          : view.phase === "drawing" && iDraw
            ? `Draw ${priv?.word ?? "your word"}.`
            : "";

  const timer =
    view.phase === "choosing" ? (
      <TimeStrip deadline={view.deadline} total={20_000} now={now} label={iDraw ? "Chuno" : "Soch rahe"} />
    ) : view.phase === "drawing" ? (
      <TimeStrip deadline={view.deadline} total={view.seconds * 1000} now={now} label={iDraw ? "Samay" : "Bana rahe"} />
    ) : view.phase === "reveal" && view.revealUntil ? (
      <p className="flex h-7 items-center justify-end text-p-body font-semibold text-muted tabular-nums">
        {view.turn + 1 >= view.totalTurns ? "Result" : "Agla page"} · {Math.max(0, Math.ceil((view.revealUntil - now) / 1000))}s
      </p>
    ) : null;

  return (
    <MotionConfig reducedMotion="user">
      <InkDefs />
      <div aria-live="polite" className="sr-only">
        {announce}
      </div>
      <AnimatePresence mode="wait" initial={false}>
        {view.phase === "over" ? (
          <motion.div key="over" {...screenIn}>
            <Results view={view} players={players} me={me} isHost={isHost} />
          </motion.div>
        ) : (
          <motion.div key="play" {...screenIn} className="space-y-4">
            {!drawingNow && (
              <>
                <TopBar view={view} players={players} me={me} onScores={() => setShowScores(true)} />
                <div className="min-h-7">{timer}</div>
              </>
            )}

            {awayLeft !== null && (
              <div role="status" className="flex items-center gap-2 rounded-cut border-[1.5px] border-vermilion bg-card px-3 py-2 text-p-body font-semibold">
                <WifiOff className="h-4 w-4 shrink-0 text-vermilion" />
                {iDraw ? "Aapka phone offline tha." : `${drawerName} ka phone offline hai — ${awayLeft}s mein agli baari.`}
              </div>
            )}

            {/* ---------- drawer: choose a word ---------- */}
            {view.phase === "choosing" && iDraw && (
              <section className="space-y-3" aria-label="Choose a word">
                <h2 className="text-p-title font-extrabold">Kya banaoge?</h2>
                <p className="-mt-2 text-p-body text-muted">Chupke se ek chit chuno. Drawing mein letters ya numbers nahi!</p>
                <WordChits choices={priv?.choices ?? []} onPick={(i) => send("choose", i)} />
                <div className="cut-soft mt-2 rounded-cut bg-card p-3">
                  <div className="text-p-note font-bold uppercase tracking-[0.14em] text-muted">Yeh log guess karenge</div>
                  <ul className="mt-2 flex flex-wrap gap-x-2 gap-y-2">
                    {players
                      .filter((p) => p.id !== me.id && p.id in view.scores)
                      .map((p) => (
                        <li key={p.id} className={`flex items-center gap-1.5 text-p-body font-semibold ${p.connected ? "" : "opacity-40"}`}>
                          <Sticker id={p.avatar} size={26} /> {p.name}
                        </li>
                      ))}
                  </ul>
                  <ul className="mt-3 space-y-1 text-p-body text-ink/80">
                    <li>· Bada aur simple banao — chhoti details baad mein.</li>
                    <li>· Pehle shape, phir rang.</li>
                    <li>· Jitna jaldi koi bujhe, utne zyada points dono ko.</li>
                  </ul>
                </div>
              </section>
            )}

            {/* ---------- drawer: draw (fits one screen: word, time, guesses, page, tools) ---------- */}
            {drawingNow && (
              <DrawerPad
                turn={view.turn}
                hostItems={hostItems}
                hostStale={hostStale}
                send={send}
                header={
                  <div className="flex items-center gap-2">
                    <div className="cut min-w-0 flex-1 -rotate-1 rounded-cut bg-turmeric px-2.5 py-1">
                      <span className="text-[11px] font-bold uppercase tracking-[0.14em]">Banao</span>
                      <div className="font-display truncate text-p-title font-extrabold leading-tight">{priv?.word ?? "…"}</div>
                    </div>
                    <DrawClock deadline={view.deadline} total={view.seconds * 1000} now={now} />
                    <button
                      onClick={() => setShowScores(true)}
                      aria-label={`Your score: ${view.scores[me.id] ?? 0}. Show all scores`}
                      className="press flex h-11 shrink-0 items-center gap-1 rounded-cut border-[1.5px] border-ink/25 px-2 text-p-body font-bold"
                    >
                      <Trophy className="h-4 w-4 text-turmeric-ink" strokeWidth={2.4} /> <ScoreTick score={view.scores[me.id] ?? 0} />
                    </button>
                  </div>
                }
                guesses={<GuessTicker feed={view.feed} players={players} correct={view.correct.length} />}
              />
            )}

            {/* ---------- everyone else, and everyone at reveal: one pad, so the page tears off between turns ---------- */}
            {(view.phase === "reveal" || !iDraw) && (
              <section className="space-y-3" aria-label={view.phase === "reveal" ? "Turn result" : view.phase === "drawing" ? "Guess the drawing" : "Waiting for the drawing"}>
                {view.phase === "drawing" && <MaskTiles mask={view.mask} first={hint} />}
                <SketchPad pageKey={`t${view.turn}`}>
                  {view.phase === "choosing" ? (
                    <div className="flex h-full flex-col items-center justify-center gap-3 px-6 text-center">
                      <motion.span animate={{ rotate: [-8, 8, -8] }} transition={{ duration: 1.6, repeat: Infinity, ease: "easeInOut" }}>
                        <Pencil className="h-10 w-10 text-muted" strokeWidth={2} />
                      </motion.span>
                      <p className="font-display text-p-lead font-extrabold">{drawerName} chit chun rahe hain…</p>
                      <p className="text-p-body text-muted">Taiyaar raho — jaldi guess karne pe zyada points!</p>
                    </div>
                  ) : (
                    <ViewerPage view={view} label={view.phase === "reveal" ? `${drawerName}'s drawing of ${view.answer}` : `${drawerName}'s drawing`} />
                  )}
                </SketchPad>
                {view.phase === "drawing" &&
                  (got ? (
                    <div className="flex items-center gap-3">
                      <Stamp tone="leaf" className="-rotate-3">
                        Sahi jawab!
                      </Stamp>
                      <span className="font-display text-p-title font-extrabold text-leaf">+{view.gains[me.id] ?? 0}</span>
                    </div>
                  ) : (
                    <GuessStrip tries={myWrong} onSubmit={(t) => send("guess", t)} />
                  ))}
                {view.phase === "drawing" && got && <p className="-mt-1 text-p-body font-semibold text-muted">Shh… baaki log abhi soch rahe hain.</p>}
                {view.phase === "reveal" && <TurnResult view={view} players={players} me={me} />}
              </section>
            )}

            {view.phase === "drawing" && !iDraw && (
              <section aria-label="Guesses" className="space-y-2">
                <h3 className="text-p-note font-bold uppercase tracking-[0.14em] text-muted">
                  Guesses · {view.correct.length} bujh gaye
                </h3>
                <GuessNotes view={view} players={players} me={me} />
              </section>
            )}

            {isHost && (
              <section aria-label="Host controls" className="mt-2 border-t-[1.5px] border-dashed border-ink/40 pt-3">
                <h3 className="mb-2 text-p-note font-semibold uppercase tracking-[0.14em] text-muted">Host ke controls</h3>
                {view.phase === "reveal" ? (
                  <PaperButton className="w-full" onClick={() => hostAct("next")}>
                    <SkipForward className="h-4 w-4" strokeWidth={2.4} /> {view.turn + 1 >= view.totalTurns ? "Result dikhao" : "Agli baari"}
                  </PaperButton>
                ) : (
                  <div className="grid grid-cols-2 gap-2">
                    <PaperButton tone="paper" disabled={view.phase !== "drawing"} onClick={() => hostAct("reveal")}>
                      <Eye className="h-4 w-4" strokeWidth={2.4} /> Jawab dikhao
                    </PaperButton>
                    <PaperButton
                      tone={confirmSkip ? "vermilion" : "paper"}
                      onClick={() => {
                        if (confirmSkip) hostAct("skip");
                        else setConfirmSkip(true);
                      }}
                    >
                      <SkipForward className="h-4 w-4" strokeWidth={2.4} /> {confirmSkip ? "Pakka skip?" : "Baari skip karo"}
                    </PaperButton>
                  </div>
                )}
              </section>
            )}
          </motion.div>
        )}
      </AnimatePresence>

      <PaperSheet open={showScores} onClose={() => setShowScores(false)} title="Ab tak ke points">
        <ScoreList rows={ranked(players, view.scores)} meId={me.id} />
      </PaperSheet>
    </MotionConfig>
  );
}
