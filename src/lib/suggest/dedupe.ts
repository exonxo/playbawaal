/**
 * Near-duplicate check for sentence-like content (dares, Spin the Bottle prompts, KBC questions):
 * the database already skips exact copies (same normalised text); this also skips rewordings like
 * "Do your best villain laugh" vs "Do your best Bollywood villain laugh!" (issue #29).
 */

const STOP = new Set(["a", "an", "the", "of", "to", "in", "on", "for", "and", "or", "your", "you", "is", "it", "with", "at", "be", "this", "that", "do", "are", "re", "have", "has", "i", "me", "my", "we", "our", "will", "would", "can"]);

/** Very light stemming, so "wins" and "win", "laughs" and "laugh" count as the same word. */
function stem(w: string): string {
  if (w.length > 5 && w.endsWith("ing")) return w.slice(0, -3);
  if (w.length > 4 && w.endsWith("ed")) return w.slice(0, -2);
  if (w.length > 3 && w.endsWith("es")) return w.slice(0, -2);
  if (w.length > 3 && w.endsWith("s") && !w.endsWith("ss")) return w.slice(0, -1);
  return w;
}

function words(norm: string): Set<string> {
  return new Set(norm.split(" ").filter((w) => w.length > 1 && !STOP.has(w)).map(stem));
}

/** True when two normalised texts say nearly the same thing (by shared meaningful words). */
export function nearDuplicate(a: string, b: string, threshold = 0.75): boolean {
  if (a === b) return true;
  const A = words(a);
  const B = words(b);
  if (A.size < 3 || B.size < 3) return false; // too short to judge; exact-copy check covers these
  let shared = 0;
  for (const w of A) if (B.has(w)) shared++;
  const jaccard = shared / (A.size + B.size - shared);
  const containment = shared / Math.min(A.size, B.size);
  return jaccard >= threshold || (containment >= 0.8 && Math.min(A.size, B.size) >= 5);
}

/** Kinds whose items are sentences, where rewordings slip past the exact-copy check. */
export const NEAR_DUP_KINDS = new Set(["dare", "bottle-prompts", "kbc-question"]);

/** Removes items that nearly repeat `existing` texts or each other. `norm` gives an item's normalised text. */
export function dropNearDuplicates<T>(items: T[], existing: Iterable<string>, norm: (t: T) => string): { kept: T[]; dropped: number } {
  const pool = [...existing];
  const kept: T[] = [];
  for (const it of items) {
    const n = norm(it);
    if (pool.some((e) => nearDuplicate(n, e))) continue;
    pool.push(n);
    kept.push(it);
  }
  return { kept, dropped: items.length - kept.length };
}
