import { bot } from "@/core/bot";
import logger from "@/lib/logger";
import { renewVkUserToken } from "@/lib/vkrenew";
import { vkUserTokenInfo, type VkUserTokenInfo } from "@/lib/vkuser";
import { PorterConfig as config } from "../../porter.config";

/**
 * Watches the VK user token, renews it unattended when it can, and says
 * something only when automation could not save it.
 *
 * The token carries `expires_in=86400`. That makes expiry a daily certainty
 * rather than an incident, and its symptom is close to invisible: posts keep
 * publishing, they just quietly lose their picture. Nothing errors, nothing
 * retries, and the first sign is somebody noticing a bare post days later.
 *
 * Renewal rides `login.vk.ru/?act=web_token` — the exchange VK's own web
 * client makes for an already-approved Mini App (see src/lib/vkrenew.ts for
 * the contract, src/scripts/vkrenewprobe.ts for how it was found). It needs a
 * live browser-session cookie jar, which can go stale on its own schedule, so
 * a failed renewal is never silently retried forever: attempts are rate-
 * limited and their failure becomes context on whatever warning follows,
 * telling the operator both THAT the token is dying and WHY the automatic
 * path could not prevent it.
 */

const DEFAULT_INTERVAL_MINUTES = 30;
const DEFAULT_WARN_BEFORE_HOURS = 6;

/**
 * Renew proactively once fewer than this many hours remain — about three
 * quarters through the measured 24 h life, so the swap happens while the old
 * token still works (the web_token exchange has only ever been observed with
 * a live token in the body).
 */
const DEFAULT_RENEW_AHEAD_HOURS = 18;

/** Floor between renewal attempts, so a dead jar cannot hammer VK hourly. */
const MIN_RENEW_GAP_MINUTES = 60;

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

/** When the last renewal was attempted — the rate limit against a dead jar. */
let lastRenewAttempt = 0;

/**
 * Whether this token needs attention soon enough to try renewing it now.
 *
 * With a reported expiry the remaining hours decide. Without one (a hand-
 * pasted token carries no issue time VK shares), age stands in for it against
 * the same threshold — the measured 24 h life means an old unknown is as
 * dangerous as a near-expired known.
 */
function renewalDue(info: VkUserTokenInfo): boolean {
  if (!info.present) return false;
  const aheadHours =
    config.vkToken?.renewAheadHours ?? DEFAULT_RENEW_AHEAD_HOURS;
  if (info.remainingHours !== null) return info.remainingHours <= aheadHours;
  return (info.ageHours ?? 0) >= aheadHours;
}

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

async function notify(
  severity: Severity,
  detail: string,
  renewalContext = "",
): Promise<void> {
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
    `${head}\n<i>${detail}</i>\n` +
    (renewalContext ? `<i>${renewalContext}</i>\n` : "") +
    "\nAutomatic renewal needs a live browser session in " +
    "<code>db/vkcookies.txt</code>: re-export the cookies of a logged-in " +
    "vk.ru tab and it recovers on its own within the hour. To fix right " +
    "now, mint a token in the Mini App and paste it into " +
    "<code>VK_USER_TOKEN</code>. Check with <code>/health</code>.";

  for (const id of ids) {
    try {
      await bot.api.sendMessage(id, text, { parse_mode: "HTML" });
    } catch (error) {
      logger.error(`[vk-watch] could not alert ${id}: ${String(error)}`);
    }
  }
}

async function tick(): Promise<void> {
  // Renew BEFORE alerting. A success resets the clock so the alert below
  // simply never fires; a failure becomes context on whatever warning follows.
  let renewalContext = "";
  if (
    renewalDue(vkUserTokenInfo()) &&
    Date.now() - lastRenewAttempt >= MIN_RENEW_GAP_MINUTES * 60_000
  ) {
    lastRenewAttempt = Date.now();
    const result = await renewVkUserToken();
    if (result.ok) {
      logger.info(
        `[vk-watch] auto-renewal succeeded (app ${result.appId}, valid ` +
          `${result.expiresInHours !== null ? `${result.expiresInHours.toFixed(1)} h` : "for an unknown time"})`,
      );
    } else {
      renewalContext = `auto-renewal unavailable — ${result.detail}`;
      logger.warn(`[vk-watch] ${renewalContext}`);
    }
  }

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

  if (announced === severity) return;
  announced = severity;

  logger.warn(
    `[vk-watch] ${severity} — ${detail}${renewalContext ? `; ${renewalContext}` : ""}`,
  );
  await notify(severity, detail, renewalContext);
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
