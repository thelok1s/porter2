import { PorterConfig as config } from "../../porter.config";
import logger from "@/lib/logger";
import { bot } from "@/core/bot";
import { tgChannelPublicLink as tgChannelPublicLinkRaw } from "@/core/api";
import { Post } from "@/models/post.schema";
import { formatMessageText, splitText, truncateToUnits, getVkLink } from "@/core/utils";
import type { InputMediaPhoto, InputMediaDocument } from "grammy/types";
import type {
  WallPostContext,
  PhotoAttachment,
  DocumentAttachment,
  PollAttachment,
} from "vk-io";

const tgChannelPublicLink = String(tgChannelPublicLinkRaw ?? "");

/**
 * Crosspost a VK wall post to the Telegram channel.
 *
 * VK → Telegram direction. Buckets attachments (photos → text → files → poll),
 * sends them in that order, and records exactly one `Post` row keyed by the
 * immutable `vk_id` (idempotent — duplicates are skipped up front).
 */
export default async function postToTelegram(post: WallPostContext): Promise<void> {
  // Skip reposts if configured
  if (config.crossposting.parameters.ignoreReposts && post.isRepost) {
    logger.info(
      `Reposts are ignored, skipping (${getVkLink(post.wall.id, post.wall.ownerId)})`,
    );
    return;
  }

  // Idempotency: never port the same VK post twice
  const exists = await Post.findOne({
    where: { vk_id: post.wall.id },
    attributes: ["id"],
  });
  if (exists) {
    logger.info(
      `Already ported post (${getVkLink(post.wall.id, post.wall.ownerId)})`,
    );
    return;
  }

  try {
    const processedText = formatMessageText(post.wall.text || "");
    const sentMessageIds: number[] = [];
    let firstFrom: string | null = null;
    let recordCreated = false;

    // Record the Post row once, after the first message is successfully sent,
    // capturing the primary id (tg_id) and the full id array (tg_ids).
    const createRecord = async (): Promise<void> => {
      if (recordCreated || sentMessageIds.length === 0) return;
      await Post.create({
        vk_id: post.wall.id,
        vk_author_id: post.wall.ownerId,
        tg_id: sentMessageIds[0],
        tg_ids: sentMessageIds,
        discussion_tg_id: null,
        tg_author_id: firstFrom,
        created_at: post.wall.createdAt,
        attachments: JSON.stringify(post.wall.attachments),
      });
      recordCreated = true;
    };

    // Build attachment buckets: photos -> text -> files -> poll
    const photos: InputMediaPhoto[] = [];
    const documents: InputMediaDocument[] = [];
    let pollQuestion: string | null = null;
    let pollOptions: string[] = [];

    for (const attachment of post.wall.attachments) {
      const json = attachment.toJSON() as
        | PhotoAttachment
        | DocumentAttachment
        | PollAttachment;

      const purl =
        (json as PhotoAttachment).largeSizeUrl ??
        (json as PhotoAttachment).mediumSizeUrl ??
        (json as PhotoAttachment).smallSizeUrl;
      if (purl) {
        photos.push({ type: "photo", media: purl });
        continue;
      }

      if (Object.prototype.hasOwnProperty.call(json, "extension")) {
        const url = (json as DocumentAttachment).url;
        if (url) {
          documents.push({ type: "document", media: String(url) });
        }
        continue;
      }

      if (
        Object.prototype.hasOwnProperty.call(json, "question") &&
        !config.crossposting.parameters.ignorePolls
      ) {
        pollQuestion = (json as PollAttachment).question ?? "Poll";
        pollOptions = ((json as PollAttachment).answers ?? []).map((a) => a.text);
      }
    }

    // 1) Photos first (caption up to 1024 units, surrogate/entity-safe)
    let remainingText = processedText;
    if (photos.length > 0) {
      let caption = "";
      if (remainingText) {
        caption = truncateToUnits(remainingText, 1024);
        remainingText = remainingText.slice(caption.length).trim();
      }
      if (caption) {
        photos[0].caption = caption;
        photos[0].parse_mode = "HTML";
      }

      const group = await bot.api.sendMediaGroup(tgChannelPublicLink, photos);
      for (const m of group) sentMessageIds.push(m.message_id);
      if (!firstFrom) firstFrom = JSON.stringify(group[0]?.from?.id ?? null);
      await createRecord();
    }

    // 2) Remaining text chunks (4096 units each)
    const remainingParts = remainingText ? splitText(remainingText) : [];
    for (const part of remainingParts) {
      const msg = await bot.api.sendMessage(tgChannelPublicLink, part, {
        parse_mode: "HTML",
      });
      sentMessageIds.push(msg.message_id);
      if (!firstFrom) firstFrom = JSON.stringify(msg.from?.id ?? null);
      await createRecord();
    }

    // 3) Files (documents) as the last content block
    if (documents.length > 0) {
      if (documents.length > 1) {
        const group = await bot.api.sendMediaGroup(tgChannelPublicLink, documents);
        for (const m of group) sentMessageIds.push(m.message_id);
        if (!firstFrom) firstFrom = JSON.stringify(group[0]?.from?.id ?? null);
      } else {
        const docMsg = await bot.api.sendDocument(
          tgChannelPublicLink,
          documents[0].media,
        );
        sentMessageIds.push(docMsg.message_id);
        if (!firstFrom) firstFrom = JSON.stringify(docMsg.from?.id ?? null);
      }
      await createRecord();
    }

    // 4) Poll at the very end
    if (pollQuestion && pollOptions.length > 0) {
      const pollMsg = await bot.api.sendPoll(
        tgChannelPublicLink,
        pollQuestion,
        pollOptions,
      );
      sentMessageIds.push(pollMsg.message_id);
      if (!firstFrom) firstFrom = JSON.stringify(pollMsg.from?.id ?? null);
      await createRecord();
    }

    // 5) Text-only post (no attachments at all)
    if (sentMessageIds.length === 0 && processedText) {
      for (const part of splitText(processedText)) {
        const msg = await bot.api.sendMessage(tgChannelPublicLink, part, {
          parse_mode: "HTML",
        });
        sentMessageIds.push(msg.message_id);
        if (!firstFrom) firstFrom = JSON.stringify(msg.from?.id ?? null);
      }
      await createRecord();
    }

    logger.info(
      `[VK –> TG] Successfully ported: ${getVkLink(post.wall.id, post.wall.ownerId)}`,
    );
  } catch (error: unknown) {
    logger.error(`[VK -X-> TG] Error while porting: ${String(error)}`);
    if (error instanceof Error && error.stack) {
      logger.debug(
        `[VK -X-> TG] Error traceback: ${JSON.stringify({
          message: error.message,
          vk_id: post.wall.id,
          vk_author_id: post.wall.ownerId,
        })} stack=${error.stack}`,
      );
    }
  }
}
