/**
 * The image-store rotation rule, without a disk or a database.
 *
 * Everything here is a claim about what may be deleted, so the assertions are
 * written as "this file must survive" wherever that is the point.
 */
import {
  planSweep,
  storedFilename,
  type StoredFile,
} from "../../local/frontend/rotation";

const DAY = 24 * 60 * 60 * 1000;
const MB = 1024 * 1024;
const NOW = Date.UTC(2026, 8, 1);

let failed = 0;
function check(name: string, ok: boolean, detail = ""): void {
  console.log(`${ok ? "✅" : "❌"} ${name}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failed++;
}

function file(name: string, ageDays: number, sizeMb = 1): StoredFile {
  return { name, size: sizeMb * MB, mtimeMs: NOW - ageDays * DAY };
}

// ── filename extraction ───────────────────────────────────────────────────
{
  const cases: Array<[string | null, string | null]> = [
    ["https://frog.example/api/images/abc-123.png", "abc-123.png"],
    ["https://frog.example/api/images/abc-123.png/card", "abc-123.png"],
    ["https://frog.example/api/images/abc-123.png?v=2", "abc-123.png"],
    // Not ours: a picture hosted elsewhere must never be counted as a claim on
    // a same-named file of ours, and the legacy /uploads dir has its own sweep.
    ["https://example.com/photo.png", null],
    ["https://frog.example/uploads/deadbeef.png", null],
    ["data:image/png;base64,AAAA", null],
    [null, null],
  ];
  for (const [input, want] of cases) {
    const got = storedFilename(input);
    check(
      `storedFilename(${JSON.stringify(input)?.slice(0, 46)})`,
      got === want,
      got === want ? "" : `got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`,
    );
  }
}

// ── age ───────────────────────────────────────────────────────────────────
{
  const plan = planSweep(
    [file("old.png", 20), file("fresh.png", 3), file("edge.png", 14)],
    new Set(),
    NOW,
    { retentionDays: 14, maxMb: 0 },
  );
  check("expired file goes", plan.remove.includes("old.png"));
  check("young file stays", !plan.remove.includes("fresh.png"));
  check(
    "exactly at the window stays",
    !plan.remove.includes("edge.png"),
    "retention is inclusive; a file is not old until it is older",
  );
}

// ── claims outrank age ────────────────────────────────────────────────────
{
  const plan = planSweep(
    [file("queued.png", 400), file("orphan.png", 400)],
    new Set(["queued.png"]),
    NOW,
    { retentionDays: 14, maxMb: 0 },
  );
  check(
    "a pending submission's picture survives at any age",
    !plan.remove.includes("queued.png"),
    "this is the data-loss case: deleting it publishes a text-only post later",
  );
  check("its unclaimed neighbour still goes", plan.remove.includes("orphan.png"));
  check("held is counted", plan.held === 1);
}

// ── budget ────────────────────────────────────────────────────────────────
{
  const plan = planSweep(
    [
      file("a.png", 1, 4),
      file("b.png", 2, 4),
      file("c.png", 3, 4),
      file("d.png", 4, 4),
    ],
    new Set(),
    NOW,
    { retentionDays: 14, maxMb: 10 },
  );
  check(
    "budget frees just enough",
    plan.remaining <= 10 * MB && plan.remaining > 6 * MB,
    `${(plan.remaining / MB).toFixed(0)} MB left of a 10 MB cap`,
  );
  check(
    "oldest go first",
    plan.remove.includes("d.png") && !plan.remove.includes("a.png"),
    `removed ${plan.remove.join(", ")}`,
  );
  check("overflowed is counted", plan.overflowed === plan.remove.length);
  check("not reported over budget once under it", !plan.overBudget);
}

// ── budget can never break a claim ────────────────────────────────────────
{
  const plan = planSweep(
    [file("queued-a.png", 1, 8), file("queued-b.png", 2, 8), file("spare.png", 3, 8)],
    new Set(["queued-a.png", "queued-b.png"]),
    NOW,
    { retentionDays: 14, maxMb: 10 },
  );
  check(
    "claimed files survive a blown budget",
    !plan.remove.includes("queued-a.png") && !plan.remove.includes("queued-b.png"),
    `removed ${plan.remove.join(", ") || "nothing"}`,
  );
  check("everything expendable is given up first", plan.remove.includes("spare.png"));
  check(
    "and the shortfall is reported rather than forced",
    plan.overBudget,
    `${(plan.remaining / MB).toFixed(0)} MB of claimed files against a 10 MB cap`,
  );
}

// ── an empty store is not a failure ───────────────────────────────────────
{
  const plan = planSweep([], new Set(), NOW, { retentionDays: 14, maxMb: 10 });
  check(
    "empty store removes nothing",
    plan.remove.length === 0 && plan.remaining === 0 && !plan.overBudget,
  );
}

console.log(`\n${failed === 0 ? "all good" : `${failed} failing`}`);
process.exit(failed === 0 ? 0 : 1);
