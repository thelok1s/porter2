import dotenv from "dotenv";
import { MemoryStorage } from "@mtcute/core";
import { createMtprotoClient } from "@/lib/mtproto";

/**
 * Interactive one-off: sign a *user account* into MTProto and print the session
 * string to paste into `MTPROTO_SESSION`.
 *
 * Only needed when the bot is not (or cannot be) an administrator of the chats
 * you want member lists for — a bot token works without any of this.
 *
 * Storage is in-memory on purpose: this script must not leave an authorized
 * session file lying around next to the one the bot uses.
 *
 * Run: `npm run mtlogin`
 */

dotenv.config();

const apiId = Number(process.env.MTPROTO_API_ID);
const apiHash = process.env.MTPROTO_API_HASH ?? "";

if (!Number.isFinite(apiId) || apiId <= 0 || apiHash === "") {
  console.error(
    "Set MTPROTO_API_ID and MTPROTO_API_HASH first — get them from https://my.telegram.org/apps",
  );
  process.exit(1);
}

const tg = await createMtprotoClient({
  apiId,
  apiHash,
  storage: new MemoryStorage(),
});

try {
  const self = await tg.start({
    phone: () => tg.input("Phone number > "),
    code: () => tg.input("Code you just received > "),
    password: () => tg.input("2FA password (blank if none) > "),
  });

  console.log(`\nSigned in as ${self.displayName} (id ${self.id}).`);
  console.log("\nPut this in porter2/.env as MTPROTO_SESSION — treat it like a");
  console.log("password; anyone holding it can act as you.\n");
  console.log(await tg.exportSession());
  console.log("");
} finally {
  await tg.destroy();
}
