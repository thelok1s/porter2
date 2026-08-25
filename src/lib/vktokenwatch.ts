import { bot } from "@/core/bot";
import logger from "@/lib/logger";
import { renewVkUserToken } from "@/lib/vkrenew";
import { vkUserTokenInfo, type VkUserTokenInfo } from "@/lib/vkuser";
import { PorterConfig as config } from "../../porter.config";

/**
 * Watches the VK user token, renews it unattended when it can, and says
 * something only when automation could not save it.
 *
 * Expiry is a certainty rather than an incident: Mini App grants live 24 h,
 * and web_token mints under VK's own web-client app id came back with ~15 min
 * (measured 2026-08-26). Its symptom is close to invisible either way: posts
 * keep publishing, they just quietly lose their picture. Nothing errors,
 * nothing retries, and the first sign is somebody noticing a bare post days
 * later.
 *
 * Because lifetimes vary by orders of magnitude, nothing here is fixed-cadence:
 * the renewal trigger, the retry floor and the tick interval all scale with
 * whatever life the CURRENT token reports (see observedLifetimeHours).
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
 *
 * For a SHORT-lived grant the same three-quarters rule applies
 * proportionally (see renewalDue); this constant only caps it.
 */
const DEFAULT_RENEW_AHEAD_HOURS = 18;

/**
 * Ceiling between renewal attempts, so a dead jar cannot hammer VK. The
 * actual floor scales with the observed lifetime of the held token — a
 * fifteen-minute grant renewed hourly would spend three quarters of its life
 * already dead (see renewGapMs).
 */
const MAX_RENEW_GAP_MINUTES = 60;

/** Never attempt renewal more often than this, whatever the lifetime. */
const MIN_RENEW_GAP_MS = 90_000;

/** Never wake the watch more often than this, whatever the lifetime. */
const MIN_TICK_MS = 45_000;

/**
 * When VK reports no expiry, warn on age instead.
 *
 * Every token measured so far has lasted 24 h, so a token past this age is
 * near the end of a life we simply were not told the length of. Silence would
 * mean the tokens we know least about are the ones we watch least.
 */
const ASSUMED_LIFETIME_HOURS = 24;

type Severity = "expired" | "expiring" | "ok";

let timer: ReturnType<typeof setTimeout> | null = null;
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
 * The lifetime VK gave the held token, in hours — remaining plus age. The
 * regime decides the whole cadence: Mini App tokens measured ~24 h, while
 * web_token grants minted under VK's own web-client app id came back with
 * `expires` ≈ 899 s (measured 2026-08-26). Null when nothing is known.
 */
function observedLifetimeHours(info: VkUserTokenInfo): number | null {
  if (!info.present || info.remainingHours === null) return null;
  const lifetime = info.remainingHours + (info.ageHours ?? 0);
  return Number.isFinite(lifetime) && lifetime > 0 ? lifetime : null;
}

/**
 * Whether this token needs attention soon enough to try renewing it now.
 *
 * With a reported expiry the trigger is three quarters through the OBSERVED
 * life — capped by the configured ahead-hours so a long-lived token keeps the
 * tuned behaviour exactly (24 h × ¾ = the old 18 h). A fifteen-minute grant
 * therefore renews around its eleventh minute instead of dying on the floor.
 *
 * Without a reported expiry (a hand-pasted token carries no issue time VK
 * shares), age stands in against the same threshold — the measured 24 h life
 * means an old unknown is as dangerous as a near-expired known.
 */
function renewalDue(info: VkUserTokenInfo): boolean {
  if (!info.present) return false;
  const aheadHours =
    config.vkToken?.renewAheadHours ?? DEFAULT_RENEW_AHEAD_HOURS;
  if (info.remainingHours !== null) {
    const lifetime = observedLifetimeHours(info);
    if (lifetime !== null) {
      return info.remainingHours <= Math.min(aheadHours, lifetime * 0.75);
    }
    return info.remainingHours <= aheadHours;
  }
  return (info.ageHours ?? 0) >= aheadHours;
}

/**
 * Floor between renewal ATTEMPTS — the anti-hammer guard for a failing jar.
 * Proportional to the observed life (a third of it) and clamped to sane
 * bounds: a 15-min grant may retry every ~5 min; a 24-h one keeps the old
 * once-an-hour ceiling. Successes reset nothing here — only failures ever
 * feel this floor, because a success replaces the token outright.
 */
function renewGapMs(info: VkUserTokenInfo): number {
  const lifetime = observedLifetimeHours(info);
  if (lifetime === null) return MAX_RENEW_GAP_MINUTES * 60_000;
  return Math.min(
    MAX_RENEW_GAP_MINUTES * 60_000,
    Math.max(MIN_RENEW_GAP_MS, (lifetime / 3) * 3_600_000),
  );
}

/**
 * How long to sleep before the next look.
 *
 * Scaled from what is left of the token — about a quarter of the remaining
 * life, so any grant gets several chances to be renewed before it matters —
 * and clamped between a fast floor and the configured interval.
 */
function nextDelayMs(): number {
  const base =
    (config.vkToken?.intervalMinutes ?? DEFAULT_INTERVAL_MINUTES) * 60_000;
  const { remainingHours } = vkUserTokenInfo();
  if (remainingHours === null || remainingHours <= 0) return base;
  return Math.max(MIN_TICK_MS, Math.min(base, (remainingHours * 3_600_000) / 4));
}

function scheduleNext(): void {
  const delay = nextDelayMs();
  timer = setTimeout(() => {
    timer = null;
    // Reschedule no matter how this tick ended, so one throw cannot kill the
    // watch silently.
    void tick().finally(scheduleNext);
  }, delay);
  // Do not hold the process open on this alone.
  timer.unref?.();
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

  // The Mini App rotation leads because it always works; VK currently refuses
  // the unattended mint outright even against a complete cookie jar, so jar
  // advice only makes sense when the failure reason says the JAR was the
  // problem. /health confirms recovery either way.
  const text =
    `${head}\n<i>${detail}</i>\n` +
    (renewalContext ? `<i>${renewalContext}</i>\n` : "") +
    "\nFix: open the Mini App page inside VK as an admin → Request access → " +
    "Reveal token, then\n<code>pbpaste | docker compose exec -T porter2 npm " +
    "run vkrenewprobe -- --install --stdin</code>\n" +
    "(validated before anything is installed). Automatic renewal rides " +
    "<code>db/vkcookies.txt</code>; if the failure above names the jar, " +
    "re-exporting a logged-in vk.ru tab's cookies may restore it. Check with " +
    "<code>/health</code>.";

  for (const id of ids) {
    try {
      await bot.api.sendMessage(id, text, { parse_mode: "HTML" });
    } catch (error) {
      logger.error(`[vk-watch] could not alert ${id}: ${String(error)}`);
    }
  }
}

async function tick(): Promise<void> {
  const info = vkUserTokenInfo();

  // Renew BEFORE alerting. A success resets the clock so the alert below
  // simply never fires; a failure becomes context on whatever warning follows.
  let renewalContext = "";
  if (renewalDue(info) && Date.now() - lastRenewAttempt >= renewGapMs(info)) {
    lastRenewAttempt = Date.now();
    const result = await renewVkUserToken();
    if (result.ok) {
      logger.info(
        `[vk-watch] auto-renewal succeeded (via ${result.via ?? "?"}, valid ` +
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

  logger.info(
    `[vk-watch] watching the VK user token — cadence adapts to the held ` +
      `token's life, capped at ${config.vkToken?.intervalMinutes ?? DEFAULT_INTERVAL_MINUTES} min`,
  );

  // Check once at startup rather than waiting out a full interval — a token
  // that died overnight should be reported at boot, not half an hour later.
  void tick().finally(scheduleNext);
}

export function stopVkTokenWatch(): void {
  if (!timer) return;
  clearTimeout(timer);
  timer = null;
}
