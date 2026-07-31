import { Bot, Context, SessionFlavor } from "grammy";

const token = process.env.TELEGRAM_TOKEN;
if (!token) {
  // Full environment validation lives in main.ts; fail loud here so a missing
  // token is never silently swallowed during module import.
  throw new Error("TELEGRAM_TOKEN is not set");
}

/**
 * Per-session data. The baseline is intentionally empty; feature modules may
 * extend this interface via declaration merging if they need session state.
 */
// Empty on purpose: a declaration-merge extension point that feature modules
// may augment with their own session fields.
// eslint-disable-next-line @typescript-eslint/no-empty-object-type
export interface SessionData {
  // baseline — modules may add fields
}

/**
 * Shared bot context type used by every module Composer. Session middleware is
 * installed once in main.ts before any module is mounted.
 */
export type BotContext = Context & SessionFlavor<SessionData>;

/**
 * The single grammY Bot instance for the whole process. Modules import this to
 * call `bot.api.*` for outbound messages; handlers receive a `BotContext` and
 * use `ctx.*` / `ctx.api.*`.
 */
export const bot = new Bot<BotContext>(token);
