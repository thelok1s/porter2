import { GrammyError } from "grammy";
import logger from "@/lib/logger";
import { bot } from "@/core/bot";
import { tgChatId as tgChatIdRaw, vkGlobalApi } from "@/core/api";
import { Post } from "@/models/post.schema";
import { Reply as ReplyModel } from "@/models/reply.schema";
import type { Message, InputMediaPhoto } from "grammy/types";
import type {
  CommentContext,
  PhotoAttachment,
  DocumentAttachment,
} from "vk-io";
import { enqueuePendingComment } from "./pending-comments";
import { formatMessageText, getHtmlLink, splitText } from "@/core/utils";

const tgChatId = String(tgChatIdRaw ?? "");

interface Sender {
  id: number;
  first_name: string;
  last_name: string;
}

/**
 * Resolve a VK commenter's display name. (Fixes P0-1.)
 *
 * The legacy code called `users.get` unconditionally and dereferenced the
 * result — which crashed for VK *group* ids (negative `fromId`, which
 * `users.get` cannot resolve → empty array → `sender.id` TypeError) and for
 * delete events (`fromId` null). We now branch by id sign, fall back to a
 * best-effort `groups.getById` for groups, and ALWAYS return a non-null sender.
 */
async function resolveSender(fromId: number | null | undefined): Promise<Sender> {
  const fallback = (id: number | null | undefined): Sender => ({
    id: id ?? 0,
    first_name: id != null && id < 0 ? "Сообщество" : "Unknown",
    last_name: "",
  });

  if (fromId == null || fromId === 0) return fallback(fromId);

  // Group/community commenter — users.get cannot resolve these.
  if (fromId < 0) {
    try {
      const res = (await vkGlobalApi.groups.getById({
        group_id: String(Math.abs(fromId)),
      })) as unknown;
      const group = Array.isArray(res)
        ? (res[0] as { id?: number; name?: string } | undefined)
        : undefined;
      if (group?.name) return { id: fromId, first_name: group.name, last_name: "" };
    } catch {
      // fall through to fallback
    }
    return fallback(fromId);
  }

  try {
    const [user] = (await vkGlobalApi.users.get({
      user_ids: [fromId],
    })) as unknown as Sender[];
    return user ?? fallback(fromId);
  } catch {
    return fallback(fromId);
  }
}

/**
 * Send a Telegram API call that targets a reply, retrying once WITHOUT
 * `reply_parameters` if Telegram reports the replied-to message is gone (400).
 * (Fixes P1-2: previously a deleted/stale reply target threw and lost the
 * whole comment.)
 */
async function sendWithReply<T>(
  send: (other: Record<string, unknown>) => Promise<T>,
  other: Record<string, unknown>,
  replyToMessageId: number | null,
): Promise<T> {
  const withReply =
    replyToMessageId != null
      ? {
          ...other,
          reply_parameters: { chat_id: tgChatId, message_id: replyToMessageId },
        }
      : { ...other };
  try {
    return await send(withReply);
  } catch (err) {
    if (err instanceof GrammyError && err.error_code === 400 && replyToMessageId != null) {
      logger.warn(
        `[VK -> TG] reply target ${replyToMessageId} not found; retrying without reply_parameters`,
      );
      return await send({ ...other });
    }
    throw err;
  }
}

/** Send long text as separate messages, replying part 0 to the target. */
async function sendTextParts(
  replyToMessageId: number,
  textParts: string[],
): Promise<number> {
  let mainMsgId: number | null = null;
  for (const [index, part] of textParts.entries()) {
    const msg = (await sendWithReply(
      (other) => bot.api.sendMessage(tgChatId, part, other),
      { parse_mode: "HTML", link_preview_options: { is_disabled: true } },
      index === 0 ? replyToMessageId : mainMsgId,
    )) as Message;
    if (mainMsgId === null) mainMsgId = msg.message_id;
  }
  return mainMsgId ?? replyToMessageId;
}

/** Persist the reply mapping row (best-effort). */
async function recordReply(
  reply: CommentContext,
  threadMsgId: number,
  tgReplyId: number | null,
  fromId: number | null | undefined,
): Promise<void> {
  try {
    await ReplyModel.create({
      vk_post_id: reply.objectId,
      vk_reply_id: reply.id,
      vk_author_id: reply.ownerId,
      tg_reply_id: tgReplyId ?? null,
      discussion_tg_id: threadMsgId,
      tg_author_id: fromId ?? null,
      created_at:
        typeof reply.createdAt === "number"
          ? new Date(reply.createdAt * 1000)
          : reply.createdAt,
      attachments: JSON.stringify(reply.attachments || []),
    });
  } catch (error) {
    logger.error(`Failed to create reply record: ${String(error)}`);
  }
}

/** Resolve the best photo URL from a VK photo attachment (null-safe). */
function photoUrl(att: PhotoAttachment): string | null {
  return att.largeSizeUrl ?? att.mediumSizeUrl ?? att.smallSizeUrl ?? null;
}

/**
 * Port a VK comment into the Telegram discussion thread. (VK → TG direction.)
 *
 * Handles new/restore, edit, and delete events. Comments whose discussion
 * thread is not linked yet are enqueued for retry instead of dropped (P0-4).
 */
export default async function replyToTelegram(reply: CommentContext): Promise<void> {
  logger.debug({
    logctx: "replyToTelegram",
    logtype: "raw context",
    reply: reply.toJSON(),
  });

  try {
    const post = await Post.findOne({
      where: { vk_id: reply.objectId },
      attributes: ["discussion_tg_id", "tg_id", "vk_id"],
    });

    if (!post) {
      logger.warn(`[VK -> TG] Post not found for VK ID ${reply.objectId}`);
      return;
    }

    // Thread not linked yet — enqueue for retry instead of permanently dropping (P0-4).
    // Deletes don't need a thread (they only need the reply record, looked up below).
    if (!post.discussion_tg_id && !reply.isDelete) {
      enqueuePendingComment(reply, reply.objectId);
      return;
    }

    const threadMsgId = post.discussion_tg_id as number;

    // Resolve the message to reply to: a parent comment if any, else the thread root.
    let replyToMessageId: number | null = threadMsgId;
    if (reply.replyId) {
      const targetComment = await ReplyModel.findOne({
        where: { vk_reply_id: reply.replyId },
        attributes: ["tg_reply_id", "vk_post_id"],
      });
      if (targetComment?.tg_reply_id) {
        if (targetComment.vk_post_id === reply.objectId) {
          replyToMessageId = targetComment.tg_reply_id;
          logger.info(
            `[VK –> TG] Replying to VK comment ${reply.replyId} -> TG message ${replyToMessageId}`,
          );
        } else {
          logger.warn(
            `Target comment ${reply.replyId} belongs to a different post (${targetComment.vk_post_id} vs ${reply.objectId}); replying to thread instead`,
          );
        }
      } else {
        logger.warn(
          `Target comment ${reply.replyId} not found in database; replying to thread instead`,
        );
      }
    }

    // ── NEW / RESTORE ───────────────────────────────────────────────────────
    if (reply.isNew || reply.isRestore) {
      // Idempotency: skip if this VK comment was already ported
      const existingReply = await ReplyModel.findOne({
        where: { vk_reply_id: reply.id },
        attributes: ["id"],
      });
      if (existingReply) {
        logger.debug(`[VK -> TG] Reply already ported: ${reply.id}`);
        return;
      }

      const sender = await resolveSender(reply.fromId);
      const processedText = formatMessageText(reply.text || "");
      const authorLink = getHtmlLink(
        `https://vk.ru/id${sender.id}`,
        `${sender.first_name} ${sender.last_name}`.trim(),
      );
      const messageText = `${authorLink}: ${processedText}`;
      const textParts = splitText(messageText, 4096);
      const hasAttachments = reply.attachments.toString().length > 0;

      if (hasAttachments) {
        // Collect photo URLs (null-safe — P1-3)
        const photoUrls: InputMediaPhoto[] = [];
        for (const attachment of reply.attachments) {
          const url = photoUrl(attachment.toJSON() as PhotoAttachment);
          if (url) photoUrls.push({ type: "photo", media: url });
        }

        if (photoUrls.length > 1) {
          // Multiple photos
          let firstMsgId: number | null = null;
          if (textParts.length > 1 || textParts[0].length > 1024) {
            firstMsgId = await sendTextParts(replyToMessageId, textParts);
            const group = (await sendWithReply(
              (other) => bot.api.sendMediaGroup(tgChatId, photoUrls, other),
              {},
              firstMsgId,
            )) as Message[];
            firstMsgId = group[0]?.message_id ?? firstMsgId;
          } else {
            const mediaGroup: InputMediaPhoto[] = photoUrls.map((photo, index) => ({
              type: "photo",
              media: photo.media,
              ...(index === 0
                ? { caption: textParts[0], parse_mode: "HTML" as const }
                : {}),
            }));
            const group = (await sendWithReply(
              (other) => bot.api.sendMediaGroup(tgChatId, mediaGroup, other),
              {},
              replyToMessageId,
            )) as Message[];
            firstMsgId = group[0]?.message_id ?? null;
          }
          await recordReply(reply, threadMsgId, firstMsgId, reply.fromId);
        } else if (photoUrls.length === 1) {
          // Single photo
          let photoMsg: Message;
          if (textParts.length > 1 || textParts[0].length > 1024) {
            const firstMsgId = await sendTextParts(replyToMessageId, textParts);
            photoMsg = (await sendWithReply(
              (other) => bot.api.sendPhoto(tgChatId, photoUrls[0].media, other),
              {},
              firstMsgId,
            )) as Message;
          } else {
            photoMsg = (await sendWithReply(
              (other) =>
                bot.api.sendPhoto(tgChatId, photoUrls[0].media, {
                  ...other,
                  caption: textParts[0],
                  parse_mode: "HTML",
                }),
              {},
              replyToMessageId,
            )) as Message;
          }
          await recordReply(reply, threadMsgId, photoMsg.message_id, reply.fromId);
        } else if (reply.attachments[0]) {
          // Document / animation (GIF). Guard the dereference (P1-3).
          const docJson = reply.attachments[0].toJSON() as DocumentAttachment;
          if (Object.prototype.hasOwnProperty.call(docJson, "extension")) {
            const docUrl = String(docJson.url ?? "");
            let animMsg: Message;
            if (textParts.length > 1 || textParts[0].length > 1024) {
              const firstMsgId = await sendTextParts(replyToMessageId, textParts);
              animMsg = (await sendWithReply(
                (other) => bot.api.sendAnimation(tgChatId, docUrl, other),
                {},
                firstMsgId,
              )) as Message;
            } else {
              animMsg = (await sendWithReply(
                (other) =>
                  bot.api.sendAnimation(tgChatId, docUrl, {
                    ...other,
                    caption: textParts[0],
                    parse_mode: "HTML",
                  }),
                {},
                replyToMessageId,
              )) as Message;
            }
            await recordReply(reply, threadMsgId, animMsg.message_id, reply.fromId);
          }
        }
      } else {
        // Text-only comment
        const mainMsgId = await sendTextParts(replyToMessageId, textParts);
        await recordReply(reply, threadMsgId, mainMsgId, reply.fromId);
        logger.info(`[VK –> TG] Reply ported: ${reply.id} (for msg: ${mainMsgId})`);
      }

      // ── EDIT ───────────────────────────────────────────────────────────────
    } else if (reply.isEdit) {
      const replyRecord = await ReplyModel.findOne({
        where: { vk_reply_id: reply.id },
        attributes: ["tg_reply_id"],
      });
      if (!replyRecord?.tg_reply_id) {
        logger.warn(`Cannot find reply to edit: ${reply.id}`);
        return;
      }
      const sender = await resolveSender(reply.fromId);
      const processedText = formatMessageText(reply.text || "");
      const authorLink = getHtmlLink(
        `https://vk.ru/id${sender.id}`,
        `${sender.first_name} ${sender.last_name}`.trim(),
      );
      const messageText = `${authorLink}: ${processedText}`;

      await bot.api.editMessageText(
        tgChatId,
        replyRecord.tg_reply_id,
        messageText,
        { parse_mode: "HTML", link_preview_options: { is_disabled: true } },
      );
      logger.info(`[VK –> TG] Reply edited: ${reply.id}`);

      // ── DELETE ─────────────────────────────────────────────────────────────
    } else if (reply.isDelete) {
      const replyRecord = await ReplyModel.findOne({
        where: { vk_reply_id: reply.id },
        attributes: ["tg_reply_id"],
      });
      if (!replyRecord?.tg_reply_id) {
        logger.warn(`Cannot find reply to delete: ${reply.id}`);
        return;
      }
      await bot.api.deleteMessage(tgChatId, replyRecord.tg_reply_id);
      await ReplyModel.destroy({ where: { vk_reply_id: reply.id } });
      logger.info(`[VK –>X TG] Reply deleted: ${reply.id}`);
    }
  } catch (error) {
    logger.error(`Error handling reply ${reply?.id}: ${String(error)}`);
  }
}
