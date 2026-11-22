/**
 * Built-in decks remember what this host's device has shown, per game, so the next game deals
 * unseen items first instead of a fresh random shuffle that repeats a third of last week's cards.
 *
 * - The host screen passes `seen` into a game's options when it starts (see withSeen).
 * - While the game runs, the host screen records the item on screen (see seenFromState).
 * - Stored on this device only (localStorage), at most KEEP items per game. Nothing is sent anywhere.
 */

const KEY = "bawaal-builtin-seen-v1";
const KEEP = 200;

/** Games with a built-in deck that should avoid repeats. */
export const MEMORY_GAMES = new Set(["charades", "draw-guess", "sound-guru", "odd-word-out", "kaun-banega-champion"]);

type Store = Record<string, string[]>;

function read(): Store {
  try {
    return JSON.parse(localStorage.getItem(KEY) ?? "{}") as Store;
  } catch {
    return {};
  }
}

export function recallSeen(gameId: string): string[] {
  return read()[gameId] ?? [];
}

export function rememberSeen(gameId: string, keys: string[]): void {
  // Kept as shown (games compare some keys exactly); de-duplicated ignoring case.
  const fresh = keys.map((k) => k.trim()).filter(Boolean);
  if (!fresh.length) return;
  const low = new Set(fresh.map((k) => k.toLowerCase()));
  try {
    const store = read();
    const merged = [...(store[gameId] ?? []).filter((k) => !low.has(k.toLowerCase())), ...fresh].slice(-KEEP);
    localStorage.setItem(KEY, JSON.stringify({ ...store, [gameId]: merged }));
  } catch {
    /* private mode or full storage: no memory this time */
  }
}

/** Options for starting a game, with this device's seen list added for games that use it. */
export function withSeen<T>(gameId: string, options: T): T {
  if (!MEMORY_GAMES.has(gameId) || typeof window === "undefined") return options;
  return { ...(options as object), seen: recallSeen(gameId) } as T;
}

/** The item(s) on screen right now, read from the host's game state, to record as seen. */
export function seenFromState(gameId: string, state: unknown): string[] {
  if (!state || typeof state !== "object") return [];
  const s = state as Record<string, unknown>;
  switch (gameId) {
    case "charades":
      return typeof s.movie === "string" ? [s.movie] : [];
    case "draw-guess":
      return typeof s.word === "string" ? [s.word] : [];
    case "sound-guru": {
      const p = s.prompt as { sound?: unknown } | null;
      return p && typeof p.sound === "string" ? [p.sound] : [];
    }
    case "odd-word-out":
    case "kaun-banega-champion":
      return Array.isArray(s.used) ? (s.used as unknown[]).filter((x): x is string => typeof x === "string") : [];
    default:
      return [];
  }
}

/** Unseen items first (in their shuffled order), then the seen ones, oldest-seen first. */
export function freshFirst<T>(items: T[], seen: readonly string[] | undefined, key: (t: T) => string = (t) => String(t)): T[] {
  if (!seen?.length) return items;
  const order = new Map(seen.map((k, i) => [k.trim().toLowerCase(), i]));
  const unseen = items.filter((t) => !order.has(key(t).trim().toLowerCase()));
  const old = items.filter((t) => order.has(key(t).trim().toLowerCase())).sort((a, b) => order.get(key(a).trim().toLowerCase())! - order.get(key(b).trim().toLowerCase())!);
  return [...unseen, ...old];
}
