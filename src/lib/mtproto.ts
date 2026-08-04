import fs from "fs";
import path from "path";
import type { ITelegramStorageProvider } from "@mtcute/core";
import type {
  TelegramClient,
  TelegramClientOptions,
} from "@mtcute/core/client.js";
import { PorterConfig as config } from "../../porter.config";
import logger from "@/lib/logger";

/**
 * A single MTProto authorization living alongside the Bot API bot.
 *
 * Porter talks to Telegram through grammY (Bot API) for everything it can, but
 * a handful of capabilities exist only in MTProto — listing every member of a
 * supergroup being the one we need. Rather than rewrite the bot, we keep a
 * second, read-only client here and let feature modules ask for it.
 *
 * Everything about this module is best-effort: `getMtprotoClient()` resolves to
 * `null` when MTProto is not configured or the sign-in failed, and callers are
 * expected to fall back rather than error out.
 */

/**
 * The platform client, plus the console-input helper both platform packages
 * add on top of the core class (used by the interactive login script).
 */
export type MtprotoClient = TelegramClient & {
  input(text: string): Promise<string>;
  destroy(): Promise<void>;
};

/**
 * mtcute ships one package per runtime, and they are not interchangeable:
 * `@mtcute/node` stores its session through better-sqlite3, which Bun cannot
 * dlopen at all, while `@mtcute/bun` reaches for `bun:sqlite`, which Node has
 * never heard of. Porter is started either way (`npm start` uses tsx, the
 * deployment uses bun), so pick at runtime and keep both as dependencies. The
 * import has to stay dynamic — a static one would drag the wrong native
 * binding in on module load.
 */
const isBun = typeof (globalThis as { Bun?: unknown }).Bun !== "undefined";

/** Build an unconnected client on the platform package for this runtime. */
export async function createMtprotoClient(
  opts: TelegramClientOptions,
): Promise<MtprotoClient> {
  const platform = isBun
    ? await import("@mtcute/bun")
    : await import("@mtcute/node");
  return new platform.TelegramClient(opts) as MtprotoClient;
}

/**
 * Session storage for this runtime.
 *
 * Passing a bare path would make mtcute resolve its own default provider,
 * which is the very thing that differs between the two packages — so hand it
 * the platform's own implementation explicitly.
 */
async function createStorage(file: string): Promise<ITelegramStorageProvider> {
  const platform = isBun
    ? await import("@mtcute/bun")
    : await import("@mtcute/node");
  return new platform.SqliteStorage(file);
}

/** Shared across the process — connecting twice would burn a second session. */
let clientPromise: Promise<MtprotoClient | null> | null = null;
let connected: MtprotoClient | null = null;

/** Whether credentials are present at all. Cheap; safe to call anywhere. */
export function isMtprotoConfigured(): boolean {
  return config.mtproto?.enabled === true;
}

async function connect(): Promise<MtprotoClient | null> {
  const mt = config.mtproto;
  if (!mt?.enabled) return null;

  if (!mt.session && !mt.botToken) {
    logger.warn(
      "[mtproto] no MTPROTO_SESSION and no bot token — nothing to sign in with",
    );
    return null;
  }

  const storagePath = path.resolve(mt.storagePath);
  fs.mkdirSync(path.dirname(storagePath), { recursive: true });

  const tg = await createMtprotoClient({
    apiId: mt.apiId,
    apiHash: mt.apiHash,
    storage: await createStorage(storagePath),
    // Porter already long-polls the Bot API. A second authorization pulling
    // updates would race that queue and could swallow messages, so wrap every
    // call in `invokeWithoutUpdates` and never build an updates manager.
    disableUpdates: true,
  });

  try {
    // `start` short-circuits on an already-authorized storage, so the session
    // string / bot token only matters on the very first run.
    const self = mt.session
      ? await tg.start({ session: mt.session })
      : await tg.start({ botToken: mt.botToken });

    logger.info(
      `[mtproto] signed in as ${self.displayName} (id ${self.id}, bot: ${self.isBot})`,
    );
    connected = tg;
    return tg;
  } catch (error) {
    logger.error(`[mtproto] sign-in failed: ${String(error)}`);
    await tg.destroy().catch(() => {});
    // Clear the memo so a transient network failure at boot doesn't disable
    // the capability for the rest of the process lifetime.
    clientPromise = null;
    return null;
  }
}

/**
 * The signed-in client, connecting on first use.
 *
 * @returns the client, or `null` when MTProto is unavailable — never throws.
 */
export function getMtprotoClient(): Promise<MtprotoClient | null> {
  if (!isMtprotoConfigured()) return Promise.resolve(null);
  clientPromise ??= connect();
  return clientPromise;
}

/** Tear the connection down. Safe to call when nothing was ever connected. */
export async function closeMtproto(): Promise<void> {
  const tg = connected;
  connected = null;
  clientPromise = null;
  if (!tg) return;

  try {
    await tg.destroy();
    logger.info("[mtproto] disconnected");
  } catch (error) {
    logger.warn(`[mtproto] disconnect failed: ${String(error)}`);
  }
}
