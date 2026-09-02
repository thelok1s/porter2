import { Composer } from "grammy";
import type { Message } from "grammy/types";
import { PorterConfig as config } from "../../porter.config";
import logger from "@/lib/logger";
import { bot } from "@/core/bot";
import type { BotContext } from "@/core/bot";
import { tgChatId, tgChannelId } from "@/core/api";
import { Post } from "@/models/post.schema";
import { replyToVk } from "./comments";
import { drainPendingForPost } from "./pending-comments";

/**
 * The subset of a Telegram discussion message we read. Declared explicitly so
 * we don't depend on grammY's shallow message fragment level exposing forward
 * fields (which varies across versions).
 */
type DiscussionMessage = Message & {
  is_automatic_forward?: boolean;
  forward_from_chat?: { id: number };
  forward_from_message_id?: number;
  message_thread_id?: number;
  caption?: string;
};

const CHAT_ID = String(tgChatId ?? "");
// `tgChannelId` is already normalised to Telegram's full "-100…" form, which
// is exactly what forward_from_chat.id reports.
const CHANNEL_PREFIX = String(tgChannelId ?? "");

const composer = new Composer<BotContext>();

/**
 * Discussion-group message handler. Two responsibilities, both part of
 * crosscommenting:
 *   (a) auto-forward → link the channel post to its discussion thread;
 *   (b) user reply   → port the comment back to VK.
 *
 * It only acts on messages from the discussion chat and self-gates on config.
 * Mounted before nothing message-aware (all-command sits ahead of it and is
 * command-scoped), so ordering is safe.
 */
composer.on("message", async (ctx, next) => {
  const msg = ctx.message as DiscussionMessage | undefined;
  if (!msg) return next();

  // Skip the bot's own messages.
  if (msg.from?.id === bot.botInfo?.id) return next();

  // Only the discussion group is relevant.
  if (!msg.chat || String(msg.chat.id) !== CHAT_ID) return next();

  const cc = config.crosscommenting;
  if (!cc.enabled) return next();

  try {
    // (a) Auto-forward: link discussion_tg_id on the originating channel post.
    if (
      msg.is_automatic_forward &&
      msg.forward_from_chat &&
      String(msg.forward_from_chat.id) === CHANNEL_PREFIX
    ) {
      const fwdId = msg.forward_from_message_id;
      logger.debug(
        `[Auto-forward] discussion msg ${msg.message_id} <- channel msg ${fwdId}`,
      );

      if (typeof fwdId === "number") {
        // P0-3: match against the full tg_ids[] array, not just tg_id. The
        // legacy query matched tg_id only (the first message of a group), so
        // multi-message posts never linked.
        //
        // Every post, not only the unlinked ones, because "no unlinked post
        // matches" answers two very different questions with one warning:
        // whether this forward is ours at all, and whether it is one we have
        // already dealt with. Only the second is worth raising a voice about.
        const posts = await Post.findAll({
          attributes: ["vk_id", "tg_id", "tg_ids", "discussion_tg_id"],
        });
        const owner = posts.find(
          (p) =>
            p.tg_id === fwdId ||
            (Array.isArray(p.tg_ids) && p.tg_ids.includes(fwdId)),
        );
        const match = owner && owner.discussion_tg_id == null ? owner : null;

        if (!match) {
          if (!owner) {
            // Someone wrote in the channel by hand. That auto-forwards exactly
            // like a ported post does, and there is no VK post behind it to
            // attach — ordinary activity, which used to be logged as a fault
            // (four such warnings in app.log over five days, all benign).
            logger.debug(
              `[Auto-forward] channel msg ${fwdId} was not ported by porter — ` +
                "nothing to link",
            );
          } else {
            logger.warn(
              `[Auto-forward] channel msg ${fwdId} (vk_id ${owner.vk_id}) is ` +
                `already linked to discussion msg ${owner.discussion_tg_id}; ` +
                `ignoring the forward at ${msg.message_id}`,
            );
          }
          return next();
        }

        {
          // Update by the immutable natural key vk_id (NOT an instance save) —
          // the candidates query selects only vk_id/tg_id/tg_ids, so the Post
          // instance has no `id` PK loaded and instance.update() would refuse.
          await Post.update(
            { discussion_tg_id: msg.message_id },
            { where: { vk_id: match.vk_id } },
          );
          logger.info(
            `[Auto-forward] Linked channel msg ${fwdId} -> discussion msg ${msg.message_id} (vk_id ${match.vk_id})`,
          );
          // P0-4: flush any comments that were waiting for this linkage.
          await drainPendingForPost(match.vk_id);
        }
      }
      return next();
    }

    // (b) User reply in the discussion group → port the comment to VK.
    if (cc.origin === "tg" || cc.origin === "both") {
      if (msg.is_automatic_forward) return next();

      const discussionRootId = msg.message_thread_id;
      if (typeof discussionRootId !== "number") return next();

      const post = await Post.findOne({
        where: { discussion_tg_id: discussionRootId },
        attributes: ["vk_id", "vk_author_id", "discussion_tg_id"],
      });
      if (!post || !post.vk_id) return next();

      const messageText = msg.text || msg.caption || "";
      await replyToVk(msg, post, messageText);
    }
  } catch (error) {
    logger.error(
      `[porter message handler] Failed to process message ${msg.message_id}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }

  return next();
});

export default composer;
