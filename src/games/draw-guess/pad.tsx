"use client";
import { useEffect, useRef, type PointerEventHandler, type ReactNode } from "react";
import { PALETTE, RES, Raster, allSegments, endPieceSegments, inkOf, type Rect } from "./raster";
import { REPLAY_MS, WIDTHS, type Item, type Stroke } from "./shared";

/** A stroke still under the drawer's finger, drawn on top of the picture. `v` changes whenever it does. */
export interface LiveInk {
  s: Stroke | null;
  v: number;
}

const css = (v: number) => {
  const [r, g, b] = PALETTE[v] ?? PALETTE[1];
  return `rgb(${r},${g},${b})`;
};

/** Draws a whole stroke with the same shape as the grid (raster.ts), with the browser's smooth lines. */
function strokePath(ctx: CanvasRenderingContext2D, s: Stroke, k: number) {
  ctx.strokeStyle = css(inkOf(s));
  ctx.lineWidth = (WIDTHS[s.w] ?? WIDTHS[1]) * k;
  ctx.beginPath();
  for (const [ax, ay, bx, by] of allSegments(s)) {
    ctx.moveTo(ax * k, ay * k);
    ctx.lineTo(bx * k, by * k);
  }
  ctx.stroke();
}

/**
 * The drawing on a canvas. Every phone builds the same 1000×1000 picture (see
 * raster.ts) and shows it scaled to its screen at full sharpness.
 *
 * With `replay`, new points of the newest stroke are spread over REPLAY_MS so
 * lines grow smoothly between updates instead of jumping.
 */
export function PadCanvas({
  items,
  replay = false,
  live,
  label,
  className = "",
  onPointerDown,
  onPointerMove,
  onPointerUp,
  children,
  dataPad,
}: {
  items: Item[];
  replay?: boolean;
  live?: React.RefObject<LiveInk>;
  label: string;
  className?: string;
  onPointerDown?: PointerEventHandler<HTMLCanvasElement>;
  onPointerMove?: PointerEventHandler<HTMLCanvasElement>;
  onPointerUp?: PointerEventHandler<HTMLCanvasElement>;
  children?: ReactNode;
  dataPad?: string;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const target = useRef(items);
  target.current = items;
  const replayRef = useRef(replay);
  replayRef.current = replay;

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    const raster = new Raster();
    const off = document.createElement("canvas");
    off.width = RES;
    off.height = RES;
    const octx = off.getContext("2d")!;
    const img = octx.createImageData(RES, RES);
    let raf = 0;
    let need = true;
    let lastTarget: Item[] | null = null;
    let liveV = -1;
    const anim = { idx: -1, shown: 0, n: 0, rate: 0 };
    let lastT = performance.now();

    const resize = () => {
      const r = canvas.getBoundingClientRect();
      const dpr = Math.min(3, window.devicePixelRatio || 1);
      const w = Math.max(1, Math.round(r.width * dpr));
      if (canvas.width !== w || canvas.height !== w) {
        canvas.width = w;
        canvas.height = w;
        need = true;
      }
    };
    const ro = new ResizeObserver(resize);
    ro.observe(canvas);
    resize();

    const copy = (d: Rect) => {
      const data = img.data;
      const buf = raster.buf;
      for (let y = d.y0; y <= d.y1; y++) {
        let o = (y * RES + d.x0) * 4;
        for (let x = d.x0; x <= d.x1; x++, o += 4) {
          const c = PALETTE[buf[y * RES + x]] ?? PALETTE[0];
          data[o] = c[0];
          data[o + 1] = c[1];
          data[o + 2] = c[2];
          data[o + 3] = 255;
        }
      }
      octx.putImageData(img, 0, 0, d.x0, d.y0, d.x1 - d.x0 + 1, d.y1 - d.y0 + 1);
    };

    const frame = (t: number) => {
      raf = requestAnimationFrame(frame);
      const dt = Math.min(100, t - lastT);
      lastT = t;
      const items = target.current;
      if (items !== lastTarget) {
        const prev = lastTarget;
        lastTarget = items;
        need = true;
        const L = items.length - 1;
        const last = items[L];
        const grew =
          replayRef.current &&
          last?.k === "s" &&
          !!prev &&
          (prev.length === L || (prev.length === items.length && prev[L]?.k === "s" && (prev[L] as Stroke).p.length <= last.p.length));
        if (grew) {
          const n = last.p.length / 2;
          const from = anim.idx === L ? anim.shown : prev.length === L ? 1 : (prev[L] as Stroke).p.length / 2;
          anim.idx = L;
          anim.shown = Math.min(from, n);
          anim.n = n;
          anim.rate = (n - anim.shown) / REPLAY_MS;
        } else anim.idx = -1;
      }
      let disp = items;
      if (anim.idx >= 0 && anim.idx === items.length - 1 && anim.shown < anim.n) {
        anim.shown = Math.min(anim.n, anim.shown + Math.max(anim.rate, 0.02) * dt);
        const last = items[anim.idx] as Stroke;
        disp = [...items.slice(0, anim.idx), { ...last, p: last.p.slice(0, Math.max(1, Math.floor(anim.shown)) * 2) }];
        need = true;
      }
      const lv = live?.current;
      if (lv && lv.v !== liveV) {
        liveV = lv.v;
        need = true;
      }
      if (!need) return;
      need = false;
      raster.sync(disp);
      const d = raster.takeDirty();
      if (d) copy(d);
      const k = canvas.width / RES;
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.imageSmoothingEnabled = true;
      ctx.imageSmoothingQuality = "high";
      ctx.drawImage(off, 0, 0, canvas.width, canvas.height);
      ctx.lineCap = "round";
      ctx.lineJoin = "round";
      const tail = raster.tail;
      if (tail) {
        ctx.strokeStyle = css(inkOf(tail));
        ctx.lineWidth = (WIDTHS[tail.w] ?? WIDTHS[1]) * k;
        ctx.beginPath();
        for (const [ax, ay, bx, by] of endPieceSegments(tail)) {
          ctx.moveTo(ax * k, ay * k);
          ctx.lineTo(bx * k, by * k);
        }
        ctx.stroke();
      }
      if (lv?.s) strokePath(ctx, lv.s, k);
    };
    raf = requestAnimationFrame(frame);
    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
    };
  }, [live]);

  return (
    <div className={`relative aspect-square w-full ${className}`}>
      <canvas
        ref={canvasRef}
        data-pad={dataPad}
        role="img"
        aria-label={label}
        className="no-callout absolute inset-0 block h-full w-full select-none"
        style={{ touchAction: onPointerDown ? "none" : undefined }}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
        onContextMenu={onPointerDown ? (e) => e.preventDefault() : undefined}
      />
      {children}
    </div>
  );
}

/** Read-only drawing (guessers, reveal, TV). */
export function PadDrawing({ items, className = "", label = "The drawing", replay = true }: { items: Item[]; className?: string; label?: string; replay?: boolean }) {
  return <PadCanvas items={items} replay={replay} label={label} className={className} />;
}
