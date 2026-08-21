import "dotenv/config";
import readline from "readline";
import {
  buildAuthorizeUrl,
  createPkce,
  exchangeCode,
  randomState,
  vkUserTokenFile,
  writeStore,
  VKID_SCOPE,
} from "@/lib/vkuser";

/**
 * Interactive one-off: authorize a *user account* through VK ID so porter can
 * put real photos on the community wall.
 *
 * Needed because a community token cannot: VK answers Code 27 for the wall
 * photo upload methods regardless of rights, and every community-token
 * alternative was measured and rejected (see src/lib/vkuser.ts).
 *
 * Run once. Afterwards porter refreshes the grant by itself; you only come back
 * here if the authorization is revoked from the account's app settings.
 *
 * Prerequisites, in .env:
 *   VKID_APP_ID       — id of a VK app you own (dev.vk.ru → создать приложение)
 *   VKID_REDIRECT_URI — a trusted redirect URI listed in that app's settings
 *
 * Sign in as an ADMINISTRATOR of the target community. Prefer a dedicated
 * admin account over a personal one: the grant can act as whoever authorizes
 * it, within `photos wall`.
 *
 * Run: `npm run vkidlogin`
 */


const APP_ID = (process.env.VKID_APP_ID ?? "").trim();
const REDIRECT_URI = (process.env.VKID_REDIRECT_URI ?? "").trim();

if (!APP_ID || !REDIRECT_URI) {
  console.error(
    "Set VKID_APP_ID and VKID_REDIRECT_URI in .env first.\n\n" +
      "  1. Create an app at https://dev.vk.ru/ (type: Web / Сайт).\n" +
      "  2. Copy its id into VKID_APP_ID.\n" +
      "  3. Add a trusted redirect URI in the app settings and put the SAME\n" +
      "     value in VKID_REDIRECT_URI — VK rejects any mismatch. Your Mini App\n" +
      "     URL is a fine choice, e.g. https://frog.prod.lok1s.tech/\n",
  );
  process.exit(1);
}

function ask(question: string): Promise<string> {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  return new Promise((resolve) =>
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer.trim());
    }),
  );
}

async function main() {
  // The verifier never leaves this process; only its SHA-256 goes to VK, so an
  // intercepted authorization code is useless on its own. That is the whole
  // point of PKCE, and why no client_secret is needed here.
  const { verifier, challenge } = createPkce();
  const state = randomState();

  console.log(
    "\nOpen this URL in a browser, signed in as an ADMIN of the community:\n",
  );
  console.log(`  ${buildAuthorizeUrl(challenge, state)}\n`);
  console.log(`Requested scope: ${VKID_SCOPE}`);
  console.log(
    "\nAfter approving you land on your redirect URI with ?code=…&device_id=…\n" +
      "in the address bar. The page itself may well 404 — that does not matter,\n" +
      "only the URL does. Copy the WHOLE URL and paste it below.\n",
  );

  const pasted = await ask("Redirected URL > ");
  if (!pasted) {
    console.error("Nothing pasted — aborted.");
    process.exit(1);
  }

  let url: URL;
  try {
    url = new URL(pasted);
  } catch {
    console.error("That is not a URL. Paste the full address, including https://");
    process.exit(1);
  }

  const code = url.searchParams.get("code");
  const deviceId = url.searchParams.get("device_id");
  const returned = url.searchParams.get("state");

  if (!code || !deviceId) {
    const error = url.searchParams.get("error_description") ?? url.searchParams.get("error");
    console.error(
      error
        ? `VK returned an error instead of a code: ${error}`
        : "That URL has no ?code= and ?device_id= — did the approval finish?",
    );
    process.exit(1);
  }

  // Guards against pasting the result of a different, possibly attacker-started
  // authorization: the code is only accepted for the request WE began.
  if (returned !== state) {
    console.error(
      "state mismatch — this URL is not from the authorization just started.\n\n" +
        "Most often this means the link came from an EARLIER run of this\n" +
        "script — an older terminal line or a still-open tab. Each run mints a\n" +
        "new state and code_verifier, and only the newest one can be redeemed.\n\n" +
        `  expected state: ${state}\n` +
        `  URL carried:    ${returned ?? "(none)"}\n\n` +
        "Close old tabs, re-run, and open only the URL printed above. The code\n" +
        "also expires 10 minutes after it is issued.",
    );
    process.exit(1);
  }

  try {
    const store = await exchangeCode(code, verifier, deviceId, state);
    writeStore(store);

    console.log(`\n✓ Authorized as user ${store.userId}.`);
    console.log(`  scope:  ${store.scope}`);
    console.log(`  stored: ${vkUserTokenFile()} (0600)`);
    console.log(
      "\nThe refresh token in that file is password-grade — anyone holding it\n" +
        "can act as this account within the scope above. It lives on the ./db\n" +
        "volume, so it survives rebuilds; keep it out of backups you share, and\n" +
        "revoke anytime at https://vk.ru/settings?act=apps\n" +
        "\nporter refreshes it automatically from here. Restart porter to pick it up.\n",
    );
  } catch (error) {
    console.error(`\nToken exchange failed: ${String(error)}`);
    console.error(
      "\nAuthorization codes are single-use and short-lived, so a stale paste\n" +
        "fails this way. Re-run and complete the flow in one go.",
    );
    process.exit(1);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
