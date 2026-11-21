// Freshness (round 14 plan, phase 3): built-in decks remember what this device showed (no network).
//   npx -y tsx docs/testing/qa/freshness.test.ts
import assert from "node:assert/strict";

// A tiny localStorage for node.
const mem = new Map<string, string>();
(globalThis as { localStorage?: unknown }).localStorage = { getItem: (k: string) => mem.get(k) ?? null, setItem: (k: string, v: string) => void mem.set(k, v), removeItem: (k: string) => void mem.delete(k) };
(globalThis as { window?: unknown }).window = globalThis;

(async () => {
const { freshFirst, recallSeen, rememberSeen, seenFromState, withSeen, MEMORY_GAMES } = await import("../../../src/lib/builtinMemory");
const charades = (await import("../../../src/games/charades/index")).default;
const { CHARADES } = await import("../../../src/content/charades");

let passed = 0;
const results: string[] = [];
async function check(id: string, name: string, fn: () => Promise<void> | void) {
  try {
    await fn();
    passed++;
    results.push(`PASS ${id} ${name}`);
  } catch (e) {
    results.push(`FAIL ${id} ${name}\n     ${(e as Error).message.split("\n")[0]}`);
  }
}

await check("MEM-1", "unseen items come first; seen ones after, oldest-seen first; case doesn't matter", () => {
  assert.deepEqual(freshFirst(["A", "B", "C", "D"], ["c", "a"]), ["B", "D", "C", "A"]);
  assert.deepEqual(freshFirst([1, 2], undefined), [1, 2]);
});
await check("MEM-2", "the card on screen is read from each game's state", () => {
  assert.deepEqual(seenFromState("charades", { movie: "Sholay" }), ["Sholay"]);
  assert.deepEqual(seenFromState("draw-guess", { word: "Kite" }), ["Kite"]);
  assert.deepEqual(seenFromState("sound-guru", { prompt: { sound: "Pressure cooker" } }), ["Pressure cooker"]);
  assert.deepEqual(seenFromState("kaun-banega-champion", { used: ["Q1", 5, "Q2"] }), ["Q1", "Q2"]);
  assert.deepEqual(seenFromState("puno", { anything: 1 }), []);
});
await check("MEM-3", "memory keeps original text, de-duplicates ignoring case, and is capped", () => {
  rememberSeen("charades", ["Sholay", "DDLJ"]);
  rememberSeen("charades", ["sholay"]);
  assert.deepEqual(recallSeen("charades"), ["DDLJ", "sholay"]);
  rememberSeen("charades", Array.from({ length: 300 }, (_, i) => `M${i}`));
  assert.equal(recallSeen("charades").length, 200);
});
await check("MEM-4", "starting a memory game adds this device's seen list; other games are untouched", () => {
  mem.clear();
  rememberSeen("draw-guess", ["Kite"]);
  assert.deepEqual((withSeen("draw-guess", { level: "family" }) as { seen?: string[] }).seen, ["Kite"]);
  assert.equal((withSeen("puno", { x: 1 }) as { seen?: string[] }).seen, undefined);
  assert.ok(MEMORY_GAMES.has("kaun-banega-champion"));
});
await check("MEM-5", "Charades: a regular host's second game repeats nothing (it repeated about 1 in 3 before)", () => {
  mem.clear();
  const players = ["a", "b", "c", "d"].map((id) => ({ id, name: id, avatar: "cat", connected: true }));
  const PER_GAME = 20;
  let repeats = 0;
  for (let run = 0; run < 50; run++) {
    mem.clear();
    const s1 = charades.init({ players, options: withSeen("charades", { level: "family" }), now: 0 }) as { deck: string[] };
    const game1 = s1.deck.slice(0, PER_GAME);
    rememberSeen("charades", game1);
    const s2 = charades.init({ players, options: withSeen("charades", { level: "family" }), now: 0 }) as { deck: string[] };
    repeats += s2.deck.slice(0, PER_GAME).filter((m) => game1.includes(m)).length;
  }
  assert.equal(repeats, 0, `${repeats} repeats across 50 second games`);
  assert.ok(CHARADES.family.length >= PER_GAME * 2);
});

console.log(results.join("\n"));
console.log(`\n${passed} passed, ${results.length - passed} failed`);
process.exit(results.length === passed ? 0 : 1);
})();
