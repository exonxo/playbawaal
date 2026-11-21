import { BOTTLE_TONES, type BottleTone } from "@/content/spin-bottle";

/**
 * Strictness settings (migration 0014), the pure part. For each Spin the Bottle mood the admin can
 * switch whole kinds of prompt off. Settings can only make a mood stricter: the safety rules in
 * bottle.ts always apply, and a kind a mood never allows (e.g. phone dares for kids) stays off.
 *
 * Used by the server (AI output and library items), and by the game on the host's device for the
 * built-in deck, so a switched-off kind never reaches the TV.
 */

export const BOTTLE_CATEGORIES = ["phone", "social", "dating", "picks", "physical", "roast"] as const;
export type BottleCategory = (typeof BOTTLE_CATEGORIES)[number];

export const CATEGORY_INFO: Record<BottleCategory, { label: string; hint: string }> = {
  phone: { label: "Phone dares", hint: "Screenshots, last text, wallpaper, search history" },
  social: { label: "Social dares", hint: "Posting a story or status (adult moods only)" },
  dating: { label: "Dating stories", hint: "Your own dates and love life" },
  picks: { label: "Group picks", hint: "\"Who here would…\" questions" },
  physical: { label: "Moving dares", hint: "Dancing, hopping, jumping jacks" },
  roast: { label: "Roasts", hint: "Roasting yourself, the boss or the company" },
};

/** Kinds each mood can ever have. The rest are off and can't be switched on. */
export const MOOD_ALLOWS: Record<BottleTone, BottleCategory[]> = {
  kids: ["picks", "physical"],
  family: ["picks", "physical", "roast"],
  college: [...BOTTLE_CATEGORIES],
  office: [...BOTTLE_CATEGORIES],
};

const DETECT: Record<Exclude<BottleCategory, "social">, RegExp> = {
  phone: /\b(?:phone|screenshot|gallery|camera\s*roll|wallpaper|autocorrect|search\s+history|screen\s*time|last\s+(?:sent\s+)?(?:text|message|photo)|recent\s+photo|selfie)\b/i,
  dating: /\b(?:date|dates|dating|crush|situationship|relationship|love\s+life|first\s+kiss|propos\w*|valentine)\b/i,
  picks: /\b(?:who\s+(?:here|in\s+this\s+(?:room|group))|which\s+(?:of\s+you|person\s+here)|anyone\s+here)\b/i,
  physical: /\b(?:dance|dancing|hop|hopping|jump\w*|push-?ups?|squats?|run|running|walk\s+like|balance|spin\s+around|plank)\b/i,
  roast: /\b(?:roast\w*|boss|manager|appraisal|hr\b|company|clients?)\b/i,
};

/** The kinds of prompt this text belongs to. */
export function categoriesOf(text: string, social = false): BottleCategory[] {
  const out: BottleCategory[] = [];
  if (social) out.push("social");
  for (const [k, re] of Object.entries(DETECT) as [BottleCategory, RegExp][]) if (re.test(text)) out.push(k);
  return out;
}

/** Settings per mood: true = allowed. Missing entries mean allowed (if the mood allows it at all). */
export type BottlePolicy = Partial<Record<BottleTone, Partial<Record<BottleCategory, boolean>>>>;

export function cleanPolicy(raw: unknown): BottlePolicy {
  const out: BottlePolicy = {};
  if (!raw || typeof raw !== "object") return out;
  for (const tone of BOTTLE_TONES) {
    const t = (raw as Record<string, unknown>)[tone];
    if (!t || typeof t !== "object") continue;
    const row: Partial<Record<BottleCategory, boolean>> = {};
    for (const c of BOTTLE_CATEGORIES) {
      const v = (t as Record<string, unknown>)[c];
      if (typeof v === "boolean") row[c] = v;
    }
    out[tone] = row;
  }
  return out;
}

/** The kinds switched off for this mood (by the mood itself or by the admin). */
export function offFor(policy: BottlePolicy, tone: BottleTone): BottleCategory[] {
  const allowed = MOOD_ALLOWS[tone];
  return BOTTLE_CATEGORIES.filter((c) => !allowed.includes(c) || policy[tone]?.[c] === false);
}

export function allowedByPolicy(text: string, social: boolean, off: readonly BottleCategory[]): boolean {
  if (!off.length) return true;
  if (social && off.includes("social")) return false;
  return !categoriesOf(text, social).some((c) => off.includes(c));
}

/** Filters a Spin the Bottle batch by the mood's settings. Null when too little is left. */
export function applyBottlePolicy<T extends { truths: string[]; dares: string[]; social: string[] }>(batch: T, off: readonly BottleCategory[]): T | null {
  if (!off.length) return batch;
  const keep = (l: string[], social: boolean) => l.filter((t) => allowedByPolicy(t, social, off));
  const out = { ...batch, truths: keep(batch.truths, false), dares: keep(batch.dares, false), social: keep(batch.social, true) };
  return out.truths.length + out.dares.length >= 4 ? out : null;
}

/** Lines for the AI instructions, so it doesn't write prompts that would be dropped. */
export function policyGuidance(off: readonly BottleCategory[], tone: BottleTone): string {
  const relevant = off.filter((c) => MOOD_ALLOWS[tone].includes(c));
  if (!relevant.length) return "";
  return `For this mood the host has switched these kinds of prompt OFF, so write none of them: ${relevant
    .map((c) => `${CATEGORY_INFO[c].label} (${CATEGORY_INFO[c].hint})`)
    .join("; ")}.`;
}
