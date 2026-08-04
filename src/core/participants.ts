import type { InputPeerLike } from "@mtcute/core";
import { getMtprotoClient, type MtprotoClient } from "@/lib/mtproto";
import logger from "@/lib/logger";

/**
 * Chat member enumeration over MTProto.
 *
 * The Bot API has no "list all members" method — `getChatAdministrators` is as
 * far as it goes, which is why porter's registries are otherwise built by
 * watching who talks. MTProto's `channels.getParticipants` returns the real
 * roster, so this module exposes it as a framework capability that any feature
 * module can call without knowing anything about mtcute.
 */

/** One member, flattened to the fields a bot actually needs. */
export interface ChatParticipant {
  userId: number;
  username: string | null;
  firstName: string | null;
  isBot: boolean;
  /** Deleted accounts stay in the participant list but have no name left. */
  isDeleted: boolean;
}

export interface ChatRoster {
  participants: ChatParticipant[];
  /**
   * Whether this is the *entire* roster.
   *
   * Telegram never returns more than 200 members through a single filter, and
   * the search sweep that works around it can still come up short in very
   * large chats. Callers that delete records based on absence must check this
   * first, or they will prune members who were merely out of the window.
   */
  complete: boolean;
}

/** Telegram's hard ceiling per `channels.getParticipants` filter. */
const WINDOW = 200;
const CHUNK = 200;

/**
 * Prefixes for the search sweep used past the 200-member window. Latin and
 * Cyrillic letters plus digits cover the display names this deployment sees;
 * a name starting with anything else is simply missed, which is why a sweep
 * never reports `complete`.
 */
const SEARCH_PREFIXES = [
  ..."abcdefghijklmnopqrstuvwxyz",
  ..."абвгдежзиклмнопрстуфхцчшщэюя",
  ..."0123456789",
];

function toParticipant(user: {
  id: number;
  username: string | null;
  firstName: string;
  isBot: boolean;
  isDeleted: boolean;
}): ChatParticipant {
  return {
    userId: user.id,
    username: user.username ?? null,
    firstName: user.firstName || null,
    isBot: user.isBot,
    isDeleted: user.isDeleted,
  };
}

/**
 * Resolve a chat by its Bot API id.
 *
 * MTProto needs an access hash, not just an id. Bots get one for free — the
 * server accepts `access_hash = 0` from them — but a user account has to have
 * seen the peer before. Walking the dialog list populates mtcute's peer cache
 * (which is persisted in the session file), so this is a one-time cost.
 */
async function resolveChat(
  tg: MtprotoClient,
  chatId: number | string,
): Promise<InputPeerLike> {
  const id = typeof chatId === "string" ? Number(chatId) : chatId;

  try {
    return await tg.resolvePeer(id);
  } catch (error) {
    logger.debug(
      `[participants] ${id} not in peer cache (${String(error)}), syncing dialogs`,
    );
  }

  try {
    // Drained for the side effect: mtcute indexes the peers in every response.
    for await (const dialog of tg.iterDialogs()) void dialog;
  } catch (error) {
    // Bots have no dialog list; they should not have needed this path anyway.
    logger.debug(`[participants] dialog sync unavailable: ${String(error)}`);
  }

  return tg.resolvePeer(id);
}

/**
 * Every member of `chatId`, as far as Telegram will report them.
 *
 * @returns the roster, or `null` when MTProto is unconfigured or the lookup
 *   failed — the caller should fall back to whatever it already knows.
 */
export async function fetchChatParticipants(
  chatId: number | string,
): Promise<ChatRoster | null> {
  const tg = await getMtprotoClient();
  if (!tg) return null;

  try {
    const peer = await resolveChat(tg, chatId);
    const collected = new Map<number, ChatParticipant>();
    let total = 0;

    for (let offset = 0; ; ) {
      const chunk = await tg.getChatMembers(peer, {
        offset,
        limit: CHUNK,
        type: "recent",
      });
      total = Math.max(total, chunk.total);
      if (chunk.length === 0) break;

      for (const member of chunk) {
        collected.set(member.user.id, toParticipant(member.user));
      }
      offset += chunk.length;
      if (offset >= total || offset >= WINDOW) break;
    }

    let complete = collected.size >= total;

    // Past 200 the `recent` filter is exhausted and only search can reach
    // further, one prefix at a time. Expensive, so it stays behind the check.
    if (!complete) {
      logger.info(
        `[participants] ${chatId}: ${collected.size}/${total} via recent, sweeping search`,
      );
      for (const query of SEARCH_PREFIXES) {
        try {
          for await (const member of tg.iterChatMembers(peer, {
            type: "all",
            query,
            limit: WINDOW,
          })) {
            collected.set(member.user.id, toParticipant(member.user));
          }
        } catch (error) {
          logger.debug(
            `[participants] search "${query}" failed: ${String(error)}`,
          );
        }
        if (collected.size >= total) break;
      }
      complete = collected.size >= total;
    }

    logger.info(
      `[participants] ${chatId}: ${collected.size} of ${total} members${complete ? "" : " (partial)"}`,
    );

    return { participants: [...collected.values()], complete };
  } catch (error) {
    logger.warn(
      `[participants] could not list members of ${chatId}: ${String(error)}`,
    );
    return null;
  }
}
