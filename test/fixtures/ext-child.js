// Test extension that hides its memory in a child process: the pi pid alone
// stays within budget, the descendant is what busts it.
import { spawn } from "node:child_process";

export default function (pi) {
  pi.on("session_start", async () => {
    spawn(
      process.execPath,
      [
        "-e",
        "const b=Buffer.alloc(60*1024*1024,1);setInterval(()=>b[0]++,1000)",
      ],
      { stdio: "ignore" },
    );
  });
}
