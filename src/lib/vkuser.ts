import fs from "fs";
import path from "path";
import crypto from "crypto";
import { VK } from "vk-io";
import logger from "@/lib/logger";

/**
 * A VK *user* authorization living alongside the community token.
 *
 * Porter talks to VK with a community token for everything it can, but one
 * capability is closed to community auth by design: putting a PHOTO on a wall
 * post. `photos.getWallUploadServer` and `photos.saveWallPhoto` answer Code 27
 * ("method is unavailable with group auth") no matter which rights the token
 * carries, and VK's own access-rights reference lists community scopes as only
 * stories/photos/app_widget/messages/docs/manage. Every community-token route
 * was tried and measured against the live wall:
 *
 *   • messages upload server — uploads fine and `wall.post` ACCEPTS the
 *     attachment, but VK strips it on publish; those photos live in album -3,
 *     which wall posts may not reference. Confirmed six times.
 *   • wall document server — the one attachment that survives, but VK refuses
 *     files it recognises as images, so artwork can only ride as an
 *     unrecognised blob and renders as a "file0.dat" download link.
 *   • an Open Graph link snippet — VK answers "link_photo_sizing_rule. No photo
 *     given" even for a publicly reachable card with a 1080x1080 og:image.
 *
 * So a user token is genuinely the only route, and this module makes holding
 * one safe and unattended.
 *
 * Everything here is best-effort: `getVkUserAccessToken()` resolves to `null`
 * when VK ID is not configured or the grant has been revoked, and callers are
 * expected to fall back (post without the picture) rather than error out.
 *
 * Security notes:
 *   • The refresh token is password-grade — anyone holding it can act as the
 *     signing account within its scopes. It is stored 0600 under ./db (a
 *     persisted, gitignored volume) and is never logged, not even truncated.
 *   • PKCE means there is no client_secret to protect.
 *   • Ask for `photos` and `wall` only. Both are ordinary scopes; the ones
 *     needing VK's individual approval are phone/email/messages.
 */

/** VK ID OAuth 2.1 endpoints. */
export const VKID_AUTHORIZE_URL = "https://id.vk.ru/authorize";
export const VKID_TOKEN_URL = "https://id.vk.ru/oauth2/auth";

/** Everything porter needs and nothing else. */
export const VKID_SCOPE = "photos wall";

const APP_ID = (process.env.VKID_APP_ID ?? "").trim();
const REDIRECT_URI = (process.env.VKID_REDIRECT_URI ?? "").trim();

const TOKEN_FILE = path.resolve(
  process.env.VKID_TOKEN_FILE ?? "./db/vkid.json",
);

/**
 * Renew this long before expiry. VK ID access tokens live about an hour; a
 * generous skew means a slow upload never starts with a token that dies
 * mid-request.
 */
const EXPIRY_SKEW_MS = 5 * 60 * 1000;

interface VkIdStore {
  /** Password-grade. Rotates on every refresh — always persist the new one. */
  refreshToken: string;
  /** VK ID binds the grant to this; refresh fails without the original. */
  deviceId: string;
  userId: number;
  scope: string;
  accessToken?: string;
  /** Epoch ms. */
  accessExpiresAt?: number;
  updatedAt: string;
}

/** True when an operator has configured the app and completed the login. */
export function isVkUserConfigured(): boolean {
  return APP_ID !== "" && fs.existsSync(TOKEN_FILE);
}

export function vkUserTokenFile(): string {
  return TOKEN_FILE;
}

function readStore(): VkIdStore | null {
  try {
    return JSON.parse(fs.readFileSync(TOKEN_FILE, "utf8")) as VkIdStore;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      logger.error(`[vkid] cannot read ${TOKEN_FILE}: ${String(error)}`);
    }
    return null;
  }
}

/**
 * Persist atomically and 0600.
 *
 * Written to a temp file and renamed so a crash mid-write cannot leave a
 * truncated store — losing the refresh token means a human has to redo the
 * browser login, so this is worth the care. The mode is set on the temp file
 * BEFORE the rename, so the token is never briefly world-readable.
 */
export function writeStore(store: VkIdStore): void {
  const dir = path.dirname(TOKEN_FILE);
  fs.mkdirSync(dir, { recursive: true });
  const tmp = `${TOKEN_FILE}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(store, null, 2), { mode: 0o600 });
  fs.chmodSync(tmp, 0o600);
  fs.renameSync(tmp, TOKEN_FILE);
}

/** A state value satisfying VK ID's "at least 32 chars of [a-zA-Z0-9_-]". */
export function randomState(): string {
  return crypto.randomBytes(32).toString("base64url");
}

/** PKCE verifier plus its S256 challenge. */
export function createPkce(): { verifier: string; challenge: string } {
  const verifier = crypto.randomBytes(48).toString("base64url");
  const challenge = crypto
    .createHash("sha256")
    .update(verifier)
    .digest("base64url");
  return { verifier, challenge };
}

/** The URL an administrator opens once, in a browser, to grant access. */
export function buildAuthorizeUrl(challenge: string, state: string): string {
  const params = new URLSearchParams({
    response_type: "code",
    client_id: APP_ID,
    redirect_uri: REDIRECT_URI,
    scope: VKID_SCOPE,
    state,
    code_challenge: challenge,
    code_challenge_method: "S256",
  });
  return `${VKID_AUTHORIZE_URL}?${params.toString()}`;
}

interface TokenResponse {
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
  user_id?: number;
  scope?: string;
  error?: string;
  error_description?: string;
}

/**
 * Post to VK ID's token endpoint.
 *
 * Errors carry only VK's `error`/`error_description` — never the request body,
 * which holds the refresh token or the authorization code.
 */
async function postToken(
  body: Record<string, string>,
): Promise<TokenResponse> {
  const res = await fetch(VKID_TOKEN_URL, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(body).toString(),
  });

  const json = (await res.json().catch(() => ({}))) as TokenResponse;
  if (!res.ok || json.error || !json.access_token) {
    throw new Error(
      `VK ID ${res.status}: ${json.error ?? "unknown"}` +
        (json.error_description ? ` — ${json.error_description}` : ""),
    );
  }
  return json;
}

function storeFromResponse(
  token: TokenResponse,
  deviceId: string,
  previous?: VkIdStore,
): VkIdStore {
  return {
    // VK ID rotates the refresh token on every use; keeping the old one would
    // work exactly once and then lock us out.
    refreshToken: token.refresh_token ?? previous?.refreshToken ?? "",
    deviceId,
    userId: token.user_id ?? previous?.userId ?? 0,
    scope: token.scope ?? previous?.scope ?? VKID_SCOPE,
    accessToken: token.access_token,
    accessExpiresAt: Date.now() + (token.expires_in ?? 3600) * 1000,
    updatedAt: new Date().toISOString(),
  };
}

/** Exchange the one-time authorization code. Used by the login script. */
export async function exchangeCode(
  code: string,
  codeVerifier: string,
  deviceId: string,
): Promise<VkIdStore> {
  const token = await postToken({
    grant_type: "authorization_code",
    code,
    code_verifier: codeVerifier,
    client_id: APP_ID,
    device_id: deviceId,
    redirect_uri: REDIRECT_URI,
  });
  return storeFromResponse(token, deviceId);
}

/**
 * Serialises refreshes.
 *
 * The refresh token rotates on use, so two concurrent refreshes race: the
 * second presents a token the first already spent, VK rejects it, and the
 * stored grant is dead until someone repeats the browser login. Publishing an
 * announcement while a submission is being approved is enough to trigger that,
 * so every caller waits on the same promise.
 */
let inflight: Promise<string | null> | null = null;

async function refreshAccessToken(store: VkIdStore): Promise<string | null> {
  try {
    const token = await postToken({
      grant_type: "refresh_token",
      refresh_token: store.refreshToken,
      client_id: APP_ID,
      device_id: store.deviceId,
      state: randomState(),
    });
    const next = storeFromResponse(token, store.deviceId, store);
    writeStore(next);
    logger.info("[vkid] access token refreshed");
    return next.accessToken ?? null;
  } catch (error) {
    logger.error(
      `[vkid] refresh failed: ${String(error)} — photo uploads are disabled ` +
        "until `npm run vkidlogin` is run again",
    );
    return null;
  }
}

/**
 * A valid user access token, or null when unavailable.
 *
 * Null is a normal outcome, not an exception: VK ID is optional, the grant can
 * be revoked from the account's app settings at any time, and callers are
 * expected to carry on without the picture.
 */
export async function getVkUserAccessToken(): Promise<string | null> {
  if (!APP_ID) return null;

  const store = readStore();
  if (!store?.refreshToken) return null;

  if (
    store.accessToken &&
    store.accessExpiresAt &&
    store.accessExpiresAt - EXPIRY_SKEW_MS > Date.now()
  ) {
    return store.accessToken;
  }

  if (!inflight) {
    inflight = refreshAccessToken(store).finally(() => {
      inflight = null;
    });
  }
  return inflight;
}

/**
 * Upload artwork as a real wall photo and return its attachment string.
 *
 * Returns null whenever the photo cannot be attached — no VK ID grant, a
 * revoked token, a rejected upload — so callers post text-only rather than
 * losing the post. `groupId` is the POSITIVE community id, which is the
 * spelling VK's photo methods use.
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
    logger.error(`[vkid] wall photo upload failed: ${String(error)}`);
    return null;
  }
}

/** One-line status for the boot log; deliberately says nothing about values. */
export function vkUserStatus(): string {
  if (!APP_ID) return "not configured (VKID_APP_ID unset)";
  const store = readStore();
  if (!store?.refreshToken) return `no grant stored — run \`npm run vkidlogin\``;
  return `authorized as user ${store.userId}, scope "${store.scope}"`;
}
