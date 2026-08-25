import fs from "fs";
import path from "path";

/**
 * Parsing for an exported VK browser session.
 *
 * The renewal path replays what VK's own web client does, so it needs the
 * user's session cookies. People export those with whatever tool is at hand, so
 * four formats are accepted and detected rather than demanded — getting the
 * format wrong otherwise looks exactly like a logged-out session, which sends
 * the diagnosis in the wrong direction. Shared by the runtime renewer and the
 * `vkrenewprobe` script so there is one parser to trust.
 */

export interface CookieJar {
  /** Ready to send as a `Cookie:` header. */
  header: string;
  /** Cookie names present, in file order. */
  names: string[];
  /** Domains seen, when the format records them; empty for a Cookie header. */
  domains: string[];
  /** Which export format was recognised. */
  format: string;
}

/** Where the jar lives: explicit override, else .txt then .json under db/. */
export function cookieJarPath(): string {
  if (process.env.VK_COOKIE_FILE) return path.resolve(process.env.VK_COOKIE_FILE);
  for (const candidate of ["./db/vkcookies.txt", "./db/vkcookies.json"]) {
    const full = path.resolve(candidate);
    if (fs.existsSync(full)) return full;
  }
  return path.resolve("./db/vkcookies.txt");
}

export function parseCookieJar(raw: string): CookieJar | null {
  const text = raw.trim();
  if (!text) return null;

  const pairs = new Map<string, string>();
  const domains = new Set<string>();
  let format: string;

  if (text.startsWith("[") || text.startsWith("{")) {
    format = "JSON";
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      return null;
    }
    const arr = Array.isArray(parsed)
      ? parsed
      : ((parsed as { cookies?: unknown[] }).cookies ?? null);
    if (!arr) {
      const single = (parsed as { cookie?: string }).cookie;
      return typeof single === "string" ? parseCookieJar(single) : null;
    }
    for (const item of arr as { name?: string; value?: string; domain?: string }[]) {
      if (!item?.name) continue;
      pairs.set(item.name, item.value ?? "");
      if (item.domain) domains.add(item.domain.replace(/^\./, ""));
    }
  } else if (
    text.split("\n").some((l) => {
      const f = l.split("\t");
      return f.length >= 5 && /^\d{4}-\d{2}-\d{2}T/.test((f[4] ?? "").trim());
    })
  ) {
    // DevTools "Application → Cookies" table, copied row-wise: each line is
    // name ␉ value ␉ domain ␉ path ␉ expires(ISO) ␉ size ␉ flags…. The ISO
    // stamp in the fifth column separates it from Netscape, whose fifth
    // column is a unix epoch. Only the leading columns matter; the flag
    // columns shift between Chrome versions and are ignored.
    format = "DevTools cookies table";
    for (const line of text.split("\n")) {
      const fields = line.split("\t").map((c) => c.trim());
      if (fields.length < 5 || !/^\d{4}-\d{2}-\d{2}T/.test(fields[4])) continue;
      const [name, value, domain] = fields;
      if (!name) continue;
      pairs.set(name, value ?? "");
      if (domain) domains.add(domain.replace(/^\./, ""));
    }
  } else if (/^[^\s#][^\n]*\t/m.test(text) || /^# Netscape/i.test(text)) {
    format = "Netscape cookies.txt";
    for (const line of text.split("\n")) {
      // curl marks HttpOnly cookies with a #HttpOnly_ prefix on the domain
      // field. Strip the marker rather than treating the line as a comment —
      // skipping it drops remixsid, the one cookie that carries the session.
      const cleaned = line.replace(/^#HttpOnly_/, "");
      if (!cleaned.trim() || cleaned.startsWith("#")) continue;
      const fields =
        cleaned.split("\t").length >= 7 ? cleaned.split("\t") : cleaned.split(/\s+/);
      if (fields.length < 7) continue;
      const [domain, , , , , name, ...rest] = fields;
      if (!name) continue;
      pairs.set(name, rest.join("\t"));
      domains.add(domain.replace(/^\./, ""));
    }
  } else {
    format = "Cookie header";
    for (const pair of text
      .replace(/^Cookie:\s*/i, "")
      .replace(/\s*\n\s*/g, " ")
      .split(";")) {
      const [k, ...v] = pair.trim().split("=");
      if (k) pairs.set(k, v.join("="));
    }
  }

  if (pairs.size === 0) return null;
  return {
    header: [...pairs].map(([k, v]) => `${k}=${v}`).join("; "),
    names: [...pairs.keys()],
    domains: [...domains],
    format,
  };
}

/** Load and parse the jar file, or null when it is absent or unusable. */
export function loadCookieJar(file: string = cookieJarPath()): CookieJar | null {
  try {
    return parseCookieJar(fs.readFileSync(file, "utf8"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    return null;
  }
}

/**
 * Persist a jar header back to disk — used after a renewal folds in whatever
 * Set-Cookie answers VK returned, so the next attempt starts from the session
 * VK last saw instead of one rotation behind.
 *
 * Written as a plain Cookie header at 0600: the file is ACCOUNT-GRADE (it
 * authenticates as the user), matching the gitignore note on db/vkcookies*.
 */
export function saveCookieJar(
  header: string,
  file: string = cookieJarPath(),
): void {
  fs.writeFileSync(file, header + "\n", { mode: 0o600 });
}
