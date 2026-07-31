import dotenv from "dotenv";
import { session } from "grammy";
import { GrammyError } from "grammy";
import { bot } from "@/core/bot";
import { initDatabase, closeDatabase } from "@/lib/sequelize";
import {
  initModules,
  mountModules,
  startModules,
  stopModules,
} from "@/core/module-loader";
import { appFiglet } from "@/utils/appFiglet";
import logger from "@/lib/logger";

dotenv.config();

const REQUIRED_ENV = [
  "VK_TOKEN",
  "TELEGRAM_TOKEN",
  "TELEGRAM_CHANNEL_ID",
  "TELEGRAM_CHANNEL_PUBLIC_LINK",
  "TELEGRAM_CHAT_ID",
] as const;

for (const key of REQUIRED_ENV) {
  if (!process.env[key]) {
    logger.fatal(`Environment variable ${key} is not set. Exiting.`);
    process.exit(1);
  }
}

async function main(): Promise<void> {
  await initDatabase();

  // Populate bot.botInfo early so /api/status can report it before/without polling.
  await bot.init();

  // Central error handler for any update that throws.
  bot.catch((err) => {
    const { ctx } = err;
    const updateId = ctx.update?.update_id;
    if (err.error instanceof GrammyError) {
      logger.error(
        `[bot] Telegram API error on update ${updateId}: ${err.error.description}`,
      );
    } else {
      logger.error(
        `[bot] error on update ${updateId}: ${
          err.error instanceof Error ? err.error.stack ?? err.error.message : String(err.error)
        }`,
      );
    }
  });

  // Session middleware (installed before any module that may use ctx.session).
  bot.use(session({ initial: () => ({}) }));

  await initModules();
  mountModules();
  appFiglet();

  // Start side-effectful modules (VK long-polling, Express API) BEFORE the
  // blocking bot.start().
  await startModules();

  logger.info("Bot started successfully (･ω<)☆");

  // bot.start() blocks until bot.stop(); run it un-awaited so signal handlers
  // can still fire and trigger a clean shutdown.
  bot.start().catch((error) => {
    logger.error(`[bot] start failed: ${String(error)}`);
    process.exit(1);
  });
}

main().catch((error) => {
  logger.error({ error });
  process.exit(1);
});

// ── Graceful shutdown ──────────────────────────────────────────────────────

let shuttingDown = false;

async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.warn(`Shutting down (${signal})`);
  try {
    bot.stop();
    await stopModules(); // LIFO: frontend → porter → all-command
    await closeDatabase();
  } catch (error) {
    logger.error(`[shutdown] error: ${String(error)}`);
  }
  process.exit(0);
}

for (const signal of ["SIGINT", "SIGTERM", "SIGQUIT"] as const) {
  process.on(signal, () => void shutdown(signal));
}
