import { getServiceClient } from "../supabase/service";
import { cleanPolicy, type BottlePolicy } from "./policy-core";

/**
 * Strictness settings, the server part: loads them from content_policy (cached for a minute).
 * Without the database, or before 0014, everything each mood allows stays on.
 */

export const BOTTLE_POLICY_KEY = "spin-bottle";
const CACHE_MS = 60_000;
let cache: { at: number; value: BottlePolicy } | null = null;

export async function loadBottlePolicy(force = false): Promise<BottlePolicy> {
  if (!force && cache && Date.now() - cache.at < CACHE_MS) return cache.value;
  const db = getServiceClient();
  if (!db) return {};
  try {
    const { data, error } = await db.from("content_policy").select("value").eq("key", BOTTLE_POLICY_KEY).maybeSingle();
    const value = error ? (cache?.value ?? {}) : cleanPolicy(data?.value);
    cache = { at: Date.now(), value };
    return value;
  } catch {
    return cache?.value ?? {};
  }
}

export function invalidatePolicy(): void {
  cache = null;
}
