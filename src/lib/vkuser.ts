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

/**
 * First-use bookkeeping, so "how long do these tokens live?" stops being a
 * guess.
 *
 * VK returns no expiry for a Mini App token, so the only way to learn the
 * lifetime is to measure it: record when a given token was first seen and
 * report its age when it dies. Stores a SHA-256 prefix, never the token — the
 * fingerprint is enough to notice rotation and useless to anyone who reads it.
 */
const metaFile = (): string =>
  path.resolve(process.env.VK_USER_TOKEN_META ?? "./db/vktoken.json");

function fingerprint(token: string): string {
  return crypto.createHash("sha256").update(token).digest("hex").slice(0, 12);
}

interface TokenMeta {
  fingerprint: string;
  firstSeen: string;
}

function readMeta(): TokenMeta | null {
  try {
    return JSON.parse(fs.readFileSync(metaFile(), "utf8")) as TokenMeta;
  } catch {
    return null;
  }
}

/** Age of the current token, recording first sight if this one is new. */
export function tokenAge(token: string): string {
  const fp = fingerprint(token);
  let meta = readMeta();
  if (meta?.fingerprint !== fp) {
    meta = { fingerprint: fp, firstSeen: new Date().toISOString() };
    try {
      fs.mkdirSync(path.dirname(metaFile()), { recursive: true });
      fs.writeFileSync(metaFile(), JSON.stringify(meta, null, 2), {
        mode: 0o600,
      });
    } catch {
      return "age unknown (could not record first use)";
    }
  }
  const hours = (Date.now() - Date.parse(meta.firstSeen)) / 3_600_000;
  return hours < 48
    ? `first seen ${hours.toFixed(1)} h ago`
    : `first seen ${(hours / 24).toFixed(1)} days ago`;
}

/** Whether a user token is available at all. */
export function isVkUserConfigured(): boolean {
  return staticUserToken() !== "";
}

/** The user token, or null when none is configured. */
export async function getVkUserAccessToken(): Promise<string | null> {
  return staticUserToken() || null;
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
  const token = staticUserToken();
  return token
    ? `VK_USER_TOKEN set — wall photos enabled (${tokenAge(token)})`
    : "no VK_USER_TOKEN — posts will go out text-only";
}
