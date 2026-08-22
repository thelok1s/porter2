import fs from "fs";
import path from "path";
import { Composer } from "grammy";

import { bot } from "@/core/bot";
import type { BotContext } from "@/core/bot";
import { vkGlobalApi } from "@/core/api";
import { listModules } from "@/core/module-loader";
import { sequelize, DB_FILE } from "@/lib/sequelize";
import { isMtprotoConfigured, getMtprotoClient } from "@/lib/mtproto";
import { isVkUserConfigured, getVkUserAccessToken } from "@/lib/vkuser";
import logger from "@/lib/logger";
import {
  render,
  code,
  link,
  type Check,
  type RuntimeFacts,
} from "@/health/render";
import { PorterConfig as config } from "../../porter.config";

/**
 * `/health` – an operator-facing status readout.
 *
 * Answers two different questions for two different readers. A moderator wants
 * "is anything broken right now"; the owner wants enough detail to act on it.
 * So the brief form is a per-service verdict and nothing else, and the detailed
 * form adds the values you would otherwise SSH in to read.
 *
 * Nothing here is a secret: no token, key, session string or file path that
 * could be used as one is ever rendered – only whether a credential works and,
 * where it helps, how old it is. That holds for the detailed form too, because
 * "superadmin" is an id in an env var, not a guarantee about who is reading
 * over their shoulder.
 *
 * Reported progressively. The instant facts (modules, config, filesystem) go
 * out immediately and each network probe patches the message as it lands, so a
 * slow VK call never delays the parts already known. Edits are coalesced on a
 * short timer: not to dodge rate limits – grammY is explicit that pre-emptive
 * throttling is "useless and harmful" – but because an edit fired for every
 * individual result is mostly wasted work, and Telegram rejects an edit whose
 * text has not changed.
 *
 * Every probe is bounded and independently caught: a health command that hangs
 * or throws because one service is down has failed at its only job.
 */

const PROBE_TIMEOUT_MS = 5_000;

/**
 * How long to gather results before rewriting the message.
 *
 * Long enough that a burst of fast probes lands in one edit, short enough that
 * the report still feels live.
 */
const FLUSH_INTERVAL_MS = 700;

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

const TIMED_OUT = Symbol("timed-out");

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
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<typeof TIMED_OUT>((resolve) => {
    timer = setTimeout(() => resolve(TIMED_OUT), ms);
  });
  try {
    return await Promise.race([work, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** Time a promise, returning the elapsed ms alongside its result. */
async function timed<T>(work: Promise<T>): Promise<{ value: T; ms: number }> {
  const started = Date.now();
  const value = await work;
  return { value, ms: Date.now() - started };
}

const errText = (e: unknown): string => {
  const err = e as { code?: number | string; message?: string };
  if (err?.code !== undefined) return `Code ${err.code}`;
  return (err?.message ?? String(e)).slice(0, 80);
};

// ── Instant checks (no network) ───────────────────────────────────────────

/**
 * The image store behind published post URLs.
 *
 * Worth a check of its own: those URLs are referenced forever by live VK and
 * Telegram posts, so an unwritable or unmounted directory breaks history, not
 * just the next upload.
 */
function checkImageStore(): Check {
  const dir = path.resolve("./data/images");
  const base = { name: "Image store", module: "frontend" };
  try {
    if (!fs.existsSync(dir)) {
      return { ...base, verdict: "warn", summary: "not created" };
    }
    fs.accessSync(dir, fs.constants.W_OK);
    const count = fs.readdirSync(dir).length;
    return {
      ...base,
      verdict: "ok",
      summary: `${count} file${count === 1 ? "" : "s"}`,
      detail: [`writable: yes`, `path: ${code("./data/images")}`],
    };
  } catch {
    return {
      ...base,
      verdict: "fail",
      summary: "not writable – published links will 404",
    };
  }
}

function checkCrossposting(): Check {
  const cp = config.crossposting;
  const cc = config.crosscommenting;
  const on = [cp?.enabled && "posts", cc?.enabled && "comments"].filter(
    Boolean,
  ) as string[];
  return {
    name: "Crossposting",
    module: "porter",
    verdict: on.length > 0 ? "ok" : "off",
    summary: on.length > 0 ? `${on.join(" + ")} (from ${cp?.origin})` : "disabled",
    detail: [`origin: ${code(String(cp?.origin ?? "–"))}`],
  };
}

// ── Network probes ────────────────────────────────────────────────────────

async function checkDatabase(): Promise<Check> {
  const base = { name: "Database" };
  const res = await withTimeout(timed(sequelize.authenticate()));
  if (res === TIMED_OUT) {
    return { ...base, verdict: "fail", summary: "timed out" };
  }
  const detail: string[] = [];
  try {
    const stat = fs.statSync(DB_FILE);
    detail.push(`size: ${code(`${(stat.size / 1024 / 1024).toFixed(1)} MB`)}`);
  } catch {
    // The file may live somewhere unreadable to us; the connection is what counts.
  }
  return { ...base, verdict: "ok", summary: "connected", ms: res.ms, detail };
}

async function checkTelegram(): Promise<Check> {
  const base = { name: "Telegram API" };
  const res = await withTimeout(timed(bot.api.getMe()));
  if (res === TIMED_OUT) {
    return { ...base, verdict: "fail", summary: "timed out" };
  }
  const me = res.value;
  return {
    ...base,
    verdict: "ok",
    summary: `@${me.username}`,
    ms: res.ms,
    detail: [
      `bot: ${link(`https://t.me/${me.username}`, `@${me.username}`)}`,
      `bot id: ${code(me.id)}`,
    ],
  };
}

async function checkVkCommunity(): Promise<Check> {
  const base = { name: "VK API (community)" };
  if (!process.env.VK_TOKEN) {
    return { ...base, verdict: "fail", summary: "VK_TOKEN unset" };
  }
  try {
    const res = await withTimeout(
      timed(vkGlobalApi.groups.getById({}) as unknown as Promise<unknown>),
    );
    if (res === TIMED_OUT) {
      return { ...base, verdict: "fail", summary: "timed out" };
    }
    const list = Array.isArray(res.value)
      ? res.value
      : ((res.value as { groups?: unknown[] } | null)?.groups ?? []);
    const group = list[0] as { name?: string; id?: number } | undefined;
    return {
      ...base,
      verdict: "ok",
      summary: group?.name ?? "token valid",
      ms: res.ms,
      detail: group?.id
        ? [
            `group: ${link(`https://vk.ru/club${group.id}`, `-${group.id}`)}`,
            `name: ${code(group.name ?? "–")}`,
          ]
        : [],
    };
  } catch (error) {
    return { ...base, verdict: "fail", summary: errText(error) };
  }
}

/**
 * The user token that wall photos depend on.
 *
 * Probes the upload route rather than just `users.get`, because that is the
 * call that actually fails when the token is bound to a stale egress IP – a
 * token can be perfectly alive and still be unable to do the one job it is
 * held for.
 */
async function checkVkUser(): Promise<Check> {
  const base = { name: "VK user token", module: "frontend" };
  if (!isVkUserConfigured()) {
    return {
      ...base,
      verdict: "off",
      summary: "User token not configured – using group token (restricted)",
    };
  }
  const token = await getVkUserAccessToken();
  if (!token) {
    return { ...base, verdict: "fail", summary: "token unavailable" };
  }

  const groupRaw = process.env.VK_GROUP_ID ?? "";
  const groupId = Math.abs(parseInt(groupRaw) || 0);
  if (!groupId) {
    return { ...base, verdict: "warn", summary: "VK_GROUP_ID unset" };
  }

  try {
    const { API } = await import("vk-io");
    const api = new API({ token });
    const res = await withTimeout(
      timed(
        api.photos.getWallUploadServer({
          group_id: groupId,
        }) as unknown as Promise<{ upload_url?: string }>,
      ),
    );
    if (res === TIMED_OUT) {
      return { ...base, verdict: "fail", summary: "timed out" };
    }
    return {
      ...base,
      verdict: res.value?.upload_url ? "ok" : "warn",
      summary: res.value?.upload_url
        ? "upload route reachable"
        : "no upload_url",
      ms: res.ms,
      detail: [`target group: ${link(`https://vk.ru/club${groupId}`, `-${groupId}`)}`],
    };
  } catch (error) {
    const err = error as { code?: number; message?: string };
    // Code 5 is the one that matters and the one that reads least like itself.
    const hint =
      err?.code === 5
        ? /another ip address/i.test(err.message ?? "")
          ? "egress IP changed (token bound elsewhere)"
          : "token expired or revoked"
        : errText(error);
    return { ...base, verdict: "fail", summary: hint };
  }
}

async function checkMtproto(): Promise<Check> {
  const base = { name: "MTProto", module: "all-command" };
  if (!isMtprotoConfigured()) {
    return {
      ...base,
      verdict: "off",
      summary: "not configured (bot sees only chat admins)",
    };
  }
  const res = await withTimeout(timed(getMtprotoClient()));
  if (res === TIMED_OUT) {
    return { ...base, verdict: "fail", summary: "timed out" };
  }
  return res.value
    ? { ...base, verdict: "ok", summary: "connected", ms: res.ms }
    : { ...base, verdict: "fail", summary: "client unavailable" };
}

async function checkApiServer(): Promise<Check> {
  const base = { name: "API server", module: "frontend" };
  const api = config.api;
  if (!api?.enabled) {
    return { ...base, verdict: "off", summary: "disabled" };
  }
  const port = api.port ?? 5050;
  try {
    const res = await withTimeout(
      timed(
        fetch(`http://127.0.0.1:${port}/health`, {
          signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
        }),
      ),
    );
    if (res === TIMED_OUT) {
      return { ...base, verdict: "fail", summary: "timed out" };
    }
    const publicUrl =
      api.imageServer?.enabled && api.imageServer.publicUrl
        ? api.imageServer.publicUrl
        : null;
    return {
      ...base,
      verdict: res.value.ok ? "ok" : "warn",
      summary: res.value.ok ? `listening on ${port}` : `HTTP ${res.value.status}`,
      ms: res.ms,
      detail: [
        `port: ${code(port)}`,
        ...(publicUrl ? [`public: ${link(publicUrl, publicUrl)}`] : []),
      ],
    };
  } catch (error) {
    return { ...base, verdict: "fail", summary: errText(error) };
  }
}

// ── Rendering ─────────────────────────────────────────────────────────────

/** The probes, in display order, paired with the slot each one fills. */
const PROBES: { name: string; run: () => Promise<Check> }[] = [
  { name: "Database", run: checkDatabase },
  { name: "Telegram API", run: checkTelegram },
  { name: "VK API (community)", run: checkVkCommunity },
  { name: "MTProto", run: checkMtproto },
  { name: "API server", run: checkApiServer },
  { name: "VK user token", run: checkVkUser },
];

function pendingCheck(name: string): Check {
  return { name, verdict: "pending", summary: "checking\u2026" };
}

/** Snapshot the process facts the detailed view reports. */
function runtimeFacts(): RuntimeFacts {
  const mem = process.memoryUsage();
  return {
    uptimeSeconds: process.uptime(),
    rssBytes: mem.rss,
    nodeVersion: process.version,
  };
}

function report(checks: Check[], detailed: boolean): string {
  return render(checks, detailed, listModules(), runtimeFacts());
}

// ── Command ───────────────────────────────────────────────────────────────

/**
 * Who may run this, and how much they see.
 *
 * Super admins get detail. Moderators and chat admins get the summary.
 * Everyone else is refused – including in a DM, where there is no chat
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
  if (isGroup && healthConfig.allowInGroups === false) return;

  const { allowed, detailed } = await authorize(ctx);
  if (!allowed) {
    await ctx.reply("Эта команда только для админов.");
    return;
  }

  // Instant facts go out first; the network probes fill in as they land.
  const checks: Check[] = [
    ...PROBES.map((p) => pendingCheck(p.name)),
    checkCrossposting(),
    checkImageStore(),
  ];
  const slot = new Map(checks.map((c, i) => [c.name, i]));

  const sent = await ctx.reply(report(checks, detailed), {
    parse_mode: "HTML",
    link_preview_options: { is_disabled: true },
  });

  let lastText = report(checks, detailed);
  let dirty = false;
  let closed = false;

  const flush = async (): Promise<void> => {
    if (!dirty) return;
    dirty = false;
    const text = report(checks, detailed);
    // Telegram rejects an edit that changes nothing; skipping is cheaper than
    // catching, and keeps a genuine failure visible in the logs.
    if (text === lastText) return;
    lastText = text;
    try {
      await ctx.api.editMessageText(ctx.chat!.id, sent.message_id, text, {
        parse_mode: "HTML",
        link_preview_options: { is_disabled: true },
      });
    } catch (error) {
      logger.debug(`[health] edit skipped: ${String(error)}`);
    }
  };

  const ticker = setInterval(() => {
    if (!closed) void flush();
  }, FLUSH_INTERVAL_MS);

  await Promise.all(
    PROBES.map(async (p) => {
      let result: Check;
      try {
        result = await p.run();
      } catch (error) {
        result = { name: p.name, verdict: "fail", summary: errText(error) };
      }
      const i = slot.get(p.name);
      if (i !== undefined) {
        // Keep the declared slot so lines never reorder as results arrive.
        checks[i] = { ...result, name: p.name };
        dirty = true;
      }
    }),
  );

  closed = true;
  clearInterval(ticker);
  dirty = true;
  await flush();
}

const healthCommand = new Composer<BotContext>();
healthCommand.command("health", handleHealth);

export default healthCommand;
