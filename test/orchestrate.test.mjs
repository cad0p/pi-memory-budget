import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { parseRunArgs } from "../src/args.mjs";
import { main } from "../src/cli.mjs";
import { resolveOptions } from "../src/config.mjs";
import { runBudget } from "../src/orchestrate.mjs";
import { renderMarkdown } from "../src/report.mjs";
import { fakeRun } from "./helpers.mjs";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pmb-orch-"));
process.on("exit", () => fs.rmSync(dir, { recursive: true, force: true }));

test("runBudget: matrix order, per-run fixture copies, setup hook env, vanilla/candidate/baseline wiring", async () => {
  const fx = path.join(dir, "fx");
  const o = resolveOptions(
    parseRunArgs([
      "--extension",
      "/cand.ts",
      "--baseline-extension",
      "/base.ts",
      "--runs",
      "2",
      "--window",
      "5",
      "--session-mb",
      "1",
      "--cases",
      "fresh,long",
      "--fixtures-dir",
      fx,
      "--cwd",
      dir,
      "--pi",
      process.execPath,
    ]),
    dir,
  );
  o.setup = {
    "*": `echo "$PMB_CASE $PMB_CONFIG $PMB_RUN" >> ${path.join(dir, "setup.log")}`,
  };
  /** @type {string[]} */
  const calls = [];
  const copies = new Set();
  const result = await runBudget(o, {
    measure: async (spec) => {
      const name =
        spec.extensions.length === 0
          ? "vanilla"
          : spec.extensions[0].includes("base")
            ? "baseline"
            : "candidate";
      calls.push(`${spec.sessionFile ? "long" : "fresh"}:${name}`);
      if (spec.sessionFile) {
        assert.ok(
          fs.statSync(spec.sessionFile).size >= 1024 * 1024,
          "a real copy of the fixture",
        );
        assert.ok(!copies.has(spec.sessionFile), "a fresh copy per run");
        copies.add(spec.sessionFile);
        assert.ok(
          !spec.sessionFile.includes("session-v1-"),
          "never the cached fixture itself",
        );
      }
      assert.equal(spec.cwd, dir);
      const add = name === "candidate" ? 10 : name === "baseline" ? 6 : 0;
      return { ...fakeRun(() => 150 + add), pings: 1 };
    },
  });
  assert.deepEqual(calls, [
    "fresh:vanilla",
    "fresh:candidate",
    "fresh:baseline",
    "long:vanilla",
    "long:candidate",
    "long:baseline",
    "fresh:vanilla",
    "fresh:candidate",
    "fresh:baseline",
    "long:vanilla",
    "long:candidate",
    "long:baseline",
  ]);
  assert.equal(result.result.ok, true);
  assert.equal(result.measurements.long.candidate.length, 2);
  assert.equal(
    result.result.checks.find((c) => c.id === "regression:fresh")?.value,
    4,
  );
  assert.equal(
    fs.readFileSync(path.join(dir, "setup.log"), "utf8").trim().split("\n")
      .length,
    12,
  );
  assert.match(
    fs.readFileSync(path.join(dir, "setup.log"), "utf8"),
    /^fresh vanilla 1$/m,
  );
  assert.deepEqual(
    fs.readdirSync(fx).filter((f) => f.startsWith("work-")),
    [],
    "work copies removed",
  );
  assert.ok(
    renderMarkdown({
      result: result.result,
      budgets: o.budgets,
      waivers: o.waivers,
      meta: result.meta,
    }).includes("Memory budget: PASS"),
  );
});

test("runBudget: a failing setup hook aborts the run", async () => {
  const o = resolveOptions(
    parseRunArgs([
      "--extension",
      "/c.ts",
      "--cases",
      "fresh",
      "--runs",
      "1",
      "--window",
      "2",
      "--fixtures-dir",
      path.join(dir, "fx2"),
      "--cwd",
      dir,
      "--pi",
      process.execPath,
    ]),
    dir,
  );
  o.setup = { "*": "exit 7" };
  await assert.rejects(
    runBudget(o, { measure: async () => fakeRun(() => 1) }),
    /setup command failed \(exit 7\)/,
  );
});

test("cli main: usage errors exit 2, help exits 0, fixture subcommand writes a file", async () => {
  const w = process.stdout.write.bind(process.stdout);
  const e = process.stderr.write.bind(process.stderr);
  /** @type {string[]} */
  const out = [];
  /** @param {unknown} s */
  const capture = (s) => {
    out.push(String(s));
    return true;
  };
  process.stdout.write = /** @type {typeof process.stdout.write} */ (capture);
  process.stderr.write = /** @type {typeof process.stderr.write} */ (capture);
  try {
    assert.equal(await main([]), 2);
    assert.equal(await main(["--help"]), 0);
    assert.equal(await main(["run", "--runs", "x"]), 2);
    assert.equal(await main(["run"]), 2);
    assert.equal(await main(["nope"]), 2);
    const f = path.join(dir, "cli-fixture.jsonl");
    assert.equal(
      await main(["fixture", "--mb", "1", "--out", f, "--seed", "2"]),
      0,
    );
    assert.ok(fs.statSync(f).size >= 1024 * 1024);
    assert.equal(await main(["--version"]), 0);
  } finally {
    process.stdout.write = w;
    process.stderr.write = e;
  }
  assert.match(out.join(""), /pi-memory-budget run --extension/);
});
