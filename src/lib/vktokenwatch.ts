import { bot } from "@/core/bot";
import logger from "@/lib/logger";
import { vkUserTokenInfo } from "@/lib/vkuser";
import { PorterConfig as config } from "../../porter.config";

/**
 * Notices that the VK user token is dying, and says so while there is still
 * time to act.
 *
 * The token carries `expires_in=86400`. That makes expiry a daily certainty
 * rather than an incident, and its symptom is close to invisible: posts keep
 * publishing, they just quietly lose their picture. Nothing errors, nothing
 * retries, and the first sign is somebody noticing a bare post days later.
 *
 * This is deliberately only detection and notification. Renewal is a separate
 * problem — VK refuses to issue a token to a non-interactive client, so there
 * is no unattended path yet (see src/scripts/vkrenewprobe.ts for what has been
 * measured). When one exists it attaches at exactly one place, marked below.
 */

const DEFAULT_INTERVAL_MINUTES = 30;
const DEFAULT_WARN_BEFORE_HOURS = 6;

/**
 * When VK reports no expiry, warn on age instead.
 *
 * Every token measured so far has lasted 24 h, so a token past this age is
 * near the end of a life we simply were not told the length of. Silence would
 * mean the tokens we know least about are the ones we watch least.
 */
const ASSUMED_LIFETIME_HOURS = 24;

type Severity = "expired" | "expiring" | "ok";

let timer: ReturnType<typeof setInterval> | null = null;
/**
 * The last severity announced.
 *
 * A warning repeated every thirty minutes for six hours stops being read, and
 * an operator who has trained themselves to ignore this channel is worse off
 * than one who was never warned. Only transitions are announced.
 */
let announced: Severity | null = null;

function superAdminIds(): number[] {
  return (process.env.SUPER_ADMIN_ID ?? "")
    .split(",")
    .map((id) => Number(id.trim()))
    .filter((id) => Number.isSafeInteger(id) && id > 0);
}

function classify(): { severity: Severity; detail: string } {
  const info = vkUserTokenInfo();

  if (!info.present) {
    return { severity: "ok", detail: "no token configured — nothing to watch" };
  }

  if (info.remainingHours !== null) {
    if (info.remainingHours <= 0) {
      return {
        severity: "expired",
        detail: `expired ${Math.abs(info.remainingHours).toFixed(1)} h ago`,
      };
    }
    const warnBelow = config.vkToken?.warnBeforeHours ?? DEFAULT_WARN_BEFORE_HOURS;
    if (info.remainingHours <= warnBelow) {
      return {
        severity: "expiring",
        detail: `${info.remainingHours.toFixed(1)} h left`,
      };
    }
    return { severity: "ok", detail: `${info.remainingHours.toFixed(1)} h left` };
  }

  // No expiry reported — fall back to age against the measured 24 h lifetime.
  const age = info.ageHours ?? 0;
  if (age >= ASSUMED_LIFETIME_HOURS) {
    return {
      severity: "expired",
      detail: `no expiry reported and ${age.toFixed(1)} h old, past the ${ASSUMED_LIFETIME_HOURS} h these have been measured to last`,
    };
  }
  const warnBelow = config.vkToken?.warnBeforeHours ?? DEFAULT_WARN_BEFORE_HOURS;
  if (ASSUMED_LIFETIME_HOURS - age <= warnBelow) {
    return {
      severity: "expiring",
      detail: `no expiry reported, ${age.toFixed(1)} h old — assume under ${(ASSUMED_LIFETIME_HOURS - age).toFixed(1)} h left`,
    };
  }
  return { severity: "ok", detail: `no expiry reported, ${age.toFixed(1)} h old` };
}

async function notify(severity: Severity, detail: string): Promise<void> {
  const ids = superAdminIds();
  if (ids.length === 0) {
    logger.warn("[vk-watch] no SUPER_ADMIN_ID set — cannot send the alert");
    return;
  }

  const head =
    severity === "expired"
      ? "🔴 <b>VK user token expired</b>\nPosts are publishing without their photos."
      : "🟡 <b>VK user token is about to expire</b>\nPhotos stop attaching when it does.";

  const text =
    `${head}\n<i>${detail}</i>\n\n` +
    "Mint a replacement by opening the Mini App in VK, then either paste it " +
    "into <code>VK_USER_TOKEN</code> and restart, or write it to " +
    "<code>db/vkuser.json</code>. Check with <code>/health</code>.";

  for (const id of ids) {
    try {
      await bot.api.sendMessage(id, text, { parse_mode: "HTML" });
    } catch (error) {
      logger.error(`[vk-watch] could not alert ${id}: ${String(error)}`);
    }
  }
}

async function tick(): Promise<void> {
  const { severity, detail } = classify();

  if (severity === "ok") {
    // Announce recovery only if a warning was actually sent, so a healthy boot
    // does not open with an all-clear for a problem nobody heard about.
    if (announced && announced !== "ok") {
      logger.info(`[vk-watch] token healthy again — ${detail}`);
    }
    announced = "ok";
    return;
  }

  // ── Renewal attaches here ────────────────────────────────────────────────
  // When an unattended path exists, try it before alerting and fall through
  // to the alert only if it fails. Nothing to call yet: VK answers err=2
  // ("Security Error") to every non-interactive request measured so far.

  if (announced === severity) return;
  announced = severity;

  logger.warn(`[vk-watch] ${severity} — ${detail}`);
  await notify(severity, detail);
}

export function startVkTokenWatch(): void {
  if (config.vkToken?.watch === false) {
    logger.info("[vk-watch] disabled by config");
    return;
  }
  if (timer) return;

  const minutes = config.vkToken?.intervalMinutes ?? DEFAULT_INTERVAL_MINUTES;
  timer = setInterval(() => void tick(), minutes * 60_000);
  // Do not hold the process open on this alone.
  timer.unref?.();
  logger.info(`[vk-watch] watching the VK user token every ${minutes} min`);

  // Check once at startup rather than waiting out a full interval — a token
  // that died overnight should be reported at boot, not half an hour later.
  void tick();
}

export function stopVkTokenWatch(): void {
  if (!timer) return;
  clearInterval(timer);
  timer = null;
}
