// Test extension whose memory grows with the session: keeps serialized copies
// of every session entry, like an extension that indexes the whole history.
// Three copies per entry make the growth far larger than RSS noise.
const held = [];

export default function (pi) {
  pi.on("session_start", async (_event, ctx) => {
    for (const entry of ctx.sessionManager.getEntries()) {
      for (let i = 0; i < 3; i++) held.push(JSON.stringify(entry));
    }
  });
}
