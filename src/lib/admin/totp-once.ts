import { allow } from "../shared-limit";
import { totpStep } from "./crypto";

/**
 * An authenticator code works once. A code is valid for about 90 seconds (clock drift), so without
 * this, a code seen over someone's shoulder or captured in transit could be used again. Uses the shared
 * limiter (migration 0015) so it holds across server instances; before 0015, per instance only.
 * `purpose` keeps the login code and a step-up code apart.
 */
export async function consumeTotp(code: string, secret: string, purpose: "login" | "stepup", now = Date.now()): Promise<boolean> {
  const step = totpStep(code, secret, now);
  if (step === null) return false;
  return allow(`totp:${purpose}:${step}`, 180, 1);
}
