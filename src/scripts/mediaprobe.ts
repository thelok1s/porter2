/**
 * The media upload fallback, against a real HTTP server and a fake Telegram.
 *
 * The failure it exists for is the one in app.log at 2026-09-02 12:00:51:
 * Telegram answered `WEBPAGE_CURL_FAILED` on a VK photo URL, the whole port
 * threw, and post 3614 was never recorded — after which two comments on it were
 * dropped hours apart with "Post not found".
 *
 * What has to hold: that refusal is retried with bytes we fetched ourselves,
 * nothing else is retried at all (a retry that is not free would duplicate a
 * post), and an attachment we cannot fetch either lets the original error
 * stand rather than pretending.
 */
import { createServer } from "http";
import { GrammyError, InputFile } from "grammy";

import { cannotFetch, sendMedia } from "../porter/posts";

let failed = 0;
function check(name: string, ok: boolean, detail = ""): void {
  console.log(`${ok ? "✅" : "❌"} ${name}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failed++;
}

/** A GrammyError as grammY builds one, without going near the network. */
function tgError(description: string, code = 400): GrammyError {
  return new GrammyError(
    `Call to 'sendMediaGroup' failed!`,
    { ok: false, error_code: code, description },
    "sendMediaGroup",
    {},
  );
}

const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);

async function main(): Promise<void> {
  const server = createServer((req, res) => {
    if (req.url?.startsWith("/gone")) {
      res.writeHead(404).end("no");
      return;
    }
    res.writeHead(200, { "content-type": "image/png" }).end(PNG);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as { port: number }).port;
  const ok = `http://127.0.0.1:${port}/photo.png`;
  const gone = `http://127.0.0.1:${port}/gone.png`;

  // ── which errors count ──────────────────────────────────────────────────
  check(
    "WEBPAGE_CURL_FAILED is a fetch refusal",
    cannotFetch(
      tgError('Bad Request: failed to send message #1 with the error message "WEBPAGE_CURL_FAILED"'),
    ),
    "the exact description from app.log",
  );
  check(
    "so is 'failed to get HTTP URL content'",
    cannotFetch(tgError("Bad Request: failed to get HTTP URL content")),
  );
  check(
    "a caption parse error is NOT",
    !cannotFetch(tgError("Bad Request: can't parse entities")),
    "retrying that would send the same broken caption twice",
  );
  check("a plain Error is NOT", !cannotFetch(new Error("socket hang up")));

  // ── the retry ───────────────────────────────────────────────────────────
  {
    let attempts = 0;
    const seen: Array<Array<string | InputFile>> = [];
    const result = await sendMedia(
      [{ type: "photo" as const, media: ok }, { type: "photo" as const, media: ok }],
      async (items) => {
        attempts++;
        seen.push(items.map((i) => i.media));
        if (attempts === 1) throw tgError('the error message "WEBPAGE_CURL_FAILED"');
        return ["sent"];
      },
    );
    check("a refused fetch is retried once", attempts === 2, `${attempts} attempts`);
    check("the first try used URLs", seen[0].every((m) => typeof m === "string"));
    check(
      "the retry uploaded bytes instead",
      seen[1].every((m) => m instanceof InputFile),
      "both attachments were downloaded and handed over as files",
    );
    check("and the caller got the result", JSON.stringify(result) === '["sent"]');
  }

  // ── everything else is left alone ───────────────────────────────────────
  {
    let attempts = 0;
    let thrown: unknown = null;
    try {
      await sendMedia([{ type: "photo" as const, media: ok }], async () => {
        attempts++;
        throw tgError("Bad Request: chat not found");
      });
    } catch (error) {
      thrown = error;
    }
    check(
      "an unrelated error is not retried",
      attempts === 1 && thrown instanceof GrammyError,
      `${attempts} attempt(s), rethrown as-is`,
    );
  }

  // ── an attachment we cannot fetch either ────────────────────────────────
  {
    let attempts = 0;
    const seen: Array<Array<string | InputFile>> = [];
    let thrown: unknown = null;
    try {
      await sendMedia([{ type: "photo" as const, media: gone }], async (items) => {
        attempts++;
        seen.push(items.map((i) => i.media));
        throw tgError('the error message "WEBPAGE_CURL_FAILED"');
      });
    } catch (error) {
      thrown = error;
    }
    check(
      "an unreachable URL is passed through unchanged",
      seen[1]?.[0] === gone,
      "no pretending we have bytes we could not get",
    );
    check(
      "and the refusal stands",
      attempts === 2 && thrown instanceof GrammyError,
      "one retry, then the real error",
    );
  }

  server.close();
  console.log(`\n${failed === 0 ? "all good" : `${failed} failing`}`);
  process.exit(failed === 0 ? 0 : 1);
}

void main();
