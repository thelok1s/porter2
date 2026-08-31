/**
 * A full rotation pass against a real disk and a real (throwaway) database.
 *
 * The rule itself is covered by rotationprobe; this checks the wiring around
 * it — that the files it names are the files that disappear, that a submission
 * row genuinely protects its picture, and that a database it cannot read makes
 * it delete nothing at all.
 */
import fs from "fs";
import os from "os";
import path from "path";

const store = fs.mkdtempSync(path.join(os.tmpdir(), "porter-images-"));
const dbFile = path.join(store, "probe.sqlite");
process.env.SUBMISSION_IMAGES_DIR = store;
process.env.DB_FILE = dbFile;
process.env.SUBMISSION_IMAGES_RETENTION_DAYS = "14";
process.env.SUBMISSION_IMAGES_MAX_MB = "0";

const DAY = 24 * 60 * 60 * 1000;

let failed = 0;
function check(name: string, ok: boolean, detail = ""): void {
  console.log(`${ok ? "✅" : "❌"} ${name}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failed++;
}

function write(name: string, ageDays: number): void {
  const filePath = path.join(store, name);
  fs.writeFileSync(filePath, Buffer.alloc(1024, 7));
  const when = new Date(Date.now() - ageDays * DAY);
  fs.utimesSync(filePath, when, when);
}

const exists = (name: string) => fs.existsSync(path.join(store, name));

async function main(): Promise<void> {
  const { sequelize } = await import("../lib/sequelize");
  const { Submission, SubmissionStatus } = await import(
    "../models/submission.schema"
  );
  const { sweepImageStore } = await import("../../local/frontend/rotation");

  await sequelize.sync();

  write("pending.png", 90);
  write("scheduled.png", 90);
  write("published.png", 90);
  write("declined.png", 90);
  write("orphan.png", 90);
  write("recent-orphan.png", 2);

  const base = {
    author_tg_id: "123456789",
    author_name: "Проба",
    text: "текст",
    metadata: null,
  };
  const url = (name: string) => `https://frog.example/api/images/${name}`;
  await Submission.create({ ...base, image: url("pending.png"), status: SubmissionStatus.PENDING });
  await Submission.create({ ...base, image: url("scheduled.png"), status: SubmissionStatus.SCHEDULED });
  await Submission.create({ ...base, image: url("published.png"), status: SubmissionStatus.PUBLISHED });
  await Submission.create({ ...base, image: url("declined.png"), status: SubmissionStatus.DECLINED });

  await sweepImageStore();

  check("pending submission keeps its picture", exists("pending.png"));
  check("scheduled submission keeps its picture", exists("scheduled.png"));
  check(
    "a published submission's picture expires",
    !exists("published.png"),
    "VK hosts its own copy once the post is up",
  );
  check("a declined submission's picture expires", !exists("declined.png"));
  check("an announcement leftover expires", !exists("orphan.png"));
  check("a recent leftover survives", exists("recent-orphan.png"));

  // A store we cannot question must not be swept: without the claim list every
  // pending submission's picture looks like an orphan.
  write("orphan2.png", 90);
  await sequelize.close();
  await sweepImageStore();
  check(
    "an unreadable database deletes nothing",
    exists("orphan2.png") && exists("pending.png"),
    "the claim list is what makes deletion safe; no list, no deletion",
  );

  fs.rmSync(store, { recursive: true, force: true });
  console.log(`\n${failed === 0 ? "all good" : `${failed} failing`}`);
  process.exit(failed === 0 ? 0 : 1);
}

void main();
