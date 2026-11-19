import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { parseFixtureArgs, parseRunArgs, UsageError } from "../src/args.mjs";
import { resolveOptions } from "../src/config.mjs";

test("run: all options parse", () => {
  const a = parseRunArgs([
    "--extension",
    "a.ts",
    "--extension",
    "b.ts",
    "--baseline-extension",
    "main.ts",
    "--config",
    "budget.json",
    "--cwd",
    "/work",
    "--env",
    "A=1",
    "--env",
    "B=x=y",
    "--runs",
    "5",
    "--window",
    "20",
    "--session-mb",
    "100",
    "--cases",
    "fresh,long",
    "--pi",
    "node /x/cli.js",
    "--report",
    "r.md",
    "--json",
    "r.json",
    "--fixtures-dir",
    "/fx",
    "--seed",
    "9",
    "--quiet",
  ]);
  assert.deepEqual(a.extensions, ["a.ts", "b.ts"]);
  assert.deepEqual(a.baselineExtensions, ["main.ts"]);
  assert.equal(a.config, "budget.json");
  assert.deepEqual(a.env, ["A=1", "B=x=y"]);
  assert.equal(a.runs, 5);
  assert.equal(a.window, 20);
  assert.equal(a.sessionMb, 100);
  assert.deepEqual(a.cases, ["fresh", "long"]);
  assert.equal(a.pi, "node /x/cli.js");
  assert.equal(a.seed, 9);
  assert.equal(a.quiet, true);
});

test("run: defaults are unset so config and built-in defaults can fill in", () => {
  const a = parseRunArgs(["--extension", "a.ts"]);
  assert.equal(a.runs, undefined);
  assert.equal(a.cases, undefined);
  assert.deepEqual(a.env, []);
});

test("run: invalid input raises UsageError", () => {
  assert.throws(() => parseRunArgs(["--runs", "0"]), UsageError);
  assert.throws(() => parseRunArgs(["--runs", "1.5"]), UsageError);
  assert.throws(() => parseRunArgs(["--window", "abc"]), UsageError);
  assert.throws(() => parseRunArgs(["--cases", "fresh,huge"]), /subset of/);
  assert.throws(() => parseRunArgs(["--env", "NOEQUALS"]), /K=V/);
  assert.throws(() => parseRunArgs(["--bogus"]), UsageError);
  assert.throws(() => parseRunArgs(["positional"]), UsageError);
});

test("fixture: args", () => {
  assert.deepEqual(
    parseFixtureArgs(["--mb", "200", "--out", "f.jsonl", "--seed", "3"]),
    {
      mb: 200,
      out: "f.jsonl",
      seed: 3,
      cwd: undefined,
      help: false,
    },
  );
  assert.equal(parseFixtureArgs(["--mb", "1", "--out", "x"]).seed, 1);
  assert.throws(() => parseFixtureArgs(["--mb", "5"]), /needs --mb/);
  assert.throws(() => parseFixtureArgs(["--out", "x"]), /needs --mb/);
});

test("resolveOptions: defaults, config file and CLI precedence, path resolution", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pmb-args-"));
  try {
    fs.writeFileSync(
      path.join(dir, "budget.json"),
      JSON.stringify({
        extensions: ["ext/a.ts"],
        env: { FROM_CFG: "1", BOTH: "cfg" },
        budgets: { steadyFresh: 30 },
        waivers: { growth2x: "linear index, tracked in #9" },
        setup: "echo hi",
        runs: 2,
        window: 12,
        cases: ["fresh"],
      }),
    );
    const cli = parseRunArgs([
      "--config",
      path.join(dir, "budget.json"),
      "--env",
      "BOTH=cli",
      "--runs",
      "4",
      "--extension",
      "rel/b.ts",
    ]);
    const o = resolveOptions(cli, "/tmpx");
    assert.deepEqual(o.extensions, [
      path.join(dir, "ext/a.ts"),
      path.resolve("rel/b.ts"),
    ]);
    assert.deepEqual(o.env, { FROM_CFG: "1", BOTH: "cli" });
    assert.equal(o.runs, 4, "CLI wins over config");
    assert.equal(o.window, 12, "config wins over default");
    assert.equal(o.sessionMb, 200);
    assert.equal(o.steadySeconds, 10);
    assert.deepEqual(o.cases, ["fresh"]);
    assert.equal(o.budgets.steadyFresh, 30);
    assert.equal(o.budgets.steadyLong, 20);
    assert.deepEqual(o.waivers, { growth2x: "linear index, tracked in #9" });
    assert.deepEqual(o.setup, { "*": "echo hi" });
    assert.equal(o.fixturesDir, path.join("/tmpx", "pi-memory-budget"));
    assert.equal(o.cwd, process.cwd());
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("resolveOptions: needs an extension; bad config keys and bad waivers are refused", () => {
  assert.throws(
    () => resolveOptions(parseRunArgs([]), "/t"),
    /at least one --extension/,
  );
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pmb-args-"));
  try {
    const f = path.join(dir, "b.json");
    fs.writeFileSync(f, JSON.stringify({ typo: 1 }));
    assert.throws(
      () =>
        resolveOptions(parseRunArgs(["--extension", "a", "--config", f]), "/t"),
      /unknown key "typo"/,
    );
    fs.writeFileSync(f, JSON.stringify({ waivers: { spike: "" } }));
    assert.throws(
      () =>
        resolveOptions(parseRunArgs(["--extension", "a", "--config", f]), "/t"),
      /non-empty reason/,
    );
    fs.writeFileSync(f, JSON.stringify({ setup: { nocase: "x" } }));
    assert.throws(
      () =>
        resolveOptions(parseRunArgs(["--extension", "a", "--config", f]), "/t"),
      /setup key/,
    );
    assert.throws(
      () =>
        resolveOptions(
          parseRunArgs([
            "--extension",
            "a",
            "--config",
            path.join(dir, "missing.json"),
          ]),
          "/t",
        ),
      /cannot read config/,
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
