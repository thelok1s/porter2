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

/**
 * Canonical channel id, always in Telegram's full `-100…` form.
 *
 * Two spellings are in circulation and both are "right" somewhere: Bot API
 * methods and `forward_from_chat.id` use `-1002321540352`, while most UIs show
 * the bare `2321540352`. TELEGRAM_CHAT_ID next to it holds the full form, so
 * the pair reads as inconsistent whichever way you set it.
 *
 * Normalising here rather than at each call site, because the failure is
 * misleading: passing the bare form to sendMessage returns "400: Bad Request:
 * chat not found", which reads like the bot was removed from the channel
 * rather than like a formatting problem. Accepts either spelling so a value
 * copied from .env.example (which documents the prefixed form) works too.
 */
function toFullChannelId(raw: string | undefined): string {
  const v = (raw ?? "").trim();
  if (!v) return "";
  return v.startsWith("-100") ? v : `-100${v.replace(/^-/, "")}`;
}

// Telegram identifiers (validated comprehensively in main.ts).
export const tgChannelId = toFullChannelId(process.env.TELEGRAM_CHANNEL_ID);
export const tgChatId = process.env.TELEGRAM_CHAT_ID!;
export const tgChannelPublicLink = process.env.TELEGRAM_CHANNEL_PUBLIC_LINK!;
