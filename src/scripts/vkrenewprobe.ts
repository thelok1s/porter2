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

async function main(): Promise<void> {
  const parsed = loadJar();
  let jar = parsed.jar;
  const names = parsed.jar.split(";").map((c) => c.trim().split("=")[0]).filter(Boolean);

  // Match the oauth host to the jar. A .vk.com jar sent to oauth.vk.ru is not
  // attached at all, and VK then serves the login page — indistinguishable
  // from a dead session unless you already suspect the domain.
  if (!HOST) {
    const com = parsed.domains.some((d) => d.endsWith("vk.com"));
    const ru = parsed.domains.some((d) => d.endsWith("vk.ru"));
    HOST = com && !ru ? "oauth.vk.com" : "oauth.vk.ru";
  }

  console.log(`VK token renewal probe — app ${APP_ID}, scope "${SCOPE}", via ${HOST}\n`);
  console.log(`cookies: ${names.length} loaded from ${cookieFile()}`);
  console.log(`         format: ${parsed.format}`);
  if (parsed.domains.length) {
    console.log(`         domains: ${parsed.domains.join(", ")}`);
  }
  console.log(`         ${names.join(", ")}`);
  if (!names.some((n) => /^remixsid/.test(n))) {
    console.log(
      "         WARNING: no remixsid — that is the session cookie. Either the\n" +
        "         tab was logged out, or the export was filtered to one domain\n" +
        "         and dropped the HttpOnly entries.",
    );
  }
  if (parsed.domains.length && !parsed.domains.some((d) => /(^|\.)vk\.(ru|com)$/.test(d))) {
    console.log(
      `         WARNING: no vk.ru/vk.com cookies in this jar — exported from ` +
        `the wrong site?`,
    );
  }
  console.log();

  let url =
    `https://${HOST}/authorize?client_id=${APP_ID}&scope=${SCOPE}` +
    `&redirect_uri=https://${HOST}/blank.html&response_type=token&v=${API_VERSION}`;

  let token: string | null = null;
  let expiresIn: number | null = null;

  for (let hop = 1; hop <= 8; hop++) {
    const res: Response = await fetch(url, {
      redirect: "manual",
      headers: {
        cookie: jar,
        "user-agent":
          "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 " +
          "(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
        accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "accept-language": "ru-RU,ru;q=0.9,en;q=0.8",
      },
    });

    jar = mergeSetCookie(jar, res.headers.getSetCookie?.() ?? []);
    const location = res.headers.get("location");
    const host = new URL(url).host;
    console.log(`[${hop}] ${res.status} ${host}${new URL(url).pathname}`);

    if (location) {
      // The fragment never reaches a server, but it IS present in the Location
      // header of the redirect that carries it — which is exactly how a
      // non-browser client can read an implicit-flow token.
      const shown = location.replace(/access_token=[^&]+/, "access_token=<redacted>");
      console.log(`    → ${shown.slice(0, 160)}`);
      const frag = location.split("#")[1];
      if (frag) {
        const p = new URLSearchParams(frag);
        const t = p.get("access_token");
        if (t) {
          token = t;
          expiresIn = Number(p.get("expires_in") ?? "0");
          break;
        }
        const err = p.get("error");
        if (err) {
          console.log(`\nFAILED — ${err}: ${p.get("error_description") ?? ""}`);
          process.exit(1);
        }
      }
      url = new URL(location, url).toString();
      continue;
    }

    const body = await readBody(res);
    if (res.headers.get("content-type")?.includes("json")) {
      console.log(`\nFAILED — VK answered ${res.status}: ${body.slice(0, 300)}`);
      process.exit(1);
    }
    console.log(`\nSTOPPED — ${classifyHtml(body)}`);
    console.log(`\n(first 400 bytes)\n${body.replace(/\s+/g, " ").slice(0, 400)}`);
    process.exit(1);
  }

  if (!token) {
    console.log("\nFAILED — redirect chain ended without a token.");
    process.exit(1);
  }

  console.log("\nTOKEN ISSUED");
  console.log(`    fingerprint: ${fingerprint(token)}  (length ${token.length})`);
  console.log(
    `    expires_in:  ${expiresIn} s` +
      (expiresIn ? ` = ${(expiresIn / 3600).toFixed(1)} h` : " — no expiry reported"),
  );

  // A token that authorises is not yet a token that works: the whole reason
  // this project exists is that photo uploads have their own gate.
  process.stdout.write("\nvalidating against photos.getWallUploadServer … ");
  try {
    const api = new API({ token });
    const res = (await api.photos.getWallUploadServer({
      group_id: GROUP_ID,
    })) as unknown as { upload_url?: string };
    console.log(res?.upload_url ? "OK — upload route reachable" : `no upload_url: ${JSON.stringify(res)}`);
  } catch (e) {
    const err = e as { code?: number; message?: string };
    console.log(`FAILED — Code ${err?.code ?? "?"}: ${err?.message ?? String(e)}`);
    console.log("\nThe session renews fine but the token cannot upload. That is a");
    console.log("scope or IP problem, not a session problem — different fix.");
    process.exit(1);
  }

  console.log("\nVERDICT: unattended renewal works from this host.");
  if (REVEAL) {
    console.log(`\naccess_token (treat as a password):\n${token}`);
  } else {
    console.log("\nRe-run with `-- --reveal` to print the token and install it.");
  }
}

main().catch((e) => {
  console.error(`probe crashed: ${String(e)}`);
  process.exit(1);
});
