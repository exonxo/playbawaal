// Emoji Picture: the card's question ("Kaunsa khel?", "Kaun hai yeh?") must fit the answer. Checks the
// category rule, the built-in deck, AI output, library rows at serve time and the Chor Kaun / Spin the
// Bottle content fixes from the same round. No network, no database. Run from the repo root:
//   npx -y tsx docs/testing/qa/emoji-category.test.ts
import assert from "node:assert/strict";
import { EMOJI_PUZZLES } from "../../../src/content/emoji-picture";
import { CHOR_TOPICS } from "../../../src/content/chor-kaun";
import { BOTTLE_PROMPTS } from "../../../src/content/spin-bottle";
import { EMOJI_ASK, EMOJI_CATEGORIES, categoryMismatch } from "../../../src/lib/suggest/emoji-category";
import { checkPuzzle, screenEmojiPuzzles, validateEmojiPuzzles } from "../../../src/lib/suggest/validate";
import { shapeServed } from "../../../src/lib/suggest/library";
import { breaksBottleRules } from "../../../src/lib/suggest/bottle";
import { buildPrompt } from "../../../src/lib/suggest/prompts";
import { THEME_CHIPS } from "../../../src/lib/suggest/theme";

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

const sachin = { emojis: "💯🏏🙏", category: "Sport", answer: "Sachin Tendulkar", alt: ["Sachin"], hint: "God of cricket", level: "family" };

check("E1", "every category has a question", () => {
  for (const c of EMOJI_CATEGORIES) assert.ok(EMOJI_ASK[c], c);
  assert.equal(EMOJI_ASK.Sport, "Kaunsa khel?");
  assert.equal(EMOJI_ASK.Person, "Kaun hai yeh?");
});

check("E2", "Sport must be the name of a sport, not a player or a tournament", () => {
  assert.ok(categoryMismatch("Sport", "Sachin Tendulkar"));
  assert.ok(categoryMismatch("Sport", "Neeraj Chopra"));
  assert.ok(categoryMismatch("Sport", "ICC T20 World Cup 2024"));
  assert.ok(categoryMismatch("Sport", "Cricket World Cup"));
  for (const ok of ["Cricket", "Kabaddi", "Kho Kho", "Snakes and Ladders", "Gilli Danda", "table tennis"]) assert.equal(categoryMismatch("Sport", ok), null, ok);
  assert.equal(categoryMismatch("Person", "Sachin Tendulkar"), null);
});

check("E3", "Phrase must read like a saying", () => {
  for (const bad of ["Tiger", "Charkha", "Mangalyaan 2", "COVID Home Isolation", "Digital India Mission", "PM Kisan Scheme"]) assert.ok(categoryMismatch("Phrase", bad), bad);
  for (const ok of ["White Elephant", "Cool as a Cucumber", "Bandar kya jaane adrak ka swaad"]) assert.equal(categoryMismatch("Phrase", ok), null, ok);
});

check("E4", "the reported card (Sport -> Sachin) is refused by the validator", () => {
  assert.equal(checkPuzzle(sachin, "family"), "category");
  assert.notEqual(typeof checkPuzzle({ ...sachin, category: "Person" }, "family"), "string");
  const s = screenEmojiPuzzles([sachin, { ...sachin, category: "Person" }], { level: "family" });
  assert.equal(s.kept.length, 1);
  assert.equal(s.reasons.category, 1);
});

check("E5", "every built-in puzzle passes the same check as AI output", () => {
  const bad = EMOJI_PUZZLES.filter((p) => typeof checkPuzzle(p, "adults") === "string" && p.level !== "kids").map((p) => p.answer);
  const badKids = EMOJI_PUZZLES.filter((p) => p.level === "kids" && typeof checkPuzzle(p, "kids") === "string").map((p) => p.answer);
  assert.deepEqual([...bad, ...badKids], []);
  assert.equal(EMOJI_PUZZLES.find((p) => p.answer === "Sachin Tendulkar")?.category, "Person");
});

check("E6", "library rows are re-checked when served: a mismatched row never reaches the game", () => {
  const rows = [sachin, ...EMOJI_PUZZLES.filter((p) => p.level !== "adults").slice(0, 4)].map((data) => ({ data }));
  const served = shapeServed("emoji-puzzle", rows, { level: "family", count: 5 }) as { answer: string; category: string }[];
  assert.ok(served.length >= 3);
  assert.ok(!served.some((p) => p.category === "Sport" && p.answer === "Sachin Tendulkar"));
  const all = validateEmojiPuzzles([sachin], 5, "family") ?? [];
  assert.ok(all.every((p) => categoryMismatch(p.category, p.answer) === null));
});

check("E7", "the AI prompt explains what each category means and lists Person/Thing", () => {
  const p = buildPrompt("emoji-puzzle", { level: "family", count: 10 });
  assert.match(p, /Person/);
  assert.match(p, /Sport = the name of a sport/);
  assert.equal(THEME_CHIPS.find((c) => c.label === "Cricket")?.category, undefined);
});

check("E8", "Chor Kaun: 'Indian brands' only has Indian brands, kitchen has no cleaning things", () => {
  const brands = CHOR_TOPICS.find((t) => t.id === "indian-brands")!.words;
  for (const w of ["Maggi", "Colgate", "Cadbury", "Surf Excel", "Kurkure", "Wheel"]) assert.ok(!brands.includes(w), w);
  const kitchen = CHOR_TOPICS.find((t) => t.id === "desi-kitchen")!.words;
  for (const w of ["Jhaaru", "Pocha", "Bucket"]) assert.ok(!kitchen.includes(w), w);
});

check("E9", "Spin the Bottle kids mood refuses hostel/college/office prompts; built-in kids deck still passes", () => {
  assert.ok(breaksBottleRules("Act like a sleepy hamster waking up in your dorm bed", "kids"));
  assert.ok(breaksBottleRules("What's the funniest thing that ever happened in your hostel dorm?", "kids"));
  assert.ok(!breaksBottleRules("Act like a sleepy hamster waking up in your dorm bed", "college"));
  const kids = BOTTLE_PROMPTS.kids;
  assert.deepEqual(kids.filter((p) => breaksBottleRules(p.text, "kids", !!p.social)).map((p) => p.text), []);
});

for (const r of results) console.log(r);
console.log(`\n${passed}/${results.length} passed`);
if (passed !== results.length) process.exit(1);
