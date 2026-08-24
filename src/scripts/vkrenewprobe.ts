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
// vk.ru and vk.com are the same service, but the session cookies are scoped to
// whichever domain you exported them from. Use the matching oauth host or the
// jar simply will not be sent.
const HOST = (process.env.VK_OAUTH_HOST ?? "oauth.vk.ru").replace(/^https?:\/\//, "");

const parsedGroup = parseInt(process.env.VK_GROUP_ID ?? "");
if (!Number.isFinite(parsedGroup) || parsedGroup === 0) {
  console.error("VK_GROUP_ID is not set or not a number — nothing to validate against.");
  process.exit(1);
}
const GROUP_ID = Math.abs(parsedGroup);

const cookieFile = path.resolve(process.env.VK_COOKIE_FILE ?? "./db/vkcookies.txt");

function loadCookies(): string {
  let raw: string;
  try {
    raw = fs.readFileSync(cookieFile, "utf8");
  } catch {
    console.error(
      `No cookie jar at ${cookieFile}.\n\n` +
        "Create it from a logged-in VK tab:\n" +
        "  Chrome → open vk.ru → DevTools → Network → click any vk.ru request\n" +
        "  → Request Headers → right-click the `Cookie:` line → Copy value\n" +
        "  → paste the WHOLE line into that file, one line, no quotes.\n\n" +
        "Copying the Cookie header rather than picking out `remixsid` by hand is\n" +
        "deliberate: the session cookie is HttpOnly (so `document.cookie` cannot\n" +
        "see it) and VK checks several cookies together.",
    );
    process.exit(1);
  }
  const jar = raw.trim().replace(/^Cookie:\s*/i, "").replace(/\s*\n\s*/g, " ");
  if (!jar) {
    console.error(`${cookieFile} is empty.`);
    process.exit(1);
  }
  return jar;
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

/** Classify an HTML body VK serves instead of redirecting. */
function classifyHtml(body: string): string {
  if (/name=["']?(pass|password)/i.test(body) || /VK ID/i.test(body))
    return "LOGIN PAGE — the session cookies are dead or were never valid here";
  if (/(Разрешить|Allow|запрашивает доступ|requests access)/i.test(body))
    return "CONSENT PAGE — session is alive, but the app is not pre-authorised " +
      "for these scopes, so renewal cannot run unattended until it is approved once";
  if (/(подтвер|confirm|security check|Проверка безопасности|captcha)/i.test(body))
    return "SECURITY CHECK — VK wants re-validation, most likely because the " +
      "request came from a different IP than the one that minted the session";
  return "unrecognised HTML page (see the dump below)";
}

async function main(): Promise<void> {
  console.log(`VK token renewal probe — app ${APP_ID}, scope "${SCOPE}", via ${HOST}\n`);

  let jar = loadCookies();
  const names = jar.split(";").map((c) => c.trim().split("=")[0]).filter(Boolean);
  console.log(`cookies: ${names.length} loaded from ${cookieFile}`);
  console.log(`         ${names.join(", ")}`);
  console.log(
    names.some((n) => /^remixsid/.test(n))
      ? "         remixsid present\n"
      : "         WARNING: no remixsid — this is the session cookie; the jar " +
        "is probably from a logged-out tab\n",
  );

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

    const body = await res.text();
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
