"use client";
import { useParams } from "next/navigation";
import { useEffect, useRef } from "react";
import { requestSuggest } from "@/lib/suggest/client";
import { remember } from "@/lib/suggest/memory";
import { batchToPrompts, type BottleBatch } from "@/lib/suggest/bottle";
import type { Pub, SignalEntry } from "./logic";

/** At most this many AI fetches per game, and never more often than every 30 seconds. */
const MAX_FETCHES = 8;
const COOLDOWN_MS = 30_000;

/**
 * Runs on the host's device only. Fetches one fresh AI batch when the game starts and another
 * whenever a pile runs low, then hands the prompts to the game as a host action. The game
 * plays from the built-in deck meanwhile, so nobody ever waits for the AI.
 */
export function useBottleRefill(view: Pub, isHost: boolean, hostAct: (type: string, payload?: unknown) => void) {
  const params = useParams();
  const roomCode = typeof params?.code === "string" ? params.code : undefined;
  const state = useRef({ count: 0, last: 0, busy: false, tone: view.tone });
  const actRef = useRef(hostAct);
  actRef.current = hostAct;

  const wantFirst = state.current.count === 0;
  const want = isHost && (wantFirst || view.needMore);

  useEffect(() => {
    if (!want) return;
    const s = state.current;
    if (s.busy || s.count >= MAX_FETCHES || Date.now() - s.last < COOLDOWN_MS) return;
    s.busy = true;
    s.count += 1;
    s.last = Date.now();
    const tone = view.tone;
    void requestSuggest<BottleBatch>("bottle-prompts", { tone }, roomCode)
      .then(({ data }) => {
        actRef.current("refill", { tone, prompts: batchToPrompts(data) });
      })
      .finally(() => {
        s.busy = false;
      });
  }, [want, view.tone, view.n, roomCode]);

  // Reported cards are remembered on this device, so they're avoided in future batches too.
  const reportedCount = view.reported.length;
  useEffect(() => {
    if (!isHost || !reportedCount) return;
    remember("bottle-prompts", view.reported.map((t) => t.toLowerCase().slice(0, 60)));
  }, [isHost, reportedCount, view.reported]);
}

/** Signals go out when this many are waiting, or every FLUSH_MS, or when the page is closed. */
const FLUSH_AT = 10;
const FLUSH_MS = 15_000;

/**
 * Host's device only. Fetches the mood's strictness settings once (kinds of prompt the admin switched
 * off) and hands them to the game. Then sends what happens to each card (shown, done, passed, flipped,
 * loved, reported) to the server in small batches, so the content engine learns what players like.
 * Sending is best effort: a failed batch is dropped, never retried in a loop.
 */
export function useBottleSignals(view: Pub, isHost: boolean, hostAct: (type: string, payload?: unknown) => void) {
  const params = useParams();
  const roomCode = typeof params?.code === "string" ? params.code.toUpperCase() : undefined;
  const actRef = useRef(hostAct);
  actRef.current = hostAct;
  const sentSeq = useRef<number | null>(null);
  const pending = useRef<SignalEntry[]>([]);
  const policyFor = useRef<string | null>(null);

  // Strictness settings, once per mood.
  useEffect(() => {
    if (!isHost || policyFor.current === view.tone) return;
    policyFor.current = view.tone;
    const tone = view.tone;
    void fetch(`/api/policy?tone=${tone}`)
      .then((r) => (r.ok ? r.json() : null))
      .then((j: { ok?: boolean; off?: unknown } | null) => {
        if (j?.ok && Array.isArray(j.off) && j.off.length) actRef.current("policy", { tone, off: j.off });
      })
      .catch(() => {});
  }, [isHost, view.tone]);

  const flush = (useBeacon = false) => {
    const batch = pending.current.splice(0, 100);
    if (!batch.length || !roomCode) return;
    const body = JSON.stringify({ roomCode, kind: "bottle-prompts", category: view.tone, events: batch.map((e) => ({ key: e.text, event: e.event })) });
    try {
      void fetch("/api/signal", { method: "POST", headers: { "Content-Type": "application/json" }, body, keepalive: useBeacon }).catch(() => {});
    } catch {
      /* best effort */
    }
  };
  const flushRef = useRef(flush);
  flushRef.current = flush;

  // Collect new log entries. Entries from before this device became host (a refresh) are skipped.
  const lastSeq = view.log.length ? view.log[view.log.length - 1].seq : 0;
  useEffect(() => {
    if (!isHost) return;
    if (sentSeq.current === null) {
      sentSeq.current = lastSeq;
      return;
    }
    const fresh = view.log.filter((e) => e.seq > (sentSeq.current ?? 0));
    if (!fresh.length) return;
    sentSeq.current = lastSeq;
    pending.current.push(...fresh);
    if (pending.current.length >= FLUSH_AT) flushRef.current();
  }, [isHost, lastSeq, view.log]);

  useEffect(() => {
    if (!isHost) return;
    const t = setInterval(() => flushRef.current(), FLUSH_MS);
    const onHide = () => flushRef.current(true);
    window.addEventListener("pagehide", onHide);
    return () => {
      clearInterval(t);
      window.removeEventListener("pagehide", onHide);
      flushRef.current(true);
    };
  }, [isHost]);
}
