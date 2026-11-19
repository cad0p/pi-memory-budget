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
 * @returns {{ status: number | null, json: any, md: string, stderr: string }}
 */
function runCli(args) {
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
    { encoding: "utf8", timeout: 600000 },
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
      "2",
    ]);
    assert.equal(r.status, 0, `${r.stderr}\n${r.md}`);
    assert.equal(r.json.ok, true);
    const steady = r.json.checks.find(
      (/** @type {{id: string}} */ c) => c.id === "steadyFresh",
    );
    assert.equal(steady.status, "PASS");
    assert.ok(
      steady.value > 2 && steady.value < 20,
      `measured +${steady.value} MB for a ~5 MB extension`,
    );
    assert.match(r.md, /Memory budget: PASS/);
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
      `measured +${steady.value} MB for a ~60 MB extension`,
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
    assert.ok(growth.value > 5, `growth +${growth.value} MB`);
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
