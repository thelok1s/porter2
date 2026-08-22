import fs from "fs";
import path from "path";
import { Composer } from "grammy";

import { bot } from "@/core/bot";
import type { BotContext } from "@/core/bot";
import { vkGlobalApi } from "@/core/api";
import { sequelize, DB_FILE } from "@/lib/sequelize";
import { isMtprotoConfigured, getMtprotoClient } from "@/lib/mtproto";
import { isVkUserConfigured, getVkUserAccessToken } from "@/lib/vkuser";
import logger from "@/lib/logger";
import { PorterConfig as config } from "../../porter.config";

/**
 * `/health` — an operator-facing status readout.
 *
 * Answers two different questions for two different readers. A moderator wants
 * "is anything broken right now"; the owner wants enough detail to act on it.
 * So the brief form is a per-service verdict and nothing else, and the detailed
 * form adds the values you would otherwise SSH in to read.
 *
 * Nothing here is a secret: no token, key, session string or file path that
 * could be used as one is ever rendered — only whether a credential works and,
 * where it helps, how old it is. That holds for the detailed form too, because
 * "superadmin" is an id in an env var, not a guarantee about who is reading
 * over their shoulder.
 *
 * Every probe is bounded and independently caught: a health command that hangs
 * or throws because one service is down has failed at its only job.
 */

const PROBE_TIMEOUT_MS = 5_000;

const SUPER_ADMIN_IDS = new Set(
  (process.env.SUPER_ADMIN_ID ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean),
);

const MODERATOR_IDS = new Set(
  (process.env.MODERATOR_IDS ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean),
);

type Verdict = "ok" | "warn" | "fail" | "off";

interface Check {
  name: string;
  verdict: Verdict;
  /** One short clause for the brief view. */
  summary: string;
  /** Extra lines shown only to a super admin. */
  detail?: string[];
}

const ICON: Record<Verdict, string> = {
  ok: "🟢",
  warn: "🟡",
  fail: "🔴",
  off: "⚪️",
};

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

/**
 * Bound a probe so one unreachable service cannot hold up the whole report.
 *
 * Resolves to a sentinel rather than rejecting: callers treat a timeout as a
 * verdict, not an exception.
 */
async function withTimeout<T>(
  work: Promise<T>,
  ms = PROBE_TIMEOUT_MS,
): Promise<T | typeof TIMED_OUT> {
  let timer: NodeJS.Timeout;
  const timeout = new Promise<typeof TIMED_OUT>((resolve) => {
    timer = setTimeout(() => resolve(TIMED_OUT), ms);
  });
  try {
    return await Promise.race([work, timeout]);
  } finally {
    clearTimeout(timer!);
  }
}
const TIMED_OUT = Symbol("timed-out");

const errText = (e: unknown): string => {
  const err = e as { code?: number | string; message?: string };
  if (err?.code !== undefined) return `Code ${err.code}`;
  return (err?.message ?? String(e)).slice(0, 80);
};

function formatUptime(seconds: number): string {
  const d = Math.floor(seconds / 86400);
  const h = Math.floor((seconds % 86400) / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}

// ── Probes ────────────────────────────────────────────────────────────────

async function checkDatabase(): Promise<Check> {
  const res = await withTimeout(sequelize.authenticate());
  if (res === TIMED_OUT) {
    return { name: "Database", verdict: "fail", summary: "timed out" };
  }
  const detail: string[] = [];
  try {
    const stat = fs.statSync(DB_FILE);
    detail.push(`size: ${(stat.size / 1024 / 1024).toFixed(1)} MB`);
  } catch {
    // The file may live somewhere unreadable to us; the connection is what counts.
  }
  return { name: "Database", verdict: "ok", summary: "connected", detail };
}

async function checkTelegram(): Promise<Check> {
  const res = await withTimeout(bot.api.getMe());
  if (res === TIMED_OUT) {
    return { name: "Telegram", verdict: "fail", summary: "timed out" };
  }
  return {
    name: "Telegram",
    verdict: "ok",
    summary: `@${res.username}`,
    detail: [`bot id: ${res.id}`],
  };
}

async function checkVkCommunity(): Promise<Check> {
  if (!process.env.VK_TOKEN) {
    return { name: "VK (community)", verdict: "fail", summary: "VK_TOKEN unset" };
  }
  try {
    const res = await withTimeout(
      vkGlobalApi.groups.getById({}) as unknown as Promise<unknown>,
    );
    if (res === TIMED_OUT) {
      return { name: "VK (community)", verdict: "fail", summary: "timed out" };
    }
    const list = Array.isArray(res)
      ? res
      : ((res as { groups?: unknown[] } | null)?.groups ?? []);
    const group = list[0] as { name?: string; id?: number } | undefined;
    return {
      name: "VK (community)",
      verdict: "ok",
      summary: group?.name ?? "token valid",
      detail: group?.id ? [`group id: -${group.id}`] : [],
    };
  } catch (error) {
    return {
      name: "VK (community)",
      verdict: "fail",
      summary: errText(error),
    };
  }
}

/**
 * The user token that wall photos depend on.
 *
 * Probes the upload route rather than just `users.get`, because that is the
 * call that actually fails when the token is bound to a stale egress IP — a
 * token can be perfectly alive and still be unable to do the one job it is
 * held for.
 */
async function checkVkUser(): Promise<Check> {
  if (!isVkUserConfigured()) {
    return {
      name: "VK photos",
      verdict: "off",
      summary: "no VK_USER_TOKEN — posts go out text-only",
    };
  }
  const token = await getVkUserAccessToken();
  if (!token) {
    return { name: "VK photos", verdict: "fail", summary: "token unavailable" };
  }

  const groupRaw = process.env.VK_GROUP_ID ?? "";
  const groupId = Math.abs(parseInt(groupRaw) || 0);
  if (!groupId) {
    return { name: "VK photos", verdict: "warn", summary: "VK_GROUP_ID unset" };
  }

  try {
    const { API } = await import("vk-io");
    const api = new API({ token });
    const res = await withTimeout(
      api.photos.getWallUploadServer({
        group_id: groupId,
      }) as unknown as Promise<{ upload_url?: string }>,
    );
    if (res === TIMED_OUT) {
      return { name: "VK photos", verdict: "fail", summary: "timed out" };
    }
    return {
      name: "VK photos",
      verdict: res?.upload_url ? "ok" : "warn",
      summary: res?.upload_url ? "upload route reachable" : "no upload_url",
    };
  } catch (error) {
    const err = error as { code?: number; message?: string };
    // Code 5 is the one that matters and the one that reads least like itself.
    const hint =
      err?.code === 5
        ? /another ip address/i.test(err.message ?? "")
          ? "egress IP changed — token bound elsewhere"
          : "token expired or revoked"
        : errText(error);
    return { name: "VK photos", verdict: "fail", summary: hint };
  }
}

async function checkMtproto(): Promise<Check> {
  if (!isMtprotoConfigured()) {
    return {
      name: "MTProto",
      verdict: "off",
      summary: "not configured — @all tags admins only",
    };
  }
  const client = await withTimeout(getMtprotoClient());
  if (client === TIMED_OUT) {
    return { name: "MTProto", verdict: "fail", summary: "timed out" };
  }
  return client
    ? { name: "MTProto", verdict: "ok", summary: "connected" }
    : { name: "MTProto", verdict: "fail", summary: "client unavailable" };
}

async function checkApiServer(): Promise<Check> {
  const api = config.api;
  if (!api?.enabled) {
    return { name: "API server", verdict: "off", summary: "disabled" };
  }
  const port = api.port ?? 5050;
  try {
    const res = await withTimeout(
      fetch(`http://127.0.0.1:${port}/health`, {
        signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
      }),
    );
    if (res === TIMED_OUT) {
      return { name: "API server", verdict: "fail", summary: "timed out" };
    }
    return {
      name: "API server",
      verdict: res.ok ? "ok" : "warn",
      summary: res.ok ? `listening on ${port}` : `HTTP ${res.status}`,
      detail: [`port: ${port}`],
    };
  } catch (error) {
    return { name: "API server", verdict: "fail", summary: errText(error) };
  }
}

/**
 * The image store behind published post URLs.
 *
 * Worth a check of its own: those URLs are referenced forever by live VK and
 * Telegram posts, so an unwritable or unmounted directory breaks history, not
 * just the next upload.
 */
function checkImageStore(): Check {
  const dir = path.resolve("./data/images");
  try {
    if (!fs.existsSync(dir)) {
      return { name: "Image store", verdict: "warn", summary: "not created yet" };
    }
    fs.accessSync(dir, fs.constants.W_OK);
    const count = fs.readdirSync(dir).length;
    return {
      name: "Image store",
      verdict: "ok",
      summary: `${count} file${count === 1 ? "" : "s"}`,
      detail: [`writable: yes`],
    };
  } catch {
    return {
      name: "Image store",
      verdict: "fail",
      summary: "not writable — published links will 404",
    };
  }
}

// ── Rendering ─────────────────────────────────────────────────────────────

async function gather(): Promise<Check[]> {
  const results = await Promise.allSettled([
    checkDatabase(),
    checkTelegram(),
    checkVkCommunity(),
    checkVkUser(),
    checkMtproto(),
    checkApiServer(),
    Promise.resolve(checkImageStore()),
  ]);
  return results.map((r, i) =>
    r.status === "fulfilled"
      ? r.value
      : {
          name: `check #${i}`,
          verdict: "fail" as const,
          summary: errText(r.reason),
        },
  );
}

function overall(checks: Check[]): Verdict {
  if (checks.some((c) => c.verdict === "fail")) return "fail";
  if (checks.some((c) => c.verdict === "warn")) return "warn";
  return "ok";
}

function render(checks: Check[], detailed: boolean): string {
  const head = `${ICON[overall(checks)]} <b>porter2</b> — ${
    overall(checks) === "ok" ? "всё работает" : "есть проблемы"
  }`;

  const lines = checks.map(
    (c) =>
      `${ICON[c.verdict]} <b>${escapeHtml(c.name)}</b> — ${escapeHtml(c.summary)}`,
  );

  if (!detailed) return [head, "", ...lines].join("\n");

  const extra: string[] = [];
  for (const c of checks) {
    if (c.detail?.length) {
      extra.push(
        `<b>${escapeHtml(c.name)}</b>`,
        ...c.detail.map((d) => `  ${escapeHtml(d)}`),
      );
    }
  }

  const mem = process.memoryUsage();
  const runtime = [
    "<b>Runtime</b>",
    `  uptime: ${formatUptime(process.uptime())}`,
    `  memory: ${(mem.rss / 1024 / 1024).toFixed(0)} MB rss`,
    `  node: ${process.version}`,
  ];

  return [head, "", ...lines, "", ...extra, ...runtime].join("\n");
}

// ── Command ───────────────────────────────────────────────────────────────

/**
 * Who may run this, and how much they see.
 *
 * Super admins get detail. Moderators and chat admins get the summary.
 * Everyone else is refused — including in a DM, where there is no chat
 * membership to fall back on.
 */
async function authorize(
  ctx: BotContext,
): Promise<{ allowed: boolean; detailed: boolean }> {
  const userId = ctx.from?.id;
  if (!userId) return { allowed: false, detailed: false };

  if (SUPER_ADMIN_IDS.has(String(userId))) {
    return { allowed: true, detailed: true };
  }
  if (MODERATOR_IDS.has(String(userId))) {
    return { allowed: true, detailed: false };
  }

  const chatId = ctx.chat?.id;
  if (chatId && ctx.chat?.type !== "private") {
    try {
      const member = await bot.api.getChatMember(chatId, userId);
      if (member.status === "creator" || member.status === "administrator") {
        return { allowed: true, detailed: false };
      }
    } catch (error) {
      logger.debug(`[health] admin check failed: ${String(error)}`);
    }
  }
  return { allowed: false, detailed: false };
}

async function handleHealth(ctx: BotContext): Promise<void> {
  const healthConfig = config.health;
  if (!healthConfig?.enabled) return; // disabled: behave as if the command does not exist

  const isGroup = ctx.chat?.type !== "private";
  if (isGroup && healthConfig.allowInGroups === false) {
    return;
  }

  const { allowed, detailed } = await authorize(ctx);
  if (!allowed) {
    await ctx.reply("Эта команда только для админов.");
    return;
  }

  const checks = await gather();
  const text = render(checks, detailed);

  try {
    await ctx.reply(text, {
      parse_mode: "HTML",
      link_preview_options: { is_disabled: true },
    });
  } catch (error) {
    logger.error(`[health] could not send report: ${String(error)}`);
  }
}

const healthCommand = new Composer<BotContext>();
healthCommand.command("health", handleHealth);

export default healthCommand;
