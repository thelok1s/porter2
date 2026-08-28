import fs from "fs";
import path from "path";
import crypto from "crypto";
import { VK } from "vk-io";

import logger from "@/lib/logger";

/**
 * The VK *user* token that lets porter put a PHOTO on a wall post.
 *
 * Porter uses a community token for everything else, but attaching a photo is
 * closed to community auth by design: `photos.getWallUploadServer` and
 * `photos.saveWallPhoto` answer Code 27 ("method is unavailable with group
 * auth") no matter which rights the token carries. Every community-token route
 * was measured against the live wall and rejected:
 *
 *   • messages upload server — uploads fine and `wall.post` ACCEPTS the
 *     attachment, but VK strips it on publish; those photos live in album -3,
 *     which wall posts may not reference. Confirmed six times.
 *   • wall document server — the one attachment that survives, but VK refuses
 *     files it recognises as images, so artwork can only ride as an
 *     unrecognised blob and renders as a "file0.dat" download link.
 *   • an Open Graph link snippet — VK answers "link_photo_sizing_rule. No photo
 *     given" even for a publicly reachable card with a 1080x1080 og:image.
 *   • photos.getUploadServer (a normal community album) — same `photos`
 *     requirement as the wall route. Not an alternative.
 *
 * A VK ID app cannot supply the token either: `photos` and `wall` are extended
 * rights there, gated behind a VK Бизнес ID profile (an ИНН) and a support
 * request that gets refused. Asking for them yields `vkid.personal_info` and
 * Code 15 on the upload call. That whole route was built, measured, and removed.
 *
 * What works is a VK MINI APP token. Mini Apps kept the old permission model
 * and are still created at vk.ru/editapp?act=create, outside the VK ID business
 * cabinet. `VKWebAppGetAuthToken` with `scope: "photos,wall"` grants both with
 * no narrowing, and the resulting token reaches the wall upload route from the
 * server. See VK_USER_TOKEN in .env.example for how to mint one.
 *
 * Two limits, both hit in practice:
 *   • The token is IP-BOUND — Code 5, "access_token was given to another ip
 *     address". It works from the porter host; a changed egress IP needs a
 *     fresh token taken from that network.
 *   • VK returns no expiry for it and there is no refresh token, so the
 *     lifetime is UNKNOWN rather than unlimited. When it stops working, an
 *     admin re-opens the Mini App and pastes a new one.
 *
 * Everything here is best-effort: `getVkUserAccessToken()` resolves to `null`
 * when no token is configured, and callers are expected to fall back (post
 * without the picture) rather than error out. A missing photo must never cost
 * a scheduled post.
 *
 * The token is password-grade — it acts as the admin who approved it — so it is
 * never logged, not even truncated.
 */

/**
 * Read on every use, never at import time.
 *
 * `main.ts` calls `dotenv.config()` in its module body, but ESM evaluates every
 * import first — a module-level `process.env.VK_USER_TOKEN` here would be
 * captured before .env is loaded and stay empty for the life of the process.
 * Under compose the variables arrive as real process env and it works by
 * accident, which is exactly how that class of bug hides.
 */
const staticUserToken = (): string => (process.env.VK_USER_TOKEN ?? "").trim();

function fingerprint(token: string): string {
  return crypto.createHash("sha256").update(token).digest("hex").slice(0, 12);
}

/**
 * The live token, and what is known about it.
 *
 * Measured: these tokens carry `expires_in=86400`. A credential with a
 * twenty-four hour life cannot have its home in a file that needs an edit and
 * a container restart to change, so `VK_USER_TOKEN` is demoted to a BOOTSTRAP
 * value and `db/vkuser.json` holds what is actually in use. A replacement can
 * then take effect in-process.
 *
 * `envFingerprint` keeps the demotion from becoming a trap. Without it a
 * stored token would shadow the env var forever, and an operator pasting a
 * fresh token into `.env` would watch it be ignored with no indication why.
 * Recording which env value the store was seeded from means a changed `.env`
 * is recognised as an operator decision and wins.
 */
interface TokenRecord {
  token: string;
  /** ISO. When this token came into our hands — the basis for its age. */
  obtainedAt: string;
  /** ISO, or null when the issuer reported no expiry. */
  expiresAt: string | null;
  source: "env" | "renewal" | "manual";
  /** Fingerprint of VK_USER_TOKEN at the time this record was written. */
  envFingerprint: string | null;
}

const storeFile = (): string =>
  path.resolve(process.env.VK_USER_TOKEN_STORE ?? "./db/vkuser.json");

function readStore(): TokenRecord | null {
  try {
    const parsed = JSON.parse(fs.readFileSync(storeFile(), "utf8")) as TokenRecord;
    return typeof parsed?.token === "string" && parsed.token ? parsed : null;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      logger.warn(`[vk] token store unreadable (${storeFile()}): ${String(error)}`);
    }
    return null;
  }
}

/**
 * Persist a token record, 0600.
 *
 * Failures are LOGGED, never swallowed. The previous implementation returned a
 * string on write failure and said nothing, which is why after weeks of running
 * there was still no recorded lifetime for any token: every write had been
 * failing silently and the report simply read "age unknown".
 */
function writeStore(record: TokenRecord): TokenRecord {
  try {
    fs.mkdirSync(path.dirname(storeFile()), { recursive: true });
    fs.writeFileSync(storeFile(), JSON.stringify(record, null, 2), { mode: 0o600 });
  } catch (error) {
    logger.error(
      `[vk] could not write the token store at ${storeFile()}: ${String(error)}. ` +
        "The token still works this run, but its age cannot be tracked and a " +
        "renewal will not survive a restart. Check the directory is writable " +
        "by the container user.",
    );
  }
  return record;
}

/** The current record: the store, unless `.env` has been changed since. */
function resolve(): TokenRecord | null {
  const env = staticUserToken();
  const stored = readStore();
  const envFp = env ? fingerprint(env) : null;

  if (env && (!stored || stored.envFingerprint !== envFp)) {
    return writeStore({
      token: env,
      obtainedAt: new Date().toISOString(),
      // A token pasted in by hand carries no issue time we can trust, so its
      // expiry is unknown rather than assumed to be a full 24 h out.
      expiresAt: null,
      source: "env",
      envFingerprint: envFp,
    });
  }
  return stored;
}

/**
 * Install a new token and report what the outgoing one managed.
 *
 * The lifetime measurement is the point of recording `obtainedAt`: VK documents
 * nothing about how long these last in practice, so every rotation is the only
 * evidence available.
 */
export function saveVkUserToken(
  token: string,
  expiresInSeconds: number | null,
  source: TokenRecord["source"],
): void {
  const previous = resolve();

  // Asking the exchange early does NOT get you a new token: VK hands back the
  // one you already hold, with less life left on it, and only rotates once it
  // is nearly dead (measured 2026-08-28 — four separate fingerprints, each
  // re-fetched 2-4× across its 15 min without changing).
  //
  // Treating that as an install corrupted the one number the whole watchdog is
  // scaled from. `obtainedAt` is the basis for age, `observedLifetimeHours` is
  // remaining + age, and resetting the clock on an UNCHANGED token made a
  // 15-minute-old grant look newly issued — so the computed lifetime collapsed
  // 0.3 h → 0.1 h → 0.0 h. Every interval here is proportional to that figure,
  // so they all contracted together, polling accelerated, and VK answered 429.
  // The observed cadence (0, 6.6, 10.3, 12.4, 13.9 min — identical in every
  // run) is that spiral, reproduced to within 0.1 min by a model of this code.
  //
  // So: keep the original issue time when the token has not actually changed.
  const unchanged = previous?.token === token;

  if (previous && !unchanged) {
    const lived = (Date.now() - Date.parse(previous.obtainedAt)) / 3_600_000;
    const line =
      `[vk] token replaced (${previous.source} → ${source}). The outgoing one ` +
      `lived ${lived.toFixed(1)} h.`;
    // A renewal→renewal swap is routine bookkeeping: the watchdog re-mints
    // short-lived web_token grants every few minutes, and this line at info
    // would drown the log. It belongs at debug. A change of SOURCE
    // (env/manual → renewal, or a hand install) is an operator-visible event
    // worth keeping at info.
    if (previous.source === "renewal" && source === "renewal") {
      logger.debug(line);
    } else {
      logger.info(line);
    }
  } else if (unchanged) {
    logger.debug(
      "[vk] the exchange returned the token we already hold — keeping its " +
        "original issue time so the measured lifetime stays honest",
    );
  }

  writeStore({
    token,
    obtainedAt: unchanged ? previous.obtainedAt : new Date().toISOString(),
    expiresAt: expiresInSeconds
      ? new Date(Date.now() + expiresInSeconds * 1000).toISOString()
      : null,
    source,
    envFingerprint: previous?.envFingerprint ?? null,
  });
}

export interface VkUserTokenInfo {
  present: boolean;
  source: TokenRecord["source"] | null;
  ageHours: number | null;
  /** Hours until expiry; null when the issuer reported none. */
  remainingHours: number | null;
  expiresAt: string | null;
}

/** What the operator report and the watchdog both need. */
export function vkUserTokenInfo(): VkUserTokenInfo {
  const record = resolve();
  if (!record) {
    return { present: false, source: null, ageHours: null, remainingHours: null, expiresAt: null };
  }
  return {
    present: true,
    source: record.source,
    ageHours: (Date.now() - Date.parse(record.obtainedAt)) / 3_600_000,
    remainingHours: record.expiresAt
      ? (Date.parse(record.expiresAt) - Date.now()) / 3_600_000
      : null,
    expiresAt: record.expiresAt,
  };
}

/** Human-readable age of the current token. */
export function tokenAge(_token?: string): string {
  const { present, ageHours } = vkUserTokenInfo();
  if (!present || ageHours === null) return "age unknown";
  return ageHours < 48
    ? `obtained ${ageHours.toFixed(1)} h ago`
    : `obtained ${(ageHours / 24).toFixed(1)} days ago`;
}

/** Whether a user token is available at all. */
export function isVkUserConfigured(): boolean {
  return resolve() !== null;
}

/** The user token, or null when none is configured. */
export async function getVkUserAccessToken(): Promise<string | null> {
  // A token we believe expired is still returned: the computed expiry depends
  // on this host's clock, and VK's own answer is the authority. Better one
  // wasted call with a definitive error than a self-inflicted outage.
  return resolve()?.token ?? null;
}

/**
 * Upload artwork as a real wall photo and return its attachment string.
 *
 * Returns null whenever the photo cannot be attached — no token, a dead token,
 * a rejected upload — so callers post text-only rather than losing the post.
 * `groupId` is the POSITIVE community id, which is the spelling VK's photo
 * methods use.
 */
export async function uploadWallPhoto(
  source: Buffer | string,
  groupId: number,
): Promise<string | null> {
  const token = await getVkUserAccessToken();
  if (!token) return null;

  try {
    const vk = new VK({ token });
    const photo = await vk.upload.wallPhoto({
      source: { value: source as never },
      group_id: groupId,
    });
    const { ownerId, id, accessKey } = photo as unknown as {
      ownerId: number;
      id: number;
      accessKey?: string;
    };
    return `photo${ownerId}_${id}${accessKey ? `_${accessKey}` : ""}`;
  } catch (error) {
    const err = error as { code?: number; message?: string };
    if (err?.code === 5) {
      // Code 5 has several distinct causes with OPPOSITE fixes, and VK spells
      // out which in the message. Log it verbatim — guessing here sent a
      // previous investigation after the wrong one.
      //
      //   "...was given to another ip address" → egress IP moved; mint a token
      //       from the network porter actually calls VK from.
      //   "invalid access_token (4)"           → expired or revoked; mint a new
      //       one, and note how long the old one lasted.
      const said = err.message ?? "(no message)";
      const cause = /another ip address/i.test(said)
        ? "IP MISMATCH — the token was issued from a different egress IP"
        : /invalid access_token/i.test(said)
          ? "TOKEN DEAD — expired or revoked, not an IP problem"
          : "unrecognised Code 5 variant";
      logger.error(
        `[vk] wall photo upload failed — ${cause}. VK said: "${said}". ` +
          `Token ${tokenAge(token)}. Diagnose with \`npm run vkuserprobe\` ` +
          "(run it INSIDE the container: docker compose exec porter " +
          "npm run vkuserprobe). Posting text-only.",
      );
    } else {
      logger.error(
        `[vk] wall photo upload failed: Code ${err?.code ?? "?"} — ` +
          `${err?.message ?? String(error)}`,
      );
    }
    return null;
  }
}

/** One-line status for the boot log; deliberately says nothing about values. */
export function vkUserStatus(): string {
  const info = vkUserTokenInfo();
  if (!info.present) return "no user token — posts will go out text-only";

  const left =
    info.remainingHours === null
      ? "expiry unknown"
      : info.remainingHours > 0
        ? `${info.remainingHours.toFixed(1)} h left`
        : "EXPIRED";
  return `user token from ${info.source} — wall photos enabled (${tokenAge()}, ${left})`;
}
