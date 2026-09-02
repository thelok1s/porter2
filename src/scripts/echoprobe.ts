/**
 * The echo guard, fed the exact comment that looped in production.
 *
 * The payload below is copied verbatim from app.log at 2026-09-02 22:16:37 —
 * porter's own mirror of Telegram message 1183, which VK announced back to it
 * and which it then carried into the discussion thread a second time.
 *
 * `isOwnEcho` is not exported (nothing else should be asking), so this rebuilds
 * the same two-signal test and pins the payloads it must and must not match.
 */
import { TG_PORT_MARKER } from "../porter/comments";

interface Comment {
  id: number;
  fromId: number | null;
  ownerId: number;
  text: string;
}

/** Must stay identical to `isOwnEcho` in replies.ts. */
function isOwnEcho(reply: Comment): boolean {
  return (
    reply.fromId != null &&
    reply.fromId === reply.ownerId &&
    (reply.text ?? "").includes(TG_PORT_MARKER)
  );
}

const GROUP = -208472307;

const cases: Array<[string, Comment, boolean]> = [
  [
    "the comment that actually looped",
    {
      id: 3618,
      fromId: GROUP,
      ownerId: GROUP,
      text:
        "そら あすか(t.me/asukad): у меня нет друзей😭😭😭\n" +
        "смогу ли я их обрести на ваших собраниях????\n\n" +
        "(Автоматически перенесено из tg)",
    },
    true,
  ],
  [
    "a real person commenting in VK",
    { id: 3619, fromId: 575317156, ownerId: GROUP, text: "Я приду" },
    false,
  ],
  [
    "an admin writing AS the community — theirs, not ours",
    { id: 3620, fromId: GROUP, ownerId: GROUP, text: "Сбор в 18:00, приходите" },
    false,
  ],
  [
    "a person who typed the marker themselves",
    {
      id: 3621,
      fromId: 575317156,
      ownerId: GROUP,
      text: "смешно: (Автоматически перенесено из tg)",
    },
    false,
  ],
  [
    "a delete event — no author, no text",
    { id: 3618, fromId: null, ownerId: GROUP, text: "" },
    false,
  ],
  [
    "an edit of a real comment",
    { id: 3619, fromId: 575317156, ownerId: GROUP, text: "Я приду!!" },
    false,
  ],
];

let failed = 0;
for (const [name, comment, want] of cases) {
  const got = isOwnEcho(comment);
  const ok = got === want;
  console.log(
    `${ok ? "✅" : "❌"} ${name} → ${got ? "skipped" : "ported"}` +
      (ok ? "" : `, wanted ${want ? "skipped" : "ported"}`),
  );
  if (!ok) failed++;
}

// The marker is shared rather than spelled twice; if that ever stops being
// true, the guard silently stops matching and the loop comes back.
const inSource = /\(Автоматически перенесено из tg\)/.test(TG_PORT_MARKER);
console.log(`${inSource ? "✅" : "❌"} marker is the string VK actually carries`);
if (!inSource) failed++;

console.log(`\n${failed === 0 ? "all good" : `${failed} failing`}`);
process.exit(failed === 0 ? 0 : 1);
