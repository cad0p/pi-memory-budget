import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const harness = fileURLToPath(new URL("../src/gc-harness.js", import.meta.url));

test("harness without --expose-gc warns and stays inert", async () => {
  const h = (await import(harness)).default;
  const w = process.stderr.write.bind(process.stderr);
  /** @type {string[]} */
  const err = [];
  process.stderr.write = (s) => {
    err.push(String(s));
    return true;
  };
  try {
    h(); // test runner has no globalThis.gc: warns, returns, no timer
  } finally {
    process.stderr.write = w;
  }
  assert.match(err.join(""), /pmb-gc: unavailable/);
});

test("harness forces a major GC when the heap grows (live node --expose-gc child)", () => {
  const script = `
    import h from ${JSON.stringify(harness)};
    h();
    const before = process.memoryUsage().heapUsed;
    let junk = [];
    for (let i = 0; i < 30; i++) junk.push(new Array(300000).fill(i));
    junk = null;
    const grown = process.memoryUsage().heapUsed;
    setTimeout(() => {
      console.log("BEFORE " + before + " GROWN " + grown + " AFTER " + process.memoryUsage().heapUsed);
      process.exit(0);
    }, 1800);
  `;
  const r = spawnSync(
    process.execPath,
    ["--expose-gc", "--input-type=module", "-e", script],
    { encoding: "utf8", timeout: 30000 },
  );
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stderr, /pmb-gc: ready/);
  const m = /BEFORE (\d+) GROWN (\d+) AFTER (\d+)/.exec(r.stdout);
  assert.ok(m, r.stdout);
  const before = Number(m[1]);
  const grown = Number(m[2]);
  const after = Number(m[3]);
  // Without the harness V8 has no reason to collect: dead heap stays high.
  // With it, the >4 MB step trigger fired and heapUsed fell back to base.
  assert.ok(grown > before + 8 * 1048576, "grown " + grown);
  assert.ok(
    after < before + 8 * 1048576,
    "harness collected: after " + after + " vs before " + before,
  );
});
