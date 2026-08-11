import dotenv from "dotenv";
import fs from "fs";
import path from "path";
import zlib from "zlib";
import { VK, API } from "vk-io";

dotenv.config();

/**
 * Probe: which photo-attachment strategy does our VK community token allow?
 *
 * Background. `upload.wallPhoto` (photos.getWallUploadServer +
 * photos.saveWallPhoto) is documented user-token-only and answers Code 27
 * ("method is unavailable with group auth") for a community token — confirmed
 * by VKCOM/vk-api-schema#242, where it fails even with `photos` rights granted.
 * A user token was ruled out, and appending a bare image URL to the message did
 * not render a preview.
 *
 * The remaining seam: photos.getMessagesUploadServer and
 * photos.saveMessagesPhoto BOTH explicitly document community-token support
 * (`ключ доступа сообщества`, rights: photos), and saveMessagesPhoto returns an
 * `access_key` — the token VK uses to reference media that is not publicly
 * listed, attachable as `photo{owner_id}_{id}_{access_key}`. Whether VK lets a
 * messages-photo ride on a WALL post is exactly the thing no documentation
 * states, so this script asks VK instead of guessing.
 *
 * Every strategy is tested against the real wall as a POSTPONED post (publish
 * date a week out), read back to see whether the attachment actually survived,
 * then DELETED. Nothing becomes visible to the community at any point.
 *
 *   bun src/scripts/vkphotoprobe.ts
 *   bun src/scripts/vkphotoprobe.ts --image ./data/images/<file>.png
 *   bun src/scripts/vkphotoprobe.ts --url https://frog.prod…/api/images/x.png
 *
 * Report the printed summary — the winning strategy is what gets wired into
 * publishAnnouncementToVk.
 */

// ── args ────────────────────────────────────────────────────────────────────

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i !== -1 ? process.argv[i + 1] : undefined;
}

const IMAGE_ARG = arg("image");
const URL_ARG = arg("url");
const PEER_ARG = arg("peer");

// ── env ─────────────────────────────────────────────────────────────────────

const TOKEN = process.env.VK_TOKEN;
const GROUP_ID_RAW = process.env.VK_GROUP_ID;

if (!TOKEN) {
  console.error("VK_TOKEN is not set — nothing to probe.");
  process.exit(1);
}
if (!GROUP_ID_RAW) {
  console.error("VK_GROUP_ID is not set — nothing to probe.");
  process.exit(1);
}

const parsedGroup = parseInt(GROUP_ID_RAW);
if (!Number.isFinite(parsedGroup) || parsedGroup === 0) {
  console.error(`VK_GROUP_ID="${GROUP_ID_RAW}" is not a usable id.`);
  process.exit(1);
}

/** Positive id for the photo methods, negative owner id for wall.post. */
const GROUP_ID = Math.abs(parsedGroup);
const OWNER_ID = -GROUP_ID;

const vk = new VK({ token: TOKEN });
const api = new API({ token: TOKEN });

// ── test image ──────────────────────────────────────────────────────────────

/**
 * Hand-rolled PNG encoder, used only when there is no real image to borrow.
 * A dependency-free fallback keeps the probe runnable on a bare server; VK
 * rejects degenerate images, so this paints a real 600x400 gradient rather
 * than a 1x1 pixel.
 */
function generatePng(width = 600, height = 400): Buffer {
  const crcTable: number[] = [];
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    crcTable[n] = c >>> 0;
  }
  const crc32 = (buf: Buffer): number => {
    let crc = 0xffffffff;
    for (let i = 0; i < buf.length; i++)
      crc = crcTable[(crc ^ buf[i]) & 0xff] ^ (crc >>> 8);
    return (crc ^ 0xffffffff) >>> 0;
  };
  const chunk = (type: string, data: Buffer): Buffer => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const typed = Buffer.concat([Buffer.from(type, "ascii"), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(typed));
    return Buffer.concat([len, typed, crc]);
  };

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // colour type: truecolour RGB
  // 10..12 stay 0: deflate, adaptive filtering, no interlace

  const raw = Buffer.alloc(height * (width * 3 + 1));
  let o = 0;
  for (let y = 0; y < height; y++) {
    raw[o++] = 0; // filter: none
    for (let x = 0; x < width; x++) {
      raw[o++] = Math.floor((x / width) * 255);
      raw[o++] = Math.floor((y / height) * 255);
      raw[o++] = 160;
    }
  }

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", zlib.deflateSync(raw)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

/** Prefer a real announcement image; fall back to a generated one. */
function resolveImage(): { source: Buffer | string; described: string } {
  if (URL_ARG) return { source: URL_ARG, described: `url ${URL_ARG}` };
  if (IMAGE_ARG)
    return {
      source: fs.readFileSync(IMAGE_ARG),
      described: `file ${IMAGE_ARG}`,
    };

  const dir = path.resolve(process.env.SUBMISSION_IMAGES_DIR ?? "./data/images");
  if (fs.existsSync(dir)) {
    const newest = fs
      .readdirSync(dir)
      .filter((f) => /\.(png|jpe?g|webp)$/i.test(f))
      .map((f) => ({ f, t: fs.statSync(path.join(dir, f)).mtimeMs }))
      .sort((a, b) => b.t - a.t)[0];
    if (newest)
      return {
        source: fs.readFileSync(path.join(dir, newest.f)),
        described: `newest stored image ${newest.f}`,
      };
  }
  return { source: generatePng(), described: "generated 600x400 PNG" };
}

// ── helpers ─────────────────────────────────────────────────────────────────

const errText = (e: unknown): string => {
  const err = e as { code?: number; message?: string };
  return err?.code ? `VK code ${err.code}: ${err.message}` : String(e);
};

interface Outcome {
  strategy: string;
  uploaded: boolean;
  posted: boolean;
  attachmentSurvived: boolean;
  note: string;
}

/**
 * Post `attachments` as a postponed entry, read it back to confirm VK really
 * kept the photo, then delete it. A post that VK accepts but silently strips
 * the attachment from is a FAILURE — reading back is the only way to tell the
 * difference, and is precisely the check the previous fix lacked.
 */
async function postVerifyDelete(
  strategy: string,
  attachments: string,
): Promise<{ posted: boolean; survived: boolean; note: string }> {
  const publishDate = Math.floor(Date.now() / 1000) + 7 * 24 * 60 * 60;
  let postId: number | undefined;

  try {
    const res = await api.wall.post({
      owner_id: OWNER_ID,
      message: `probe: ${strategy} — postponed, auto-deleted`,
      attachments,
      publish_date: publishDate,
    });
    postId = res.post_id;
  } catch (e) {
    return { posted: false, survived: false, note: `wall.post — ${errText(e)}` };
  }

  let survived = false;
  let note = `posted #${postId}`;
  try {
    const got = (await api.wall.getById({
      posts: `${OWNER_ID}_${postId}`,
    })) as unknown;
    // 5.131 returns a bare array; newer versions wrap it in { items }.
    const items = Array.isArray(got)
      ? got
      : ((got as { items?: unknown[] }).items ?? []);
    const post = items[0] as { attachments?: { type: string }[] } | undefined;
    const kinds = (post?.attachments ?? []).map((a) => a.type);
    survived = kinds.includes("photo");
    note = survived
      ? `photo attached (${kinds.join(", ")})`
      : `VK STRIPPED it — attachments: [${kinds.join(", ") || "none"}]`;
  } catch (e) {
    note = `posted #${postId} but read-back failed — ${errText(e)}`;
  }

  try {
    if (postId) await api.wall.delete({ owner_id: OWNER_ID, post_id: postId });
  } catch (e) {
    note += ` (cleanup failed, delete #${postId} by hand — ${errText(e)})`;
  }

  return { posted: true, survived, note };
}

// ── strategies ──────────────────────────────────────────────────────────────

/** The candidate: messages upload server, which documents group-token support. */
async function viaMessagesUploadServer(
  source: Buffer | string,
): Promise<Outcome[]> {
  const strategy = "messages-upload-server";
  let photo;
  try {
    photo = await vk.upload.messagePhoto({
      source: { value: source as never },
      ...(PEER_ARG ? { peer_id: Number(PEER_ARG) } : {}),
    });
  } catch (e) {
    return [
      {
        strategy,
        uploaded: false,
        posted: false,
        attachmentSurvived: false,
        note: `upload failed — ${errText(e)}`,
      },
    ];
  }

  const p = photo as unknown as {
    ownerId: number;
    id: number;
    accessKey?: string;
  };
  console.log(
    `  uploaded: owner=${p.ownerId} id=${p.id} access_key=${p.accessKey ?? "(none)"}`,
  );

  // Try WITH the access key first — that is the documented way to reference
  // media VK does not list publicly — then without, to see which VK honours.
  const variants: { label: string; attach: string }[] = [];
  if (p.accessKey)
    variants.push({
      label: `${strategy} + access_key`,
      attach: `photo${p.ownerId}_${p.id}_${p.accessKey}`,
    });
  variants.push({
    label: `${strategy} (no access_key)`,
    attach: `photo${p.ownerId}_${p.id}`,
  });

  const results: Outcome[] = [];
  for (const v of variants) {
    console.log(`  → posting ${v.attach}`);
    const r = await postVerifyDelete(v.label, v.attach);
    results.push({
      strategy: v.label,
      uploaded: true,
      posted: r.posted,
      attachmentSurvived: r.survived,
      note: r.note,
    });
    if (r.survived) break; // first win is enough; stop touching the wall
  }
  return results;
}

/** Control: confirm the Code 27 wall is still there and we are not chasing a ghost. */
async function viaWallUploadServer(source: Buffer | string): Promise<Outcome> {
  const strategy = "wall-upload-server (control)";
  try {
    const photo = await vk.upload.wallPhoto({
      source: { value: source as never },
      group_id: GROUP_ID,
    });
    const r = await postVerifyDelete(strategy, String(photo));
    return {
      strategy,
      uploaded: true,
      posted: r.posted,
      attachmentSurvived: r.survived,
      note: `UNEXPECTED — upload succeeded. ${r.note}`,
    };
  } catch (e) {
    return {
      strategy,
      uploaded: false,
      posted: false,
      attachmentSurvived: false,
      note: `blocked as expected — ${errText(e)}`,
    };
  }
}

/** Fallback: does VK build a snippet from a public URL in `attachments`? */
async function viaLinkAttachment(url: string): Promise<Outcome> {
  const strategy = "link attachment";
  const publishDate = Math.floor(Date.now() / 1000) + 7 * 24 * 60 * 60;
  let postId: number | undefined;
  try {
    const res = await api.wall.post({
      owner_id: OWNER_ID,
      message: "probe: link attachment — postponed, auto-deleted",
      attachments: url,
      publish_date: publishDate,
    });
    postId = res.post_id;
    const got = (await api.wall.getById({
      posts: `${OWNER_ID}_${postId}`,
    })) as unknown;
    const items = Array.isArray(got)
      ? got
      : ((got as { items?: unknown[] }).items ?? []);
    const post = items[0] as
      | { attachments?: { type: string; link?: { photo?: unknown } }[] }
      | undefined;
    const link = (post?.attachments ?? []).find((a) => a.type === "link");
    const hasImage = !!link?.link?.photo;
    return {
      strategy,
      uploaded: true,
      posted: true,
      attachmentSurvived: hasImage,
      note: link
        ? hasImage
          ? "snippet built WITH an image"
          : "snippet built but WITHOUT an image (no og:image scraped)"
        : "no link attachment produced",
    };
  } catch (e) {
    return {
      strategy,
      uploaded: false,
      posted: false,
      attachmentSurvived: false,
      note: errText(e),
    };
  } finally {
    try {
      if (postId) await api.wall.delete({ owner_id: OWNER_ID, post_id: postId });
    } catch {
      console.warn(`  cleanup failed — delete post #${postId} by hand`);
    }
  }
}

// ── main ────────────────────────────────────────────────────────────────────

async function main() {
  console.log(`VK photo-attachment probe — group ${GROUP_ID} (owner ${OWNER_ID})\n`);

  try {
    const perms = (await api.groups.getTokenPermissions({})) as unknown as {
      mask?: number;
      permissions?: { name: string }[];
    };
    const names = (perms.permissions ?? []).map((p) => p.name);
    console.log(`token rights: ${names.join(", ") || "(none reported)"}`);
    if (!names.includes("photos"))
      console.log(
        "  ⚠ 'photos' is NOT granted — the messages upload server needs it.\n" +
          "    Grant it in: сообщество → Управление → Работа с API → ваш ключ.",
      );
  } catch (e) {
    console.log(`token rights: could not read — ${errText(e)}`);
  }

  const { source, described } = resolveImage();
  console.log(`test image: ${described}\n`);

  const results: Outcome[] = [];

  console.log("[1] messages upload server (the candidate)");
  results.push(...(await viaMessagesUploadServer(source)));

  console.log("\n[2] wall upload server (control — expected Code 27)");
  results.push(await viaWallUploadServer(source));

  if (URL_ARG) {
    console.log("\n[3] link attachment from a public URL");
    results.push(await viaLinkAttachment(URL_ARG));
  } else {
    console.log(
      "\n[3] link attachment — skipped (pass --url <public image or page URL>)",
    );
  }

  console.log("\n──────── summary ────────");
  for (const r of results) {
    const verdict = r.attachmentSurvived ? "✅ WORKS" : "❌ no";
    console.log(`${verdict}  ${r.strategy}\n        ${r.note}`);
  }

  const winner = results.find((r) => r.attachmentSurvived);
  console.log(
    winner
      ? `\nUse: ${winner.strategy}`
      : "\nNo strategy attached a photo. A user token is then the only remaining route — report this output.",
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
