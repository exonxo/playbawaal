// Spin the Bottle: built-in deck, safety rules, game flow and the content-library helpers (no database,
// no AI). Run from the repo root:
//   npx -y tsx docs/testing/qa/spin-bottle.test.ts
import assert from "node:assert/strict";
import { BOTTLE_PROMPTS, BOTTLE_TONES, type BottleTone } from "../../../src/content/spin-bottle";
import { breaksBottleRules, buildBottlePrompt, fallbackBottleBatch, validateBottleBatch } from "../../../src/lib/suggest/bottle";
import { initState, publicView, reduce, tick, SPIN_MS, type State } from "../../../src/games/spin-bottle/logic";
import { itemsFrom, pickFromLibrary, pickPlan, shapeServed, BOTTLE_MIN, BOTTLE_PICK, GAME_FOR, isLibraryKind } from "../../../src/lib/suggest/library";
import { buildPrompt } from "../../../src/lib/suggest/prompts";
import { HOST_ID, type GameAction, type Player } from "../../../src/lib/types";

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

const players = ["a", "b", "c"].map((id) => ({ id, name: id, avatar: "cat", connected: true }) as unknown as Player);
const act = (type: string, playerId: string, payload?: unknown) => ({ type, playerId, payload }) as GameAction;

(async () => {
  delete process.env.SUPABASE_SERVICE_ROLE_KEY;
  delete process.env.NEXT_PUBLIC_SUPABASE_URL;

  await check("SB-1", "every built-in prompt passes its own mood's rules", () => {
    for (const t of BOTTLE_TONES) {
      const bad = BOTTLE_PROMPTS[t].filter((p) => breaksBottleRules(p.text, t, !!p.social));
      assert.equal(bad.length, 0, `${t}: ${bad.map((b) => b.text).join(" | ")}`);
    }
  });
  await check("SB-2", "kids and family have no social dares; the fallback never adds one", () => {
    for (const t of ["kids", "family"] as const) {
      assert.ok(!BOTTLE_PROMPTS[t].some((p) => p.social));
      assert.equal(fallbackBottleBatch(t).social.length, 0);
    }
  });
  await check("SB-3", "banned prompts are refused", () => {
    const banned: [string, BottleTone, boolean][] = [
      ["Kiss the person on your left on the cheek", "college", false],
      ["Take two shots of anything you like right now", "college", false],
      ["Text your boss 'I quit' and show us", "office", false],
      ["Post a story saying you love Mondays", "college", false],
      ["Post a story saying you love Mondays", "kids", true],
      ["Post a story tagging @everyone in your contacts", "college", true],
      ["Post a story and mention your best friend in it", "college", true],
      ["Who is your crush in this room? Be honest now", "college", false],
      ["What's your secret talent nobody knows about?", "kids", false],
    ];
    for (const [text, tone, social] of banned) assert.ok(breaksBottleRules(text, tone, social), text);
  });
  await check("SB-4", "harmless prompts still pass", () => {
    assert.ok(!breaksBottleRules("Post a story: I'm the funniest person here, for 1 hour", "college", true));
    assert.ok(!breaksBottleRules("Which crush from school do you still think about?", "college", false));
    assert.ok(!breaksBottleRules("Do your best monkey impression for 10 seconds.", "kids", false));
  });
  await check("SB-5", "a full game: everyone picked once per cycle, never the holder, flip and done work", () => {
    let s: State = initState("family", players);
    let now = 1000;
    const picked: string[] = [];
    for (let r = 0; r < 9; r++) {
      const holder = s.turn.holder;
      s = reduce(s, act("spin", holder ?? "a"), players, now);
      assert.equal(s.phase, "spinning");
      const target = s.turn.target as string;
      assert.notEqual(target, holder);
      picked.push(target);
      s = tick(s, now + SPIN_MS);
      assert.equal(s.phase, "choose");
      const other = players.find((p) => p.id !== target)!.id;
      assert.equal(reduce(s, act("pick", other, "dare"), players, now).phase, "choose", "only the picked player chooses");
      s = reduce(s, act("pick", target, r % 2 ? "truth" : "dare"), players, now);
      assert.ok(s.turn.card && s.turn.card[0].text !== s.turn.card[1].text);
      s = reduce(s, act("flip", target), players, now);
      assert.equal(s.turn.side, 1);
      s = reduce(s, act("done", target), players, now);
      assert.equal(s.phase, "ready");
      now += 10_000;
    }
    for (let c = 0; c < 3; c++) assert.equal(new Set(picked.slice(c * 3, c * 3 + 3)).size, 3, picked.join(","));
  });
  await check("SB-6", "the host action can spin on someone else's turn; another player can't", () => {
    let s: State = initState("family", players);
    s = reduce(s, act("spin", "a"), players, 0);
    s = tick(s, SPIN_MS);
    const target = s.turn.target as string;
    s = reduce(reduce(s, act("pick", target, "truth"), players, 0), act("done", target), players, 0);
    const other = players.find((p) => p.id !== target)!.id;
    assert.equal(reduce(s, act("spin", other), players, 1).phase, "ready");
    assert.equal(reduce(s, act("spin", HOST_ID), players, 1).phase, "spinning");
  });
  await check("SB-7", "only the host can add prompts, and banned ones are dropped", () => {
    let s: State = initState("family", players);
    const before = s.queue.dare.length;
    const payload = { tone: "family", prompts: [{ kind: "dare", text: "Take two shots of whisky right now" }, { kind: "dare", text: "Do a silly dance for ten whole seconds" }] };
    assert.equal(reduce(s, act("refill", "a", payload), players, 0).queue.dare.length, before);
    s = reduce(s, act("refill", HOST_ID, payload), players, 0);
    assert.equal(s.queue.dare.length, before + 1);
  });
  await check("SB-8", "a player's social opt-out isn't in the shared view", () => {
    const s = reduce(initState("college", players), act("social", "b", false), players, 0);
    assert.deepEqual(s.noSocial, ["b"]);
    assert.ok(!JSON.stringify(publicView(s)).includes("noSocial"));
  });
  await check("SB-9", "bottle prompts are a library kind for the spin-bottle game", () => {
    assert.ok(isLibraryKind("bottle-prompts"));
    assert.equal(GAME_FOR["bottle-prompts"], "spin-bottle");
    const plan = pickPlan("bottle-prompts", { tone: "office" });
    assert.deepEqual(plan.categories, ["office"]);
    assert.equal(plan.count, BOTTLE_PICK);
    assert.equal(plan.min, BOTTLE_MIN);
    assert.deepEqual(pickPlan("bottle-prompts", { tone: "nonsense" }).categories, ["family"]);
  });
  await check("SB-10", "an AI batch becomes one library row per prompt, tagged with the mood", () => {
    const items = itemsFrom("bottle-prompts", { truths: ["Truth one is here?"], dares: ["Dare one is here."], social: ["Social one is here."] }, { tone: "college", theme: "Hostel life" });
    assert.equal(items.length, 3);
    assert.ok(items.every((i) => i.category === "college" && i.theme === "Hostel life"));
    assert.deepEqual(items.map((i) => i.data), [{ kind: "truth", text: "Truth one is here?" }, { kind: "dare", text: "Dare one is here." }, { kind: "dare", text: "Social one is here.", social: true }]);
  });
  await check("SB-11", "library rows are served back as a batch and re-checked with the mood's rules", () => {
    const rows = [
      ...Array.from({ length: 4 }, (_, i) => ({ data: { kind: "truth", text: `What is your favourite cartoon number ${i}?` } })),
      ...Array.from({ length: 4 }, (_, i) => ({ data: { kind: "dare", text: `Walk like a penguin for ${i + 5} seconds.` } })),
      { data: { kind: "dare", text: "Take two shots of whisky right now" } },
      { data: { kind: "dare", text: "Post a story: I'm the funniest person here, for 1 hour", social: true } },
    ];
    const kids = shapeServed("bottle-prompts", rows, { tone: "kids" }) as { truths: string[]; dares: string[]; social: string[] };
    assert.equal(kids.truths.length, 4);
    assert.equal(kids.dares.length, 4, "the banned dare is dropped");
    assert.equal(kids.social.length, 0, "kids never get social dares");
    const college = shapeServed("bottle-prompts", rows, { tone: "college" }) as { social: string[] };
    assert.equal(college.social.length, 1);
    assert.equal(shapeServed("bottle-prompts", rows.slice(0, 3), { tone: "kids" }), null, "too few to be worth using");
  });
  await check("SB-12", "with no database the library is skipped (the game asks the AI as before)", async () => {
    assert.equal(await pickFromLibrary("bottle-prompts", { tone: "family" }, { userId: "00000000-0000-0000-0000-000000000001" }), null);
  });
  await check("SB-13", "the admin theme reaches the prompt; the browser can't add one", () => {
    assert.match(buildPrompt("bottle-prompts", { tone: "college", theme: "Hostel life", avoid: [] }), /Theme for this batch: Hostel life/);
    assert.doesNotMatch(buildBottlePrompt("college", []), /Theme for this batch/);
  });
  await check("SB-14", "a batch validator keeps only rule-passing prompts and needs at least 6", () => {
    const v = validateBottleBatch({ truths: ["Who is your crush in this room?", "What's your most unhinged 2 AM order, honestly?"], dares: ["Do a robot dance for 10 seconds", "Speak like a pirate until next turn", "Sing a jingle like an opera star", "Act like a cat seeing a cucumber", "Do a slow-motion run across the room"], social: ["Post a story tagging @everyone"] }, "college");
    assert.ok(v);
    assert.equal(v!.truths.length, 1);
    assert.equal(v!.social.length, 0);
    assert.equal(validateBottleBatch({ truths: ["What's your favourite food here?"], dares: [] }, "family"), null);
  });

  console.log(results.join("\n"));
  console.log(`\n${passed} passed, ${results.length - passed} failed`);
  process.exit(results.length === passed ? 0 : 1);
})();
