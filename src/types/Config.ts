export interface Config {
  loggingLevel: "debug" | "info" | "warn" | "error";
  /**
   * A second, MTProto-level authorization used for the things the Bot API
   * simply does not expose — most notably enumerating every member of a
   * supergroup. Optional: every consumer must degrade gracefully when this is
   * disabled or temporarily unreachable.
   */
  mtproto?:
    | {
        enabled: true;
        /** api_id from my.telegram.org. */
        apiId: number;
        /** api_hash from my.telegram.org. */
        apiHash: string;
        /**
         * User-account session string (see `npm run mtlogin`). Preferred over
         * `botToken`: a user account can read member lists without being an
         * administrator, and never competes for the bot's update queue.
         */
        session?: string;
        /**
         * Bot token, used when no session string is supplied. The bot must be
         * an administrator of every chat it is asked about.
         */
        botToken?: string;
        /** SQLite file holding the auth key and the peer cache. */
        storagePath: string;
      }
    | {
        enabled: false;
      };
  crossposting: {
    enabled: boolean;
    origin: "vk" | "tg" | "both";
    parameters: {
      ignoreReposts: boolean;
      ignorePolls: boolean;
    };
  };
  crosscommenting:
    | {
        enabled: true;
        origin: "vk" | "tg" | "both";
      }
    | {
        enabled: false;
      };
  api:
    | {
        enabled: true;
        /** Port for the REST API server. Default: 3000. Must be 1-65535. */
        port?: number;
        /** API key for authentication. Default: "changeme" */
        apiKey?: string;
        /** Methods to include (whitelist). If not set, all methods are enabled. */
        includeMethods?: string[];
        /** Methods to exclude (blacklist). Applied after includeMethods. */
        excludeMethods?: string[];
        /** Submissions feature configuration */
        submissions?:
          | {
              enabled: true;
              /** Telegram chat ID for moderation messages */
              moderationChatId: string;
              /** Topic/thread ID for forum-style groups (optional) */
              moderationTopicId?: number;
              /** VK group ID for posting (negative number) */
              vkGroupId?: string;
            }
          | {
              enabled: false;
            };
        /** Image server configuration for hosting images */
        imageServer?:
          | {
              enabled: true;
              /** Public URL where images are accessible (required). Must be publicly accessible, not localhost. */
              publicUrl: string;
              /** Directory for storing uploaded images. Default: "./uploads" */
              uploadsDir?: string;
              /** Whether to fall back to buffer mode if image server fails. Default: true */
              fallbackToBuffer?: boolean;
              /** Max age in hours for uploaded images before cleanup. Default: 24 */
              maxAgeHours?: number;
            }
          | {
              enabled: false;
            };
      }
    | {
        enabled: false;
      };
}

/**
 * Helper type to check if API is enabled
 */
export type ApiEnabledConfig = Config & {
  api: Extract<Config["api"], { enabled: true }>;
};

/**
 * Helper type to check if submissions are enabled
 */
export type SubmissionsEnabledConfig = ApiEnabledConfig & {
  api: ApiEnabledConfig["api"] & {
    submissions: Extract<
      NonNullable<ApiEnabledConfig["api"]["submissions"]>,
      { enabled: true }
    >;
  };
};

/**
 * Helper type to check if image server is enabled
 */
export type ImageServerEnabledConfig = ApiEnabledConfig & {
  api: ApiEnabledConfig["api"] & {
    imageServer: Extract<
      NonNullable<ApiEnabledConfig["api"]["imageServer"]>,
      { enabled: true }
    >;
  };
};

/**
 * Validate port number
 */
export function isValidPort(port: number): boolean {
  return Number.isInteger(port) && port >= 1 && port <= 65535;
}

/**
 * Validate public URL (must not be localhost for production use)
 */
export function isValidPublicUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    const isLocalhost =
      parsed.hostname === "localhost" ||
      parsed.hostname === "127.0.0.1" ||
      parsed.hostname === "0.0.0.0";
    return !isLocalhost;
  } catch {
    return false;
  }
}

/**
 * Check if a method is allowed based on include/exclude lists
 */
export function isMethodAllowed(
  method: string,
  includeMethods?: string[],
  excludeMethods?: string[],
): boolean {
  // If include list is specified, method must be in it
  if (includeMethods && includeMethods.length > 0) {
    if (!includeMethods.includes(method)) {
      return false;
    }
  }

  // If exclude list is specified, method must not be in it
  if (excludeMethods && excludeMethods.length > 0) {
    if (excludeMethods.includes(method)) {
      return false;
    }
  }

  return true;
}
