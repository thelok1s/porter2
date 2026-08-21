import "dotenv/config";
import { API } from "vk-io";

import { getVkUserAccessToken, missingScopes, vkUserTokenFile } from "@/lib/vkuser";

import fs from "fs";

/**
 * Read-only probe of the VK ID user grant.
 *
 * `npm run vkidlogin` reports the scope VK ID *says* it granted, which came
 * back as `vkid.personal_info` alone. That is a claim, not a capability: the
 * question that actually matters is whether the token can reach the wall photo
 * endpoints. This asks VK directly.
 *
 * Nothing here writes. It reads the identity, the permission mask, and asks
 * for upload URLs without uploading to them — an upload server handshake
 * returns a URL and creates nothing. No post is made, no photo saved.
 *
 * Run on the host that holds db/vkid.json:
 *   npm run vkidprobe
 */

const GROUP_ID_RAW = process.env.VK_GROUP_ID;
const parsedGroup = parseInt(GROUP_ID_RAW ?? "");
if (!Number.isFinite(parsedGroup) || parsedGroup === 0) {
  console.error("VK_GROUP_ID is not set or not a number — nothing to probe.");
  process.exit(1);
}
const GROUP_ID = Math.abs(parsedGroup);
const OWNER_ID = -GROUP_ID;

/**
 * Standard VK user permission bits. The mask is authoritative in a way the
 * scope string is not, so the raw value is always printed alongside the
 * decode — if the table is stale, the number still tells the truth.
 */
const BITS: Array<[number, string]> = [
  [1, "notify"],
  [2, "friends"],
  [4, "photos"],
  [8, "audio"],
  [16, "video"],
  [32, "stories"],
  [64, "pages"],
  [128, "leftmenu"],
  [256, "status"],
  [512, "notes"],
  [1024, "messages"],
  [2048, "wall"],
  [4096, "ads"],
  [8192, "offline"],
  [16384, "docs"],
  [32768, "groups"],
  [65536, "notifications"],
  [131072, "stats"],
  [262144, "email"],
  [268435456, "market"],
];

function decodeMask(mask: number): string {
  const on = BITS.filter(([bit]) => (mask & bit) !== 0).map(([, name]) => name);
  return on.length > 0 ? on.join(", ") : "(nothing)";
}

const errText = (e: unknown): string => {
  const err = e as { code?: number; message?: string };
  return err?.code !== undefined
    ? `Code ${err.code}: ${err.message ?? "no message"}`
    : String(e);
};

async function main(): Promise<void> {
  console.log(`VK ID grant probe — group ${GROUP_ID} (owner ${OWNER_ID})\n`);

  const file = vkUserTokenFile();
  if (!fs.existsSync(file)) {
    console.error(`No grant at ${file} — run \`npm run vkidlogin\` first.`);
    process.exit(1);
  }

  const store = JSON.parse(fs.readFileSync(file, "utf8")) as {
    userId: number;
    scope: string;
  };
  console.log(`stored scope: "${store.scope}"`);
  const missing = missingScopes(store.scope);
  console.log(
    missing.length > 0
      ? `  → reported as missing: ${missing.join(", ")}\n`
      : "  → reports everything needed\n",
  );

  const token = await getVkUserAccessToken();
  if (!token) {
    console.error(
      "Could not obtain an access token. The grant may be revoked or expired —\n" +
        "re-run `npm run vkidlogin`.",
    );
    process.exit(1);
  }
  const api = new API({ token });

  // [1] Identity — proves the token is live at all.
  console.log("[1] users.get (is the token live?)");
  try {
    const users = await api.users.get({});
    const u = users[0];
    console.log(`    ok — user ${u?.id} ${u?.first_name} ${u?.last_name}\n`);
  } catch (e) {
    console.log(`    FAILED — ${errText(e)}\n`);
  }

  // [2] The authoritative answer: what the user actually granted this app.
  console.log("[2] account.getAppPermissions (authoritative grant mask)");
  try {
    const mask = (await api.account.getAppPermissions({
      user_id: store.userId,
    })) as unknown as number;
    console.log(`    mask = ${mask}`);
    console.log(`    decoded: ${decodeMask(mask)}`);
    const hasPhotos = (mask & 4) !== 0;
    const hasWall = (mask & 2048) !== 0;
    console.log(
      `    photos: ${hasPhotos ? "YES" : "no"}   wall: ${hasWall ? "YES" : "no"}\n`,
    );
  } catch (e) {
    console.log(`    FAILED — ${errText(e)}\n`);
  }

  // [3] The one that matters. Returns a URL; uploads nothing.
  console.log("[3] photos.getWallUploadServer (the route we need)");
  try {
    const r = (await api.photos.getWallUploadServer({
      group_id: GROUP_ID,
    })) as unknown as { upload_url?: string };
    console.log(
      r?.upload_url
        ? "    ok — GOT AN UPLOAD URL. The user token can reach the wall route.\n"
        : `    odd — no upload_url in response\n`,
    );
  } catch (e) {
    console.log(`    FAILED — ${errText(e)}\n`);
  }

  // [4] The album route, for comparison. Also returns a URL only.
  console.log("[4] photos.getUploadServer (community album route)");
  try {
    const r = (await api.photos.getUploadServer({
      group_id: GROUP_ID,
    })) as unknown as { upload_url?: string };
    console.log(
      r?.upload_url
        ? "    ok — GOT AN UPLOAD URL. Album route is open to this token.\n"
        : "    odd — no upload_url in response\n",
    );
  } catch (e) {
    console.log(`    FAILED — ${errText(e)}\n`);
  }

  // [5] Wall read access — a cheap check on the wall scope.
  console.log("[5] wall.get (wall read access)");
  try {
    const r = await api.wall.get({ owner_id: OWNER_ID, count: 1 });
    console.log(`    ok — wall readable, ${r.count} posts\n`);
  } catch (e) {
    console.log(`    FAILED — ${errText(e)}\n`);
  }

  console.log("──────── what to conclude ────────");
  console.log(
    "If [3] returned an upload URL, the grant can attach wall photos whatever\n" +
      "the scope string said, and attachPhoto should work — say so and I will\n" +
      "drop the scope guard.\n" +
      "If [3] failed with Code 27 but [4] returned a URL, the album route is the\n" +
      "way in and is worth wiring up.\n" +
      "If both failed, the grant is genuinely profile-only and VK ID is a dead\n" +
      "end without business verification.",
  );
}

main().catch((e) => {
  console.error(`probe crashed: ${errText(e)}`);
  process.exit(1);
});
