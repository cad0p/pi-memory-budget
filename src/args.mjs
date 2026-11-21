// Command line parsing for the pi-memory-budget CLI.

import { parseArgs } from "node:util";

export const USAGE = `pi-memory-budget: memory budgets for pi extensions

Usage:
  pi-memory-budget run --extension <path> [options]
  pi-memory-budget fixture --mb <n> --out <file.jsonl> [--seed <n>]

run options:
  --extension <path>           extension under test (repeatable, passed to pi as -e)
  --baseline-extension <path>  baseline build of the extension, e.g. from main (repeatable)
  --config <budget.json>       budgets, waivers, env, setup hooks (see README)
  --cwd <dir>                  working directory of pi (default: current directory)
  --env K=V                    extra environment variable for every pi process (repeatable)
  --runs <n>                   runs per configuration and case, median is used (default 3)
  --window <s>                 measurement window per run in seconds (default 30)
  --steady-seconds <s>         settled-window length for steady RSS (default 10)
  --settle-max <s>             cap on the quiescence wait; "not settled" past it (default 120)
  --settle-min <s>             no settle before this time; every run is forced-GC'd by then (default 30)
  --session-mb <n>             size of the long session fixture in MiB (default 200)
  --cases <list>               comma-separated: fresh,long,long2x (default all)
  --seed <n>                   fixture seed (default 1)
  --pi <cmd>                   pi command (default: ./node_modules/.bin/pi of --cwd, then PATH)
  --pi-arg <arg>               extra argument for every pi process (repeatable)
  --no-gc                      do not start pi with --expose-gc and the GC harness
                               (default: on — steady is measured after forced GCs)
  --report <file.md>           write the markdown report
  --json <file.json>           write the JSON report
  --fixtures-dir <dir>         fixture cache (default: <tmpdir>/pi-memory-budget)
  --quiet                      no progress output on stderr

Exit code: 0 all budgets pass or are waived, 1 a budget FAILs, 2 usage or runtime error,
3 no FAIL but at least one check is INCONCLUSIVE (e.g. vanilla's own run spread
exceeds the budget, or a release could not be observed).
Checks read deduplicated RSS on Linux (shared file-backed pages counted once across
the process tree). Platforms without /proc/<pid>/smaps (macOS) cannot compute it:
there the checks are REPORT-ONLY and the exit code is 0 unless the run itself failed
(2). Pass/fail comes from the Linux run.
`;

/**
 * @typedef {object} RunOptions
 * @property {string[]} extensions
 * @property {string[]} baselineExtensions
 * @property {string | undefined} config
 * @property {string | undefined} cwd
 * @property {string[]} env
 * @property {number | undefined} runs
 * @property {number | undefined} window
 * @property {number | undefined} steadySeconds
 * @property {number | undefined} settleMax
 * @property {number | undefined} settleMin
 * @property {number | undefined} sessionMb
 * @property {string[] | undefined} cases
 * @property {number | undefined} seed
 * @property {string | undefined} pi
 * @property {string[]} piArgs
 * @property {string | undefined} report
 * @property {string | undefined} json
 * @property {string | undefined} fixturesDir
 * @property {boolean} noGc
 * @property {boolean} quiet
 */

/**
 * @param {string | undefined} v
 * @param {string} name
 * @param {{ min?: number, integer?: boolean }} [rule]
 */
function num(v, name, rule = {}) {
  if (v === undefined) return undefined;
  const n = Number(v);
  if (
    !Number.isFinite(n) ||
    (rule.integer && !Number.isInteger(n)) ||
    n < (rule.min ?? 0)
  ) {
    throw new UsageError(
      `--${name} must be ${rule.integer ? "an integer" : "a number"} >= ${rule.min ?? 0}, got "${v}"`,
    );
  }
  return n;
}

export class UsageError extends Error {}

export const CASES = ["fresh", "long", "long2x"];

/**
 * @param {string[]} argv arguments after the "run" subcommand
 * @returns {RunOptions & { help: boolean }}
 */
export function parseRunArgs(argv) {
  let parsed;
  try {
    parsed = parseArgs({
      args: argv,
      allowPositionals: false,
      options: {
        extension: { type: "string", multiple: true },
        "baseline-extension": { type: "string", multiple: true },
        config: { type: "string" },
        cwd: { type: "string" },
        env: { type: "string", multiple: true },
        runs: { type: "string" },
        window: { type: "string" },
        "steady-seconds": { type: "string" },
        "settle-max": { type: "string" },
        "settle-min": { type: "string" },
        "session-mb": { type: "string" },
        cases: { type: "string" },
        seed: { type: "string" },
        pi: { type: "string" },
        "pi-arg": { type: "string", multiple: true },
        report: { type: "string" },
        json: { type: "string" },
        "fixtures-dir": { type: "string" },
        "no-gc": { type: "boolean" },
        quiet: { type: "boolean" },
        help: { type: "boolean", short: "h" },
      },
    });
  } catch (e) {
    throw new UsageError(e instanceof Error ? e.message : String(e));
  }
  const v = parsed.values;
  let cases;
  if (v.cases !== undefined) {
    cases = v.cases
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    const bad = cases.filter((c) => !CASES.includes(c));
    if (bad.length || cases.length === 0) {
      throw new UsageError(
        `--cases must be a comma-separated subset of ${CASES.join(",")}, got "${v.cases}"`,
      );
    }
  }
  for (const e of v.env ?? []) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*=/.test(e))
      throw new UsageError(`--env expects K=V, got "${e}"`);
  }
  return {
    extensions: v.extension ?? [],
    baselineExtensions: v["baseline-extension"] ?? [],
    config: v.config,
    cwd: v.cwd,
    env: v.env ?? [],
    runs: num(v.runs, "runs", { min: 1, integer: true }),
    window: num(v.window, "window", { min: 1 }),
    steadySeconds: num(v["steady-seconds"], "steady-seconds", { min: 1 }),
    settleMax: num(v["settle-max"], "settle-max", { min: 1 }),
    settleMin: num(v["settle-min"], "settle-min", { min: 0 }),
    sessionMb: num(v["session-mb"], "session-mb", { min: 1 }),
    cases,
    seed: num(v.seed, "seed", { integer: true }),
    pi: v.pi,
    piArgs: v["pi-arg"] ?? [],
    report: v.report,
    json: v.json,
    fixturesDir: v["fixtures-dir"],
    noGc: v["no-gc"] ?? false,
    quiet: v.quiet ?? false,
    help: v.help ?? false,
  };
}

/**
 * @param {string[]} argv arguments after the "fixture" subcommand
 * @returns {{ mb: number, out: string, seed: number, cwd: string | undefined, help: boolean }}
 */
export function parseFixtureArgs(argv) {
  let parsed;
  try {
    parsed = parseArgs({
      args: argv,
      allowPositionals: false,
      options: {
        mb: { type: "string" },
        out: { type: "string" },
        seed: { type: "string" },
        cwd: { type: "string" },
        help: { type: "boolean", short: "h" },
      },
    });
  } catch (e) {
    throw new UsageError(e instanceof Error ? e.message : String(e));
  }
  const v = parsed.values;
  if (!v.help && (v.mb === undefined || v.out === undefined)) {
    throw new UsageError("fixture needs --mb <n> and --out <file.jsonl>");
  }
  return {
    mb: num(v.mb, "mb", { min: 0.01 }) ?? 0,
    out: v.out ?? "",
    seed: num(v.seed, "seed", { integer: true }) ?? 1,
    cwd: v.cwd,
    help: v.help ?? false,
  };
}
