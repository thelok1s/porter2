import { Config } from "@/types/Config";

/**
 * Application configuration.
 *
 * Behavioral flags (what's enabled, origins, limits) live here as committed
 * defaults. Deployment-specific values — chat IDs, the VK group, the API key,
 * ports, public URLs — are read from the environment so the same code runs in
 * any environment without editing this file.
 *
 * (Under `bun`, .env is auto-loaded before modules evaluate, so these
 * process.env reads see .env values at import time.)
 */

const num = (v: string | undefined, fallback: number): number => {
  const n = v ? Number(v) : NaN;
  return Number.isFinite(n) ? n : fallback;
};

const topicRaw = process.env.MODERATION_TOPIC_ID;
const moderationTopicId =
  topicRaw && Number.isFinite(Number(topicRaw)) ? Number(topicRaw) : undefined;

// MTProto is opt-in and self-describing: supplying credentials turns it on.
// Without api_id/api_hash there is nothing to connect with, so the whole
// section collapses to `{ enabled: false }` and callers fall back.
// `??` is the wrong operator for these: a key that is present but blank in
// .env reads as "" rather than undefined, which would sail past a nullish
// fallback (a blank MTPROTO_SESSION_FILE once resolved to the working
// *directory*, which SQLite reports as "unable to open database file").
const str = (v: string | undefined, fallback = ""): string =>
  (v ?? "").trim() || fallback;

const mtprotoApiId = num(process.env.MTPROTO_API_ID, 0);
const mtprotoApiHash = str(process.env.MTPROTO_API_HASH);
const mtprotoSession = str(process.env.MTPROTO_SESSION);

const PorterConfig: Config = {
  loggingLevel: "debug",

  mtproto:
    mtprotoApiId > 0 && mtprotoApiHash !== ""
      ? {
          enabled: true,
          apiId: mtprotoApiId,
          apiHash: mtprotoApiHash,
          session: mtprotoSession || undefined,
          botToken: process.env.TELEGRAM_TOKEN,
          storagePath: str(
            process.env.MTPROTO_SESSION_FILE,
            "./db/mtproto.session",
          ),
        }
      : { enabled: false },

  crossposting: {
    enabled: true,
    origin: "vk",
    parameters: {
      ignoreReposts: true,
      ignorePolls: false,
    },
  },

  crosscommenting: {
    enabled: true,
    origin: "both",
  },

  // The VK user token expires every 24h (measured: expires_in=86400) and its
  // failure is silent — posts keep publishing, just without their photo. On by
  // default: it reports to SUPER_ADMIN_ID alone and reveals no credential.
  vkToken: {
    watch: true,
    intervalMinutes: 30,
    warnBeforeHours: 6,
  },

  // Operator status readout. Off by default — it reports on live credentials
  // and infrastructure, so exposing it should be a choice, not an inheritance.
  health: {
    enabled: false,
    allowInGroups: true,
  },

  api: {
    enabled: true,
    port: num(process.env.PORTER_API_PORT ?? process.env.API_PORT, 5050),
    apiKey: process.env.PORTER_API_KEY ?? process.env.API_KEY ?? "changeme",
    submissions: {
      enabled: true,
      // Telegram chat id (with -100 prefix) that receives moderation messages.
      moderationChatId: process.env.MODERATION_CHAT_ID ?? "",
      moderationTopicId,
      // VK group to publish to. Must be NEGATIVE (e.g. -228995635).
      vkGroupId: process.env.VK_GROUP_ID,
    },
    imageServer: {
      enabled: true,
      publicUrl: process.env.PORTER_PUBLIC_URL ?? "127.0.0.1/",
      uploadsDir: "./uploads",
      fallbackToBuffer: true,
      maxAgeHours: 24,
    },
  },
};

export { PorterConfig };
