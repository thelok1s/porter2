import { PorterConfig as config } from "../../porter.config";
import logger from "@/lib/logger";
import { vkGroupApi } from "@/core/api";
import messageHandler from "./message-handler";
import postToTelegram from "./posts";
import replyToTelegram from "./replies";
import { startPendingSweeper, stopPendingSweeper } from "./pending-comments";
import type { WallPostContext, CommentContext } from "vk-io";

/**
 * Porter — the tg-vk crossposting & crosscommenting core module.
 *
 * Exposes a Composer (the discussion-group message handler) plus VK lifecycle
 * hooks (start/stop long-polling + wall event listeners). This module is the
 * reusable, committed core of porter2; the frontend-support and @all features
 * live as separate, private local modules and never import from here.
 */

const START_TIME = Math.floor(Date.now() / 1000);

async function handleWallPost(context: WallPostContext): Promise<void> {
  if (!context) return;
  // P1-4: explicit parens. The legacy `createdAt ?? 0 > START_TIME` parsed as
  // `createdAt ?? (0 > START_TIME)` due to operator precedence.
  if ((context.wall.createdAt ?? 0) > START_TIME) {
    await postToTelegram(context);
  }
}

async function handleWallReply(context: CommentContext): Promise<void> {
  const createdAt =
    (context as unknown as { createdAt?: number }).createdAt ?? 0;
  if (
    (context.isNew && createdAt > START_TIME) ||
    (context.isEdit && createdAt > START_TIME) ||
    context.isDelete ||
    context.isRestore
  ) {
    await replyToTelegram(context);
  }
}

const porterModule = {
  composer: messageHandler,

  async start() {
    startPendingSweeper();

    if (
      config.crossposting.enabled &&
      (config.crossposting.origin === "vk" ||
        config.crossposting.origin === "both")
    ) {
      vkGroupApi.updates.on("wall_post_new", handleWallPost);
    }

    const cc = config.crosscommenting;
    if (cc.enabled && (cc.origin === "vk" || cc.origin === "both")) {
      vkGroupApi.updates.on(
        [
          "wall_reply_new",
          "wall_reply_restore",
          "wall_reply_edit",
          "wall_reply_delete",
        ],
        handleWallReply,
      );
    }

    await vkGroupApi.updates.start();
    logger.info("[porter] VK long-polling started");
  },

  async stop() {
    do {
      await vkGroupApi.updates.stop();
    } while (vkGroupApi.updates.isStarted);
    stopPendingSweeper();
    logger.info("[porter] VK long-polling stopped");
  },
};

export default porterModule;
