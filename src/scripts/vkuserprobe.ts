import "dotenv/config";
import { API } from "vk-io";

import { getVkUserAccessToken } from "@/lib/vkuser";

/**
 * Read-only probe of the VK user token in VK_USER_TOKEN.
 *
 * The token is IP-bound and has no published expiry, so when photos stop
 * appearing on posts the useful question is which of the two broke. This asks
 * VK directly, from this host, on this network.
 *
 * Writes nothing: an upload-server handshake returns a URL and creates
 * nothing. No post is made, no photo saved.
 *
 *   npm run vkuserprobe
 */

const parsedGroup = parseInt(process.env.VK_GROUP_ID ?? "");
if (!Number.isFinite(parsedGroup) || parsedGroup === 0) {
  console.error("VK_GROUP_ID is not set or not a number — nothing to probe.");
  process.exit(1);
}
const GROUP_ID = Math.abs(parsedGroup);
const OWNER_ID = -GROUP_ID;

const errText = (e: unknown): string => {
  const err = e as { code?: number; message?: string };
  return err?.code !== undefined
    ? `Code ${err.code}: ${err.message ?? "no message"}`
    : String(e);
};

async function main(): Promise<void> {
  console.log(`VK user token probe — group ${GROUP_ID} (owner ${OWNER_ID})\n`);

  const token = await getVkUserAccessToken();
  if (!token) {
    console.error("VK_USER_TOKEN is not set — nothing to probe.");
    process.exit(1);
  }
  const api = new API({ token });

  console.log("[1] users.get (is the token still alive?)");
  try {
    const users = await api.users.get({});
    const u = users[0];
    console.log(`    ok — user ${u?.id} ${u?.first_name} ${u?.last_name}\n`);
  } catch (e) {
    console.log(`    FAILED — ${errText(e)}`);
    console.log("    Code 5 here means the token expired or was issued to a");
    console.log("    different IP. Mint a fresh one from this network.\n");
  }

  console.log("[2] photos.getWallUploadServer (the route photos depend on)");
  try {
    const r = (await api.photos.getWallUploadServer({
      group_id: GROUP_ID,
    })) as unknown as { upload_url?: string };
    console.log(
      r?.upload_url
        ? "    ok — upload URL returned. Wall photos should work.\n"
        : "    odd — no upload_url in response\n",
    );
  } catch (e) {
    console.log(`    FAILED — ${errText(e)}\n`);
  }

  console.log("[3] wall.get (community readable?)");
  try {
    const r = await api.wall.get({ owner_id: OWNER_ID, count: 1 });
    console.log(`    ok — ${r.count} posts\n`);
  } catch (e) {
    console.log(`    FAILED — ${errText(e)}\n`);
  }
}

main().catch((e) => {
  console.error(`probe crashed: ${errText(e)}`);
  process.exit(1);
});
