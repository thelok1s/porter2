import type { CommentContext } from "vk-io";
import logger from "@/lib/logger";
import replyToTelegram from "./replies";

/**
 * In-memory retry buffer for VK comments that arrive before their discussion
 * thread is linked in Telegram (the auto-forward hasn't been detected yet).
 *
 * Fixes P0-4: the legacy code permanently dropped such comments. Now we hold
 * them and reprocess once the linkage succeeds (drained by the auto-forward
 * handler). A periodic sweeper discards entries that stay unlinked longer than
 * MAX_AGE_MS so the buffer can't grow unbounded.
 *
 * Note: this is volatile — a process restart loses pending entries. The window
 * is short (seconds), restarts are rare, and the linkage fix (P0-3) shrinks the
 * race considerably. A persistent `pending_comments` table is a documented
 * follow-up if durability becomes a concern.
 */

const MAX_AGE_MS = 5 * 60 * 1000; // drop after 5 minutes unlinked
const SWEEP_INTERVAL_MS = 30 * 1000;

interface PendingEntry {
  reply: CommentContext;
  vkPostId: number;
  enqueuedAt: number;
}

const queue: PendingEntry[] = [];
let sweepTimer: ReturnType<typeof setInterval> | null = null;

/** Hold a comment for retry once its post's discussion thread is linked. */
export function enqueuePendingComment(reply: CommentContext, vkPostId: number): void {
  queue.push({ reply, vkPostId, enqueuedAt: Date.now() });
  logger.info(
    `[pending] enqueued VK comment ${reply.id} for post ${vkPostId} (thread not linked yet)`,
  );
}

/** Reprocess every pending comment for a post (called after the thread is linked). */
export async function drainPendingForPost(vkPostId: number): Promise<void> {
  const ready = queue.filter((p) => p.vkPostId === vkPostId);
  if (ready.length === 0) return;
  for (let i = queue.length - 1; i >= 0; i--) {
    if (queue[i].vkPostId === vkPostId) queue.splice(i, 1);
  }
  logger.info(
    `[pending] draining ${ready.length} pending comment(s) for post ${vkPostId}`,
  );
  for (const entry of ready) {
    try {
      await replyToTelegram(entry.reply);
    } catch (error) {
      logger.error(
        `[pending] failed to drain comment ${entry.reply.id}: ${String(error)}`,
      );
    }
  }
}

/** Start the periodic sweeper that drops stale unlinked comments. */
export function startPendingSweeper(): void {
  if (sweepTimer) return;
  sweepTimer = setInterval(() => {
    const now = Date.now();
    for (let i = queue.length - 1; i >= 0; i--) {
      if (now - queue[i].enqueuedAt > MAX_AGE_MS) {
        const entry = queue[i];
        logger.warn(
          `[pending] dropping stale comment ${entry.reply.id} for post ${entry.vkPostId} (unlinked after ${MAX_AGE_MS / 1000}s)`,
        );
        queue.splice(i, 1);
      }
    }
  }, SWEEP_INTERVAL_MS);
  // Don't keep the process alive just for the sweeper.
  sweepTimer.unref?.();
}

export function stopPendingSweeper(): void {
  if (sweepTimer) {
    clearInterval(sweepTimer);
    sweepTimer = null;
  }
}
