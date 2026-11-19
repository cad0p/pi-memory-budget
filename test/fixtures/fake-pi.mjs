// Stand-in for pi in unit tests: answers RPC get_state pings, holds
// FAKE_PI_MB megabytes, optionally spawns a child holding FAKE_PI_KID_MB, and
// records its argv and pid to FAKE_PI_LOG (JSON) when set.
import { spawn } from "node:child_process";
import fs from "node:fs";
import readline from "node:readline";

const held = Buffer.alloc(Number(process.env.FAKE_PI_MB ?? 0) * 1024 * 1024, 1);
let kid = null;
if (Number(process.env.FAKE_PI_KID_MB ?? 0) > 0) {
  kid = spawn(
    process.execPath,
    [
      "-e",
      `const b=Buffer.alloc(${Number(process.env.FAKE_PI_KID_MB)}*1024*1024,1);setInterval(()=>b[0]++,1000)`,
    ],
    { stdio: "ignore" },
  );
}
if (process.env.FAKE_PI_LOG) {
  fs.writeFileSync(
    process.env.FAKE_PI_LOG,
    JSON.stringify({
      argv: process.argv.slice(2),
      pid: process.pid,
      kid: kid?.pid ?? null,
      cwd: process.cwd(),
      env: process.env.FAKE_PI_ENV_PROBE ?? null,
      held: held.length,
    }),
  );
}
if (process.env.FAKE_PI_EXIT_AFTER_MS)
  setTimeout(() => process.exit(3), Number(process.env.FAKE_PI_EXIT_AFTER_MS));
const rl = readline.createInterface({ input: process.stdin });
rl.on("line", (line) => {
  try {
    const m = JSON.parse(line);
    process.stdout.write(
      `${JSON.stringify({ id: m.id, type: "response", command: m.type, success: true, data: {} })}\n`,
    );
  } catch {}
});
setInterval(() => {}, 1000);
