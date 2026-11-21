// Test extension that forks a node child holding about 5 MB of anonymous
// memory. The child maps the same node binary and shared libraries pi already
// has, so summed RSS charges the subtree about 45 MB for the child (the old
// metric, issue #10) while the deduplicated metric charges only what the child
// actually adds: its own anonymous memory plus the buffer.
import { spawn } from "node:child_process";

export default function (pi) {
  pi.on("session_start", async () => {
    spawn(
      process.execPath,
      [
        "-e",
        "const b=Buffer.alloc(5*1024*1024,1);setInterval(()=>b[0]++,1000)",
      ],
      { stdio: "ignore" },
    );
  });
}
