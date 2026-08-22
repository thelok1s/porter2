/**
 * Presentation for `/health`.
 *
 * Pure: no probes, no bot, no config reads. The module list arrives as an
 * argument rather than being imported, which keeps this file free of the
 * bot-construction side effects in `@/core/module-loader` and lets the layout
 * be exercised on its own.
 */

export type Verdict = "ok" | "warn" | "fail" | "off" | "pending";

export interface Check {
  name: string;
  verdict: Verdict;
  /** One short clause for the brief view. */
  summary: string;
  /**
   * Which module owns this check, matching its folder under `src/` or
   * `local/`. Undefined means it is a porter2 service rather than a module's.
   */
  module?: string;
  /** Round-trip time, where the check measured one. */
  ms?: number;
  /**
   * Extra lines for the detailed view. Pre-rendered HTML – build them with
   * `code()` and `link()`, which escape their inputs, rather than by
   * interpolating raw strings.
   */
  detail?: string[];
}

export const ICON: Record<Verdict, string> = {
  ok: "🟢",
  warn: "🟡",
  fail: "🔴",
  off: "⚪️",
  pending: "⏳",
};

export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

/** Monospace, so ids can be tapped to copy in Telegram clients. */
export function code(value: string | number): string {
  return `<code>${escapeHtml(String(value))}</code>`;
}

/** A link whose label stays monospace, for ids that also point somewhere. */
export function link(url: string, label: string | number): string {
  return `<a href="${escapeHtml(url)}">${code(label)}</a>`;
}

export function formatUptime(seconds: number): string {
  const d = Math.floor(seconds / 86400);
  const h = Math.floor((seconds % 86400) / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}

/** Worst verdict wins, but anything still running keeps the header honest. */
export function overall(checks: Check[]): Verdict {
  if (checks.some((c) => c.verdict === "pending")) return "pending";
  if (checks.some((c) => c.verdict === "fail")) return "fail";
  if (checks.some((c) => c.verdict === "warn")) return "warn";
  return "ok";
}

function line(c: Check): string {
  const ms = c.ms !== undefined ? ` (${c.ms} ms)` : "";
  return `${ICON[c.verdict]} <b>${escapeHtml(c.name)}</b> – ${escapeHtml(c.summary)}${ms}`;
}

export interface RuntimeFacts {
  uptimeSeconds: number;
  rssBytes: number;
  nodeVersion: string;
}

export function render(
  checks: Check[],
  detailed: boolean,
  modules: { name: string }[],
  runtime: RuntimeFacts,
): string {
  const state = overall(checks);
  const head = `${ICON[state]} <b>porter2 service</b> – ${
    state === "pending" ? "checking…" : state === "ok" ? "healthy" : "degraded"
  }`;

  const out: string[] = [
    head,
    "",
    `<b>Modules</b> (${modules.length})`,
    `  ${modules.map((m) => code(m.name)).join(", ")}`,
    "",
  ];

  // porter2's own services first, then a section per owning module. Grouping by
  // owner makes it obvious whether a failure is the platform or one feature.
  out.push(...checks.filter((c) => !c.module).map(line));

  const byModule = new Map<string, Check[]>();
  for (const c of checks) {
    if (!c.module) continue;
    const list = byModule.get(c.module) ?? [];
    list.push(c);
    byModule.set(c.module, list);
  }
  for (const [name, list] of byModule) {
    out.push("", `<i>---module ${escapeHtml(name)}---</i>`, ...list.map(line));
  }

  if (!detailed) return out.join("\n");

  const extra: string[] = [];
  for (const c of checks) {
    if (c.detail?.length) {
      extra.push(`<b>${escapeHtml(c.name)}</b>`, ...c.detail.map((d) => `  ${d}`));
    }
  }

  const runtimeLines = [
    "<b>Runtime</b>",
    `  uptime: ${code(formatUptime(runtime.uptimeSeconds))}`,
    `  memory: ${code(`${(runtime.rssBytes / 1024 / 1024).toFixed(0)} MB rss`)}`,
    `  node: ${code(runtime.nodeVersion)}`,
  ];

  return [...out, "", ...extra, ...runtimeLines].join("\n");
}
