import pino from "pino";
import fs from "fs";
import path from "path";
import { PorterConfig as config } from "../../porter.config";

// Ensure logs directory exists
const logsDir = path.resolve(process.cwd(), "logs");
try {
  fs.mkdirSync(logsDir, { recursive: true });
} catch {
  // If directory creation fails, pino destinations may fail; still attempt to continue.
}

// Detect PM2 to control stdout format (JSON for PM2 compatibility)
const isPM2 = Boolean(
  process.env.pm_id || process.env.PM2_HOME || process.env.PM2,
);

// Stdout stream: JSON when under PM2, pretty otherwise
const stdoutStream = isPM2
  ? pino.destination(1) // JSON to stdout for PM2
  : pino.transport({
      target: "pino-pretty",
      options: {
        colorize: true,
        ignore: "pid,hostname",
        translateTime: "SYS:yyyy-mm-dd HH:MM:ss",
      },
    });

/**
 * Build one file stream, or nothing if the file cannot be opened.
 *
 * Log files are a convenience; the bot is the product. Constructing these
 * eagerly meant an unwritable logs/ threw EACCES during module import and took
 * the whole process down before it reached main() — measured 2026-08-28, when
 * mounting ./logs as a volume gave the directory the HOST's root ownership and
 * the container user (UID 1001) could not open error.log. The bot was dead on
 * arrival because it could not write a log line. Never again: a destination
 * that cannot be opened is dropped, stdout carries everything regardless, and
 * the reason is printed once so the cause is not a mystery.
 */
function fileStream(
  name: string,
  level: string,
): { level: string; stream: pino.DestinationStream } | null {
  try {
    return {
      level,
      stream: pino.destination({ dest: path.join(logsDir, name), sync: true }),
    };
  } catch (error) {
    const why = (error as NodeJS.ErrnoException)?.code ?? String(error);
    process.stderr.write(
      `[logger] ${name} disabled (${why}) — logging to stdout only. ` +
        `If logs/ is a mounted volume, it inherits the host directory's owner: ` +
        `sudo chown -R 1001:1001 logs\n`,
    );
    return null;
  }
}

// app.log goes through pino-pretty in a worker, so a bad path surfaces as an
// async error event rather than a throw here — handled below.
let appPrettyTransport: ReturnType<typeof pino.transport> | null = null;
try {
  appPrettyTransport = pino.transport({
    target: "pino-pretty",
    options: {
      colorize: false,
      ignore: "pid,hostname",
      translateTime: "SYS:yyyy-mm-dd HH:MM:ss",
      destination: path.join(logsDir, "app.log"),
    },
  });
  // An unwritable destination reaches us here. Without a listener this is an
  // unhandled 'error' event, which is fatal — the exact crash class above.
  appPrettyTransport.on("error", (error: unknown) => {
    process.stderr.write(`[logger] app.log disabled (${String(error)})\n`);
  });
} catch (error) {
  process.stderr.write(`[logger] app.log disabled (${String(error)})\n`);
}

const streams = [
  // Stdout: pretty unless under PM2 (then JSON). Always present — this is the
  // one destination that must never be optional, since `docker logs` reads it.
  { level: config?.loggingLevel ?? "info", stream: stdoutStream },

  ...(appPrettyTransport
    ? [{ level: config?.loggingLevel ?? "info", stream: appPrettyTransport }]
    : []),

  // error.log: warn and higher
  fileStream("error.log", "warn"),

  // debug.log: debug and higher
  fileStream("debug.log", "debug"),
].filter((entry): entry is { level: string; stream: pino.DestinationStream } =>
  entry !== null,
);

// Redact secrets so a raw context/update accidentally logged can never leak the
// bot token or VK token to disk. (The legacy logger had no redaction and leaked
// the Telegram token across ~179 log lines.)
const REDACT_PATHS = [
  "token",
  "*.token",
  "*.*.token",
  "telegram.token",
  "*.telegram.token",
  "api.token",
  "*.api.token",
  "TELEGRAM_TOKEN",
  "VK_TOKEN",
  "PORTER_API_KEY",
];

const logger = pino(
  {
    level: config?.loggingLevel ?? "info",
    redact: { paths: REDACT_PATHS, censor: "[REDACTED]" },
  },
  pino.multistream(streams),
);

export default logger;
