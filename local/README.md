# Local (private) modules

This directory holds **deployment-specific modules** that are not part of the
reusable Porter core. Its contents are gitignored (see `../.gitignore`), so the
`porter2` repository ships only the framework glue plus the tg-vk repost module.
Each deployment provides its own `local/` modules.

## Module contract

A module is a directory containing `index.ts` that **default-exports a grammY
`Composer`**:

```ts
// local/<name>/index.ts
import { Composer } from "grammy";
import type { BotContext } from "@/core/bot";

const module = new Composer<BotContext>();

module.command("hello", async (ctx) => {
  await ctx.reply("hi from a private module");
});

export default module;
```

The core module loader (`src/core/module-loader.ts`) discovers every
`local/*/index.ts` and mounts it on the bot, guarded so that a missing module
never breaks startup.

## Current modules (private to this deployment)

- `frontend/` — Express API server + TMA bridge that the Next.js frontend talks
  to (submissions, posts, send, stats, health, image uploads). Replaces the old
  `porter/src/api/` server.
- `all-command/` — `/all` and `@all` admin mention command, admin-gated. Tags
  the chat's full roster, read live from the framework's MTProto capability
  (`@/core/participants`) and nowhere else — no local member table, no watching
  messages, so it is unaffected by the bot's privacy mode.

## Adding a module

1. `mkdir -p local/<name> && touch local/<name>/index.ts`
2. `export default` a `Composer<BotContext>` (see `.example/`).
3. Optionally add `local/<name>/config.ts` for module-specific configuration.
4. Restart — the loader picks it up automatically.
