import "dotenv/config";
import crypto from "crypto";
import fs from "fs";

import { cookieJarPath, loadCookieJar } from "../lib/vkcookies";
import { getVkUserAccessToken, saveVkUserToken } from "../lib/vkuser";
import {
  postWebToken,
  uploadRouteWorks,
  harvestJarTokens,
  WEB_CLIENT_APP_ID,
} from "../lib/vkrenew";

/**
 * Operator tool for VK user-token renewal — the probe grew up.
 *
 * Runs exactly what the runtime renewer (src/lib/vkrenew.ts) runs: the
 * `login.vk.ru/?act=web_token` exchange against db/vkcookies.txt, then the
 * jar-harvest fallback. Use it to answer "would automatic renewal succeed
 * right now?" before anything is at stake, or to rotate the token by hand
 * when automation cannot.
 *
 *   npm run vkrenewprobe                 # attempt + report; installs nothing
 *   npm run vkrenewprobe -- --install    # also install a validated token
 *   npm run vkrenewprobe -- --reveal     # print the token too (password-grade)
 *
 * Nothing is ever installed without passing photos.getWallUploadServer first,
 * same gate as production.
 */

const REVEAL = process.argv.includes("--reveal");
const INSTALL = process.argv.includes("--install");

const APP_ID = Number(process.env.VK_APP_ID ?? "") || 54703482;

const parsedGroup = parseInt(process.env.VK_GROUP_ID ?? "");
if (!Number.isFinite(parsedGroup) || parsedGroup === 0) {
  console.error("VK_GROUP_ID is not set or not a number — nothing to validate against.");
  process.exit(1);
}

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

Export the WHOLE jar from the SAME tab that talks to vk.ru, and make sure it
contains \`p\`, \`sua\` and \`remixsid\` — web_token answers "unauthorized"
without them no matter how fresh everything else is. HttpOnly cookies are part
of the jar; an export method that cannot see them is the wrong method.`;

const fingerprint = (t: string): string =>
  crypto.createHash("sha256").update(t).digest("hex").slice(0, 12);

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

/** Shared success tail so every route reports and installs identically. */
async function succeed(via: string, token: string, secondsLeft: number | null): Promise<void> {
  console.log(`\nVERDICT: a working token was produced — via ${via}.`);
  console.log(`    fingerprint: ${fingerprint(token)}  (length ${token.length})`);
  if (secondsLeft !== null) {
    const eta = new Date(Date.now() + secondsLeft * 1000).toISOString();
    console.log(`    lifetime:    ${(secondsLeft / 3600).toFixed(1)} h (until ~${eta})`);
  } else {
    console.log("    lifetime:    unknown (VK reported none we could trust)");
  }

  process.stdout.write("\n    validating against photos.getWallUploadServer … ");
  const verdict = await uploadRouteWorks(token);
  if (!verdict.ok) {
    console.log(`FAILED — ${verdict.detail}`);
    console.log("\nA token was minted but cannot upload — a scope or IP problem, not");
    console.log("a session problem. NOT installed; different fix needed.");
    process.exit(1);
  }
  console.log("OK — upload route reachable");

  if (!INSTALL) {
    console.log("\nDry run only — re-run with `-- --install` to put this token in the store.");
  } else {
    saveVkUserToken(token, secondsLeft, "manual");
    console.log("\nInstalled as the live user token. Wall photos are back.");
  }
  if (REVEAL) console.log(`\naccess_token (treat as a password):\n${token}`);
}

async function main(): Promise<void> {
  const parsed = loadJar();
  const names = parsed.names;

  console.log(
    `VK renewal tool — app ${APP_ID} (+${WEB_CLIENT_APP_ID} fallback), ` +
      `${INSTALL ? "INSTALL MODE" : "dry run"}\n`,
  );
  console.log(`cookies: ${names.length} loaded from ${cookieJarPath()}  (${parsed.format})`);

  // Which cookies are present decides everything downstream, so audit before
  // attempting: each missing name maps to a specific, known failure mode.
  const missing = ["remixsid", "httoken", "p", "sua"].filter(
    (need) => !names.some((n) => n === need || n.startsWith(need)),
  );
  if (missing.length) {
    console.log(`         MISSING: ${missing.join(", ")}`);
    console.log(
      "         web_token needs these session cookies; without them it answers" +
        '\n         "unauthorized". Re-export the COMPLETE jar (see below).',
    );
  }
  console.log();

  const held = await getVkUserAccessToken();
  console.log(`held token: ${held ? `present (fingerprint ${fingerprint(held)})` : "none"}`);

  const harvested = harvestJarTokens(parsed.header);
  console.log(
    `jar harvest: ${harvested.length} candidate token(s) in p/sua` +
      harvested.map((t) => ` [${fingerprint(t)}]`).join(""),
  );

  // The production route, both app ids × both body shapes. First success wins.
  let jarHeader = parsed.header;
  for (const appId of [...new Set([APP_ID, WEB_CLIENT_APP_ID])]) {
    for (const bodyToken of [null, held]) {
      const shape = bodyToken ? "token-in-body" : "cookies-only";
      process.stdout.write(`\nPOST act=web_token · app ${appId} · ${shape} … `);
      try {
        const res = await postWebToken(appId, bodyToken, jarHeader);
        jarHeader = res.jarHeader;
        if (res.attempt.kind === "minted") {
          console.log(`MINTED (valid ${res.attempt.grant.secondsRemaining ?? "?"} s)`);
          await succeed(`web_token app ${appId}`, res.attempt.grant.token, res.attempt.grant.secondsRemaining);
          return;
        }
        console.log(res.attempt.detail);
      } catch (e) {
        console.log(String(e).slice(0, 160));
      }
    }
  }

  // Fallback: tokens already inside the jar, same validation gate.
  for (const candidate of harvested) {
    process.stdout.write(`\nvalidating harvested jar token ${fingerprint(candidate)} … `);
    const verdict = await uploadRouteWorks(candidate);
    if (verdict.ok) {
      console.log("OK");
      await succeed("harvested from jar (p/sua)", candidate, null);
      return;
    }
    console.log(verdict.detail);
  }

  console.log("\nVERDICT: every route refused.");
  console.log(
    "\nIf MISSING cookies were listed above, fix that first — re-export the\n" +
      "complete jar from the logged-in tab (HttpOnly included) and retry.\n" +
      "Otherwise paste the error above into the investigation.",
  );
  process.exit(2);
}

main().catch((e) => {
  console.error(`tool crashed: ${String(e)}`);
  process.exit(1);
});
