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

// app.log: pretty formatted using pino-pretty, written to file
const appPrettyTransport = pino.transport({
  target: "pino-pretty",
  options: {
    colorize: false,
    ignore: "pid,hostname",
    translateTime: "SYS:yyyy-mm-dd HH:MM:ss",
    destination: path.join(logsDir, "app.log"),
  },
});

const streams = [
  // Stdout: pretty unless under PM2 (then JSON)
  { level: config?.loggingLevel ?? "info", stream: stdoutStream },

  // app.log: pretty formatted
  { level: config?.loggingLevel ?? "info", stream: appPrettyTransport },

  // error.log: warn and higher
  {
    level: "warn",
    stream: pino.destination({
      dest: path.join(logsDir, "error.log"),
      sync: true,
    }),
  },

  // debug.log: debug and higher
  {
    level: "debug",
    stream: pino.destination({
      dest: path.join(logsDir, "debug.log"),
      sync: true,
    }),
  },
];

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
