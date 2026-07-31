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

const PorterConfig: Config = {
  loggingLevel: "debug",

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
