import crypto from "crypto";
import { API } from "vk-io";

import logger from "@/lib/logger";
import { getVkUserAccessToken, saveVkUserToken } from "@/lib/vkuser";
import { loadCookieJar } from "@/lib/vkcookies";

/**
 * Unattended renewal of the VK user token.
 *
 * This replays the request VK's own clients make when they need a fresh Mini
 * App token, captured twice from real logged-in sessions (DevTools, 2026-08):
 *
 *   POST https://login.vk.ru/?act=web_token
 *   Content-Type: application/x-www-form-urlencoded
 *   Cookie: <the whole vk.ru session jar>
 *   Origin/Referer: https://vk.ru/  ·  Sec-Fetch-Mode: cors
 *   body: version=1&app_id=<id>            ← the desktop web client: NO token
 *         version=1&app_id=<id>&access_token=<held token>   ← the other capture
 *   → {"type":"okay","data":{"access_token":"vk1.a.…",
 *        "expires":<unix seconds>,"user_id":…,"logout_hash":"…"}}
 *
 * The decisive property: authentication is the COOKIE JAR, not the body. The
 * working capture carried no access_token at all — the session cookies (most
 * tellingly `p`, itself a vk1.a token, alongside remixsid and httoken) are
 * what authorizes the mint. Both body shapes are therefore tried; a partial
 * jar that lacks the session-token cookies is refused with
 * {"error_info":"unauthorized"}, which no body shape can talk around.
 *
 * Fallback: a COMPLETE jar contains usable API tokens outright — `p` is one,
 * and `sua` embeds another between ^ separators. Those are harvested and put
 * through the same validation gate, so a jar good enough to log in with can
 * often restore service even when the exchange endpoint refuses.
 *
 * Two things are genuinely unknown and both are handled rather than assumed:
 *   • Whether OUR app id works in the body. The captures carried 6287487 —
 *     VK's own client id. Candidates are tried in order (ours first, then
 *     theirs), and every minted token must pass photos.getWallUploadServer
 *     before it is allowed near the store, so a wrong-scope token is
 *     discarded. Fail closed: keep the old token, post text-only.
 *   • What `expires` MEANS. The one sample parsed as absolute unix seconds —
 *     yet landed ~44 min BEFORE the response's own Date header, so trusting a
 *     non-positive remainder would store a born-dead stamp and alarm forever.
 *     A remainder that does not come out positive is recorded as UNKNOWN, and
 *     age-based watching takes over.
 *
 * The token is password-grade and the cookie jar IS the account: neither is
 * ever logged, not even truncated — failures quote only VK's redacted error
 * text, and successes identify tokens by SHA-256 fingerprint alone.
 */

/** Where the exchange lives; measured against login.vk.ru. */
const ENDPOINT = "https://login.vk.ru/?act=web_token";
const ORIGIN = "https://vk.ru";

/**
 * The app id VK's web client uses for itself — what both captures carried. A
 * fallback candidate when our own app id is refused.
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
  /**
   * Seconds until VK says this token dies; null when unreported OR when the
   * arithmetic lands non-positive — see the header comment on `expires`.
   */
  secondsRemaining: number | null;
}

/**
 * Interpret an undocumented expiry figure.
 *
 * Absolute-vs-relative disambiguation by magnitude: a relative lifetime would
 * read as a 1970 date, so anything plausibly a timestamp (> 1e9) is absolute.
 * A non-positive result is NOT clamped to zero and returned — it means the
 * field meant something other than "dies at", and recording it would have the
 * watchdog declare a freshly validated token expired. Unknown beats wrong.
 */
function secondsRemaining(rawExpiry: number | undefined): number | null {
  if (rawExpiry === undefined || !Number.isFinite(rawExpiry)) return null;
  const left =
    rawExpiry > 1_000_000_000
      ? Math.round(rawExpiry - Date.now() / 1000)
      : Math.round(rawExpiry);
  return left > 0 ? left : null;
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

/**
 * Tokens sitting in plain sight inside the session jar — see harvestJarTokens
 * for which cookies qualify.
 *
 * `remixsid` is the classic session itself; a jar without it reads as
 * logged-out. The carriers are where sessions keep their API token: older
 * ones used `p`/`sua`, newer exports stash it in `remixnsid`/`remixnttpid`.
 */
export const JAR_HARD_REQUIREMENTS = ["remixsid"];
export const JAR_TOKEN_CARRIERS = ["p", "sua", "remixnsid", "remixnttpid"];

/**
 * Tokens sitting in plain sight inside the session jar.
 *
 * The working capture's cookies include `p=vk1.a.…` — the web session's own
 * API token — and `sua=<hash>#<uid>^vk1.a.…^<timestamp>`, another one. Newer
 * sessions keep theirs elsewhere: a fresh Chrome export (2026-08) stashed
 * ready vk1.a tokens in `remixnsid` and `remixnttpid` instead. All four are
 * scanned. Only well-formed vk1.a tokens are taken; everything else in those
 * cookies is opaque session state.
 */
export function harvestJarTokens(jarHeader: string): string[] {
  const found = new Set<string>();
  for (const pair of jarHeader.split(";")) {
    const eq = pair.indexOf("=");
    if (eq <= 0) continue;
    const name = pair.slice(0, eq).trim();
    if (!JAR_TOKEN_CARRIERS.includes(name)) continue;
    let value = pair.slice(eq + 1).trim();
    try {
      value = decodeURIComponent(value);
    } catch {
      /* malformed escape — scan it as-is */
    }
    for (const piece of value.split(/[\^#]/)) {
      const candidate = piece.trim();
      if (/^vk1\.a\.[A-Za-z0-9._-]{20,}$/.test(candidate)) found.add(candidate);
    }
  }
  return [...found];
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

/**
 * One wire round-trip against the exchange. Exported so the operator tool
 * (`vkrenewprobe`) replays attempts one by one and reports each, without
 * keeping a second copy of the request shape.
 */
export async function postWebToken(
  appId: number,
  bodyToken: string | null,
  jarHeader: string,
): Promise<{ attempt: Attempt; jarHeader: string }> {
  // Form encoding via URLSearchParams is safe here where it was NOT for the
  // oauth scope param: this body carries no commas and vk1.a tokens survive
  // percent-encoding unchanged.
  const fields: Record<string, string> = { version: "1", app_id: String(appId) };
  if (bodyToken) fields.access_token = bodyToken;

  const res = await fetch(ENDPOINT, {
    method: "POST",
    redirect: "manual",
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    headers: {
      cookie: jarHeader,
      // Exactly the captured value — the charset suffix the earlier draft sent
      // is not something the working request carried, and fidelity is free.
      "content-type": "application/x-www-form-urlencoded",
      origin: ORIGIN,
      referer: `${ORIGIN}/`,
      accept: "application/json, text/plain, */*",
      "accept-language": "ru-RU,ru;q=0.9,en;q=0.8",
      "sec-fetch-dest": "empty",
      "sec-fetch-mode": "cors",
      "sec-fetch-site": "same-site",
      "user-agent": UA,
    },
    body: new URLSearchParams(fields).toString(),
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
 * Prove a candidate token can do the ONE job the user token exists for before
 * it replaces anything. `photos.getWallUploadServer` needs exactly the rights
 * the token is held for (`photos` + `wall`), creates nothing, and fails with
 * Code 5 / 15 / 27 for every way a token can be wrong for us.
 */
/** Exported for the operator tool, which reports on the same gate. */
export async function uploadRouteWorks(
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
  /** ok | no-jar | http | bad-envelope | validation */
  reason: string;
  /** Human detail, credential-free by construction (see redactForLogs). */
  detail: string;
  expiresInHours: number | null;
  /** How the installed token was obtained — e.g. "web_token app 54703482". */
  via: string | null;
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

async function install(
  token: string,
  secondsLeft: number | null,
  via: string,
): Promise<VkRenewResult> {
  const hours = secondsLeft !== null ? secondsLeft / 3600 : null;
  saveVkUserToken(token, secondsLeft, "renewal");
  logger.info(
    `[vk-renew] token renewed via ${via} (fingerprint ${fingerprint(token)}, valid ` +
      `${hours !== null ? `${hours.toFixed(1)} h` : "for an unknown time"})`,
  );
  return { ok: true, reason: "ok", detail: `renewed via ${via}`, expiresInHours: hours, via };
}

async function runRenewal(): Promise<VkRenewResult> {
  const none: VkRenewResult = {
    ok: false,
    reason: "",
    detail: "",
    expiresInHours: null,
    via: null,
  };

  // Optional now: the primary body shape authenticates by cookies alone. When
  // present it feeds only the secondary variant.
  const current = await getVkUserAccessToken();

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

  // remixsid IS the classic session; its absence predicts a LOGIN page. And a
  // jar with no token-carrier cookie gets "unauthorized" from web_token and
  // has nothing to harvest either, so say so up front rather than leaving the
  // operator to guess why a logged-in-looking export is refused.
  const missingHard = JAR_HARD_REQUIREMENTS.filter(
    (need) => !jar.names.some((n) => n.startsWith(need)),
  );
  const carriers = JAR_TOKEN_CARRIERS.filter((c) => jar.names.includes(c));
  let jarNote = "";
  if (missingHard.length || carriers.length === 0) {
    const bits: string[] = [];
    if (missingHard.length) bits.push(`jar lacks ${missingHard.join(", ")}`);
    if (carriers.length === 0)
      bits.push(`no token-carrier cookie (${JAR_TOKEN_CARRIERS.join("/")})`);
    jarNote = `; ${bits.join("; ")} — re-export the COMPLETE jar (HttpOnly included)`;
  }

  let failure: Pick<VkRenewResult, "reason" | "detail"> = {
    reason: "unknown",
    detail: "no candidate attempted",
  };

  // Ours first: a token minted under OUR app is the one we know carries the
  // right grants. The web client's app id exists because the captures proved
  // the route accepts it, and validation below polices whatever scopes come
  // back. Per app id, the cookie-only body goes first — it is the shape the
  // proven-working desktop client sends.
  const candidates = [...new Set([configuredAppId(), WEB_CLIENT_APP_ID])];
  let jarHeader = jar.header;

  for (const appId of candidates) {
    for (const bodyToken of [null, current]) {
      let result: { attempt: Attempt; jarHeader: string };
      try {
        result = await postWebToken(appId, bodyToken, jarHeader);
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
        failure = {
          reason: attempt.reason,
          detail: `${attempt.detail} (app ${appId}${bodyToken ? ", token-in-body" : ""})`,
        };
        continue;
      }

      const verdict = await uploadRouteWorks(attempt.grant.token);
      if (!verdict.ok) {
        failure = { reason: "validation", detail: `${verdict.detail} (app ${appId})` };
        continue;
      }

      return await install(
        attempt.grant.token,
        attempt.grant.secondsRemaining,
        `web_token app ${appId}`,
      );
    }
  }

  // Last resort before giving up: the jar itself may carry a usable token.
  for (const candidate of harvestJarTokens(jarHeader)) {
    const verdict = await uploadRouteWorks(candidate);
    if (!verdict.ok) {
      failure = {
        reason: "validation",
        detail: `harvested jar token rejected — ${verdict.detail}`,
      };
      continue;
    }
    // No expiry is published for these; the store records it as unknown and
    // the watchdog falls back to age.
    return await install(candidate, null, "harvested from jar");
  }

  logger.warn(`[vk-renew] renewal failed — ${failure.reason}: ${failure.detail}${jarNote}`);
  return { ...none, ...failure };
}
