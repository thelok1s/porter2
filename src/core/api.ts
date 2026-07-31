import { API, VK } from "vk-io";

/**
 * VK and shared identifier clients.
 *
 * NOTE: This file intentionally holds ONLY the VK clients and Telegram
 * identifiers — not the grammY Bot. The bot instance lives in `@/core/bot`.
 * Keeping them separate means VK-touching code depends on `@/core/api` while
 * Telegram-touching code depends on `@/core/bot`, making the boundary explicit.
 */

if (!process.env.VK_TOKEN) {
  throw new Error("VK_TOKEN is not provided");
}

export const vkGroupApi = new VK({ token: process.env.VK_TOKEN });
export const vkGlobalApi = new API({ token: process.env.VK_TOKEN });

// Telegram identifiers (validated comprehensively in main.ts).
export const tgChannelId = process.env.TELEGRAM_CHANNEL_ID!;
export const tgChatId = process.env.TELEGRAM_CHAT_ID!;
export const tgChannelPublicLink = process.env.TELEGRAM_CHANNEL_PUBLIC_LINK!;
