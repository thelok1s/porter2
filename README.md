# [RU] Porter2
![GitHub top language](https://img.shields.io/github/languages/top/thelok1s/porter2)
![GitHub package.json version](https://img.shields.io/github/package-json/v/thelok1s/porter2)
![GitHub last commit](https://img.shields.io/github/last-commit/thelok1s/porter2)
```
    ____  ____  _____/ /____  _____
   / __ \/ __ \/ ___/ __/ _ \/ ___/
  / /_/ / /_/ / /  / /_/  __/ /
 / .___/\____/_/   \__/\___/_/
/_/
```
## Описание
Многофункциональный инструмент для синхронизации публикаций и комментариев между ВКонтакте и Telegram.
Написан на Typescript для работы в Node.

> [!CAUTION]
> Проект в стадии разработки, возможно неожиданное поведение, используйте в важных каналах/группах на свой страх и риск.
> Issues приветствуются.

A modular, grammY-based rewrite of **Porter** — a VK ↔ Telegram crossposting &
crosscommenting bot — with isolated feature modules. Replaces the legacy
Telegraf.js app in `../porter/`.

## Architecture

```
src/
  main.ts              entrypoint: env check → DB → bot.init → modules → bot.start
  core/                framework glue (committed, reusable)
    bot.ts             grammY Bot instance + BotContext type
    api.ts             vk-io clients + Telegram identifiers
    module-loader.ts   mounts modules + runs init/start/stop lifecycle hooks
    utils.ts           text helpers (byte/char-safe truncation, VK→HTML)
    logger.ts          pino (with secret redaction)
  lib/sequelize.ts     SQLite + Sequelize bootstrap
  models/              Post, Reply, Submission, User (Sequelize)
  porter/              the tg-vk crossposting/crosscommenting MODULE (committed core)
    posts.ts             VK → TG posts
    replies.ts           VK → TG comments
    comments.ts          TG → VK comments
    message-handler.ts   discussion-group dispatcher (auto-forward + TG→VK)
    pending-comments.ts  retry buffer for comments that arrive before linkage
    index.ts             module entry (Composer + VK lifecycle)
  types/ utils/ scripts/
local/                PRIVATE modules (gitignored — deployment-specific)
  frontend/             Express API + moderation callbacks (serves the TMA)
  all-command/          /all + @all admin command
  README.md             module contract (committed)
  .example/             sample module (committed)
porter.config.ts        feature flags + per-module config
```

### Module contract

Every feature is a grammY `Composer` (for handlers) and/or an object with
lifecycle hooks:

```ts
// Simplest: a bare Composer
export default new Composer<BotContext>();

// With side effects (polling, HTTP server):
export default {
  composer,                  // optional Composer
  async init() { ... },      // after DB init, before launch
  async start() { ... },     // after the bot is launched
  async stop() { ... },      // on shutdown (reverse order)
};
```

`module-loader.ts` normalizes both shapes and mounts them in a defined order.
Committed modules live under `src/`; private, deployment-specific ones under
`local/` (gitignored). **New features never need to touch the Porter repost
logic** — add a module and it's picked up automatically.

## Moderation via Mini App

Submission moderation happens in the Telegram Mini App, not inline buttons:

1. A new submission posts a moderation message to `MODERATION_CHAT_ID` with a
   single **web_app** button (`📝 Модерировать в Mini App`) deep-linking to
   `${TMA_PUBLIC_URL}/moderate?id=<submissionId>`.
2. The Mini App (`frontend/src/app/moderate/page.tsx`) reuses the announcement
   editor — prefilled from the submission and editable — plus an action block
   (**Опубликовать сейчас / Запланировать / Отклонить**) and brief cards of the
   already-postponed VK queue.
3. Moderator identity is verified: the Mini App sends raw Telegram `initData`,
   and the backend validates it (HMAC `WebAppData` + bot token) in
   `local/frontend/auth.ts`. The shared `x-api-key` is no longer trusted alone.

Relevant endpoints (under `/api/submissions`): `GET /:id`, `PATCH /:id` (edit),
`GET /postponed`, and `POST /:id/{approve,schedule,decline}` (each requires a
valid `x-telegram-init-data` header).

Set `TMA_PUBLIC_URL` (porter2 env) to the Mini App's public HTTPS URL — Telegram
requires valid HTTPS for `web_app` buttons.

> Dev caveat: the mock `initData` has no valid signature, so moderation
> *actions* return 401 in the mocked browser. Test the full flow by opening the
> Mini App from Telegram (real `initData`).

## Getting started

```bash
cp .env.example .env       # fill in tokens & IDs
npm install
npm run init               # create SQLite tables
npm start                  # tsx src/main.ts   (or: npm run start:bun)
```

Required env: `VK_TOKEN`, `TELEGRAM_TOKEN`, `TELEGRAM_CHANNEL_ID`,
`TELEGRAM_CHANNEL_PUBLIC_LINK`, `TELEGRAM_CHAT_ID`.
