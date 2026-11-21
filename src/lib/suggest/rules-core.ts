/**
 * Admin content rules (migration 0014), the pure part: matching and filtering. No database or server
 * imports, so the admin panel's "test a sentence" box uses exactly the same code as the server.
 *
 * - block:  anything containing it is dropped.
 * - topic:  a topic the AI must avoid. Told to the AI, and also dropped like a block word.
 * - allow:  an exception. Text matched by an allow rule is ignored when checking block and topic rules
 *           (so allowing "Essex" stops a block on "sex" from catching it).
 * A rule's scope is "all" or one content kind (e.g. "bottle-prompts").
 */

export type RuleType = "block" | "allow" | "topic";
export type MatchType = "word" | "pattern";

export interface ContentRule {
  id: number;
  rule_type: RuleType;
  match_type: MatchType;
  pattern: string;
  scope: string;
  note?: string | null;
  active: boolean;
}

export const RULE_TYPES: RuleType[] = ["block", "allow", "topic"];
export const MATCH_TYPES: MatchType[] = ["word", "pattern"];
export const MAX_PATTERN = 200;
/** Patterns (regular expressions) are kept short and simple: they run on every AI reply. */
export const MAX_REGEX = 100;

/**
 * True when a pattern could take a very long time on some text ("catastrophic backtracking"):
 * a repeated group that itself repeats, like (a+)+ or (\w*)*, or a back-reference.
 */
export function slowPattern(p: string): boolean {
  if (/\\[1-9]|\\k</.test(p)) return true; // back-references
  // A group with a quantifier inside, followed by another quantifier.
  if (/\((?:[^()\\]|\\.)*[+*}](?:[^()\\]|\\.)*\)\s*(?:[+*]|\{\d)/.test(p)) return true;
  // A repeated group of alternatives that can match the same text, like (a|a)* or (a|ab)+.
  if (/\((?:[^()\\]|\\.)*\|(?:[^()\\]|\\.)*\)\s*(?:[+*]|\{\d)/.test(p)) return true;
  return false;
}

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** The rule as a regular expression, or null if it can't be used (e.g. a broken pattern). */
export function compileRule(r: Pick<ContentRule, "match_type" | "pattern">): RegExp | null {
  const p = r.pattern.trim();
  if (!p || p.length > MAX_PATTERN) return null;
  try {
    // A slow or over-long pattern saved before these checks existed is skipped, never run.
    if (r.match_type === "pattern") return p.length > MAX_REGEX || slowPattern(p) ? null : new RegExp(p, "giu");
    // Whole word or phrase: not part of a longer word. Spaces in the phrase match any spacing.
    const body = p.split(/\s+/).map(escape).join("\\s+");
    return new RegExp(`(?<![\\p{L}\\p{N}])${body}(?![\\p{L}\\p{N}])`, "giu");
  } catch {
    return null;
  }
}

/** Why a pattern can't be saved, or null if it's fine. */
export function ruleProblem(r: Pick<ContentRule, "match_type" | "pattern">): string | null {
  const p = r.pattern.trim();
  if (!p) return "empty";
  if (p.length > MAX_PATTERN) return "too_long";
  if (r.match_type === "pattern") {
    if (p.length > MAX_REGEX) return "pattern_too_long";
    if (slowPattern(p)) return "pattern_too_complex";
    try {
      new RegExp(p, "giu");
    } catch {
      return "bad_pattern";
    }
    // A pattern that matches empty text would block everything.
    if (new RegExp(p, "iu").test("")) return "matches_everything";
  }
  return null;
}

export function inScope(r: ContentRule, kind: string): boolean {
  return r.active && (r.scope === "all" || r.scope === kind);
}

export interface Compiled {
  rule: ContentRule;
  re: RegExp;
}

export function compileAll(rules: ContentRule[], kind: string): Compiled[] {
  const out: Compiled[] = [];
  for (const rule of rules) {
    if (!inScope(rule, kind)) continue;
    const re = compileRule(rule);
    if (re) out.push({ rule, re });
  }
  return out;
}

/** The first block or topic rule this text breaks (after removing allowed text), or null. */
export function matchRule(text: string, compiled: Compiled[]): ContentRule | null {
  if (!text || !compiled.length) return null;
  let t = text;
  for (const c of compiled) {
    if (c.rule.rule_type !== "allow") continue;
    c.re.lastIndex = 0;
    t = t.replace(c.re, " ");
  }
  for (const c of compiled) {
    if (c.rule.rule_type === "allow") continue;
    c.re.lastIndex = 0;
    if (c.re.test(t)) return c.rule;
  }
  return null;
}

function strings(v: unknown, out: string[] = [], depth = 0): string[] {
  if (depth > 4) return out;
  if (typeof v === "string") out.push(v);
  else if (Array.isArray(v)) for (const x of v) strings(x, out, depth + 1);
  else if (v && typeof v === "object") for (const x of Object.values(v)) strings(x, out, depth + 1);
  return out;
}

const blocked = (v: unknown, compiled: Compiled[]) => strings(v).some((s) => matchRule(s, compiled) !== null);

export interface FilterStats {
  dropped: number;
}

/**
 * Removes whatever breaks a rule, keeping the shape the game expects. Returns null when nothing
 * usable is left (the caller then asks another AI service, or uses the built-in content).
 * Shapes: a list of items (emoji puzzles, KBC questions); a Chor Kaun topic {label, words};
 * a Spin the Bottle batch {truths, dares, social}; a dare {text}; or an object holding lists.
 */
export function applyRules(kind: string, data: unknown, rules: ContentRule[], stats: FilterStats = { dropped: 0 }): unknown | null {
  const compiled = compileAll(rules, kind);
  if (!compiled.some((c) => c.rule.rule_type !== "allow") || data == null) return data;
  const keepList = (list: unknown[]) => {
    const kept = list.filter((x) => !blocked(x, compiled));
    stats.dropped += list.length - kept.length;
    return kept;
  };
  if (Array.isArray(data)) {
    const kept = keepList(data);
    return kept.length ? kept : null;
  }
  if (typeof data !== "object") return blocked(data, compiled) ? null : data;
  const o = data as Record<string, unknown>;
  if (kind === "chor-kaun-topic" && typeof o.label === "string") {
    if (blocked(o.label, compiled)) {
      stats.dropped += 1;
      return null;
    }
    const words = Array.isArray(o.words) ? keepList(o.words) : [];
    return words.length >= 12 ? { ...o, words } : null;
  }
  if (kind === "bottle-prompts" && ("truths" in o || "dares" in o)) {
    const list = (k: string) => (Array.isArray(o[k]) ? keepList(o[k] as unknown[]) : []);
    const out = { ...o, truths: list("truths"), dares: list("dares"), social: list("social") };
    return out.truths.length + out.dares.length ? out : null;
  }
  // Anything else: filter its lists; a broken plain field drops the whole thing.
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(o)) {
    if (Array.isArray(v)) out[k] = keepList(v);
    else if (typeof v === "string" && matchRule(v, compiled)) {
      stats.dropped += 1;
      return null;
    } else out[k] = v;
  }
  return out;
}

/** Lines added to the AI instructions so the model avoids what the rules would drop anyway. */
export function ruleGuidance(kind: string, rules: ContentRule[]): string {
  const scoped = rules.filter((r) => inScope(r, kind));
  const topics = scoped.filter((r) => r.rule_type === "topic").map((r) => r.pattern.trim()).slice(0, 30);
  const words = scoped.filter((r) => r.rule_type === "block" && r.match_type === "word").map((r) => r.pattern.trim()).slice(0, 40);
  const lines: string[] = [];
  if (topics.length) lines.push(`Do not mention or hint at these topics: ${JSON.stringify(topics)}.`);
  if (words.length) lines.push(`Never use these words or phrases: ${JSON.stringify(words)}.`);
  return lines.join("\n");
}
