import crypto from "crypto";
import { API } from "vk-io";

import logger from "@/lib/logger";
import { getVkUserAccessToken, saveVkUserToken } from "@/lib/vkuser";
import { loadCookieJar } from "@/lib/vkcookies";

/**
 * Unattended renewal of the VK user token.
 *
 * This replays the request VK's own web client makes when it needs a fresh
 * Mini App token, captured from a real logged-in session (DevTools, 2026-08):
 *
 *   POST https://login.vk.ru/?act=web_token
 *   Content-Type: application/x-www-form-urlencoded
 *   Cookie: <the whole vk.ru session jar>
 *   Origin/Referer: https://vk.ru/  ·  Sec-Fetch-Mode: cors
 *   body: version=1&app_id=<id>&access_token=<the token currently held>
 *   → {"type":"okay","data":{"access_token":"vk1.a.…",
 *        "expires":<ABSOLUTE unix seconds>,"user_id":…,"logout_hash":"…"}}
 *
 * Three properties make this work unattended where the legacy OAuth consent
 * chain refused everything (that history lives in src/scripts/vkrenewprobe.ts):
 *   • it authenticates with the browser SESSION (the cookie jar), not with an
 *     interactive consent step, so there is no grant_access for VK to refuse
 *     to a script;
 *   • it answers JSON — nothing has to be scraped out of windows-1251 HTML;
 *   • it EXCHANGES the token already held, needing no password and no fresh
 *     approval, provided the `photos,wall` grant exists — which it does for
 *     the approved Mini App.
 *
 * Two things are genuinely unknown and both are handled rather than assumed:
 *   • Whether OUR app id works in the body. The capture carried 6287487 — VK's
 *     own web client. Candidates are tried in order (ours first, then theirs),
 *     and every minted token must pass photos.getWallUploadServer before it is
 *     allowed near the store, so a token minted under the wrong app fails that
 *     check and is discarded. Fail closed: keep the old token, post text-only.
 *   • Whether the endpoint accepts an ALREADY-EXPIRED token. The capture ran
 *     with a live one in the body. Renewal therefore runs proactively while
 *     the old token still works (vktokenwatch renews from ≤18 h remaining), so
 *     the question never has to be answered in production.
 *
 * The token is password-grade and the cookie jar IS the account: neither is
 * ever logged, not even truncated — failures quote only VK's redacted error
 * text, and successes identify tokens by SHA-256 fingerprint alone.
 */

/** Where the exchange lives; measured against login.vk.ru. */
const ENDPOINT = "https://login.vk.ru/?act=web_token";
const ORIGIN = "https://vk.ru";

/**
 * The app id VK's web client uses for itself — what the original capture
 * carried. A fallback candidate when our own app id is refused.
 */
export const WEB_CLIENT_APP_ID = 6287487;

/** Our Mini App, overridable for testing another one without a code change. */
function configuredAppId(): number {
  return Number(process.env.VK_APP_ID ?? "") || 54703482;
}

const REQUEST_TIMEOUT_MS = 15_000;

const UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

function fingerprint(token: string): string {
  return crypto.createHash("sha256").update(token).digest("hex").slice(0, 12);
}

/** Positive community id, as VK's photo methods spell it — or null. */
function wallGroupId(): number | null {
  const raw = parseInt(process.env.VK_GROUP_ID ?? "");
  return Number.isFinite(raw) && raw !== 0 ? Math.abs(raw) : null;
}

export interface WebTokenGrant {
  token: string;
  /** Seconds until VK says this token dies; null when unreported. */
  secondsRemaining: number | null;
}

/**
 * `expires` semantics are undocumented; the one captured sample was absolute
 * unix seconds. A relative lifetime would read as a date in early 1970, so
 * magnitude disambiguates: anything plausibly a timestamp (> 1e9, i.e. after
 * 2001) is absolute, anything smaller is seconds-left.
 */
function secondsRemaining(rawExpiry: number | undefined): number | null {
  if (rawExpiry === undefined || !Number.isFinite(rawExpiry)) return null;
  return rawExpiry > 1_000_000_000
    ? Math.max(0, Math.round(rawExpiry - Date.now() / 1000))
    : Math.max(0, Math.round(rawExpiry));
}

/**
 * Pull the grant out of a response of undocumented shape.
 *
 * The success envelope was `{"type":"okay","data":{…}}` once; searching for
 * the keys beats hardcoding a path that may move. Exported because
 * `vkrenewprobe` reports on the same wire format and must agree about what
 * `expires` means.
 */
export function parseWebTokenEnvelope(payload: unknown): WebTokenGrant | null {
  let token: string | undefined;
  let expiry: number | undefined;
  const visit = (value: unknown): void => {
    if (!value || typeof value !== "object") return;
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      if (token === undefined && key === "access_token" && typeof child === "string") {
        token = child;
      } else if (
        expiry === undefined &&
        (key === "expires" || key === "expires_in") &&
        typeof child === "number"
      ) {
        expiry = child;
      } else {
        visit(child);
      }
    }
  };
  visit(payload);
  return token ? { token, secondsRemaining: secondsRemaining(expiry) } : null;
}

const REDACTIONS: [RegExp, string][] = [
  [/"access_token"\s*:\s*"[^"]*"/g, '"access_token":"<redacted>"'],
  // Bare tokens can appear outside their JSON key in odd envelopes.
  [/vk1\.a\.[A-Za-z0-9._-]+/g, "<redacted-token>"],
  [/"logout_hash"\s*:\s*"[^"]*"/g, '"logout_hash":"<redacted>"'],
];

/**
 * Make VK's answer safe to log or alert on.
 *
 * Error strings from an undocumented endpoint are its only documentation, but
 * they travel alongside credential material. Redact first, quote second.
 */
export function redactForLogs(text: string): string {
  return REDACTIONS.reduce((acc, [re, to]) => acc.replace(re, to), text);
}

/**
 * Fold Set-Cookie answers into the jar header, keeping a redirect chain or a
 * second attempt authenticated. Rotated values replace; deletions remove.
 */
export function mergeSetCookies(header: string, setCookies: string[]): string {
  const map = new Map<string, string>();
  for (const pair of header.split(";")) {
    const [k, ...v] = pair.trim().split("=");
    if (k) map.set(k, v.join("="));
  }
  for (const sc of setCookies) {
    const [pair] = sc.split(";");
    const [k, ...v] = pair.trim().split("=");
    if (!k) continue;
    const value = v.join("=");
    if (value === "DELETED" || /expires=Thu, 01 Jan 1970/i.test(sc)) map.delete(k);
    else map.set(k, value);
  }
  return [...map].map(([k, v]) => `${k}=${v}`).join("; ");
}

type Attempt =
  | { kind: "minted"; grant: WebTokenGrant }
  | { kind: "refused"; reason: "http" | "bad-envelope"; detail: string };

async function postWebToken(
  appId: number,
  currentToken: string,
  jarHeader: string,
): Promise<{ attempt: Attempt; jarHeader: string }> {
  // Form encoding via URLSearchParams is safe here where it was NOT for the
  // oauth scope param: this body carries no commas and vk1.a tokens survive
  // percent-encoding unchanged.
  const res = await fetch(ENDPOINT, {
    method: "POST",
    redirect: "manual",
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    headers: {
      cookie: jarHeader,
      "content-type": "application/x-www-form-urlencoded;charset=UTF-8",
      origin: ORIGIN,
      referer: `${ORIGIN}/`,
      accept: "application/json, text/plain, */*",
      "accept-language": "ru-RU,ru;q=0.9,en;q=0.8",
      "sec-fetch-dest": "empty",
      "sec-fetch-mode": "cors",
      "sec-fetch-site": "same-site",
      "user-agent": UA,
    },
    body: new URLSearchParams({
      version: "1",
      app_id: String(appId),
      access_token: currentToken,
    }).toString(),
  });

  const nextJar = mergeSetCookies(jarHeader, res.headers.getSetCookie?.() ?? []);
  const text = await res.text();

  if (res.status !== 200) {
    return {
      attempt: {
        kind: "refused",
        reason: "http",
        detail: `HTTP ${res.status}: ${redactForLogs(text).replace(/\s+/g, " ").slice(0, 160)}`,
      },
      jarHeader: nextJar,
    };
  }

  let payload: unknown;
  try {
    payload = JSON.parse(text);
  } catch {
    return {
      attempt: {
        kind: "refused",
        reason: "bad-envelope",
        detail: `non-JSON answer: ${redactForLogs(text).replace(/\s+/g, " ").slice(0, 160)}`,
      },
      jarHeader: nextJar,
    };
  }

  const grant = parseWebTokenEnvelope(payload);
  if (!grant) {
    // The envelope verbatim, minus credentials — undocumented errors are all
    // the documentation this endpoint has.
    const shown = redactForLogs(JSON.stringify(payload) ?? "").slice(0, 240);
    return {
      attempt: { kind: "refused", reason: "bad-envelope", detail: `envelope ${shown}` },
      jarHeader: nextJar,
    };
  }

  return { attempt: { kind: "minted", grant }, jarHeader: nextJar };
}

/**
 * Prove a minted token can do the ONE job the user token exists for before it
 * replaces anything. `photos.getWallUploadServer` needs exactly the rights the
 * token is held for (`photos` + `wall`), creates nothing, and fails with Code 5
 * / 15 / 27 for every way a token can be wrong for us.
 */
async function uploadRouteWorks(
  token: string,
): Promise<{ ok: boolean; detail: string }> {
  const groupId = wallGroupId();
  if (!groupId) {
    return {
      ok: false,
      detail: "VK_GROUP_ID unset — refusing to swap in an unvalidated token",
    };
  }
  try {
    const api = new API({ token });
    const res = (await api.photos.getWallUploadServer({
      group_id: groupId,
    })) as unknown as { upload_url?: string };
    return res?.upload_url
      ? { ok: true, detail: "upload route reachable" }
      : { ok: false, detail: "answer carried no upload_url" };
  } catch (error) {
    const err = error as { code?: number; message?: string };
    return {
      ok: false,
      detail: `Code ${err?.code ?? "?"}: ${(err?.message ?? String(error)).slice(0, 120)}`,
    };
  }
}

export interface VkRenewResult {
  ok: boolean;
  /** ok | no-token | no-jar | http | bad-envelope | validation */
  reason: string;
  /** Human detail, credential-free by construction (see redactForLogs). */
  detail: string;
  expiresInHours: number | null;
  appId: number | null;
}

let inflight: Promise<VkRenewResult> | null = null;

/**
 * One renewal attempt: exchange the held token for a fresh one and, only after
 * validation, install it. Never throws — every outcome is a VkRenewResult, so
 * the watchdog can fold failures straight into its alerting.
 */
export function renewVkUserToken(): Promise<VkRenewResult> {
  // Deduplicate overlapping ticks rather than racing two exchanges.
  if (inflight) return inflight;
  inflight = runRenewal().finally(() => {
    inflight = null;
  });
  return inflight;
}

async function runRenewal(): Promise<VkRenewResult> {
  const none: VkRenewResult = {
    ok: false,
    reason: "",
    detail: "",
    expiresInHours: null,
    appId: null,
  };

  const current = await getVkUserAccessToken();
  if (!current) {
    return { ...none, reason: "no-token", detail: "no user token configured to exchange" };
  }

  const jar = loadCookieJar();
  if (!jar) {
    return {
      ...none,
      reason: "no-jar",
      detail:
        "no usable cookie jar — export the cookies of a logged-in vk.ru tab " +
        "(any of: Cookie header, Netscape cookies.txt, Cookie-Editor JSON)",
    };
  }

  // remixsid IS the session; its absence predicts a LOGIN page, not renewal.
  const jarNote = jar.names.some((n) => n.startsWith("remixsid"))
    ? ""
    : "; jar lacks remixsid — likely a partial export";

  let failure: Pick<VkRenewResult, "reason" | "detail"> = {
    reason: "unknown",
    detail: "no candidate attempted",
  };

  // Ours first: a token minted under OUR app is the one we know carries the
  // right grants. The web client's app id exists because the capture proved
  // the route accepts it, and validation below polices whatever scopes come back.
  const candidates = [...new Set([configuredAppId(), WEB_CLIENT_APP_ID])];
  let jarHeader = jar.header;

  for (const appId of candidates) {
    let result: { attempt: Attempt; jarHeader: string };
    try {
      result = await postWebToken(appId, current, jarHeader);
    } catch (error) {
      const timedOut = error instanceof Error && error.name === "TimeoutError";
      failure = {
        reason: "http",
        detail: timedOut
          ? `timed out after ${REQUEST_TIMEOUT_MS} ms`
          : String(error).slice(0, 160),
      };
      continue;
    }
    jarHeader = result.jarHeader;

    const attempt = result.attempt;
    if (attempt.kind !== "minted") {
      failure = { reason: attempt.reason, detail: `${attempt.detail} (app ${appId})` };
      continue;
    }

    const verdict = await uploadRouteWorks(attempt.grant.token);
    if (!verdict.ok) {
      failure = {
        reason: "validation",
        detail: `${verdict.detail} (app ${appId})`,
      };
      continue;
    }

    const hours =
      attempt.grant.secondsRemaining !== null
        ? attempt.grant.secondsRemaining / 3600
        : null;
    saveVkUserToken(attempt.grant.token, attempt.grant.secondsRemaining, "renewal");
    logger.info(
      `[vk-renew] token renewed via act=web_token (app ${appId}, fingerprint ` +
        `${fingerprint(attempt.grant.token)}, valid ` +
        `${hours !== null ? `${hours.toFixed(1)} h` : "for an unknown time"})`,
    );
    return {
      ok: true,
      reason: "ok",
      detail: `renewed via app ${appId}`,
      expiresInHours: hours,
      appId,
    };
  }

  logger.warn(`[vk-renew] renewal failed — ${failure.reason}: ${failure.detail}${jarNote}`);
  return { ...none, ...failure };
}
