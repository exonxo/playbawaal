import { BOTTLE_TONES } from "@/content/spin-bottle";
import { getServiceClient } from "../supabase/service";
import { LIBRARY_KINDS } from "../suggest/library";
import { BOTTLE_CATEGORIES, CATEGORY_INFO, MOOD_ALLOWS, cleanPolicy } from "../suggest/policy-core";
import { BOTTLE_POLICY_KEY, invalidatePolicy, loadBottlePolicy } from "../suggest/policy";
import { MATCH_TYPES, RULE_TYPES, ruleProblem, type MatchType, type RuleType } from "../suggest/rules-core";
import { invalidateRules } from "../suggest/rules";
import { MIN_SHOWN, REPORT_ROOMS, RETIRE_RATE } from "../suggest/signals";
import { auditOrThrow } from "./audit";
import type { ActionContext, ActionResult } from "./actions";

/**
 * The content engine's admin side (migration 0014): rules, strictness settings, the reports queue
 * and player signals. Reads here are not personal data (no accounts, rooms or names are stored with
 * signals), so they aren't audited; every write is audited first.
 */

const fail = (status: number, error: string): ActionResult => ({ status, body: { ok: false, error } });
const ok = (body: Record<string, unknown> = {}): ActionResult => ({ status: 200, body: { ok: true, ...body } });

function db() {
  const client = getServiceClient();
  if (!client) throw new Error("database_not_configured");
  return client;
}

export const RULE_SCOPES = ["all", ...LIBRARY_KINDS] as const;
const NORM = /^[\p{L}\p{N} ]{1,200}$/u;

/* ---------------- Actions ---------------- */

export async function ruleAdd(body: Record<string, unknown>, ctx: ActionContext): Promise<ActionResult> {
  const rule_type = body.rule_type as RuleType;
  const match_type = (body.match_type ?? "word") as MatchType;
  const pattern = typeof body.pattern === "string" ? body.pattern.trim() : "";
  const scope = typeof body.scope === "string" ? body.scope : "all";
  const note = typeof body.note === "string" && body.note.trim() ? body.note.trim().slice(0, 200) : null;
  if (!RULE_TYPES.includes(rule_type)) return fail(400, "bad_rule_type");
  if (!MATCH_TYPES.includes(match_type)) return fail(400, "bad_match_type");
  if (!(RULE_SCOPES as readonly string[]).includes(scope)) return fail(400, "bad_scope");
  const problem = ruleProblem({ match_type, pattern });
  if (problem) return fail(400, problem);
  await auditOrThrow({ actor: ctx.actor, action: "rule.add", target: scope, details: { rule_type, match_type, pattern, note }, ip: ctx.ip });
  const { data, error } = await db()
    .from("content_rules")
    .insert({ rule_type, match_type, pattern, scope, note, created_by: ctx.actor })
    .select("id")
    .single();
  if (error) return fail(500, "rule_write_failed");
  invalidateRules();
  return ok({ id: data.id });
}

export async function ruleSetActive(body: Record<string, unknown>, ctx: ActionContext): Promise<ActionResult> {
  const id = Number(body.id);
  if (!Number.isInteger(id) || id < 1) return fail(400, "bad_id");
  if (typeof body.active !== "boolean") return fail(400, "active_required");
  await auditOrThrow({ actor: ctx.actor, action: "rule.set_active", target: `rule:${id}`, details: { active: body.active }, ip: ctx.ip });
  const { data, error } = await db().from("content_rules").update({ active: body.active, updated_at: new Date().toISOString() }).eq("id", id).select("id");
  if (error) return fail(500, "rule_write_failed");
  if (!data?.length) return fail(404, "not_found");
  invalidateRules();
  return ok({ id, active: body.active });
}

export async function ruleDelete(body: Record<string, unknown>, ctx: ActionContext): Promise<ActionResult> {
  const id = Number(body.id);
  if (!Number.isInteger(id) || id < 1) return fail(400, "bad_id");
  await auditOrThrow({ actor: ctx.actor, action: "rule.delete", target: `rule:${id}`, details: {}, ip: ctx.ip });
  const { data, error } = await db().from("content_rules").delete().eq("id", id).select("id");
  if (error) return fail(500, "rule_write_failed");
  if (!data?.length) return fail(404, "not_found");
  invalidateRules();
  return ok({ id });
}

export async function policySet(body: Record<string, unknown>, ctx: ActionContext): Promise<ActionResult> {
  if (!body.value || typeof body.value !== "object" || Array.isArray(body.value)) return fail(400, "bad_policy");
  const value = cleanPolicy(body.value);
  // Only store settings that make a mood stricter; a kind the mood never allows can't be switched on.
  for (const tone of BOTTLE_TONES) {
    const row = value[tone];
    if (!row) continue;
    for (const c of BOTTLE_CATEGORIES) if (!MOOD_ALLOWS[tone].includes(c)) delete row[c];
  }
  await auditOrThrow({ actor: ctx.actor, action: "policy.set", target: BOTTLE_POLICY_KEY, details: { value }, ip: ctx.ip });
  const { error } = await db()
    .from("content_policy")
    .upsert({ key: BOTTLE_POLICY_KEY, value, updated_by: ctx.actor, updated_at: new Date().toISOString() }, { onConflict: "key" });
  if (error) return fail(500, "policy_write_failed");
  invalidatePolicy();
  return ok({ value });
}

/** Reports queue: "restore" puts the item back; "remove" keeps it off for good. Both clear the reports. */
export async function reportResolve(body: Record<string, unknown>, ctx: ActionContext): Promise<ActionResult> {
  const kind = typeof body.kind === "string" ? body.kind : "";
  const category = typeof body.category === "string" ? body.category : "";
  const norm = typeof body.norm === "string" ? body.norm : "";
  const decision = body.decision;
  if (!(LIBRARY_KINDS as readonly string[]).includes(kind)) return fail(400, "bad_kind");
  if (!/^[a-z0-9_-]{1,32}$/.test(category)) return fail(400, "bad_category");
  if (!NORM.test(norm)) return fail(400, "bad_item");
  if (decision !== "restore" && decision !== "remove") return fail(400, "bad_decision");
  await auditOrThrow({ actor: ctx.actor, action: "report.resolve", target: `${kind}:${category}`, details: { norm, decision }, ip: ctx.ip });
  const d = db();
  const r = await d.rpc("library_set_off", { p_kind: kind, p_norms: [norm], p_reason: decision === "remove" ? "admin" : null, p_off: decision === "remove" });
  if (r.error) return fail(500, "update_failed");
  let changed = Number(r.data) || 0;
  if (decision === "remove") {
    // An item the engine already switched off keeps its automatic reason above, so "undo" would still
    // offer it. Mark it as the admin's decision instead, so it stays off for good.
    const m = await d
      .from("content_library")
      .update({ off_reason: "admin", off_at: new Date().toISOString() })
      .eq("kind", kind)
      .eq("text_norm", norm)
      .eq("active", false)
      .in("off_reason", ["reports", "signals"])
      .select("id");
    if (m.error) return fail(500, "update_failed");
    changed += m.data?.length ?? 0;
  }
  await d.from("content_reports").delete().eq("kind", kind).eq("category", category).eq("text_norm", norm);
  await d.from("content_signals").update({ reported: 0 }).eq("kind", kind).eq("category", category).eq("text_norm", norm);
  return ok({ changed, decision });
}

/** Switches back on items the engine switched off automatically (reason reports or signals). */
export async function signalRestore(body: Record<string, unknown>, ctx: ActionContext): Promise<ActionResult> {
  const id = Number(body.id);
  if (!Number.isInteger(id) || id < 1) return fail(400, "bad_id");
  await auditOrThrow({ actor: ctx.actor, action: "signal.restore", target: `library:${id}`, details: {}, ip: ctx.ip });
  const { data, error } = await db()
    .from("content_library")
    .update({ active: true, off_reason: null, off_at: null })
    .eq("id", id)
    .in("off_reason", ["reports", "signals"])
    .select("id");
  if (error) return fail(500, "update_failed");
  if (!data?.length) return fail(404, "not_found");
  return ok({ id });
}

/* ---------------- Views ---------------- */

export async function rulesView() {
  const { data, error } = await db().from("content_rules").select("id, rule_type, match_type, pattern, scope, note, active, created_by, created_at").order("created_at", { ascending: false }).limit(500);
  if (error) throw new Error("engine_not_ready");
  return { rules: data ?? [], scopes: RULE_SCOPES };
}

export async function policyView() {
  return {
    value: await loadBottlePolicy(true),
    moods: BOTTLE_TONES,
    categories: BOTTLE_CATEGORIES.map((c) => ({ id: c, ...CATEGORY_INFO[c] })),
    allows: MOOD_ALLOWS,
  };
}

interface SignalRow {
  kind: string;
  category: string;
  text_norm: string;
  text_key: string;
  shown: number;
  done: number;
  passed: number;
  flipped: number;
  skipped: number;
  loved: number;
  reported: number;
}

async function libraryStatus(rows: { kind: string; text_norm: string }[]) {
  const out = new Map<string, { id: number; active: boolean; off_reason: string | null }>();
  const byKind = new Map<string, string[]>();
  for (const r of rows) byKind.set(r.kind, [...(byKind.get(r.kind) ?? []), r.text_norm]);
  for (const [kind, norms] of byKind) {
    const { data } = await db().from("content_library").select("id, text_norm, active, off_reason").eq("kind", kind).in("text_norm", norms.slice(0, 200));
    for (const x of data ?? []) out.set(`${kind}|${x.text_norm}`, { id: x.id, active: x.active, off_reason: x.off_reason });
  }
  return out;
}

export async function reportsView() {
  const { data, error } = await db()
    .from("content_signals")
    .select("kind, category, text_norm, text_key, shown, done, passed, flipped, skipped, loved, reported")
    .gt("reported", 0)
    .order("reported", { ascending: false })
    .limit(100);
  if (error) throw new Error("engine_not_ready");
  const rows = (data ?? []) as SignalRow[];
  const status = await libraryStatus(rows);
  return {
    threshold: REPORT_ROOMS,
    items: rows.map((r) => {
      const lib = status.get(`${r.kind}|${r.text_norm}`);
      return { ...r, inLibrary: !!lib, active: lib?.active ?? null, offReason: lib?.off_reason ?? null };
    }),
  };
}

const rate = (n: number, d: number) => (d > 0 ? n / d : 0);

export async function signalsView() {
  const d = db();
  const { data, error } = await d
    .from("content_signals")
    .select("kind, category, text_norm, text_key, shown, done, passed, flipped, skipped, loved, reported")
    .gte("shown", 5)
    .order("shown", { ascending: false })
    .limit(1000);
  if (error) throw new Error("engine_not_ready");
  const rows = ((data ?? []) as SignalRow[]).map((r) => ({
    ...r,
    dislike: rate(r.flipped + r.passed + r.skipped, r.shown),
    like: rate(r.done + r.loved, r.shown),
  }));
  const worst = [...rows].sort((a, b) => b.dislike - a.dislike).slice(0, 25);
  const best = [...rows].sort((a, b) => b.like - a.like).slice(0, 25);
  const status = await libraryStatus([...worst, ...best]);
  const tag = <T extends { kind: string; text_norm: string }>(r: T) => ({ ...r, inLibrary: status.has(`${r.kind}|${r.text_norm}`) });
  const { data: off } = await d
    .from("content_library")
    .select("id, kind, category, text_key, off_reason, off_at")
    .in("off_reason", ["reports", "signals"])
    .order("off_at", { ascending: false })
    .limit(50);
  const { count } = await d.from("content_signals").select("text_norm", { count: "exact", head: true });
  return {
    tracked: count ?? 0,
    rules: { minShown: MIN_SHOWN, retireRate: RETIRE_RATE, reportRooms: REPORT_ROOMS },
    worst: worst.map(tag),
    best: best.map(tag),
    switchedOff: off ?? [],
  };
}
