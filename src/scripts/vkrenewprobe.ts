import "dotenv/config";
import fs from "fs";
import crypto from "crypto";
import { API } from "vk-io";

import { cookieJarPath, loadCookieJar } from "../lib/vkcookies";
import {
  parseWebTokenEnvelope,
  mergeSetCookies,
  WEB_CLIENT_APP_ID,
} from "../lib/vkrenew";

/**
 * Diagnostic probe for VK user-token renewal.
 *
 * The runtime renewer (src/lib/vkrenew.ts) replays `POST login.vk.ru/
 * ?act=web_token` — the exchange VK's own web client makes for an approved
 * Mini App. This probe runs the SAME route standalone: it never touches
 * db/vkuser.json, so it can be pointed at a freshly exported cookie jar to
 * answer "would automatic renewal succeed right now?" before anything is at
 * stake. It also still carries the older OAuth consent-chain strategies below,
 * kept because they are the best map of WHY when web_token refuses (jar stale,
 * security check, refused consent).
 *
 *   npm run vkrenewprobe            # verdict only, token never printed
 *   npm run vkrenewprobe -- --reveal  # also print the token, to install it
 *
 * Writes nothing to VK beyond the exchange itself: the validation call returns
 * an upload URL and creates no photo and no post.
 */

const REVEAL = process.argv.includes("--reveal");

const APP_ID = Number(process.env.VK_APP_ID ?? "") || 54703482;
const SCOPE = "photos,wall";
const API_VERSION = "5.199";
// vk.ru and vk.com are the same service, but session cookies are scoped to
// whichever domain you exported them from — send a .vk.com jar to login.vk.ru
// and it is simply not attached, which looks identical to being logged out.
// Chosen from the jar below when the export format carries domains.
let HOST = (process.env.VK_OAUTH_HOST ?? "").replace(/^https?:\/\//, "");

const parsedGroup = parseInt(process.env.VK_GROUP_ID ?? "");
if (!Number.isFinite(parsedGroup) || parsedGroup === 0) {
  console.error("VK_GROUP_ID is not set or not a number — nothing to validate against.");
  process.exit(1);
}
const GROUP_ID = Math.abs(parsedGroup);

const HELP = `Create the jar from a logged-in VK tab, saved at db/vkcookies.txt
(override with VK_COOKIE_FILE). Any ONE of these formats works:

  A. Cookie header (no extension needed)
     Chrome -> open vk.ru -> DevTools -> Network -> click any vk.ru request
     -> Request Headers -> right-click the \`Cookie:\` line -> Copy value
     -> paste the whole line into the file.

  B. Netscape cookies.txt
     What "Get cookies.txt", curl and yt-dlp produce. Tab-separated, often
     starting with "# Netscape HTTP Cookie File". Paste it in unchanged.

  C. JSON
     What Cookie-Editor and EditThisCookie produce: an array of
     {"name": ..., "value": ...} objects. Paste it in unchanged.

Export the WHOLE jar, not just remixsid: that cookie is HttpOnly (so
\`document.cookie\` cannot see it) and VK validates several together.`;

const fingerprint = (t: string): string =>
  crypto.createHash("sha256").update(t).digest("hex").slice(0, 12);

/** Load through the shared parser, so probe and runtime can never disagree. */
function loadJar() {
  const file = cookieJarPath();
  try {
    const parsed = loadCookieJar(file);
    if (parsed) return parsed;
  } catch (e) {
    console.error(`${file} could not be read: ${String(e)}\n\n${HELP}`);
    process.exit(1);
  }
  console.error(
    `${fs.existsSync(file) ? `${file}: recognised no cookies in it` : `No cookie jar at ${file}`}.` +
      `\n\n${HELP}`,
  );
  process.exit(1);
}

/**
 * Decode a VK page.
 *
 * These pages are windows-1251 and VK declares that NOWHERE — no charset in
 * Content-Type, no meta tag. `res.text()` assumes UTF-8 and returns mojibake,
 * which silently disables every Cyrillic pattern below and makes a consent
 * page or a security check read as a dead session: the exact distinction this
 * probe exists to draw. Valid UTF-8 never produces U+FFFD, so its presence is
 * a reliable tell to re-decode.
 */
async function readBody(res: Response): Promise<string> {
  const buf = Buffer.from(await res.arrayBuffer());
  const declared = /charset=["']?([\w-]+)/i.exec(
    (res.headers.get("content-type") ?? "") + buf.subarray(0, 2048).toString("latin1"),
  )?.[1];
  if (declared) {
    try {
      return new TextDecoder(declared).decode(buf);
    } catch {
      /* unknown label — fall through to sniffing */
    }
  }
  const utf8 = buf.toString("utf8");
  if (!utf8.includes("�")) return utf8;
  try {
    return new TextDecoder("windows-1251").decode(buf);
  } catch {
    return utf8;
  }
}

/**
 * Classify an HTML page VK serves instead of redirecting.
 *
 * Order and pattern choice are both load-bearing, and both were arrived at by
 * measuring the real pages rather than by reasoning:
 *
 *   • A bare /captcha/ matched EVERY login page, because VK's oauth form always
 *     carries a populated hidden `captcha_sid` whether or not a captcha is
 *     actually demanded. It reported SECURITY CHECK — a false positive on the
 *     one verdict that would abandon the whole approach. Only `captcha_img`,
 *     the visible challenge, means a captcha is really being asked for.
 *   • A real `<input type="password">` is the one dependable positive signal:
 *     present on the login form, absent from consent and security pages.
 *
 * The decoded <title> is reported alongside the verdict so a wrong guess stays
 * visible instead of authoritative.
 */
function classifyHtml(body: string): string {
  const title = /<title>([^<]*)<\/title>/i.exec(body)?.[1]?.trim() ?? "(no title)";
  const say = (verdict: string): string => `${verdict}\n           VK titled the page: "${title}"`;

  if (/(Разрешить|запрашивает доступ|запрашивает следующие|requests? access)/i.test(body))
    return say(
      "CONSENT PAGE — session is alive, the app just is not pre-authorised for " +
        "these scopes. Approve once in a browser; that grant is exactly what " +
        "lets act=web_token mint silently afterwards.",
    );
  if (/type=["']?password/i.test(body))
    return say(
      "LOGIN PAGE — VK did not accept the session and is asking for credentials. " +
        "The jar is stale, from a logged-out tab, or scoped to the other domain " +
        "(a .vk.com jar is never sent to login.vk.ru).",
    );
  if (/(Проверка безопасности|не робот|captcha_img|security check|Подтверждение входа)/i.test(body))
    return say(
      "SECURITY CHECK — VK wants re-validation, most likely because the request " +
        "arrived from a different IP than the one that minted the session. " +
        "Re-export the cookies from THIS network.",
    );
  return say("unrecognised page");
}

const UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

interface Outcome {
  token: string | null;
  /** Seconds the issuer expects this token to live; null when unreported. */
  expiresIn: number | null;
  errCode: string | null;
  sawGrantAccess: boolean;
  note: string;
}

const emptyOutcome = (): Outcome => ({
  token: null, expiresIn: null, errCode: null, sawGrantAccess: false, note: "",
});

/**
 * The production route, exercised standalone.
 *
 * Contract (captured from VK's own web client, see src/lib/vkrenew.ts):
 * POST form `version=1&app_id&access_token=<held token>` to
 * login.<site>/?act=web_token with Origin https://vk.ru and the session jar.
 * Measured gates: vk.com or an app origin answers "wrong origin"; GET without
 * a body answers "unauthorized".
 *
 * Both app ids are tried — OUR Mini App first, then the id VK's web client
 * uses for itself (what the original capture carried) — because which of them
 * this endpoint accepts per app is exactly the open question this probe
 * settles before the runtime ever depends on it.
 */
async function tryWebToken(jarIn: string, site: string): Promise<Outcome[]> {
  const outcomes: Outcome[] = [];
  let jar = jarIn;

  for (const appId of [APP_ID, WEB_CLIENT_APP_ID]) {
    const out = emptyOutcome();
    console.log(`      POST login.${site}/?act=web_token   app ${appId}`);

    try {
      const res = await fetch(`https://login.${site}/?act=web_token`, {
        method: "POST",
        headers: {
          cookie: jar,
          "content-type": "application/x-www-form-urlencoded;charset=UTF-8",
          origin: `https://${site}`,
          referer: `https://${site}/`,
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
          access_token: (await getHeldToken()) ?? "",
        }).toString(),
      });
      jar = mergeSetCookies(jar, res.headers.getSetCookie?.() ?? []);

      const text = await readBody(res);
      let parsed: unknown;
      try {
        parsed = JSON.parse(text);
      } catch {
        out.note = `non-JSON answer (${res.status}): ${text.replace(/\s+/g, " ").slice(0, 160)}`;
        outcomes.push(out);
        continue;
      }

      const grant = parseWebTokenEnvelope(parsed);
      if (grant) {
        out.token = grant.token;
        out.expiresIn = grant.secondsRemaining;
      } else {
        // Echo the envelope verbatim, minus credentials: undocumented errors
        // are the only documentation this endpoint has.
        out.note = JSON.stringify(parsed)
          .replace(/"access_token":"[^"]*"/g, '"access_token":"<redacted>"')
          .replace(/"logout_hash":"[^"]*"/g, '"logout_hash":"<redacted>"')
          .slice(0, 240);
      }
    } catch (e) {
      out.note = String(e).slice(0, 160);
    }
    outcomes.push(out);

    // First success wins; no point asking again under the other app id.
    if (out.token) break;
  }
  return outcomes;
}

/**
 * The token the runtime currently holds — the value the exchange consumes.
 *
 * Read straight from the sources rather than importing @/lib/vkuser: the probe
 * must be able to run against a DIFFERENT jar than production without dragging
 * in the store's precedence rules, and must never write anything it loads.
 */
async function getHeldToken(): Promise<string | null> {
  try {
    const stored = JSON.parse(fs.readFileSync("./db/vkuser.json", "utf8"));
    if (typeof stored?.token === "string" && stored.token) return stored.token;
  } catch {
    /* fall through to env */
  }
  const env = (process.env.VK_USER_TOKEN ?? "").trim();
  return env || null;
}

/**
 * One way of asking the legacy OAuth chain for a token — kept as DIAGNOSTICS.
 *
 * A browser completes this flow in a single click, so each strategy adds one
 * candidate property a CSRF-style check might want. None survived measurement
 * (every one was refused at grant_access), but walking them still separates a
 * dead jar (never reaches grant_access) from a refusal (reaches it), which is
 * the distinction that decides whether re-exporting cookies can help.
 */
interface Strategy {
  label: string;
  why: string;
  browserHeaders?: boolean;
  sendHttoken?: boolean;
  extraParams?: Record<string, string>;
}

const STRATEGIES: Strategy[] = [
  { label: "plain", why: "baseline, so any change is attributable" },
  {
    label: "+ browser navigation headers",
    why: "Referer/Sec-Fetch-*: a cross-site GET carrying cookies but no Referer " +
      "is the classic shape of a request a CSRF check rejects",
    browserHeaders: true,
  },
  {
    label: "+ httoken echoed as a param",
    why: "VK sets an httoken cookie; double-submit CSRF wants it repeated in " +
      "the request",
    browserHeaders: true,
    sendHttoken: true,
  },
  {
    label: "+ display=page",
    why: "the parameter the working browser approval carried",
    browserHeaders: true,
    sendHttoken: true,
    extraParams: { display: "page" },
  },
];

async function walk(strategy: Strategy, jarIn: string, verbose: boolean): Promise<Outcome> {
  let jar = jarIn;
  const httoken = /(?:^|;\s*)httoken=([^;]+)/.exec(jarIn)?.[1] ?? "";
  // Built by hand, NOT with URLSearchParams: that percent-encodes the comma to
  // `scope=photos%2Cwall`, and the literal-comma form is the one observed to
  // reach grant_access. Not worth risking VK's parser on a cosmetic change.
  const extra = Object.entries(strategy.extraParams ?? {})
    .map(([k, v]) => `&${k}=${v}`)
    .join("");
  let url =
    `https://${HOST}/authorize?client_id=${APP_ID}&scope=${SCOPE}` +
    `&redirect_uri=https://${HOST}/blank.html&response_type=token` +
    `&v=${API_VERSION}${extra}`;
  let referer = `https://${HOST}/`;
  const out = emptyOutcome();

  for (let hop = 1; hop <= 8; hop++) {
    let target = url;
    if (strategy.sendHttoken && httoken && /act=grant_access/.test(target) &&
        !/[?&]httoken=/.test(target)) {
      target += `&httoken=${encodeURIComponent(httoken)}`;
    }

    const headers: Record<string, string> = {
      cookie: jar,
      "user-agent": UA,
      accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      "accept-language": "ru-RU,ru;q=0.9,en;q=0.8",
    };
    if (strategy.browserHeaders) {
      headers.referer = referer;
      headers["sec-fetch-dest"] = "document";
      headers["sec-fetch-mode"] = "navigate";
      headers["sec-fetch-site"] = new URL(target).host === new URL(referer).host
        ? "same-origin" : "cross-site";
      headers["sec-fetch-user"] = "?1";
      headers["upgrade-insecure-requests"] = "1";
    }

    const res: Response = await fetch(target, { redirect: "manual", headers });
    jar = mergeSetCookies(jar, res.headers.getSetCookie?.() ?? []);
    const location = res.headers.get("location");
    const here = new URL(target);
    console.log(`      [${hop}] ${res.status} ${here.host}${here.pathname}`);

    if (location) {
      const shown = location.replace(/access_token=[^&]+/, "access_token=<redacted>");
      console.log(`          → ${verbose ? shown : shown.slice(0, 150)}`);
      const frag = location.split("#")[1];
      if (frag) {
        const q = new URLSearchParams(frag);
        const t = q.get("access_token");
        if (t) {
          out.token = t;
          out.expiresIn = Number(q.get("expires_in") ?? "0") || null;
          return out;
        }
        if (q.get("error")) {
          out.note = `${q.get("error")}: ${q.get("error_description") ?? ""}`;
          return out;
        }
      }
      if (/act=grant_access/.test(location)) out.sawGrantAccess = true;
      const err = /[?&]err=(\d+)/.exec(location);
      if (err) out.errCode = err[1];
      referer = target;
      url = new URL(location, target).toString();
      continue;
    }

    const body = await readBody(res);
    if (res.headers.get("content-type")?.includes("json")) {
      out.note = body.slice(0, 200);
      return out;
    }
    if (/\/blank\.html/.test(target)) {
      out.note = "landed on blank.html with no token";
      return out;
    }
    out.note = classifyHtml(body);
    return out;
  }
  out.note = "redirect limit reached";
  return out;
}

async function main(): Promise<void> {
  const verbose = process.argv.includes("--verbose");
  const parsed = loadJar();
  const names = parsed.names;

  if (!HOST) {
    const com = parsed.domains.some((d) => d.endsWith("vk.com"));
    const ru = parsed.domains.some((d) => d.endsWith("vk.ru"));
    HOST = com && !ru ? "oauth.vk.com" : "oauth.vk.ru";
  }

  console.log(`VK token renewal probe — app ${APP_ID} (+${WEB_CLIENT_APP_ID} fallback), scope "${SCOPE}"\n`);
  console.log(`cookies: ${names.length} loaded from ${cookieJarPath()}  (${parsed.format})`);
  console.log(`         ${names.join(", ")}`);
  // Which cookies are present is the first thing to check when two endpoints
  // disagree about the same jar, so keep listing them.
  for (const [name, role] of [
    ["remixsid", "the session itself"],
    ["httoken", "VK's anti-CSRF token for login.vk.* actions"],
  ] as const) {
    if (!names.some((n) => n === name || n.startsWith(name))) {
      console.log(`         MISSING ${name} — ${role}`);
    }
  }
  console.log();

  const site = HOST.replace(/^oauth\./, "");
  const held = await getHeldToken();
  if (!held) {
    console.error(
      "No held token found (db/vkuser.json empty/unreadable, VK_USER_TOKEN unset)\n" +
        "— the web_token exchange consumes the CURRENT token, so there is\n" +
        "nothing to renew. Mint one in the Mini App first.",
    );
    process.exit(1);
  }

  console.log("── web_token (the production renewal route)");
  console.log("   POST form version/app_id/access_token; no consent step involved");
  const attempts = await tryWebToken(parsed.header, site);
  let sawUnauthorized = false;
  for (let i = 0; i < attempts.length; i++) {
    const out = attempts[i];
    const appId = [APP_ID, WEB_CLIENT_APP_ID][Math.min(i, 1)];
    if (out.token) {
      await report(`web_token (app ${appId})`, out);
      return;
    }
    console.log(`      no token — ${out.note}\n`);
    if (/unauthorized/i.test(out.note)) sawUnauthorized = true;
  }
  if (sawUnauthorized) {
    console.log(
      '   NOTE: "unauthorized" here is about the JAR, not the endpoint. The\n' +
        "   origin check passed and VK simply does not recognise this session,\n" +
        "   so re-export the cookies — everything below fails the same way.\n",
    );
  }

  let winner: { strategy: Strategy; outcome: Outcome } | null = null;
  let anyGrantAccess = false;
  for (const strategy of STRATEGIES) {
    console.log(`── legacy chain: ${strategy.label} (diagnostics)`);
    console.log(`   ${strategy.why}`);
    const outcome = await walk(strategy, parsed.header, verbose);
    if (outcome.sawGrantAccess) anyGrantAccess = true;
    if (outcome.token) {
      console.log("      TOKEN ISSUED\n");
      winner = { strategy, outcome };
      break;
    }
    console.log(
      `      no token${outcome.errCode ? ` — err=${outcome.errCode}` : ""}` +
        `${outcome.note ? ` — ${outcome.note.split("\n")[0]}` : ""}\n`,
    );
  }

  if (!winner) {
    // Which failure this is decides where to look next, so do not describe one
    // as the other — the login case is a jar problem and the grant_access case
    // is not.
    if (anyGrantAccess) {
      console.log("VERDICT: session accepted, but every strategy was refused at grant_access.");
      console.log(
        "\nThe legacy chain remains closed to scripts — expected; web_token above\n" +
          "is the production route. Re-run with `-- --verbose` to print the\n" +
          "grant_access URLs in full if you are mapping what changed.",
      );
    } else {
      console.log("VERDICT: the flow never reached grant_access.");
      console.log(
        "\nVK asked for credentials instead of identifying the session, so the\n" +
          "jar is the problem — stale, exported from a logged-out tab, or scoped\n" +
          "to the other domain. Re-export and try again.",
      );
    }
    process.exit(2);
  }

  await report(winner.strategy.label, winner.outcome);
}

/** Shared success path, so every route reports identically. */
async function report(routeLabel: string, outcome: Outcome): Promise<void> {
  const token = outcome.token as string;
  const expiresIn = outcome.expiresIn;
  console.log(`VERDICT: unattended renewal works — via "${routeLabel}".`);
  console.log(`    fingerprint: ${fingerprint(token)}  (length ${token.length})`);
  if (expiresIn !== null) {
    const eta = new Date(Date.now() + expiresIn * 1000).toISOString();
    console.log(`    lifetime:    ${expiresIn} s = ${(expiresIn / 3600).toFixed(1)} h (until ~${eta})`);
  } else {
    console.log("    lifetime:    not reported");
  }

  process.stdout.write("\n    validating against photos.getWallUploadServer … ");
  try {
    const api = new API({ token });
    const res = (await api.photos.getWallUploadServer({
      group_id: GROUP_ID,
    })) as unknown as { upload_url?: string };
    console.log(res?.upload_url ? "OK — upload route reachable" : `no upload_url: ${JSON.stringify(res)}`);
  } catch (e) {
    const err = e as { code?: number; message?: string };
    console.log(`FAILED — Code ${err?.code ?? "?"}: ${err?.message ?? String(e)}`);
    console.log("\nRenewal works but the token cannot upload — a scope or IP problem,");
    console.log("not a session problem. Different fix.");
    process.exit(1);
  }

  console.log(
    "\nThe runtime performs this exact exchange by itself from db/vkcookies.txt;",
    "\nthis run installed nothing.",
  );
  if (REVEAL) console.log(`\naccess_token (treat as a password):\n${token}`);
  else console.log("\nRe-run with `-- --reveal` to print the token.");
}

main().catch((e) => {
  console.error(`probe crashed: ${String(e)}`);
  process.exit(1);
});
