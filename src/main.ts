import dns from "node:dns";
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
import { closeMtproto, getMtprotoClient, isMtprotoConfigured } from "@/lib/mtproto";
import { appFiglet } from "@/utils/appFiglet";
import logger from "@/lib/logger";

/**
 * Resolve IPv4 before IPv6.
 *
 * Node 17+ resolves "verbatim" — it dials addresses in whatever order the
 * resolver returns them. Inside a Docker bridge network, which normally has no
 * IPv6 route, api.telegram.org answering with its AAAA record first means the
 * bot connects to an address it cannot reach. grammY treats that as a network
 * error and retries indefinitely, so `bot.init()` never returns: the process
 * stays alive, never reaches `startModules()`, and the REST API never binds to
 * 5050. The symptom is a container that is "up (unhealthy)" with a boot log
 * that stops after the last import-time line, and 502s on every /api route.
 *
 * Must run before any network call, hence above dotenv and the module imports
 * that build clients.
 */
dns.setDefaultResultOrder("ipv4first");

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

  // Connect the optional MTProto client up front so a bad session or revoked
  // token shows up in the boot log rather than in the middle of a command.
  // Failure is logged inside and leaves the capability simply unavailable.
  if (isMtprotoConfigured()) {
    await getMtprotoClient();
  }

  // Register the Mini App as the default menu button so moderators can open it
  // directly from the bot's private chat (gives full Telegram Web App context,
  // unlike the plain url button used in the group moderation message).
  const tmaUrl = (process.env.TMA_PUBLIC_URL ?? "").replace(/\/$/, "");
  if (tmaUrl) {
    try {
      await bot.api.setChatMenuButton({
        menu_button: { type: "web_app", text: "Модерация", web_app: { url: tmaUrl } },
      });
      logger.info(`[bot] Menu button set → ${tmaUrl}`);
    } catch (err) {
      logger.warn(`[bot] Could not set menu button: ${String(err)}`);
    }
  }

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
    await closeMtproto();
    await closeDatabase();
  } catch (error) {
    logger.error(`[shutdown] error: ${String(error)}`);
  }
  process.exit(0);
}

for (const signal of ["SIGINT", "SIGTERM", "SIGQUIT"] as const) {
  process.on(signal, () => void shutdown(signal));
}
