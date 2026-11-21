import { getServiceClient } from "./supabase/service";

/**
 * Rate limits shared by every server instance (migration 0015, `rate_hit`). Before 0015 is applied,
 * or without a database, it falls back to a per-instance memory limit, which is weaker on a
 * serverless host (each instance counts on its own) but never blocks the app.
 */

const memory = new Map<string, { start: number; hits: number }>();

function memoryHit(key: string, windowSeconds: number, max: number, now = Date.now()): boolean {
  const start = Math.floor(now / (windowSeconds * 1000)) * windowSeconds * 1000;
  const b = memory.get(key);
  if (!b || b.start !== start) {
    if (memory.size > 5000) memory.clear();
    memory.set(key, { start, hits: 1 });
    return true;
  }
  b.hits += 1;
  return b.hits <= max;
}

let sharedBroken = false;

/** True when this hit is within `max` per `windowSeconds` for `key`. */
export async function allow(key: string, windowSeconds: number, max: number): Promise<boolean> {
  const k = key.slice(0, 200);
  // The memory limit always applies too: it's free and stops a burst before it reaches the database.
  if (!memoryHit(k, windowSeconds, max)) return false;
  const db = sharedBroken ? null : getServiceClient();
  if (!db) return true;
  try {
    const { data, error } = await db.rpc("rate_hit", { p_key: k, p_window_seconds: windowSeconds, p_max: max });
    if (error) {
      // Function missing (0015 not applied yet): stop asking; memory limits only.
      if (/function|does not exist|schema cache/i.test(error.message)) sharedBroken = true;
      return true;
    }
    return data !== false;
  } catch {
    return true;
  }
}

/** For tests: forget all memory counts. */
export function resetMemoryLimits(): void {
  memory.clear();
}

/** The caller's IP. The platform proxy appends the real address last, so the last entry is trusted. */
export function requestIp(req: Request): string {
  const xf = req.headers.get("x-forwarded-for");
  if (xf) {
    const parts = xf.split(",").map((x) => x.trim()).filter(Boolean);
    if (parts.length) return parts[parts.length - 1];
  }
  return req.headers.get("x-real-ip")?.trim() || "unknown";
}
