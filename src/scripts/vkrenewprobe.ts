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
  candidateAppIds,
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
 * 2. Rotate by hand when you want a LONG-lived grant: the automatic mint now
 *    works again but under VK's own web-client app id, whose tokens live only
 *    ~15 min (measured 2026-08-26). A Mini App page token pasted on stdin
 *    lasts ~24 h — worth the minute of work whenever the churn annoys you.
 *
 *   npm run vkrenewprobe                 # attempt + report; installs nothing
 *   npm run vkrenewprobe -- --install    # also install a validated token
 *   npm run vkrenewprobe -- --install --stdin   # install a PASTED token
 *   npm run vkrenewprobe -- --reveal     # print the token too (password-grade)
 *   npm run vkrenewprobe -- --sweep      # survey app ids for a LONGER life
 *
 * 3. Answer "is there a longer-lived token we could renew just as easily?"
 *    (`--sweep`). The incumbent mints ~15 min, so the watch re-mints ~200×/day;
 *    the sweep measures whether any other app id does better through the same
 *    exchange. Adopting a winner is one variable, VK_APP_ID. Installs nothing.
 *
 * Nothing is ever installed without passing photos.getWallUploadServer first,
 * same gate as production.
 */

const REVEAL = process.argv.includes("--reveal");
const INSTALL = process.argv.includes("--install");
const FROM_STDIN = process.argv.includes("--stdin");
const SWEEP = process.argv.includes("--sweep");

const APP_ID = Number(process.env.VK_APP_ID ?? "") || 54703482;

/**
 * App ids to SURVEY for a longer-lived grant (`--sweep`).
 *
 * The question this answers: the incumbent (VK's web client, 6287487) mints
 * tokens that live ~15 min, so the watchdog re-mints ~200×/day. Does any other
 * app id mint a LONGER-lived token through the very same exchange — same cookie
 * jar, same endpoint, only `app_id` differs? If one does, adopting it costs a
 * single environment variable: VK_APP_ID jumps to the front of candidateAppIds
 * and the whole existing pipeline picks it up unchanged.
 *
 * These are VK's own publicly-known client ids — the values their clients ship
 * and that appear throughout VK's public API documentation and community
 * tooling. They are surveyed, never assumed: what a token is WORTH here is
 * decided by photos.getWallUploadServer, the same gate production uses, so an
 * id that mints something with the wrong scope is reported and discarded rather
 * than adopted.
 *
 * NOTE the account-side tradeoff before adopting one: minting under a client id
 * that is not ours is exactly what the session's own browser already does, but
 * a server doing it on a schedule is a pattern VK may rate-limit or flag. That
 * is a risk to THIS account, so the decision belongs to the operator; the sweep
 * only supplies the measurement.
 */
const SURVEY_APP_IDS: { id: number; label: string }[] = [
  { id: 6287487, label: "VK web client (incumbent — the ~15 min one)" },
  { id: 2274003, label: "VK Android" },
  { id: 3140623, label: "VK iPhone" },
  { id: 3682744, label: "VK iPad" },
  { id: 3697615, label: "VK Windows" },
  { id: 6146827, label: "VK Me" },
  { id: 7913379, label: "VK Calls" },
  { id: 5027722, label: "VK Admin" },
];

/** Politeness gap between sweep requests, so a survey is not a burst. */
const SWEEP_GAP_MS = 700;
const pause = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

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
db/vkcookies.txt (override with VK_COOKIE_FILE). Mints come from VK's
web-client app id and last only ~15 min; the watchdog renews on that cadence
by itself. Any ONE of these formats works:

  A. Cookie header (no extension needed) — BEST choice
     Chrome -> open vk.ru -> DevTools -> Network -> click a request to
     login.vk.ru (NOT just vk.ru!) -> Request Headers -> right-click the
     \`Cookie:\` line -> Copy value -> paste into the file.
     Why login.vk.ru: its Cookie header carries \`httoken\`, the login-domain
     session cookie that vk.ru's own Application->Cookies view never shows —
     measured 2026-08-26 as the difference between "unauthorized" and a
     working mint.

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

\`remixsid\` AND \`httoken\` must be in the jar — the latter rides only
login.vk.ru traffic, hence format A. Carrier cookies (\`p\`/\`sua\` older,
\`remixnsid\`/\`remixnttpid\` newer) matter only for the harvest fallback:
the 2026-08-26 working jar had no p/sua and still minted. HttpOnly cookies
are part of the jar; an export method that cannot see them is the wrong
method.`;

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
    const life =
      secondsLeft < 3600
        ? `${Math.round(secondsLeft / 60)} min`
        : `${(secondsLeft / 3600).toFixed(1)} h`;
    console.log(`    lifetime:    ${life} (until ~${eta})`);
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

/**
 * Survey every candidate app id for a longer-lived grant. Installs NOTHING —
 * this is a measurement, and adopting a result is a deliberate second step
 * (set VK_APP_ID). Tokens minted along the way are validated so the report can
 * say whether each would actually have been usable, and are never printed.
 */
async function sweep(): Promise<void> {
  const parsed = loadJar();
  let jarHeader = parsed.header;
  const held = await getVkUserAccessToken();

  console.log(
    "VK app-id survey — which id mints the LONGEST-lived usable token?\n" +
      `cookies: ${parsed.names.length} from ${cookieJarPath()} (${parsed.format})\n` +
      "Nothing is installed. Same jar, same endpoint; only app_id differs.\n",
  );

  type Row = { id: number; label: string; life: number | null; usable: boolean; note: string };
  const rows: Row[] = [];

  for (const { id, label } of SURVEY_APP_IDS) {
    process.stdout.write(`app ${String(id).padEnd(9)} ${label.padEnd(42)} … `);
    let row: Row = { id, label, life: null, usable: false, note: "refused" };

    // Cookies-only is the shape the working capture used; fall back to
    // token-in-body only if that is refused, mirroring production's order.
    // With no token held the second shape IS the first — skip it rather than
    // sending the same request twice for every id in the survey.
    for (const bodyToken of held ? [null, held] : [null]) {
      try {
        const res = await postWebToken(id, bodyToken, jarHeader);
        jarHeader = res.jarHeader;
        if (res.attempt.kind !== "minted") {
          row.note = res.attempt.detail.replace(/\s+/g, " ").slice(0, 70);
          await pause(SWEEP_GAP_MS);
          continue;
        }
        const secs = res.attempt.grant.secondsRemaining;
        const verdict = await uploadRouteWorks(res.attempt.grant.token);
        row = {
          id,
          label,
          life: secs,
          usable: verdict.ok,
          note: verdict.ok ? "minted + upload OK" : `minted but ${verdict.detail.slice(0, 50)}`,
        };
        break;
      } catch (e) {
        row.note = String(e).slice(0, 70);
      }
      await pause(SWEEP_GAP_MS);
    }

    const lifeText =
      row.life === null
        ? row.usable
          ? "lifetime unreported"
          : ""
        : row.life < 3600
          ? `${Math.round(row.life / 60)} min`
          : `${(row.life / 3600).toFixed(1)} h`;
    console.log(`${row.usable ? "MINTED" : "no"}  ${lifeText}  ${row.note}`);
    rows.push(row);
    await pause(SWEEP_GAP_MS);
  }

  const usable = rows.filter((r) => r.usable);
  console.log("\n── verdict ─────────────────────────────────────────────");
  if (usable.length === 0) {
    console.log(
      "No app id minted a usable token. If the incumbent also failed, the JAR\n" +
        "is the problem, not the app id — re-export it (see --help) and re-run.",
    );
    process.exit(2);
  }

  // An unreported lifetime sorts last: an unknown is not evidence of a long
  // life, and adopting one would trade a measured 15 min for a guess.
  const ranked = [...usable].sort((a, b) => (b.life ?? -1) - (a.life ?? -1));
  const best = ranked[0];
  const incumbent = rows.find((r) => r.id === WEB_CLIENT_APP_ID);

  for (const r of ranked) {
    const life = r.life === null ? "unreported" : `${Math.round(r.life / 60)} min`;
    console.log(`  usable: app ${String(r.id).padEnd(9)} ${life.padStart(10)}  ${r.label}`);
  }

  const beats =
    best.life !== null && incumbent?.life != null && best.life > incumbent.life * 1.5;
  console.log();
  if (beats) {
    console.log(
      `Best: app ${best.id} at ~${Math.round(best.life! / 60)} min — ` +
        `${(best.life! / (incumbent!.life || 1)).toFixed(1)}× the incumbent.\n` +
        `Adopt with:  VK_APP_ID=${best.id}   (then restart; candidateAppIds puts it first)\n` +
        "Re-run this sweep after a day — VK has changed which ids mint before.",
    );
  } else {
    console.log(
      "Nothing beats the incumbent meaningfully. Keep the current setup: the\n" +
        "watchdog already re-mints on the short cadence without operator action.\n" +
        "For a LONG (~24 h) grant, manual Mini App rotation remains the only\n" +
        "measured option — see the help text above.",
    );
  }
}

async function main(): Promise<void> {
  if (FROM_STDIN) return installPastedToken();
  if (SWEEP) return sweep();

  const parsed = loadJar();
  const names = parsed.names;

  console.log(
    `VK renewal tool — app ${WEB_CLIENT_APP_ID} (VK web client) + ` +
      `${APP_ID} fallback, ${INSTALL ? "INSTALL MODE" : "dry run"}\n`,
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
          "         The exchange itself works without them (measured), but\n" +
          "         the harvest fallback will have nothing to try.",
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

  // The production route, same app-id order as production (candidateAppIds).
  let jarHeader = parsed.header;
  for (const appId of candidateAppIds()) {
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
    "\nIf MISSING cookies were listed above, fix that first — the session must\n" +
      "authenticate before any app id is considered.\n" +
      "If the jar was COMPLETE and still refused: VK accepts only some jars.\n" +
      "(Measured 2026-08-26: a full DevTools export answered \"unauthorized\",\n" +
      "a trimmed ~22-cookie session minted under app 6287487 — so jar shape,\n" +
      "not just presence, matters. Mints under 6287487 live only ~15 min.)\n" +
      "For a LONG-lived (~24 h) token, rotate by hand — see the manual-rotation\n" +
      "block in the help above, or: pbpaste | docker compose exec -T porter2 npm run \\\n" +
      "  vkrenewprobe -- --install --stdin",
  );
  process.exit(2);
}

main().catch((e) => {
  console.error(`tool crashed: ${String(e)}`);
  process.exit(1);
});
