// Content quality (round 14 plan, phase 4): near-duplicates, film certificates, news story dedupe.
//   npx -y tsx docs/testing/qa/content-quality.test.ts
import assert from "node:assert/strict";
import { dropNearDuplicates, nearDuplicate } from "../../../src/lib/suggest/dedupe";
import { familyCertificate } from "../../../src/lib/suggest/tmdb";
import { prefilter } from "../../../src/lib/suggest/news";
import { normText } from "../../../src/lib/suggest/library";

let passed = 0;
const results: string[] = [];
function check(id: string, name: string, fn: () => void) {
  try {
    fn();
    passed++;
    results.push(`PASS ${id} ${name}`);
  } catch (e) {
    results.push(`FAIL ${id} ${name}\n     ${(e as Error).message.split("\n")[0]}`);
  }
}
const n = normText;

check("DUP-1", "rewordings of the same dare are caught", () => {
  assert.ok(nearDuplicate(n("Do your best Bollywood villain laugh — the room votes on the winner."), n("Do your best villain laugh, and the room votes for the winner!")));
  assert.ok(nearDuplicate(n("Name three street foods you would queue an hour for."), n("Name 3 street foods you'd queue for an hour")) || nearDuplicate(n("Name three street foods you would queue an hour for"), n("Name three street foods you would queue for an hour")));
});
check("DUP-2", "different prompts on a similar theme are kept", () => {
  assert.ok(!nearDuplicate(n("Do your best Bollywood villain laugh."), n("Act out a Bollywood hero's slow-motion entry.")));
  assert.ok(!nearDuplicate(n("Sing a song"), n("Sing a song loudly")), "too short to judge: exact check covers it");
});
check("DUP-3", "a batch drops repeats of the library and of itself", () => {
  const r = dropNearDuplicates(
    ["Tell the group one harmless secret talent you have.", "Share one harmless secret talent you have with the group!", "Pretend you are a cricket commentator for 15 seconds."],
    [n("Pretend you're a cricket commentator describing this room for 15 seconds")],
    (t) => n(t),
  );
  assert.deepEqual(r.kept, ["Tell the group one harmless secret talent you have."]);
  assert.equal(r.dropped, 2);
});
check("CERT-1", "family puzzles only from films certified for families", () => {
  for (const c of ["U", "UA", "U/A", "UA 7+", "UA 13+", null]) assert.ok(familyCertificate(c), String(c));
  for (const c of ["A", "S", "UA 16+", "UA16+"]) assert.ok(!familyCertificate(c), c);
});
check("NEWS-1", "the same story from two outlets is kept once", () => {
  const now = Date.parse("2026-11-20T10:00:00Z");
  const a = (headline: string) => ({ headline, description: "", date: "2026-11-19", url: "", source: "x" }) as never;
  const r = prefilter([a("India wins the Hockey Asia Cup final against Korea in Rajgir"), a("Hockey Asia Cup final: India beat Korea in Rajgir to win title"), a("ISRO launches its heaviest rocket from Sriharikota")], new Set(), now);
  assert.equal(r.kept.length, 2, JSON.stringify(r));
  assert.equal(r.repeats, 1);
});

console.log(results.join("\n"));
console.log(`\n${passed} passed, ${results.length - passed} failed`);
process.exit(results.length === passed ? 0 : 1);
