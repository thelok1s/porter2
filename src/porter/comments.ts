import logger from "@/lib/logger";
import { vkGlobalApi } from "@/core/api";
import { Post as PostModel } from "@/models/post.schema";
import { Reply as ReplyModel } from "@/models/reply.schema";
import type { Message } from "grammy/types";

/**
 * Strip Telegram HTML to plain text for VK (VK uses its own [url|text] markup).
 */
function formatTelegramToVkText(text: string): string {
  if (!text) return "";
  return text.replace(/<br\s*\/?>/gi, "\n").replace(/<[^>]+>/g, "");
}

/**
 * Port a Telegram discussion message to VK as a comment. (TG → VK direction.)
 *
 * Idempotent by `tg_reply_id`: a TG message is ported at most once. The comment
 * is posted to VK first, then the mapping row is persisted.
 */
export async function replyToVk(
  msg: Message,
  post: PostModel,
  messageText?: string,
): Promise<void> {
  logger.debug({
    logctx: "replyToVk",
    logtype: "raw context",
    msg_id: msg.message_id,
    from_id: msg.from?.id,
    post_vk_id: post.vk_id,
    text: messageText,
  });

  try {
    // Idempotency: skip if this TG message was already ported
    const existingReply = await ReplyModel.findOne({
      where: { tg_reply_id: msg.message_id },
      attributes: ["id"],
    });
    if (existingReply) {
      logger.warn(`[TG -> VK] Comment already ported: TG msg ${msg.message_id}`);
      return;
    }

    const tgUsername = msg.from?.username;
    if (!tgUsername) {
      logger.warn("[TG -> VK] Message has no sender username, skipping");
      return;
    }

    const userLink = `t.me/${tgUsername}`;
    const userDisplayName = `${msg.from?.first_name ?? ""} ${msg.from?.last_name ?? ""}`.trim();

    const text = messageText || msg.text || "";
    if (!text) {
      logger.warn("[TG -> VK] Message has no text content, skipping");
      return;
    }

    const processedText = formatTelegramToVkText(text);
    const commentText = `${userDisplayName}(${userLink}): ${processedText}\n\n(Автоматически перенесено из tg)`;

    // Create the VK comment (post as the group when the owner is a group)
    const vkComment = await vkGlobalApi.wall.createComment({
      owner_id: post.vk_author_id as number,
      post_id: post.vk_id as number,
      message: commentText,
      from_group:
        post.vk_author_id && post.vk_author_id < 0
          ? Math.abs(post.vk_author_id)
          : undefined,
    });

    if (!vkComment.comment_id) {
      logger.error("[TG -> VK] Failed to create VK comment: no comment_id returned");
      return;
    }

    // Persist the mapping row
    try {
      await ReplyModel.create({
        vk_post_id: post.vk_id,
        vk_reply_id: vkComment.comment_id,
        vk_author_id: post.vk_author_id,
        tg_reply_id: msg.message_id,
        discussion_tg_id: post.discussion_tg_id,
        tg_author_id: msg.from?.id,
        created_at: new Date(),
        attachments: JSON.stringify([]),
      });
      logger.info(
        `[TG -> VK] Comment ported: TG msg ${msg.message_id} -> VK comment ${vkComment.comment_id}`,
      );
    } catch (error) {
      logger.error(`[TG -> VK] Failed to create reply record: ${String(error)}`);
    }
  } catch (error) {
    logger.error(
      `[TG -> VK] Error handling comment from TG msg ${msg.message_id}: ${String(error)}`,
    );
    if (error instanceof Error && error.stack) {
      logger.debug(`[TG -> VK] Error stack: ${error.stack}`);
    }
  }
}
