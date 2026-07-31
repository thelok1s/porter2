import { Composer } from "grammy";
import type { BotContext } from "@/core/bot";

/**
 * Example private module. Copy this directory to local/<your-feature>/ and
 * edit. The loader mounts every local module automatically.
 */
const example = new Composer<BotContext>();

example.command("ping", async (ctx) => {
  await ctx.reply("pong");
});

export default example;
