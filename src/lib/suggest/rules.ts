import { getServiceClient } from "../supabase/service";
import { applyRules, ruleGuidance, type ContentRule } from "./rules-core";

/**
 * Admin content rules, the server part: loads the active rules (cached for a minute on each server
 * instance) and applies them. Without the database, or before 0014 is applied, there are no rules.
 */

const CACHE_MS = 60_000;
let cache: { at: number; rules: ContentRule[] } | null = null;

export async function loadRules(force = false): Promise<ContentRule[]> {
  if (!force && cache && Date.now() - cache.at < CACHE_MS) return cache.rules;
  const db = getServiceClient();
  if (!db) return [];
  try {
    const { data, error } = await db
      .from("content_rules")
      .select("id, rule_type, match_type, pattern, scope, note, active")
      .eq("active", true)
      .limit(500);
    const rules = error || !Array.isArray(data) ? [] : (data as ContentRule[]);
    cache = { at: Date.now(), rules };
    return rules;
  } catch {
    return cache?.rules ?? [];
  }
}

/** Called after the admin changes a rule, so this instance uses the change straight away. */
export function invalidateRules(): void {
  cache = null;
}

/** Applies the active rules to validated content of this kind. */
export async function screenWithRules(kind: string, data: unknown): Promise<unknown | null> {
  return applyRules(kind, data, await loadRules());
}

export { applyRules, ruleGuidance };
