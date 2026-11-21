// Security hardening (round 14 review): room protocol trust, rate limits, names, admin rules, single-use
// authenticator codes and security headers (no network, no database). Run from the repo root:
//   npx -y tsx docs/testing/qa/security-hardening.test.ts
import assert from "node:assert/strict";
import { createRoomReceiver, MAX_FIRST_AGE_MS } from "../../../src/lib/roomReceiver";
import { generateSigningKeys, importSigner, sign } from "../../../src/lib/secure";
import type { RoomSnapshot, SignedRoom } from "../../../src/lib/room";
import { cleanName, makeLimiter, MAX_ACTION_CT } from "../../../src/lib/useHostRoom";
import { ruleProblem, slowPattern, compileRule } from "../../../src/lib/suggest/rules-core";
import { totpAt, totpStep, randomSecretBase32 } from "../../../src/lib/admin/crypto";
import { consumeTotp } from "../../../src/lib/admin/totp-once";
import { allow, requestIp, resetMemoryLimits } from "../../../src/lib/shared-limit";
import nextConfig from "../../../next.config";

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

/** The server's answer to "which key is this room's host?" (stands in for /api/rooms/CODE). */
let serverKey: string | null = null;
let serverDown = false;
globalThis.fetch = (async () => {
  if (serverDown) throw new Error("offline");
  return new Response(JSON.stringify({ exists: true, hostKey: serverKey }), { headers: { "content-type": "application/json" } });
}) as typeof fetch;

async function signedSnap(pair: Awaited<ReturnType<typeof generateSigningKeys>>, over: Partial<RoomSnapshot> = {}): Promise<SignedRoom> {
  const snap = { code: "ABCD", phase: "lobby", gameId: null, players: [], hostPlayerId: null, together: true, view: null, hostNow: 1, at: Date.now(), epoch: 1000, seq: 1, hostEcdh: "x", kicked: [], ...over } as RoomSnapshot;
  const d = JSON.stringify(snap);
  return { v: 1, d, s: await sign(await importSigner(pair), d), k: pair.publicKey } as unknown as SignedRoom;
}

(async () => {
  const host = await generateSigningKeys();
  const attacker = await generateSigningKeys();

  /* ---------------- Room protocol ---------------- */
  await check("ROOM-1", "real site: before the server knows the host key, a key seen on the channel is NOT trusted", async () => {
    serverKey = null;
    const r = createRoomReceiver("ABCD", { strict: true });
    assert.equal(await r.accept(await signedSnap(attacker)), null, "attacker snapshot refused");
  });
  await check("ROOM-2", "real site: once the server has the host key, the real host is accepted and the attacker isn't", async () => {
    serverKey = null;
    const r = createRoomReceiver("ABCD", { strict: true });
    await r.accept(await signedSnap(attacker));
    serverKey = host.publicKey;
    await new Promise((res) => setTimeout(res, 1600)); // past the retry gap
    assert.ok(await r.accept(await signedSnap(host, { seq: 2 })), "real host accepted");
    assert.equal(await r.accept(await signedSnap(attacker, { seq: 3 })), null, "attacker still refused");
  });
  await check("ROOM-3", "real site: with the key API unreachable, nothing is accepted (no fake room)", async () => {
    serverDown = true;
    const r = createRoomReceiver("ABCD", { strict: true });
    assert.equal(await r.accept(await signedSnap(attacker)), null);
    assert.equal(await r.accept(await signedSnap(host)), null);
    serverDown = false;
  });
  await check("ROOM-4", "demo mode (no server) still trusts the first key, as before", async () => {
    serverKey = null;
    const r = createRoomReceiver("ABCD");
    assert.ok(await r.accept(await signedSnap(host)));
  });
  await check("ROOM-5", "an old snapshot from an earlier session is refused by a phone that just loaded", async () => {
    serverKey = host.publicKey;
    const r = createRoomReceiver("ABCD", { strict: true });
    assert.equal(await r.accept(await signedSnap(host, { at: Date.now() - MAX_FIRST_AGE_MS - 60_000 })), null);
    assert.ok(await r.accept(await signedSnap(host, { seq: 5 })), "a fresh one is accepted");
  });
  await check("ROOM-6", "tampered and wrong-room snapshots are still refused", async () => {
    serverKey = host.publicKey;
    const r = createRoomReceiver("ABCD", { strict: true });
    const good = await signedSnap(host);
    assert.equal(await r.accept({ ...good, d: good.d.replace('"lobby"', '"closed"') }), null);
    assert.equal(await r.accept(await signedSnap(host, { code: "WXYZ" })), null);
  });

  /* ---------------- Flood limits ---------------- */
  await check("LIM-1", "per-sender limiter: a burst is allowed, a flood is cut, and it refills over time", () => {
    const lim = makeLimiter(25, 60);
    const t = 1_000_000;
    let ok = 0;
    for (let i = 0; i < 500; i++) if (lim("p1", t)) ok++;
    assert.equal(ok, 60, "burst of 60, then refused");
    assert.ok(lim("p2", t), "another sender has its own bucket");
    assert.ok(lim("p1", t + 1000), "a second later, p1 can send again");
  });
  await check("LIM-2", "actions are capped at a realistic size", () => {
    assert.ok(MAX_ACTION_CT <= 64_000);
  });
  await check("LIM-3", "shared limit falls back to memory without a database and still cuts floods", async () => {
    resetMemoryLimits();
    let ok = 0;
    for (let i = 0; i < 50; i++) if (await allow("test:key", 60, 30)) ok++;
    assert.equal(ok, 30);
  });
  await check("LIM-4", "the IP used for limits is the last forwarded entry (the one the platform adds)", () => {
    const req = new Request("http://x", { headers: { "x-forwarded-for": "6.6.6.6, 10.0.0.1, 203.0.113.9" } });
    assert.equal(requestIp(req), "203.0.113.9");
  });

  /* ---------------- Names ---------------- */
  await check("NAME-1", "names lose control, direction-override and invisible characters", () => {
    assert.equal(cleanName("Pr‮oloy"), "Proloy");
    assert.equal(cleanName("Ro​han\u0000"), "Rohan");
    assert.equal(cleanName("  A   B  "), "A B");
    assert.equal(cleanName("​​"), "");
    assert.equal(cleanName("x".repeat(40)).length, 16);
  });

  /* ---------------- Admin rules: slow patterns ---------------- */
  await check("RGX-1", "patterns that can hang the server are refused", () => {
    for (const p of ["(a+)+$", "(\\w*)*x", "(a|a)*b", "(x+x+)+y", "(.*a){12}", "(a)\\1"]) {
      assert.ok(slowPattern(p) || ruleProblem({ match_type: "pattern", pattern: p }), `refused: ${p}`);
      assert.equal(compileRule({ match_type: "pattern", pattern: p }), null, `never compiled: ${p}`);
    }
    assert.equal(ruleProblem({ match_type: "pattern", pattern: "x".repeat(101) }), "pattern_too_long");
  });
  await check("RGX-2", "ordinary patterns are still fine", () => {
    for (const p of ["\\bboss(es)?\\b", "colou?r", "^(hi|hello)\\b", "[0-9]{2,4}"]) assert.equal(ruleProblem({ match_type: "pattern", pattern: p }), null, p);
  });

  /* ---------------- Single-use authenticator codes ---------------- */
  await check("TOTP-1", "a valid code works once; replaying it is refused; login and step-up are separate", async () => {
    resetMemoryLimits();
    const secret = randomSecretBase32();
    const now = Date.now();
    const code = totpAt(secret, now);
    assert.notEqual(totpStep(code, secret, now), null);
    assert.equal(await consumeTotp(code, secret, "login", now), true);
    assert.equal(await consumeTotp(code, secret, "login", now + 5000), false, "replay refused");
    assert.equal(await consumeTotp(code, secret, "stepup", now), true, "step-up is its own use");
    assert.equal(await consumeTotp("000000" === code ? "111111" : "000000", secret, "login", now), false, "wrong code refused");
  });

  /* ---------------- Security headers ---------------- */
  await check("HDR-1", "every page gets anti-framing, nosniff, referrer and permissions headers; no 'powered by'", async () => {
    assert.equal(nextConfig.poweredByHeader, false);
    const rules = await nextConfig.headers!();
    const all = rules.find((r) => r.source === "/:path*");
    assert.ok(all, "applies to every path");
    const h = Object.fromEntries(all!.headers.map((x) => [x.key.toLowerCase(), x.value]));
    assert.match(h["content-security-policy"], /frame-ancestors 'self'/);
    assert.equal(h["x-content-type-options"], "nosniff");
    assert.ok(h["x-frame-options"]);
    assert.ok(h["referrer-policy"]);
    assert.match(h["permissions-policy"], /camera=\(\)/);
  });

  console.log(results.join("\n"));
  console.log(`\n${passed} passed, ${results.length - passed} failed`);
  process.exit(results.length === passed ? 0 : 1);
})();
