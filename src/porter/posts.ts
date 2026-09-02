import { GrammyError, InputFile } from "grammy";
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
 * Telegram downloads media by URL itself. These are the ways it reports that it
 * could not — and none of them means the file is bad: VK's CDN was simply
 * unreachable from Telegram's side for a moment.
 *
 * It used to cost far more than the picture. The send threw, `postToTelegram`
 * caught it and logged, and no `Post` row was ever written — so the post never
 * reached the channel AND every comment VK later announced on it answered
 * "Post not found for VK ID …" forever. One unlucky fetch severed a post and
 * its whole future conversation (app.log, 2026-09-02: post 3614, then two
 * orphaned comments hours apart).
 */
const TELEGRAM_CANNOT_FETCH =
  /WEBPAGE_CURL_FAILED|WEBPAGE_MEDIA_EMPTY|failed to get HTTP URL content|wrong file identifier\/HTTP URL specified/i;

/** Exported so the retry rule can be pinned without a live Telegram. */
export function cannotFetch(error: unknown): boolean {
  return (
    error instanceof GrammyError && TELEGRAM_CANNOT_FETCH.test(error.description)
  );
}

/** Long enough for a slow CDN, short enough not to stall the longpoll. */
const UPLOAD_FETCH_TIMEOUT_MS = 20_000;

/** The Bot API's ceiling for an upload. */
const MAX_UPLOAD_BYTES = 50 * 1024 * 1024;

/**
 * Fetch an attachment ourselves so its bytes can be uploaded rather than
 * linked. Null when we cannot reach it either — at that point the file really
 * is gone, rather than merely out of Telegram's reach, and the original
 * refusal deserves to stand.
 */
async function fetchForUpload(url: string): Promise<InputFile | null> {
  try {
    const response = await fetch(url, {
      signal: AbortSignal.timeout(UPLOAD_FETCH_TIMEOUT_MS),
    });
    if (!response.ok) return null;
    const bytes = Buffer.from(await response.arrayBuffer());
    if (bytes.length === 0 || bytes.length > MAX_UPLOAD_BYTES) return null;
    const name = url.split("?")[0].split("/").pop() || "attachment";
    return new InputFile(bytes, name);
  } catch (error) {
    logger.debug(`[VK -> TG] could not fetch ${url} for upload: ${String(error)}`);
    return null;
  }
}

/**
 * Send media, and when Telegram declines to fetch the URLs, download them and
 * send the bytes instead.
 *
 * Only ever retried on that one class of refusal, which is a 400 — Telegram
 * validates a media group before sending any of it, so nothing went out and a
 * second attempt cannot duplicate anything. Every other error is rethrown
 * untouched.
 */
export async function sendMedia<T extends { media: string | InputFile }, R>(
  items: T[],
  send: (items: T[]) => Promise<R>,
): Promise<R> {
  try {
    return await send(items);
  } catch (error) {
    if (!cannotFetch(error)) throw error;
    logger.warn(
      `[VK -> TG] Telegram would not fetch ${items.length} attachment(s) — ` +
        "downloading them and uploading instead",
    );
    const uploaded = await Promise.all(
      items.map(async (item) => {
        if (typeof item.media !== "string") return item;
        const file = await fetchForUpload(item.media);
        return file ? { ...item, media: file } : item;
      }),
    );
    return await send(uploaded);
  }
}

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

      const group = await sendMedia(photos, (media) =>
        bot.api.sendMediaGroup(tgChannelPublicLink, media),
      );
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
        const group = await sendMedia(documents, (media) =>
          bot.api.sendMediaGroup(tgChannelPublicLink, media),
        );
        for (const m of group) sentMessageIds.push(m.message_id);
        if (!firstFrom) firstFrom = JSON.stringify(group[0]?.from?.id ?? null);
      } else {
        const [docMsg] = await sendMedia([documents[0]], ([doc]) =>
          bot.api
            .sendDocument(tgChannelPublicLink, doc.media)
            .then((message) => [message]),
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
    // Worth stating the consequence: with no Post row, every comment VK
    // announces on this post from now on will answer "Post not found" and be
    // dropped. The post is not merely late, its conversation is severed.
    logger.error(
      `[VK -X-> TG] Error while porting: ${String(error)} — post ` +
        `${post.wall.id} is not recorded, so its comments cannot be ported either`,
    );
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
