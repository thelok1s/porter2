import { Composer } from "grammy";
import { bot } from "@/core/bot";
import type { BotContext } from "@/core/bot";
import logger from "@/lib/logger";

// ── Committed core module ─────────────────────────────────────────────────
import porter from "@/porter";

// ── Private local modules (gitignored under local/) ───────────────────────
import allCommand from "@local/all-command";
import frontend from "@local/frontend";

/**
 * A feature module. The simplest module just default-exports a `Composer`
 * (commands/callbacks). Modules with side effects (VK polling, an HTTP server)
 * export this object instead, with optional lifecycle hooks.
 */
export interface ModuleDefinition {
  name: string;
  composer?: Composer<BotContext>;
  /** Called after DB init, before the bot starts. */
  init?: () => Promise<void> | void;
  /** Called after the bot is launched. Start servers/polling here. */
  start?: () => Promise<void> | void;
  /** Called on shutdown, in reverse mount order. */
  stop?: () => Promise<void> | void;
}

/** A module's default export: either a bare Composer or a ModuleDefinition. */
type ModuleExport = Composer<BotContext> | Omit<ModuleDefinition, "name">;

function normalize(name: string, exp: ModuleExport): ModuleDefinition {
  if (exp instanceof Composer) return { name, composer: exp };
  return { name, ...exp };
}

/**
 * Ordered module manifest.
 *
 * ORDERING RATIONALE — grammY's filter middleware (e.g. `Composer.command`)
 * automatically falls through to `next()` for updates it does not match, so a
 * command/callback-scoped module transparently passes everything it doesn't
 * own to the next module. Porter's message handler is terminal for
 * discussion-chat messages, so any message-aware feature MUST be mounted before
 * `porter`. Command-only modules can sit anywhere; we keep a single explicit
 * order for clarity.
 */
const MODULES: ModuleDefinition[] = [
  normalize("all-command", allCommand), // commands only → falls through
  normalize("porter", porter), // crossposting / crosscommenting
  normalize("frontend", frontend), // Express API + moderation callbacks
];

/** Run every module's init hook (after DB init, before launch). */
export async function initModules(): Promise<void> {
  for (const m of MODULES) {
    if (m.init) {
      await m.init();
      logger.info(`[modules] init: ${m.name}`);
    }
  }
}

/** Mount every module's Composer onto the bot in declaration order. */
export function mountModules(): void {
  for (const m of MODULES) {
    if (m.composer) {
      bot.use(m.composer);
      logger.info(`[modules] mounted: ${m.name}`);
    } else {
      logger.info(`[modules] ${m.name} (no composer)`);
    }
  }
}

/** Start every module (servers / polling), in declaration order. */
export async function startModules(): Promise<void> {
  for (const m of MODULES) {
    if (m.start) {
      await m.start();
      logger.info(`[modules] started: ${m.name}`);
    }
  }
}

/** Stop every module in reverse order (LIFO) for a clean shutdown. */
export async function stopModules(): Promise<void> {
  for (let i = MODULES.length - 1; i >= 0; i--) {
    const m = MODULES[i];
    if (!m.stop) continue;
    try {
      await m.stop();
      logger.info(`[modules] stopped: ${m.name}`);
    } catch (error) {
      logger.error(`[modules] error stopping ${m.name}: ${String(error)}`);
    }
  }
}
