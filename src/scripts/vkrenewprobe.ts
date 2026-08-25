import "dotenv/config";
import crypto from "crypto";
import fs from "fs";

import { cookieJarPath, loadCookieJar } from "../lib/vkcookies";
import { getVkUserAccessToken, saveVkUserToken } from "../lib/vkuser";
import {
  postWebToken,
  uploadRouteWorks,
  harvestJarTokens,
  JAR_HARD_REQUIREMENTS,
  JAR_TOKEN_CARRIERS,
  WEB_CLIENT_APP_ID,
} from "../lib/vkrenew";

/**
 * Operator tool for VK user-token renewal — the probe grew up.
 *
 * Two jobs:
 *
 * 1. Run exactly what the runtime renewer (src/lib/vkrenew.ts) runs: the
 *    `login.vk.ru/?act=web_token` exchange against db/vkcookies.txt, then the
 *    jar-harvest fallback. Use it to answer "would automatic renewal succeed
 *    right now?" before anything is at stake.
 * 2. Rotate by hand when automation cannot — the reliable path since VK began
 *    refusing the server-side mint outright (measured 2026-08-25): mint in the
 *    Mini App page, pipe the revealed token in on stdin.
 *
 *   npm run vkrenewprobe                 # attempt + report; installs nothing
 *   npm run vkrenewprobe -- --install    # also install a validated token
 *   npm run vkrenewprobe -- --install --stdin   # install a PASTED token
 *   npm run vkrenewprobe -- --reveal     # print the token too (password-grade)
 *
 * Nothing is ever installed without passing photos.getWallUploadServer first,
 * same gate as production.
 */

const REVEAL = process.argv.includes("--reveal");
const INSTALL = process.argv.includes("--install");
const FROM_STDIN = process.argv.includes("--stdin");

const APP_ID = Number(process.env.VK_APP_ID ?? "") || 54703482;

const parsedGroup = parseInt(process.env.VK_GROUP_ID ?? "");
if (!Number.isFinite(parsedGroup) || parsedGroup === 0) {
  console.error("VK_GROUP_ID is not set or not a number — nothing to validate against.");
  process.exit(1);
}

const HELP = `Manual rotation — always works, needs NO cookie jar:

  Open the Mini App page INSIDE VK as a community admin
  (frontend/public/vk-probe.html in the cyberjab repo), approve,
  tap "Reveal token", then carry it here:

    pbpaste | docker compose exec -T porter2 npm run vkrenewprobe \\
        -- --install --stdin

  The pasted token goes through the same photos.getWallUploadServer gate;
  nothing is installed unless it can actually upload.

Automatic renewal — rides a browser-session cookie jar saved at
db/vkcookies.txt (override with VK_COOKIE_FILE). Any ONE of these
formats works:

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

  D. DevTools cookies table
     Application tab -> Cookies -> select the rows -> Cmd/Ctrl-C. Tab-
     separated columns (name, value, domain, path, expiry, ...). Paste in
     unchanged — and select the WHOLE list, not just the rows in view.

Export the WHOLE jar from the SAME tab that talks to vk.ru. \`remixsid\` must
be there, plus at least ONE token-carrier cookie — sessions keep their API
token in \`p\`/\`sua\` (older) or \`remixnsid\`/\`remixnttpid\` (newer).
Without any carrier, web_token answers "unauthorized" and there is nothing to
harvest either. HttpOnly cookies are part of the jar; an export method that
cannot see them is the wrong method.`;

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

/**
 * The manual-rotation path: a token minted in the Mini App page arrives on
 * stdin (piped, so it never lands in shell history or `ps`). Validated by the
 * shared gate inside succeed(); nothing is written without --install.
 */
async function installPastedToken(): Promise<void> {
  console.log("VK token install — reading the pasted token from stdin …");
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  const token = Buffer.concat(chunks).toString("utf8").trim();

  if (!/^vk1\.a\./.test(token)) {
    console.error(
      "stdin carried no vk1.a… token — copy exactly what the probe page\n" +
        "reveals (tap Reveal token), including the vk1.a. prefix.",
    );
    process.exit(1);
  }
  // The Mini App grant reports no expiry we can carry over here; recorded as
  // unknown and the watchdog's age-based watching takes over.
  await succeed("pasted from the Mini App page", token, null);
}

async function main(): Promise<void> {
  if (FROM_STDIN) return installPastedToken();

  const parsed = loadJar();
  const names = parsed.names;

  console.log(
    `VK renewal tool — app ${APP_ID} (+${WEB_CLIENT_APP_ID} fallback), ` +
      `${INSTALL ? "INSTALL MODE" : "dry run"}\n`,
  );
  console.log(`cookies: ${names.length} loaded from ${cookieJarPath()}  (${parsed.format})`);

  // Which cookies are present decides everything downstream, so audit before
  // attempting: each missing name maps to a specific, known failure mode.
  const missingHard = JAR_HARD_REQUIREMENTS.filter(
    (need) => !names.some((n) => n === need || n.startsWith(need)),
  );
  const carriers = JAR_TOKEN_CARRIERS.filter((c) => names.includes(c));
  if (missingHard.length || carriers.length === 0) {
    if (missingHard.length) {
      console.log(`         MISSING: ${missingHard.join(", ")}`);
      console.log("         without it the jar reads as logged-out.");
    }
    if (carriers.length === 0) {
      console.log(
        `         no token-carrier cookie (${JAR_TOKEN_CARRIERS.join(", ")}).\n` +
          "         The session keeps its API token in one of these — older\n" +
          "         sessions in p/sua, newer exports in remixnsid/remixnttpid.\n" +
          '         Without any, web_token answers "unauthorized" and the\n' +
          "         harvest fallback has nothing to try.",
      );
    }
    console.log("         Fix: re-export the COMPLETE jar (see below).");
  }
  console.log();

  const held = await getVkUserAccessToken();
  console.log(`held token: ${held ? `present (fingerprint ${fingerprint(held)})` : "none"}`);

  const harvested = harvestJarTokens(parsed.header);
  console.log(
    `jar harvest: ${harvested.length} candidate token(s) from carrier cookies` +
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
      await succeed("harvested from jar", candidate, null);
      return;
    }
    console.log(verdict.detail);
  }

  console.log("\nVERDICT: every route refused.");
  console.log(
    "\nIf MISSING cookies were listed above, fix that first — re-export the\n" +
      "complete jar from the logged-in tab (HttpOnly included) and retry.\n" +
      "If the jar was COMPLETE and still refused, VK is gating the mint itself\n" +
      "(measured 2026-08-25: a full 20-cookie session still answers\n" +
      '"unauthorized", and neither carrier cookie holds a usable token).\n' +
      "Rotate by hand instead — see the manual-rotation block in the help\n" +
      "above, or: pbpaste | docker compose exec -T porter2 npm run \\\n" +
      "  vkrenewprobe -- --install --stdin",
  );
  process.exit(2);
}

main().catch((e) => {
  console.error(`tool crashed: ${String(e)}`);
  process.exit(1);
});
