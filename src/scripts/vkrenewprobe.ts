import "dotenv/config";
import fs from "fs";
import path from "path";
import crypto from "crypto";
import { API } from "vk-io";

/**
 * THROWAWAY VALIDATION PROBE — not part of the runtime.
 *
 * Answers one question before any renewal engine gets written: will VK hand
 * this host a fresh user token when presented with an exported browser
 * session, or will it demand re-validation because the request arrives from
 * porter's IP instead of the laptop the cookies were minted on?
 *
 * Background. VK Mini App / implicit-flow user tokens last ~24 h and there is
 * no refresh token. The `offline` scope, which used to make them permanent,
 * has been removed: oauth.vk.ru answers
 *   401 {"error":"invalid_request","error_description":"invalid scope"}
 * for `offline` in any combination, while accepting a nonsense scope with 200.
 * So the only unattended route left is to replay the legacy implicit flow with
 * a logged-in session, which is what this measures.
 *
 * Writes nothing to VK. The authorize call issues a token (that is the point);
 * the validation call returns an upload URL and creates no photo and no post.
 *
 *   npm run vkrenewprobe            # verdict only, token never printed
 *   npm run vkrenewprobe -- --reveal  # also print the token, to install it
 */

const REVEAL = process.argv.includes("--reveal");

const APP_ID = Number(process.env.VK_APP_ID ?? "") || 54703482;
const SCOPE = "photos,wall";
const API_VERSION = "5.199";
// vk.ru and vk.com are the same service, but session cookies are scoped to
// whichever domain you exported them from — send a .vk.com jar to oauth.vk.ru
// and it is simply not attached, which looks identical to being logged out.
// Chosen from the jar below when the export format carries domains.
let HOST = (process.env.VK_OAUTH_HOST ?? "").replace(/^https?:\/\//, "");

const parsedGroup = parseInt(process.env.VK_GROUP_ID ?? "");
if (!Number.isFinite(parsedGroup) || parsedGroup === 0) {
  console.error("VK_GROUP_ID is not set or not a number — nothing to validate against.");
  process.exit(1);
}
const GROUP_ID = Math.abs(parsedGroup);

function cookieFile(): string {
  if (process.env.VK_COOKIE_FILE) return path.resolve(process.env.VK_COOKIE_FILE);
  for (const candidate of ["./db/vkcookies.txt", "./db/vkcookies.json"]) {
    const full = path.resolve(candidate);
    if (fs.existsSync(full)) return full;
  }
  return path.resolve("./db/vkcookies.txt");
}

interface Jar {
  /** Ready to send as a `Cookie:` header. */
  jar: string;
  /** Which export format was recognised, for the log. */
  format: string;
  /** Cookie domains seen, when the format records them. Empty for a header string. */
  domains: string[];
}

const HELP = `Create the jar from a logged-in VK tab. Any ONE of these works:

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

/**
 * Accept whatever the user's export tool produced.
 *
 * Three formats are in circulation and they are trivial to confuse, so detect
 * rather than demand. Getting this wrong reads as "logged out" — the same
 * symptom as a genuinely dead session — which would send the diagnosis in
 * completely the wrong direction.
 */
function parseJar(raw: string): Jar {
  const text = raw.trim();
  if (!text) {
    console.error(`${cookieFile()} is empty.\n\n${HELP}`);
    process.exit(1);
  }

  const pairs = new Map<string, string>();
  const domains = new Set<string>();
  let format: string;

  if (text.startsWith("[") || text.startsWith("{")) {
    format = "JSON";
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch (e) {
      console.error(`${cookieFile()} looks like JSON but does not parse: ${String(e)}`);
      process.exit(1);
    }
    // Cookie-Editor exports an array; some tools wrap it, and the design doc
    // for the real renewer stores {"cookie": "<header>"}.
    const arr = Array.isArray(parsed)
      ? parsed
      : ((parsed as { cookies?: unknown[]; cookie?: string }).cookies ?? null);
    if (!arr) {
      const single = (parsed as { cookie?: string }).cookie;
      if (typeof single === "string") return parseJar(single);
      console.error(`${cookieFile()}: JSON has neither an array nor a "cookie" string.`);
      process.exit(1);
    }
    for (const item of arr as { name?: string; value?: string; domain?: string }[]) {
      if (!item?.name) continue;
      pairs.set(item.name, item.value ?? "");
      if (item.domain) domains.add(item.domain.replace(/^\./, ""));
    }
  } else if (/^[^\s#][^\n]*\t/m.test(text) || /^# Netscape/i.test(text)) {
    format = "Netscape cookies.txt";
    for (const line of text.split("\n")) {
      // curl marks HttpOnly cookies with a #HttpOnly_ prefix on the domain.
      // Those are the ones that matter here, so strip the marker rather than
      // skipping the line as a comment — dropping them loses remixsid.
      const cleaned = line.replace(/^#HttpOnly_/, "");
      if (!cleaned.trim() || cleaned.startsWith("#")) continue;
      const f = cleaned.split("\t").length >= 7 ? cleaned.split("\t") : cleaned.split(/\s+/);
      if (f.length < 7) continue;
      const [domain, , , , , name, ...rest] = f;
      if (!name) continue;
      pairs.set(name, rest.join("\t"));
      domains.add(domain.replace(/^\./, ""));
    }
  } else {
    format = "Cookie header";
    for (const pair of text.replace(/^Cookie:\s*/i, "").replace(/\s*\n\s*/g, " ").split(";")) {
      const [k, ...v] = pair.trim().split("=");
      if (k) pairs.set(k, v.join("="));
    }
  }

  if (pairs.size === 0) {
    console.error(`${cookieFile()}: recognised ${format} but found no cookies.\n\n${HELP}`);
    process.exit(1);
  }

  return {
    jar: [...pairs].map(([k, v]) => `${k}=${v}`).join("; "),
    format,
    domains: [...domains],
  };
}

function loadJar(): Jar {
  try {
    return parseJar(fs.readFileSync(cookieFile(), "utf8"));
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
    console.error(`No cookie jar at ${cookieFile()}.\n\n${HELP}`);
    process.exit(1);
  }
}

/** Merge Set-Cookie from a hop into the jar, so the chain stays authenticated. */
function mergeSetCookie(jar: string, setCookies: string[]): string {
  const map = new Map<string, string>();
  for (const pair of jar.split(";")) {
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

const fingerprint = (t: string): string =>
  crypto.createHash("sha256").update(t).digest("hex").slice(0, 12);

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
  if (!utf8.includes("\uFFFD")) return utf8;
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
        "these scopes. Approve once in a browser, then renewal runs unattended.",
    );
  if (/type=["']?password/i.test(body))
    return say(
      "LOGIN PAGE — VK did not accept the session and is asking for credentials. " +
        "The jar is stale, from a logged-out tab, or scoped to the other domain " +
        "(a .vk.com jar is never sent to oauth.vk.ru).",
    );
  if (/(Проверка безопасности|не робот|captcha_img|security check|Подтверждение входа)/i.test(body))
    return say(
      "SECURITY CHECK — VK wants re-validation, most likely because the request " +
        "arrived from a different IP than the one that minted the session. " +
        "This is the result that sinks the cookie-jar approach.",
    );
  return say("unrecognised page");
}

const UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

/**
 * One way of asking VK for a token.
 *
 * A browser completes this flow in a single click, so the question is which
 * property of a browser request `login.vk.ru/?act=grant_access` is checking
 * for. Each strategy adds one candidate, and they run cheapest-first so the
 * output names the minimum that works rather than a pile that happens to.
 */
interface Strategy {
  label: string;
  why: string;
  /** Referer + Sec-Fetch-* + Upgrade-Insecure-Requests, as a navigation sends. */
  browserHeaders?: boolean;
  /** Echo the httoken cookie as a query param (double-submit CSRF pattern). */
  sendHttoken?: boolean;
  extraParams?: Record<string, string>;
}

const STRATEGIES: Strategy[] = [
  {
    label: "plain",
    why: "what failed before — the baseline, so a fix is attributable",
  },
  {
    label: "+ browser navigation headers",
    why: "Referer/Sec-Fetch-*: a cross-site GET carrying cookies but no Referer " +
      "is the classic shape of a request a CSRF check rejects",
    browserHeaders: true,
  },
  {
    label: "+ httoken echoed as a param",
    why: "VK sets an httoken cookie; double-submit CSRF wants it repeated in " +
      "the request, which is what a page-rendered form would do",
    browserHeaders: true,
    sendHttoken: true,
  },
  {
    label: "+ display=page",
    why: "the parameter the working browser approval carried, in case " +
      "grant_access branches on presentation",
    browserHeaders: true,
    sendHttoken: true,
    extraParams: { display: "page" },
  },
];

interface Outcome {
  token: string | null;
  expiresIn: number | null;
  errCode: string | null;
  sawGrantAccess: boolean;
  note: string;
}

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
  const out: Outcome = {
    token: null, expiresIn: null, errCode: null, sawGrantAccess: false, note: "",
  };

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
    jar = mergeSetCookie(jar, res.headers.getSetCookie?.() ?? []);
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
          out.expiresIn = Number(q.get("expires_in") ?? "0");
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

/**
 * Recursively find an access token in a response of unknown shape.
 *
 * `act=web_token` is undocumented, so its success envelope is whatever VK
 * happens to send. Searching for the key beats hardcoding a path that moves.
 */
function findToken(value: unknown): { token?: string; expires?: number } {
  const found: { token?: string; expires?: number } = {};
  const visit = (v: unknown): void => {
    if (!v || typeof v !== "object") return;
    for (const [k, child] of Object.entries(v as Record<string, unknown>)) {
      if (k === "access_token" && typeof child === "string") found.token = child;
      else if ((k === "expires" || k === "expires_in") && typeof child === "number")
        found.expires = child;
      else visit(child);
    }
  };
  visit(value);
  return found;
}

/**
 * The call VK's web client makes to implement VKWebAppGetAuthToken.
 *
 * Much better suited to unattended use than replaying the OAuth consent chain:
 * one request, a JSON answer, and no grant_access step to be refused at. It is
 * why re-opening an already-approved Mini App hands back a token instantly.
 *
 * Two gates, measured against the live endpoint. Origin must be https://vk.ru
 * (https://vk.com and the app's own origin both answer "wrong origin"), and
 * then the web session decides — with no cookies it answers "unauthorized",
 * which is a statement about the JAR, not about the endpoint.
 */
async function tryWebToken(jar: string, site: string): Promise<Outcome> {
  const out: Outcome = {
    token: null, expiresIn: null, errCode: null, sawGrantAccess: false, note: "",
  };
  console.log(`      GET login.${site}/?act=web_token`);

  const res = await fetch(
    `https://login.${site}/?act=web_token&app_id=${APP_ID}&scope=${SCOPE}`,
    {
      headers: {
        cookie: jar,
        origin: `https://${site}`,
        referer: `https://${site}/`,
        "user-agent": UA,
        accept: "application/json, text/plain, */*",
        "accept-language": "ru-RU,ru;q=0.9,en;q=0.8",
      },
    },
  );

  const text = await readBody(res);
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    out.note = `non-JSON answer (${res.status}): ${text.replace(/\s+/g, " ").slice(0, 160)}`;
    return out;
  }

  const { token, expires } = findToken(parsed);
  if (token) {
    out.token = token;
    out.expiresIn = expires ?? null;
    return out;
  }

  // Echo the envelope verbatim, minus any token. The shape is undocumented, so
  // its error strings are the only documentation that exists.
  out.note = JSON.stringify(parsed)
    .replace(/"access_token":"[^"]*"/, '"access_token":"<redacted>"')
    .slice(0, 240);
  return out;
}

async function main(): Promise<void> {
  const verbose = process.argv.includes("--verbose");
  const parsed = loadJar();
  const names = parsed.jar.split(";").map((c) => c.trim().split("=")[0]).filter(Boolean);

  if (!HOST) {
    const com = parsed.domains.some((d) => d.endsWith("vk.com"));
    const ru = parsed.domains.some((d) => d.endsWith("vk.ru"));
    HOST = com && !ru ? "oauth.vk.com" : "oauth.vk.ru";
  }

  console.log(`VK token renewal probe — app ${APP_ID}, scope "${SCOPE}", via ${HOST}\n`);
  console.log(`cookies: ${names.length} loaded from ${cookieFile()}  (${parsed.format})`);
  if (!names.some((n) => /^remixsid/.test(n))) {
    console.log("         WARNING: no remixsid — that is the session cookie.");
  }
  console.log();

  const site = HOST.replace(/^oauth\./, "");

  // Cheapest and cleanest route first: one JSON call, no consent chain.
  console.log("── web_token (what VKWebAppGetAuthToken calls underneath)");
  console.log("   one JSON request; no grant_access step to be refused at");
  const web = await tryWebToken(parsed.jar, site);
  if (web.token) {
    await report({ label: "web_token" } as Strategy, web);
    return;
  }
  console.log(`      no token — ${web.note}\n`);
  if (/unauthorized/i.test(web.note)) {
    console.log(
      '   NOTE: "unauthorized" here is about the JAR, not the endpoint. The\n' +
        "   origin check passed and VK simply does not recognise this session,\n" +
        "   so re-export the cookies — everything below fails the same way.\n",
    );
  }

  let winner: { strategy: Strategy; outcome: Outcome } | null = null;
  let anyGrantAccess = false;
  for (const strategy of STRATEGIES) {
    console.log(`── ${strategy.label}`);
    console.log(`   ${strategy.why}`);
    const outcome = await walk(strategy, parsed.jar, verbose);
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
        "\nReaching grant_access means VK identified the session — this is not a\n" +
          "cookie problem. It is refusing to issue a token to a non-interactive\n" +
          "client, and none of the browser properties tested above is what it\n" +
          "checks for.\n\n" +
          "Re-run with `-- --verbose` to print the grant_access URL in full; a\n" +
          "parameter truncated out of the log is the most likely missing piece.",
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

  await report(winner.strategy, winner.outcome);
}

/** Shared success path, so both routes report identically. */
async function report(strategy: Strategy, outcome: Outcome): Promise<void> {
  const token = outcome.token as string;
  const expiresIn = outcome.expiresIn;
  console.log(`VERDICT: unattended renewal works — via "${strategy.label}".`);
  console.log(`    fingerprint: ${fingerprint(token)}  (length ${token.length})`);
  console.log(
    `    expires_in:  ${expiresIn ?? "not reported"}` +
      (expiresIn ? ` s = ${(expiresIn / 3600).toFixed(1)} h` : ""),
  );

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

  if (REVEAL) console.log(`\naccess_token (treat as a password):\n${token}`);
  else console.log("\nRe-run with `-- --reveal` to print the token.");
}

main().catch((e) => {
  console.error(`probe crashed: ${String(e)}`);
  process.exit(1);
});
