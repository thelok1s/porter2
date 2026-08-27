import "dotenv/config";
import fs from "fs";

import { renewVkUserToken } from "@/lib/vkrenew";
import { vkUserTokenInfo } from "@/lib/vkuser";

/**
 * Force one VK user-token renewal right now, outside the watchdog's schedule.
 *
 *   docker compose exec porter2 npm run vkrenew
 *
 * The watchdog renews on its own and retries when it fails, so this is for the
 * moments when waiting for the next tick is the wrong answer: you have just
 * re-exported the cookie jar and want to know whether it works, or a post is
 * about to go out and you would rather not find out afterwards that its photo
 * was dropped.
 *
 * It runs the SAME path production runs — src/lib/vkrenew.ts, including the
 * photos.getWallUploadServer gate — so a token that cannot upload is reported
 * and discarded rather than installed. Nothing here is a second implementation
 * that could drift from the real one.
 *
 * REFUSES TO RUN OUTSIDE THE CONTAINER, and that is the point rather than a
 * formality. VK user tokens are IP-BOUND: one minted from a laptop is welded to
 * that egress IP and answers Code 5 "access_token was given to another ip
 * address" when porter uses it from the server. Installing one would take the
 * photo off every post until somebody noticed — a silent failure, which is the
 * exact failure mode this whole subsystem exists to prevent. The token store
 * and cookie jar also live in the container's mounted volumes, so a host run
 * would be reading and writing the wrong copies of both.
 */

/** Escape hatch for a deployment where porter runs on the host, not in Docker. */
const HOST_OVERRIDE = "PORTER_ALLOW_HOST_RENEW";

function insideContainer(): boolean {
  // Set by the Dockerfile — the cheap, explicit answer.
  if (process.env.PORTER_IN_CONTAINER === "1") return true;
  // Docker's own marker file, for images built before that ENV existed.
  if (fs.existsSync("/.dockerenv")) return true;
  // Last resort: PID 1's cgroup names the runtime on Linux.
  try {
    const cgroup = fs.readFileSync("/proc/1/cgroup", "utf8");
    if (/docker|containerd|kubepods|podman/.test(cgroup)) return true;
  } catch {
    /* not Linux, or no procfs — fall through to "no" */
  }
  return false;
}

function refuse(): never {
  console.error(
    [
      "Refusing to run: this is not the porter container.",
      "",
      "VK user tokens are bound to the IP they were minted from. A token",
      "created here would answer Code 5 (\"given to another ip address\") when",
      "porter uses it from the server, and every post would quietly lose its",
      "photo. The token store and cookie jar also live in the container's",
      "volumes, so this run would be reading the wrong files anyway.",
      "",
      "Run it there instead:",
      "",
      "    docker compose exec porter2 npm run vkrenew",
      "",
      `If porter genuinely runs on this host rather than in Docker, set ${HOST_OVERRIDE}=1.`,
    ].join("\n"),
  );
  process.exit(1);
}

function describe(): string {
  const info = vkUserTokenInfo();
  if (!info.present) return "none held";
  const age = info.ageHours !== null ? `${info.ageHours.toFixed(1)} h old` : "age unknown";
  const left =
    info.remainingHours === null
      ? "expiry not reported"
      : info.remainingHours > 0
        ? `${info.remainingHours.toFixed(1)} h left`
        : `EXPIRED ${Math.abs(info.remainingHours).toFixed(1)} h ago`;
  return `source ${info.source ?? "unknown"}, ${age}, ${left}`;
}

async function main(): Promise<void> {
  if (!insideContainer() && process.env[HOST_OVERRIDE] !== "1") refuse();

  console.log(`held before: ${describe()}`);
  process.stdout.write("renewing … ");

  const result = await renewVkUserToken();

  if (!result.ok) {
    console.log("FAILED");
    console.error(`\n${result.reason}: ${result.detail}`);
    if (result.rateLimited) {
      console.error(
        "\nVK is rate-limiting the exchange. Wait ~10 minutes before trying\n" +
          "again — retrying now extends the block rather than riding it out.",
      );
    }
    console.error(
      "\nThe held token is untouched; renewal fails closed. For a long-lived\n" +
        "token, rotate by hand:\n" +
        "  pbpaste | docker compose exec -T porter2 npm run vkrenewprobe -- --install --stdin\n" +
        "To see which route refused, and why:\n" +
        "  docker compose exec porter2 npm run vkrenewprobe",
    );
    process.exit(1);
  }

  const life =
    result.expiresInHours !== null
      ? `${result.expiresInHours.toFixed(1)} h`
      : "an unknown time";
  console.log("OK");
  console.log(`\nInstalled via ${result.via ?? "?"}, valid ${life}.`);
  console.log(`held now:    ${describe()}`);
  console.log(
    "\nValidated against photos.getWallUploadServer before install, so wall\n" +
      "photos work. Check the whole picture with /health.",
  );
}

main().catch((error) => {
  console.error(`vkrenew crashed: ${String(error)}`);
  process.exit(1);
});
