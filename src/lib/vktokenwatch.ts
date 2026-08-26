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
/**
 * Ceiling on how early a token counts as "about to expire" — proportional to
 * the OBSERVED life in practice (see warnBelowHours), so this only binds for
 * long-lived grants: 24 h × ¼ = the tuned six hours exactly.
 */
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
 * Retry cadence while the token is DEAD — first retry this far out, doubling
 * per consecutive failure up to EXPIRED_RETRY_CEILING_MS.
 *
 * A dead token means every post is silently losing its photo, so this is the
 * moment to look MOST often. The pre-2026-08-26 code did the opposite: with no
 * positive `remainingHours` to scale from, nextDelayMs fell back to the 30-min
 * base, so an expired token that failed one renewal sat dead for half an hour
 * before the next attempt. Measured in prod that day: failures at 02:30, 03:00,
 * 03:30, 04:00 — four thirty-minute gaps, two hours of photo-less posts, and
 * the eventual recovery at 04:30 was the same jar that had been fine all along.
 *
 * Backoff still applies, because "retry until it works" against a genuinely
 * dead jar must not become an unbounded hammer on VK's login endpoint. The
 * ceiling stays well under the healthy-token cadence: persistence is the point.
 */
const EXPIRED_RETRY_BASE_MS = 60_000;
const EXPIRED_RETRY_CEILING_MS = 5 * 60_000;

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
 * How many unattended renewals have failed in a row. Reset to zero the moment
 * one succeeds. The operator is paged only once this crosses alertAfterFailures
 * — the difference between a transient VK blip (heals next tick) and automation
 * that has genuinely stopped keeping up.
 */
let consecutiveRenewalFailures = 0;

/**
 * Whether the current trouble has already been escalated to SUPER_ADMIN_ID.
 * Keeps a stuck episode to a single page, and gates whether recovery is worth
 * an all-clear: a dip nobody was paged about recovers quietly.
 */
let pagedFailure = false;

/** Consecutive renewal failures before the operator is paged. */
function alertAfterFailures(): number {
  const configured = config.vkToken?.alertAfterFailures;
  return Number.isFinite(configured) && (configured as number) > 0
    ? Math.floor(configured as number)
    : 3;
}

/**
 * Whether the held token is past its reported expiry — i.e. whether photos are
 * dropping off posts right now. A token with no reported expiry is NOT counted
 * here: its state is a guess from age, not a fact, and a guess should not drive
 * the aggressive cadence.
 */
function isDead(info: VkUserTokenInfo): boolean {
  return info.present && info.remainingHours !== null && info.remainingHours <= 0;
}

/**
 * How long to wait before the next attempt while the token is dead: doubling
 * from EXPIRED_RETRY_BASE_MS per consecutive failure, capped. Bounded backoff
 * rather than a fixed floor, so a jar that is genuinely dead is retried
 * forever without hammering (~1, 2, 4, 5, 5, 5 … minutes).
 */
function expiredRetryDelayMs(): number {
  const doublings = Math.min(Math.max(consecutiveRenewalFailures - 1, 0), 10);
  return Math.min(EXPIRED_RETRY_CEILING_MS, EXPIRED_RETRY_BASE_MS * 2 ** doublings);
}

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
 * Hours-left under which the token counts as "about to expire".
 *
 * Proportional like everything else here: a quarter of the OBSERVED life,
 * capped by the configured warnBeforeHours so a 24 h grant keeps the tuned
 * six hours exactly. A fifteen-minute web_token mint therefore sits at "ok"
 * for almost its whole life — being near expiry is its NORMAL state, and the
 * watchdog swaps it around minute eleven — and only crosses into "expiring"
 * once automation has demonstrably stopped keeping up. A fixed threshold
 * would instead flag every fresh short-lived mint (0.2 h left of a 15-min
 * grant is 80% of its life remaining) and degrade /health plus page the
 * operator on every boot for a token working exactly as designed.
 */
function warnBelowHours(info: VkUserTokenInfo): number {
  const configured =
    config.vkToken?.warnBeforeHours ?? DEFAULT_WARN_BEFORE_HOURS;
  const lifetime = observedLifetimeHours(info);
  if (lifetime === null) return configured;
  return Math.min(configured, lifetime * 0.25);
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
  // A dead token is already costing photos on every post. The anti-hammer floor
  // drops to the retry cadence so "keep trying until it works" is not silently
  // throttled by a gap sized for a token that still functions.
  if (isDead(info)) return expiredRetryDelayMs();
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
  const info = vkUserTokenInfo();
  // Dead token: come back on the retry cadence, not the idle one. This is the
  // case the old code got backwards (see EXPIRED_RETRY_BASE_MS).
  if (isDead(info)) return expiredRetryDelayMs();
  const { remainingHours } = info;
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
    const warnBelow = warnBelowHours(info);
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

export type VkTokenSeverity = Severity;

/**
 * What the watch currently thinks of the held token, computed fresh on every
 * call — exported so /health grades the token by the SAME standard the
 * operator is alerted by, rather than growing its own (and inevitably fixed-
 * hour) threshold next to this one.
 */
export function vkTokenStatus(): { severity: VkTokenSeverity; detail: string } {
  return classify();
}

/** Deliver one operator message to every configured super admin. */
async function sendToSuperAdmins(text: string): Promise<void> {
  const ids = superAdminIds();
  if (ids.length === 0) {
    logger.warn("[vk-watch] no SUPER_ADMIN_ID set — cannot send the alert");
    return;
  }
  for (const id of ids) {
    try {
      await bot.api.sendMessage(id, text, { parse_mode: "HTML" });
    } catch (error) {
      logger.error(`[vk-watch] could not alert ${id}: ${String(error)}`);
    }
  }
}

/**
 * The all-clear, sent ONLY to close a page that actually went out.
 *
 * An operator who was told photos are dropping needs to be told when they stop
 * dropping — otherwise the only way to learn the incident ended is to go and
 * run /health, and a red message with no green after it trains people to
 * distrust the channel. Never sent on its own: a dip nobody was paged about
 * recovers silently (see tick).
 */
async function notifyRecovered(detail: string, attempts: number): Promise<void> {
  // `attempts` is the run of failures the winning renewal ended. Zero means no
  // renewal of ours ran on the tick that found the token healthy — someone
  // rotated it by hand, or the store changed underneath us. Claiming credit for
  // that would be a lie, and a misleading one: it would tell an operator the
  // automation recovered when in fact their own paste is what fixed it.
  const how =
    attempts > 0
      ? `recovered automatically after ${attempts} failed attempt${attempts === 1 ? "" : "s"}`
      : "the token is valid again";
  const text =
    "🟢 <b>VK user token renewed</b>\nPhotos are attaching again.\n" +
    `<i>${detail}</i>\n<i>${how}</i>\n` +
    "\nNo action needed. <code>/health</code> for the full picture.";
  await sendToSuperAdmins(text);
}

async function notify(
  severity: Severity,
  detail: string,
  renewalContext = "",
): Promise<void> {
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
    "<code>/health</code>.\n\nRenewal keeps retrying on its own; you will get " +
    "a green message if it recovers without you.";

  await sendToSuperAdmins(text);
}

async function tick(): Promise<void> {
  const info = vkUserTokenInfo();

  // Renew BEFORE alerting. A success resets the failure count so the page below
  // never fires; a failure adds to the run and becomes context on it.
  let renewalContext = "";
  let failuresBeforeSuccess = 0;
  if (renewalDue(info) && Date.now() - lastRenewAttempt >= renewGapMs(info)) {
    lastRenewAttempt = Date.now();
    const result = await renewVkUserToken();
    if (result.ok) {
      // Capture the run this success ended BEFORE clearing it — the all-clear
      // reports how many attempts it took, and the counter is about to go.
      failuresBeforeSuccess = consecutiveRenewalFailures;
      consecutiveRenewalFailures = 0;
      // The routine case — the watch mints short-lived grants every few
      // minutes. At debug so it does not bury the log; failures stay at warn.
      logger.debug(
        `[vk-watch] auto-renewal succeeded (via ${result.via ?? "?"}, valid ` +
          `${result.expiresInHours !== null ? `${result.expiresInHours.toFixed(1)} h` : "for an unknown time"})`,
      );
    } else {
      consecutiveRenewalFailures += 1;
      renewalContext = `auto-renewal unavailable — ${result.detail}`;
      // A failed renew effort is shown — the operator asked to see these — but
      // one miss is expected against the flaky short-lived exchange, so the
      // count travels with it to show whether it is a blip or a real run.
      logger.warn(
        `[vk-watch] ${renewalContext} (${consecutiveRenewalFailures}× in a row)`,
      );
    }
  }

  const { severity, detail } = classify();

  if (severity === "ok") {
    // A healthy token means any earlier run of failures is history — including
    // one ended by an operator's manual rotation in another process, whose
    // count would otherwise linger in memory and page on the very next single
    // miss. The counter measures "renewal has stopped keeping the token
    // healthy", so a healthy token zeroes it by definition.
    consecutiveRenewalFailures = 0;

    // Announce recovery only if the operator was actually paged, so a healthy
    // boot — or a transient dip nobody heard about — does not open with an
    // all-clear for a problem that never reached anyone.
    const wasPaged = pagedFailure;
    const wasWarning = announced !== null && announced !== "ok";
    pagedFailure = false;
    announced = "ok";

    if (wasPaged) {
      logger.info(`[vk-watch] token healthy again — ${detail}`);
      await notifyRecovered(detail, failuresBeforeSuccess);
    } else if (wasWarning || failuresBeforeSuccess > 0) {
      logger.debug(`[vk-watch] token recovered — ${detail}`);
    }
    return;
  }

  // Non-ok severity. Page SUPER_ADMIN_ID only when renewal has failed
  // COMPLETELY — a run of consecutive failures, not a single self-healing blip.
  // A short-lived token dipping below the warn line while renewal is still
  // keeping up is normal operation, so it is logged at debug and never paged.
  const renewalGaveUp = consecutiveRenewalFailures >= alertAfterFailures();
  const changed = announced !== severity;
  announced = severity;

  if (renewalGaveUp) {
    if (changed) {
      logger.warn(
        `[vk-watch] ${severity} — ${detail}${renewalContext ? `; ${renewalContext}` : ""}`,
      );
    }
    if (!pagedFailure) {
      pagedFailure = true;
      await notify(severity, detail, renewalContext);
    }
  } else if (changed) {
    logger.debug(
      `[vk-watch] ${severity} — ${detail} (renewal still recovering, not paging)`,
    );
  }
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
