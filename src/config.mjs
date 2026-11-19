// budget.json loading and merging with CLI options.

import fs from "node:fs";
import path from "node:path";
import { CASES, UsageError } from "./args.mjs";
import { resolveBudgets } from "./budget.mjs";

/**
 * @typedef {object} ConfigFile
 * @property {Record<string, number>} [budgets]
 * @property {Record<string, string | { reason: string }>} [waivers] budget key -> reason
 * @property {string[]} [extensions]
 * @property {string[]} [baselineExtensions]
 * @property {string} [cwd]
 * @property {Record<string, string>} [env]
 * @property {string | Record<string, string>} [setup] shell command, or case name ("*" for all) -> command
 * @property {number} [runs]
 * @property {number} [window]
 * @property {number} [steadySeconds]
 * @property {number} [settleMax]
 * @property {number} [sessionMb]
 * @property {string[]} [cases]
 * @property {number} [seed]
 * @property {string[]} [piArgs]
 */

const KNOWN = new Set([
  "budgets",
  "waivers",
  "extensions",
  "baselineExtensions",
  "cwd",
  "env",
  "setup",
  "runs",
  "window",
  "steadySeconds",
  "settleMax",
  "sessionMb",
  "cases",
  "seed",
  "piArgs",
  "$schema",
]);

/**
 * @param {string} file
 * @returns {ConfigFile}
 */
export function loadConfigFile(file) {
  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (e) {
    throw new UsageError(
      `cannot read config ${file}: ${e instanceof Error ? e.message : e}`,
    );
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw))
    throw new UsageError(`${file}: expected a JSON object`);
  for (const k of Object.keys(raw)) {
    if (!KNOWN.has(k))
      throw new UsageError(
        `${file}: unknown key "${k}" (known: ${[...KNOWN].join(", ")})`,
      );
  }
  return raw;
}

/**
 * @typedef {object} ResolvedOptions
 * @property {string[]} extensions absolute
 * @property {string[]} baselineExtensions absolute
 * @property {string} cwd absolute
 * @property {Record<string, string>} env
 * @property {Record<string, string>} setup case -> command ("*" = every case)
 * @property {number} runs
 * @property {number} window
 * @property {number} steadySeconds
 * @property {number} settleMax
 * @property {number} sessionMb
 * @property {string[]} cases
 * @property {number} seed
 * @property {string | undefined} pi
 * @property {string[]} piArgs
 * @property {string} fixturesDir
 * @property {import("./budget.mjs").Budgets} budgets
 * @property {Record<string, string>} waivers
 */

/**
 * CLI values win over the config file, which wins over defaults. Relative
 * paths from the CLI resolve against the process cwd, from the config file
 * against the file's directory.
 * @param {import("./args.mjs").RunOptions} cli
 * @param {string} tmpdir
 * @returns {ResolvedOptions}
 */
export function resolveOptions(cli, tmpdir) {
  const cfgPath = cli.config ? path.resolve(cli.config) : undefined;
  const cfg = cfgPath ? loadConfigFile(cfgPath) : {};
  const cfgDir = cfgPath ? path.dirname(cfgPath) : process.cwd();
  /** @param {string[]} list @param {string} base */
  const abs = (list, base) => list.map((p) => path.resolve(base, p));

  const extensions = [
    ...abs(cfg.extensions ?? [], cfgDir),
    ...abs(cli.extensions, process.cwd()),
  ];
  if (extensions.length === 0)
    throw new UsageError(
      "run needs at least one --extension <path> (or 'extensions' in the config)",
    );
  const cwd = cli.cwd
    ? path.resolve(cli.cwd)
    : cfg.cwd
      ? path.resolve(cfgDir, cfg.cwd)
      : process.cwd();

  /** @type {Record<string, string>} */
  const env = { ...(cfg.env ?? {}) };
  for (const e of cli.env) {
    const i = e.indexOf("=");
    env[e.slice(0, i)] = e.slice(i + 1);
  }
  /** @type {Record<string, string>} */
  const setup =
    typeof cfg.setup === "string"
      ? { "*": cfg.setup }
      : { ...(cfg.setup ?? {}) };
  for (const k of Object.keys(setup)) {
    if (k !== "*" && !CASES.includes(k))
      throw new UsageError(
        `setup key "${k}" must be "*" or one of ${CASES.join(", ")}`,
      );
  }
  const cases = cli.cases ?? cfg.cases ?? CASES;
  const bad = cases.filter((c) => !CASES.includes(c));
  if (bad.length)
    throw new UsageError(`unknown case(s) in config: ${bad.join(", ")}`);
  const { budgets, waivers } = resolveBudgets(
    cfg.budgets,
    /** @type {Record<string, unknown> | undefined} */ (cfg.waivers),
  );

  return {
    extensions,
    baselineExtensions: [
      ...abs(cfg.baselineExtensions ?? [], cfgDir),
      ...abs(cli.baselineExtensions, process.cwd()),
    ],
    cwd,
    env,
    setup,
    runs: cli.runs ?? cfg.runs ?? 3,
    window: cli.window ?? cfg.window ?? 30,
    steadySeconds: cli.steadySeconds ?? cfg.steadySeconds ?? 10,
    settleMax: cli.settleMax ?? cfg.settleMax ?? 120,
    sessionMb: cli.sessionMb ?? cfg.sessionMb ?? 200,
    cases,
    seed: cli.seed ?? cfg.seed ?? 1,
    pi: cli.pi,
    piArgs: [...(cfg.piArgs ?? []), ...cli.piArgs],
    fixturesDir: cli.fixturesDir
      ? path.resolve(cli.fixturesDir)
      : path.join(tmpdir, "pi-memory-budget"),
    budgets,
    waivers,
  };
}
