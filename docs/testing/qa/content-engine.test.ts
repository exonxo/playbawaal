// Content engine core (round 13): admin rules, strictness settings, player signals and the game's
// signal log (no database, no AI). Run from the repo root:
//   npx -y tsx docs/testing/qa/content-engine.test.ts
import assert from "node:assert/strict";
import { BOTTLE_PROMPTS, type BottleTone } from "../../../src/content/spin-bottle";
import { applyRules, compileAll, matchRule, ruleGuidance, ruleProblem, type ContentRule } from "../../../src/lib/suggest/rules-core";
import { allowedByPolicy, applyBottlePolicy, categoriesOf, cleanPolicy, MOOD_ALLOWS, offFor, policyGuidance } from "../../../src/lib/suggest/policy-core";
import { cleanEvents, retireDecisions, roomHash, MIN_SHOWN, REPORT_ROOMS } from "../../../src/lib/suggest/signals";
import { initState, publicView, reduce, tick, SPIN_MS, type State } from "../../../src/games/spin-bottle/logic";
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

let nextId = 1;
const rule = (r: Partial<ContentRule>): ContentRule => ({ id: nextId++, rule_type: "block", match_type: "word", pattern: "x", scope: "all", active: true, ...r });
const players = ["a", "b", "c"].map((id) => ({ id, name: id, avatar: "cat", connected: true }) as unknown as Player);
const act = (type: string, playerId: string, payload?: unknown) => ({ type, playerId, payload }) as GameAction;

/** Spins and picks until a card is on screen. */
function toCard(s: State, kind: "truth" | "dare", now: number): State {
  s = reduce(s, act("spin", HOST_ID), players, now);
  s = tick(s, now + SPIN_MS);
  return reduce(s, act("pick", s.turn.target!, kind), players, now + SPIN_MS);
}

(async () => {
  /* ---------------- Rules ---------------- */
  await check("RUL-1", "a word rule matches whole words only, any case", () => {
    const c = compileAll([rule({ pattern: "cricket" })], "dare");
    assert.ok(matchRule("Talk about CRICKET for a minute", c));
    assert.equal(matchRule("Cricketers are fun", c), null);
  });
  await check("RUL-2", "a phrase matches across different spacing", () => {
    const c = compileAll([rule({ pattern: "office party" })], "dare");
    assert.ok(matchRule("Plan the office   party", c));
  });
  await check("RUL-3", "an allow rule is an exception to a block rule", () => {
    const c = compileAll([rule({ pattern: "sex" }), rule({ rule_type: "allow", pattern: "Essex" })], "dare");
    assert.equal(matchRule("Name a town in Essex", c), null);
    assert.ok(matchRule("sex", c));
  });
  await check("RUL-4", "scope: a rule for one kind doesn't touch other kinds; paused rules do nothing", () => {
    const rules = [rule({ pattern: "boss", scope: "bottle-prompts" }), rule({ pattern: "chai", active: false })];
    assert.ok(matchRule("Roast the boss", compileAll(rules, "bottle-prompts")));
    assert.equal(matchRule("Roast the boss", compileAll(rules, "emoji-puzzle")), null);
    assert.equal(matchRule("Make chai", compileAll(rules, "bottle-prompts")), null);
  });
  await check("RUL-5", "topic bans block like words and are told to the AI", () => {
    const rules = [rule({ rule_type: "topic", pattern: "Famous Actor" }), rule({ pattern: "jail" })];
    assert.ok(matchRule("Do an impression of Famous Actor", compileAll(rules, "dare")));
    const g = ruleGuidance("dare", rules);
    assert.match(g, /Famous Actor/);
    assert.match(g, /jail/);
    assert.equal(ruleGuidance("dare", []), "");
  });
  await check("RUL-6", "broken or match-everything patterns can't be saved", () => {
    assert.equal(ruleProblem({ match_type: "pattern", pattern: "(" }), "bad_pattern");
    assert.equal(ruleProblem({ match_type: "pattern", pattern: ".*" }), "matches_everything");
    assert.equal(ruleProblem({ match_type: "word", pattern: "  " }), "empty");
    assert.equal(ruleProblem({ match_type: "word", pattern: "x".repeat(201) }), "too_long");
    assert.equal(ruleProblem({ match_type: "pattern", pattern: "\\bboss(es)?\\b" }), null);
  });
  const block = [rule({ pattern: "boss" })];
  await check("RUL-7", "Spin the Bottle batches keep their shape, minus blocked prompts", () => {
    const out = applyRules("bottle-prompts", { truths: ["Who is your boss?", "Best chai?"], dares: ["Dance now"], social: ["Post: my boss rocks"] }, block) as { truths: string[]; dares: string[]; social: string[] };
    assert.deepEqual(out.truths, ["Best chai?"]);
    assert.deepEqual(out.dares, ["Dance now"]);
    assert.deepEqual(out.social, []);
    assert.equal(applyRules("bottle-prompts", { truths: ["boss one"], dares: [], social: [] }, block), null);
  });
  await check("RUL-8", "emoji lists drop blocked puzzles (checked in every field)", () => {
    const out = applyRules("emoji-puzzle", [{ emojis: "👔", answer: "Boss", hint: "work" }, { emojis: "☕", answer: "Chai", hint: "drink" }], block) as unknown[];
    assert.equal(out.length, 1);
    assert.equal(applyRules("emoji-puzzle", [{ answer: "boss" }], block), null);
  });
  await check("RUL-9", "Chor Kaun: a blocked label drops the topic; blocked words are removed", () => {
    const words = Array.from({ length: 14 }, (_, i) => `word ${i}`);
    assert.equal(applyRules("chor-kaun-topic", { label: "Boss life", words }, block), null);
    const t = applyRules("chor-kaun-topic", { label: "Office", words: [...words, "boss"] }, block) as { words: string[] };
    assert.equal(t.words.length, 14);
    assert.equal(applyRules("chor-kaun-topic", { label: "Office", words: ["boss", "a b"] }, block), null, "too few words left");
  });
  await check("RUL-10", "a dare with a blocked text is dropped; no rules changes nothing", () => {
    assert.equal(applyRules("dare", { text: "Call your boss" }, block), null);
    const d = { text: "Sing a song" };
    assert.equal(applyRules("dare", d, []), d);
    assert.equal(applyRules("dare", d, [rule({ rule_type: "allow", pattern: "song" })]), d, "allow-only rules change nothing");
  });
  await check("RUL-11", "objects holding lists (e.g. news checks) are filtered, not thrown away", () => {
    const out = applyRules("kbc-question", { checks: [{ id: 1, note: "boss story" }, { id: 2, note: "fine" }] }, block) as { checks: unknown[] };
    assert.equal(out.checks.length, 1);
  });

  /* ---------------- Strictness ---------------- */
  await check("POL-1", "prompts are sorted into kinds", () => {
    assert.ok(categoriesOf("Show your 3rd most recent screenshot").includes("phone"));
    assert.ok(categoriesOf("What's the worst date you've been on?").includes("dating"));
    assert.ok(categoriesOf("Who here would survive a zombie apocalypse?").includes("picks"));
    assert.ok(categoriesOf("Hop on one foot and count to 15").includes("physical"));
    assert.ok(categoriesOf("Do your best impression of the boss").includes("roast"));
    assert.deepEqual(categoriesOf("Post a story", true), ["social"]);
  });
  await check("POL-2", "settings only make a mood stricter; kids never get phone or dating", () => {
    const p = cleanPolicy({ kids: { phone: true, physical: false }, college: { social: false }, office: "nope", bogus: { phone: false } });
    assert.ok(offFor(p, "kids").includes("phone"), "kids phone stays off even if set on");
    assert.ok(offFor(p, "kids").includes("physical"));
    assert.deepEqual(offFor(p, "college"), ["social"]);
    assert.deepEqual(offFor(p, "office"), []);
    assert.ok(!MOOD_ALLOWS.family.includes("dating"));
  });
  await check("POL-3", "a batch loses switched-off kinds; too little left means null", () => {
    const batch = {
      truths: ["What's the worst date you've been on?", "Best chai spot?", "Funniest teacher?", "Worst haircut?"],
      dares: ["Show your 3rd most recent screenshot.", "Sing like a robot."],
      social: ["Post a story saying hi."],
    };
    const out = applyBottlePolicy(batch, ["dating", "phone", "social"])!;
    assert.equal(out.truths.length, 3);
    assert.deepEqual(out.dares, ["Sing like a robot."]);
    assert.deepEqual(out.social, []);
    assert.equal(applyBottlePolicy({ truths: ["A date story?"], dares: [], social: [] }, ["dating"]), null);
    assert.equal(applyBottlePolicy(batch, []), batch);
  });
  await check("POL-4", "the AI is told only about kinds the mood could have had", () => {
    assert.match(policyGuidance(["social", "phone"], "college"), /Social dares/);
    assert.equal(policyGuidance(["phone", "dating"], "kids"), "", "kids never had those, nothing to say");
  });

  /* ---------------- Signals ---------------- */
  await check("SIG-1", "events from the browser are cleaned (known events, short text, max 100)", () => {
    const out = cleanEvents([{ key: "  Pitch   a startup ", event: "flipped" }, { key: "x", event: "shown" }, { key: "ok text", event: "hacked" }, null, ...Array.from({ length: 200 }, () => ({ key: "ab", event: "shown" }))]);
    assert.equal(out[0].key, "Pitch a startup");
    assert.ok(out.every((e) => e.key.length >= 2));
    assert.ok(out.length <= 100);
    assert.equal(cleanEvents("nope").length, 0);
  });
  await check("SIG-2", "reports from enough rooms switch an item off; so does a high flip-or-pass rate", () => {
    const d = retireDecisions([
      { text_norm: "a", shown: 3, done: 0, passed: 0, flipped: 0, reported_rooms: REPORT_ROOMS },
      { text_norm: "b", shown: MIN_SHOWN, done: 2, passed: 6, flipped: 6, reported_rooms: 0 },
      { text_norm: "c", shown: MIN_SHOWN - 1, done: 0, passed: 19, flipped: 0, reported_rooms: 0 },
      { text_norm: "d", shown: 40, done: 30, passed: 5, flipped: 5, reported_rooms: 1 },
    ]);
    assert.deepEqual(d.reports, ["a"]);
    assert.deepEqual(d.signals, ["b"], "c hasn't been shown enough; d is liked");
  });
  await check("SIG-3", "the room hash is one-way, stable and short", () => {
    const h = roomHash("11111111-2222-3333-4444-555555555555");
    assert.match(h, /^[0-9a-f]{32}$/);
    assert.equal(h, roomHash("11111111-2222-3333-4444-555555555555"));
    assert.notEqual(h, roomHash("11111111-2222-3333-4444-555555555556"));
    assert.ok(!h.includes("1111"));
  });

  /* ---------------- Game: signal log and strictness ---------------- */
  await check("GAME-1", "a card logs shown, then flipped + shown for the other side, then done", () => {
    let s = toCard(initState("college", players), "truth", 0);
    const [a, b] = s.turn.card!;
    s = reduce(s, act("flip", s.turn.target!), players, 5000);
    s = reduce(s, act("flip", s.turn.target!), players, 5100);
    s = reduce(s, act("done", s.turn.target!), players, 6000);
    const log = publicView(s).log.map((e) => `${e.event}:${e.text === a.text ? "A" : e.text === b.text ? "B" : "?"}`);
    assert.deepEqual(log, ["shown:A", "flipped:A", "shown:B", "flipped:B", "done:A"]);
    assert.ok(publicView(s).log.every((e, i, all) => i === 0 || e.seq > all[i - 1].seq), "sequence numbers rise");
  });
  await check("GAME-2", "pass, report and the first laugh are logged; the target's own laugh isn't", () => {
    let s = toCard(initState("family", players), "dare", 0);
    const target = s.turn.target!;
    const other = players.find((p) => p.id !== target)!.id;
    const third = players.find((p) => p.id !== target && p.id !== other)!.id;
    s = reduce(s, act("react", target, "😂"), players, 4000);
    s = reduce(s, act("react", other, "😂"), players, 4100);
    s = reduce(s, act("react", third, "🔥"), players, 4200);
    s = reduce(s, act("report", other), players, 4300);
    s = reduce(s, act("pass", target), players, 4400);
    const events = publicView(s).log.map((e) => e.event);
    assert.deepEqual(events, ["shown", "loved", "reported", "shown", "passed"]);
  });
  await check("GAME-3", "strictness from the server removes switched-off kinds from the built-in deck", () => {
    let s = initState("college", players);
    s = reduce(s, act("policy", HOST_ID, { tone: "college", off: ["phone", "dating", "social", "made-up"] }), players, 0);
    assert.deepEqual(s.off, ["phone", "dating", "social"]);
    for (const k of ["truth", "dare"] as const) assert.ok(s.queue[k].every((p) => allowedByPolicy(p.text, !!p.social, s.off)), `${k} pile is clean`);
    // Many cards later, still nothing switched off is dealt.
    let now = 0;
    for (let i = 0; i < 120; i++) {
      s = toCard(s, i % 2 ? "dare" : "truth", now);
      for (const side of s.turn.card!) assert.ok(allowedByPolicy(side.text, !!side.social, s.off), `dealt "${side.text}"`);
      s = reduce(s, act("done", HOST_ID), players, now + 4000);
      now += 10_000;
    }
  });
  await check("GAME-4", "strictness from a player, or for another mood, is ignored", () => {
    const s = initState("office", players);
    assert.equal(reduce(s, act("policy", "a", { tone: "office", off: ["phone"] }), players, 0), s);
    assert.equal(reduce(s, act("policy", HOST_ID, { tone: "kids", off: ["phone"] }), players, 0), s);
  });
  await check("GAME-5", "a mood with everything switched off still deals cards (never runs dry)", () => {
    const tone: BottleTone = "kids";
    let s = reduce(initState(tone, players), act("policy", HOST_ID, { tone, off: ["picks", "physical"] }), players, 0);
    for (let i = 0; i < 30; i++) {
      s = toCard(s, "dare", i * 10_000);
      assert.ok(s.turn.card && s.turn.card[0] && s.turn.card[1], "card dealt");
      s = reduce(s, act("pass", HOST_ID), players, i * 10_000 + 4000);
    }
    assert.ok(BOTTLE_PROMPTS[tone].length > 0);
  });

  console.log(results.join("\n"));
  console.log(`\n${passed} passed, ${results.length - passed} failed`);
  process.exit(results.length === passed ? 0 : 1);
})();
