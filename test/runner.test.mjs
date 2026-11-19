import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { buildPiArgs, resolvePi, splitCommand } from "../src/pi.mjs";
import { measureRun } from "../src/runner.mjs";

const fakePi = fileURLToPath(
  new URL("./fixtures/fake-pi.mjs", import.meta.url),
);
const pi = { command: process.execPath, args: [fakePi] };
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pmb-runner-"));
process.on("exit", () => fs.rmSync(dir, { recursive: true, force: true }));

/** @param {number} pid */
function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

test("buildPiArgs: rpc, session or --no-session, full isolation flags, one -e per extension", () => {
  assert.deepEqual(buildPiArgs({ extensions: [], sessionFile: null }), [
    "--mode",
    "rpc",
    "--no-session",
    "-ne",
    "-ns",
    "-np",
    "--no-themes",
    "--no-mcp",
    "-nc",
  ]);
  assert.deepEqual(
    buildPiArgs({
      extensions: ["/a.ts", "/b.ts"],
      sessionFile: "/s.jsonl",
      extraArgs: ["--offline"],
    }),
    [
      "--mode",
      "rpc",
      "--session",
      "/s.jsonl",
      "-ne",
      "-ns",
      "-np",
      "--no-themes",
      "--no-mcp",
      "-nc",
      "-e",
      "/a.ts",
      "-e",
      "/b.ts",
      "--offline",
    ],
  );
});

test("splitCommand and resolvePi resolution order: --pi, node_modules/.bin, PATH", () => {
  assert.deepEqual(splitCommand("node /x/cli.js"), {
    command: "node",
    args: ["/x/cli.js"],
  });
  assert.throws(() => splitCommand("  "), /empty/);
  assert.equal(resolvePi({ pi: "mypi --x", cwd: dir }).source, "--pi");
  const proj = fs.mkdtempSync(path.join(dir, "proj-"));
  fs.mkdirSync(path.join(proj, "node_modules", ".bin"), { recursive: true });
  fs.writeFileSync(
    path.join(proj, "node_modules", ".bin", "pi"),
    "#!/bin/sh\n",
    { mode: 0o755 },
  );
  const local = resolvePi({ cwd: proj });
  assert.equal(local.source, "node_modules/.bin");
  assert.equal(local.command, path.join(proj, "node_modules", ".bin", "pi"));
  const prev = process.env.PATH;
  try {
    const bin = fs.mkdtempSync(path.join(dir, "bin-"));
    fs.writeFileSync(path.join(bin, "pi"), "#!/bin/sh\n", { mode: 0o755 });
    process.env.PATH = bin;
    const empty = fs.mkdtempSync(path.join(dir, "empty-"));
    assert.equal(resolvePi({ cwd: empty }).source, "PATH");
    process.env.PATH = "";
    assert.throws(() => resolvePi({ cwd: empty }), /could not find pi/);
  } finally {
    process.env.PATH = prev;
  }
});

test("measureRun samples RSS, pings, passes cwd/env/args and leaves no process behind", async () => {
  const log = path.join(dir, "log1.json");
  const r = await measureRun({
    pi,
    extensions: ["/ext/one.ts"],
    sessionFile: null,
    cwd: dir,
    env: {
      ...process.env,
      FAKE_PI_MB: "60",
      FAKE_PI_LOG: log,
      FAKE_PI_ENV_PROBE: "probe",
    },
    windowSec: 3,
    steadySec: 2,
  });
  const info = JSON.parse(fs.readFileSync(log, "utf8"));
  assert.deepEqual(info.argv, [
    "--mode",
    "rpc",
    "--no-session",
    "-ne",
    "-ns",
    "-np",
    "--no-themes",
    "--no-mcp",
    "-nc",
    "-e",
    "/ext/one.ts",
  ]);
  assert.equal(fs.realpathSync(info.cwd), fs.realpathSync(dir));
  assert.equal(info.env, "probe");
  assert.ok(r.settled, "fake pi is flat after allocation: settles");
  assert.ok(r.steadyMb !== null && r.steadyMb > 60, `steady ${r.steadyMb}`);
  assert.ok(
    r.spikeMb >= r.steadyMb &&
      r.steadyMb !== null &&
      r.releasedMb !== null &&
      r.spikeMb >= r.releasedMb,
  );
  assert.ok(
    r.samples.length >= 10 && r.samples.length <= 20,
    `samples ${r.samples.length}`,
  );
  assert.ok(r.samples[r.samples.length - 1].t >= 2.9);
  assert.ok(r.pings > 10, `pings ${r.pings}`);
  assert.ok(r.maxGapMs > 0 && r.maxGapMs < 1500, `gap ${r.maxGapMs}`);
  assert.ok(r.readyMs !== null && r.readyMs < 3000);
  assert.equal(alive(info.pid), false, "pi process is gone after the run");
});

test("measureRun reports descendant processes separately and kills them too", async () => {
  const log = path.join(dir, "log2.json");
  const r = await measureRun({
    pi,
    extensions: [],
    sessionFile: "/some/session.jsonl",
    cwd: dir,
    env: {
      ...process.env,
      FAKE_PI_MB: "0",
      FAKE_PI_KID_MB: "50",
      FAKE_PI_LOG: log,
    },
    windowSec: 4,
    steadySec: 2,
  });
  const info = JSON.parse(fs.readFileSync(log, "utf8"));
  assert.ok(
    r.childrenSteadyMb !== null && r.childrenSteadyMb > 45,
    `children ${r.childrenSteadyMb}`,
  );
  assert.ok(
    r.mainSteadyMb !== null &&
      r.steadyMb !== null &&
      r.steadyMb > r.mainSteadyMb + 40,
    "children are folded into the total (steady), reported separately as main/kids",
  );
  assert.ok(info.argv.includes("--session"));
  await new Promise((res) => setTimeout(res, 200));
  assert.equal(alive(info.pid), false);
  assert.equal(alive(info.kid), false, "child process of pi is gone too");
});

test("gc normalization: harness -e in the argv, --expose-gc in NODE_OPTIONS, off with gc:false", async () => {
  const log = path.join(dir, "log-gc.json");
  const r = await measureRun({
    pi,
    extensions: ["/ext/one.ts"],
    harnessExtensions: ["/harness/gc-harness.js"],
    gc: true,
    sessionFile: null,
    cwd: dir,
    env: { ...process.env, FAKE_PI_MB: "10", FAKE_PI_LOG: log },
    windowSec: 2,
    steadySec: 1,
  });
  const info = JSON.parse(fs.readFileSync(log, "utf8"));
  // the harness loads before the extension under test, in every configuration
  assert.deepEqual(
    info.argv.filter(
      (/** @type {string} */ a) =>
        a === "-e" || a.endsWith(".ts") || a.endsWith(".js"),
    ),
    ["-e", "/harness/gc-harness.js", "-e", "/ext/one.ts"],
  );
  assert.match(info.nodeOptions ?? "", /--expose-gc/);
  assert.equal(info.gcExposed, true, "fake pi saw globalThis.gc");
  assert.equal(r.gcReady, false, "fake pi loads no real extension: no marker");

  // an existing NODE_OPTIONS is preserved
  const log2 = path.join(dir, "log-gc2.json");
  await measureRun({
    pi,
    extensions: [],
    harnessExtensions: [],
    gc: true,
    sessionFile: null,
    cwd: dir,
    env: {
      ...process.env,
      NODE_OPTIONS: "--no-warnings",
      FAKE_PI_MB: "10",
      FAKE_PI_LOG: log2,
    },
    windowSec: 2,
    steadySec: 1,
  });
  const info2 = JSON.parse(fs.readFileSync(log2, "utf8"));
  assert.match(info2.nodeOptions, /--no-warnings --expose-gc/);

  // gc:false: no flag, no harness — the process runs exactly as before
  const log3 = path.join(dir, "log-gc3.json");
  await measureRun({
    pi,
    extensions: ["/ext/one.ts"],
    harnessExtensions: ["/harness/gc-harness.js"],
    gc: false,
    sessionFile: null,
    cwd: dir,
    env: { ...process.env, FAKE_PI_MB: "10", FAKE_PI_LOG: log3 },
    windowSec: 2,
    steadySec: 1,
  });
  const info3 = JSON.parse(fs.readFileSync(log3, "utf8"));
  assert.equal(info3.argv.includes("gc-harness"), false);
  assert.equal(info3.nodeOptions, null);
  assert.equal(info3.gcExposed, false);
});

test("measureRun fails loudly, and cleans up, when pi exits early", async () => {
  await assert.rejects(
    measureRun({
      pi,
      extensions: [],
      sessionFile: null,
      cwd: dir,
      env: { ...process.env, FAKE_PI_EXIT_AFTER_MS: "700" },
      windowSec: 5,
      steadySec: 2,
    }),
    /pi exited after/,
  );
});

test("measureRun fails when the pi command cannot be spawned", async () => {
  await assert.rejects(
    measureRun({
      pi: { command: path.join(dir, "does-not-exist"), args: [] },
      extensions: [],
      sessionFile: null,
      cwd: dir,
      env: process.env,
      windowSec: 2,
      steadySec: 1,
    }),
    /ENOENT/,
  );
});
