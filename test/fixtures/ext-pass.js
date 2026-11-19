// Test extension that passes the budgets: allocates and holds about 5 MB.
const held = [];

export default function (pi) {
  pi.on("session_start", async () => {
    held.push(Buffer.alloc(5 * 1024 * 1024, 1)); // fill: touch every page so it counts as RSS
  });
}
