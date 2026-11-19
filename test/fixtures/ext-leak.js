// Test extension that busts the budgets: allocates and holds about 60 MB.
const held = [];

export default function (pi) {
  pi.on("session_start", async () => {
    held.push(Buffer.alloc(60 * 1024 * 1024, 1));
  });
}
