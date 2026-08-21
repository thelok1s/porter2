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
 * one safe and unattended. It is NOT, however, a route that works by default —
 * see "The permission wall" below before spending time here.
 *
 * The permission wall
 * -------------------
 * VK states the requirement on the method pages themselves. Both
 * `photos.getWallUploadServer` and `photos.getUploadServer` say a user token is
 * the only caller and that the `photos` right is "выдаётся в исключительных
 * случаях через запрос в поддержку по электронной почте devsupport@corp.vk.com"
 * — granted in exceptional cases, by email request. `wall.post` says the same
 * of the `wall` right.
 *
 * Measured against a real grant (`npm run vkidprobe`), on an app created in the
 * VK ID cabinet without business verification:
 *
 *   • the consent screen offers only «Общая информация», and the grant comes
 *     back as `vkid.personal_info` — VK narrows the request silently rather
 *     than rejecting an over-broad scope;
 *   • photos.getWallUploadServer → Code 15, "cannot be called with current
 *     scopes";
 *   • photos.getUploadServer (the community-album idea, floated as a way round
 *     the wall route) → Code 1051, and its method page carries the identical
 *     `photos` requirement. It is not an alternative;
 *   • wall.get works, so the token is live and the community readable.
 *
 * Code 1051 ("method is unavailable with current profile type") is absent from
 * VK's published error table, which stops at 603. Do not read much into it.
 *
 * The escalation path is therefore singular: confirm a VK Бизнес ID profile
 * (requires an ИНН), then email devsupport@corp.vk.com asking for `photos` and
 * `wall` with a justification. Until that lands, posts go out text-only and
 * this module reports the shortfall instead of pretending to work.
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
 *   • Ask for `photos` and `wall` only — nothing wider. Both are gated behind
 *     an individual support request (see "The permission wall"), so a grant
 *     that comes back narrower is the normal case, not a malfunction.
 */

/** VK ID OAuth 2.1 endpoints. */
export const VKID_AUTHORIZE_URL = "https://id.vk.ru/authorize";
export const VKID_TOKEN_URL = "https://id.vk.ru/oauth2/auth";

/** Everything porter needs and nothing else. */
export const VKID_SCOPE = "photos wall";

/**
 * What an upload actually needs. VK ID narrows the grant to whatever the app
 * is allowed in its Доступы settings and reports the result in `scope` — it
 * does NOT reject an over-broad request. Ask for `photos wall` on an app that
 * may not have them and you get back `vkid.personal_info` with no error, so
 * the shortfall has to be detected here or it stays invisible until a post
 * silently goes out without its picture.
 */
export function missingScopes(scope: string): string[] {
  const granted = new Set(scope.split(/\s+/).filter(Boolean));
  return ["photos", "wall"].filter((s) => !granted.has(s));
}

/**
 * Read on every use, never at import time.
 *
 * An entrypoint calls `dotenv.config()` in its module body, but ESM evaluates
 * every import first — so a module-level `process.env.VKID_APP_ID` here is
 * captured before the .env file is loaded and stays empty for the life of the
 * process. Under compose the variables arrive as real process env and it works
 * by accident, which is exactly how this hid: it only broke for the one
 * entrypoint that depends on dotenv, `npm run vkidlogin`, where it silently
 * built an authorize URL with `client_id=` blank.
 */
const appId = (): string => (process.env.VKID_APP_ID ?? "").trim();
const redirectUri = (): string => (process.env.VKID_REDIRECT_URI ?? "").trim();
const tokenFile = (): string =>
  path.resolve(process.env.VKID_TOKEN_FILE ?? "./db/vkid.json");

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
  return appId() !== "" && fs.existsSync(tokenFile());
}

export function vkUserTokenFile(): string {
  return tokenFile();
}

function readStore(): VkIdStore | null {
  try {
    return JSON.parse(fs.readFileSync(tokenFile(), "utf8")) as VkIdStore;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      logger.error(`[vkid] cannot read ${tokenFile()}: ${String(error)}`);
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
  const file = tokenFile();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(store, null, 2), { mode: 0o600 });
  fs.chmodSync(tmp, 0o600);
  fs.renameSync(tmp, file);
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
    client_id: appId(),
    redirect_uri: redirectUri(),
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
  state: string,
): Promise<VkIdStore> {
  const token = await postToken({
    grant_type: "authorization_code",
    code,
    code_verifier: codeVerifier,
    client_id: appId(),
    device_id: deviceId,
    redirect_uri: redirectUri(),
    // VK ID lists state as required here, not just on /authorize, and it must
    // be the value the authorization started with.
    state,
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
      client_id: appId(),
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
  if (!appId()) return null;

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
  const store = readStore();
  if (store) {
    const missing = missingScopes(store.scope);
    if (missing.length > 0) {
      // Doomed before it starts — VK would answer Code 27/15. Say why once,
      // rather than letting a generic upload failure hide a settings problem.
      logger.warn(
        `[vkid] skipping photo upload: grant lacks ${missing.join(" and ")} ` +
          `(granted "${store.scope}"). These are extended rights — enable them ` +
          "in the app's Доступы, then re-run `npm run vkidlogin`.",
      );
      return null;
    }
  }

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
  if (!appId()) return "not configured (VKID_APP_ID unset)";
  const store = readStore();
  if (!store?.refreshToken) return `no grant stored — run \`npm run vkidlogin\``;
  const missing = missingScopes(store.scope);
  if (missing.length > 0) {
    return (
      `grant for user ${store.userId} is MISSING ${missing.join(" and ")} ` +
      `(granted: "${store.scope}") — photo uploads stay disabled`
    );
  }
  return `authorized as user ${store.userId}, scope "${store.scope}"`;
}
