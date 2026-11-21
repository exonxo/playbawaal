import { NextResponse } from "next/server";
import { isBottleTone } from "@/content/spin-bottle";
import { offFor } from "@/lib/suggest/policy-core";
import { loadBottlePolicy } from "@/lib/suggest/policy";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * The strictness settings a game needs: for Spin the Bottle, the kinds of prompt switched off for a
 * mood. Not secret (it only lists switched-off kinds), so no sign-in is needed. Cached briefly.
 */
export async function GET(req: Request) {
  const tone = new URL(req.url).searchParams.get("tone");
  if (!isBottleTone(tone)) return NextResponse.json({ ok: false, error: "bad_tone" }, { status: 400 });
  const off = offFor(await loadBottlePolicy(), tone);
  return NextResponse.json({ ok: true, tone, off }, { headers: { "cache-control": "public, max-age=60" } });
}
