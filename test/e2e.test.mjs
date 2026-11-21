// End-to-end tests against a real pi. Skipped unless PMB_E2E=1 (CI sets it);
// they need @earendil-works/pi-coding-agent in node_modules (devDependency)
// and take a few minutes.
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { writeFixture } from "../src/fixture.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));
const pi = path.join(root, "node_modules", ".bin", "pi");
const cli = path.join(root, "src", "cli.mjs");
const skip =
  process.env.PMB_E2E !== "1"
    ? "set PMB_E2E=1 to run (needs pi in node_modules)"
    : false;
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pmb-e2e-"));
process.on("exit", () => fs.rmSync(dir, { recursive: true, force: true }));
const fx = path.join(dir, "fixtures");

/**
 * @param {string[]} args
 * @param {Record<string, string>} [env] extra environment (the platform seam)
 * @returns {{ status: number | null, json: any, md: string, stderr: string }}
 */
function runCli(args, env = {}) {
  const json = path.join(dir, `r-${Math.random().toString(36).slice(2)}.json`);
  const report = json.replace(/\.json$/, ".md");
  const r = spawnSync(
    process.execPath,
    [
      cli,
      "run",
      "--cwd",
      root,
      "--fixtures-dir",
      fx,
      "--window",
      "12",
      "--session-mb",
      "20",
      "--json",
      json,
      "--report",
      report,
      ...args,
    ],
    { encoding: "utf8", timeout: 600000, env: { ...process.env, ...env } },
  );
  const out = fs.existsSync(json)
    ? JSON.parse(fs.readFileSync(json, "utf8"))
    : null;
  return {
    status: r.status,
    json: out,
    md: fs.existsSync(report) ? fs.readFileSync(report, "utf8") : "",
    stderr: r.stderr,
  };
}

const ext = (/** @type {string} */ n) => path.join(root, "test", "fixtures", n);

test(
  "pi loads the generated fixture: entry count matches over RPC",
  { skip },
  async () => {
    const file = path.join(dir, "load.jsonl");
    const st = writeFixture(file, { mb: 5, seed: 1 });
    const child = spawn(pi, ["--mode", "rpc", "--session", file, "-ne"], {
      cwd: root,
      stdio: ["pipe", "pipe", "pipe"],
    });
    /** @type {Record<string, any>} */
    const got = {};
    let buf = "";
    child.stdout.on("data", (d) => {
      buf += d;
      let i = buf.indexOf("\n");
      while (i >= 0) {
        const line = buf.slice(0, i);
        buf = buf.slice(i + 1);
        i = buf.indexOf("\n");
        try {
          const m = JSON.parse(line);
          if (m.type === "response") got[m.id] = m;
        } catch {}
      }
    });
    try {
      for (const [id, type] of [
        ["state", "get_state"],
        ["messages", "get_messages"],
        ["entries", "get_entries"],
      ]) {
        child.stdin.write(`${JSON.stringify({ id, type })}\n`);
      }
      const deadline = Date.now() + 60000;
      while (Object.keys(got).length < 3 && Date.now() < deadline)
        await new Promise((r) => setTimeout(r, 100));
    } finally {
      child.kill("SIGKILL");
    }
    assert.equal(got.state?.success, true, JSON.stringify(got.state));
    assert.equal(
      got.entries?.success,
      true,
      JSON.stringify(got.entries).slice(0, 300),
    );
    assert.equal(
      got.entries.data.entries.length,
      st.entries,
      "every generated entry was loaded",
    );
    assert.equal(got.messages.success, true);
    assert.ok(
      got.messages.data.messages.length > 100,
      "messages rebuilt from the session branch",
    );
    assert.equal(
      fs.readFileSync(file, "utf8").split("\n")[0].includes('"version":3'),
      true,
    );
  },
);

test(
  "an extension holding ~5 MB passes the budgets",
  { skip, timeout: 600000 },
  () => {
    const r = runCli([
      "--extension",
      ext("ext-pass.js"),
      "--cases",
      "fresh,long",
      "--runs",
      "3",
    ]);
    assert.equal(r.status, 0, `${r.stderr}\n${r.md}`);
    assert.equal(r.json.ok, true, r.md);
    const steady = r.json.checks.find(
      (/** @type {{id: string}} */ c) => c.id === "steadyFresh",
    );
    assert.equal(steady.status, "PASS", r.md);
    // A ~5 MB fixture cannot be pinned by a tight RSS range: steady deltas are
    // median(candidate) - median(vanilla) and the vanilla baseline itself
    // drifts by a few MB run to run, so a +5 holder has measured as low as
    // +0.3 on CI. Assert the budget margin loosely here and prove the fixture
    // is really held via the post-GC arrayBuffers diagnostic, which is
    // deterministic (RSS noise does not touch it).
    assert.ok(
      steady.value > -15 && steady.value < 20,
      `delta ${steady.value} MB out of sanity range\n${r.md}`,
    );
    const cand = r.json.aggregates.fresh.candidate.gcDiag;
    const van = r.json.aggregates.fresh.vanilla.gcDiag;
    assert.ok(cand && van, `post-GC diagnostics missing\n${r.md}`);
    assert.ok(
      cand.arrayBuffersMb - van.arrayBuffersMb > 3,
      `arrayBuffers delta ${(cand.arrayBuffersMb - van.arrayBuffersMb).toFixed(1)} MB: the ~5 MB fixture buffer is not held\n${r.md}`,
    );
    assert.match(r.md, /Memory budget: PASS/);
    // Issue #10: vanilla is one process and shares nothing with itself, so the
    // deduplicated steady must be the summed steady (the two are read a moment
    // apart: status vs smaps).
    assert.equal(r.json.meta.metric, "dedup");
    for (const c of ["fresh", "long"]) {
      const van = r.json.aggregates[c].vanilla;
      assert.ok(
        Math.abs(van.steadyMb - van.summedSteadyMb) < 1,
        `${c}: vanilla dedupe ${van.steadyMb} vs summed ${van.summedSteadyMb}`,
      );
    }
  },
);

test(
  "an extension holding ~60 MB fails the steady budget with exit code 1",
  { skip, timeout: 600000 },
  () => {
    const r = runCli([
      "--extension",
      ext("ext-leak.js"),
      "--cases",
      "fresh",
      "--runs",
      "1",
    ]);
    assert.equal(r.status, 1, `${r.stderr}\n${r.md}`);
    const steady = r.json.checks.find(
      (/** @type {{id: string}} */ c) => c.id === "steadyFresh",
    );
    assert.equal(steady.status, "FAIL");
    assert.ok(
      steady.value > 40,
      `measured +${steady.value} MB for a ~60 MB extension\n${r.md}`,
    );
    assert.match(r.md, /Memory budget: FAIL/);
  },
);

test(
  "a waiver turns that failure into WAIVED and exit code 0",
  { skip, timeout: 600000 },
  () => {
    const cfg = path.join(dir, "waive.json");
    fs.writeFileSync(
      cfg,
      JSON.stringify({
        waivers: { steadyFresh: "test: holding 60 MB on purpose" },
      }),
    );
    const r = runCli([
      "--extension",
      ext("ext-leak.js"),
      "--cases",
      "fresh",
      "--runs",
      "1",
      "--config",
      cfg,
    ]);
    assert.equal(r.status, 0, `${r.stderr}\n${r.md}`);
    assert.equal(
      r.json.checks.find(
        (/** @type {{id: string}} */ c) => c.id === "steadyFresh",
      ).status,
      "WAIVED",
    );
    assert.match(r.md, /WAIVED \(would FAIL\): test: holding 60 MB on purpose/);
  },
);

test(
  "memory that grows with the session fails the growth budget",
  { skip, timeout: 600000 },
  () => {
    const r = runCli([
      "--extension",
      ext("ext-grow.js"),
      "--cases",
      "long,long2x",
      "--runs",
      "1",
    ]);
    assert.equal(r.status, 1, `${r.stderr}\n${r.md}`);
    const growth = r.json.checks.find(
      (/** @type {{id: string}} */ c) => c.id === "growth2x",
    );
    assert.equal(growth.status, "FAIL");
    assert.ok(growth.value > 5, `growth +${growth.value} MB\n${r.md}`);
  },
);

test(
  "an extension whose child holds ~60 MB fails steady anyway (children are budgeted)",
  { skip, timeout: 600000 },
  () => {
    const r = runCli([
      "--extension",
      ext("ext-child.js"),
      "--cases",
      "fresh",
      "--runs",
      "1",
    ]);
    assert.equal(r.status, 1, `${r.stderr}\n${r.md}`);
    const steady = r.json.checks.find(
      (/** @type {{id: string}} */ c) => c.id === "steadyFresh",
    );
    assert.equal(steady.status, "FAIL");
    assert.ok(
      steady.value > 40,
      `total +${steady.value} MB including the child\n${r.md}`,
    );
    assert.ok(
      r.json.aggregates.fresh.candidate.childrenSteadyMb > 45,
      `children ${r.json.aggregates.fresh.candidate.childrenSteadyMb}`,
    );
  },
);

test(
  "an extension that forks a node child is charged what the child adds, not the node binary again",
  { skip, timeout: 900000 },
  () => {
    // The child holds ~5 MB of anonymous memory but maps the node binary and
    // the shared libraries pi already maps: summed RSS charges that twice
    // (+~45 MB, over the +20 MB steady budget), the deduplicated metric once
    // (+~14 MB: the child's own runtime plus the buffer).
    const r = runCli([
      "--extension",
      ext("ext-fork-5mb.js"),
      "--cases",
      "fresh",
      "--runs",
      "2",
    ]);
    assert.equal(r.json?.meta.metric, "dedup", r.stderr);
    const van = r.json.aggregates.fresh.vanilla;
    const cand = r.json.aggregates.fresh.candidate;
    const summedDelta = cand.summedSteadyMb - van.summedSteadyMb;
    const dedupDelta = cand.steadyMb - van.steadyMb;
    assert.ok(
      summedDelta > 35,
      `summed delta +${summedDelta.toFixed(1)} MB: the forked node child is not visible in summed RSS\n${r.md}`,
    );
    assert.ok(
      dedupDelta < 25,
      `deduplicated delta +${dedupDelta.toFixed(1)} MB: shared file pages were charged to the child\n${r.md}`,
    );
    assert.ok(
      summedDelta - dedupDelta > 20,
      `shared pages counted once should be > 20 MB, got ${(summedDelta - dedupDelta).toFixed(1)}\n${r.md}`,
    );
    // The steady check reads the deduplicated delta, which is under the +20 MB
    // budget here; the run may still be INCONCLUSIVE on a noisy box (exit 3),
    // which is why the numbers above, not the verdict, are the assertion.
    assert.ok([0, 3].includes(r.status ?? -1), `exit ${r.status}\n${r.md}`);
    assert.match(r.md, /Checks use DEDUPLICATED RSS/);
  },
);

test(
  "a platform without smaps is REPORT-ONLY: exit 0 where Linux fails",
  { skip, timeout: 900000 },
  () => {
    // Same extension that fails the Linux run with exit 1 (see the ~60 MB test
    // above), measured through the macOS path (ps, summed RSS) by the
    // PMB_PLATFORM seam: the checks print the verdict a Linux run would have
    // given and decide nothing.
    const r = runCli(
      ["--extension", ext("ext-leak.js"), "--cases", "fresh", "--runs", "1"],
      { PMB_PLATFORM: "darwin" },
    );
    assert.equal(r.status, 0, `${r.stderr}\n${r.md}`);
    assert.match(r.md, /^## Memory budget: REPORT-ONLY/);
    assert.match(r.md, /no \/proc\/<pid>\/smaps/);
    assert.match(r.md, /pass\/fail comes from the Linux run/i);
    assert.equal(r.json.meta.reportOnly, true);
    assert.equal(r.json.meta.metric, "rss");
    const steady = r.json.checks.find(
      (/** @type {{id: string}} */ c) => c.id === "steadyFresh",
    );
    assert.equal(steady.status, "REPORT-ONLY");
    assert.equal(steady.wouldBe, "FAIL");
    assert.ok(
      steady.value > 40,
      `the measurement still happened: +${steady.value} MB\n${r.md}`,
    );
    // No FAIL anywhere: the exit code cannot be 1 on such a platform.
    assert.equal(
      r.json.checks.some(
        (/** @type {{status: string}} */ c) => c.status === "FAIL",
      ),
      false,
    );
  },
);

test("no pi process is left behind", { skip }, () => {
  const ps = spawnSync("ps", ["-A", "-o", "args="], {
    encoding: "utf8",
  }).stdout;
  assert.equal(
    ps.split("\n").some((l) => l.includes(root) && l.includes("--mode rpc")),
    false,
    "orphan pi process",
  );
});
