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

  /**
   * `/health` — an operator-facing status readout in Telegram.
   *
   * OFF by default and deliberately so: it reports on live credentials and
   * infrastructure, so it should be a decision to expose rather than something
   * a deployment inherits. Access is still gated at call time — moderators get
   * a summary, only SUPER_ADMIN_ID sees detail — but the flag is the outer
   * boundary.
   */
  /**
   * Watch the VK user token and say something before photos start disappearing.
   *
   * These tokens carry `expires_in=86400`, so the failure is not an edge case —
   * it is a daily certainty. Without a watch the only symptom is posts quietly
   * publishing without their picture, which nothing alerts on and nobody
   * notices for a while.
   *
   * On by default, unlike `/health`: this reports to the owner alone and
   * reveals no credential, so there is nothing here to expose by inheriting it.
   */
  vkToken?: {
    watch: boolean;
    /** How often to look, in minutes. Default 30. */
    intervalMinutes?: number;
    /**
     * Warn once fewer than this many hours remain. Default 6 — enough notice
     * to act without the warning arriving so early it becomes background noise.
     */
    warnBeforeHours?: number;
    /**
     * Start trying unattended renewal once fewer than this many hours remain
     * (or, for tokens with no reported expiry, once they are this old).
     * Default 18 — about three quarters through the measured 24 h life, so
     * the exchange runs while the outgoing token is still valid; the web_token
     * route has only ever been observed accepting a live token.
     */
    renewAheadHours?: number;
    /**
     * Page SUPER_ADMIN_ID only after unattended renewal has failed this many
     * times in a row. Default 3.
     *
     * web_token mints live only ~15 min, so the watch re-mints every few
     * minutes and an occasional attempt hits a transient VK blip (a 502, a
     * momentary Code 5) that the very next attempt heals. Paging on a single
     * miss would ring the operator for something already fixed. Only a run of
     * consecutive failures means automation has genuinely stopped keeping up —
     * a dead jar, a moved egress IP, VK down — and needs a human. A single
     * success resets the count.
     */
    alertAfterFailures?: number;
  };

  health?: {
    enabled: boolean;
    /**
     * Whether the command answers in group chats as well as DMs. Group replies
     * are visible to everyone present, so even the brief form leaks which
     * services exist; DM-only is the cautious setting.
     *
     * Flat rather than a discriminated union so the setting can be configured
     * while the feature is still off, ready for whenever it is turned on.
     */
    allowInGroups?: boolean;
  };
}

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
