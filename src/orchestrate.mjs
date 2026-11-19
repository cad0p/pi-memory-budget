// Runs the (configuration x case x run) matrix sequentially: never more than
// one pi process at a time.

import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { evaluate } from "./budget.mjs";
import { ensureFixture } from "./fixture.mjs";
import { piVersion, resolvePi } from "./pi.mjs";
import { measureRun } from "./runner.mjs";

/**
 * @typedef {object} Hooks
 * @property {(msg: string) => void} [log]
 * @property {typeof measureRun} [measure] injectable for tests
 */

/**
 * @param {string} command
 * @param {string} cwd
 * @param {NodeJS.ProcessEnv} env
 * @returns {Promise<void>}
 */
function runSetup(command, cwd, env) {
  return new Promise((resolve, reject) => {
    const p = spawn("sh", ["-c", command], {
      cwd,
      env,
      stdio: ["ignore", "inherit", "inherit"],
    });
    p.on("error", reject);
    p.on("exit", (code) =>
      code === 0
        ? resolve()
        : reject(new Error(`setup command failed (exit ${code}): ${command}`)),
    );
  });
}

/**
 * @param {import("./config.mjs").ResolvedOptions} o
 * @param {Hooks} [hooks]
 */
export async function runBudget(o, hooks = {}) {
  const log = hooks.log ?? (() => {});
  const measure = hooks.measure ?? measureRun;
  const pi = resolvePi({ pi: o.pi, cwd: o.cwd });
  const version = await piVersion(pi, o.cwd);
  log(`pi ${version} (${pi.source}: ${pi.command})`);

  /** @type {Record<string, string | null>} */
  const sessions = {};
  for (const c of o.cases) {
    if (c === "fresh") sessions[c] = null;
    else {
      const mb = c === "long" ? o.sessionMb : o.sessionMb * 2;
      const t = Date.now();
      const { file, generated } = ensureFixture(o.fixturesDir, mb, o.seed);
      log(
        `fixture ${c}: ${file} (${(fs.statSync(file).size / 1048576).toFixed(0)} MiB, ${generated ? `generated in ${((Date.now() - t) / 1000).toFixed(1)}s` : "cached"})`,
      );
      sessions[c] = file;
    }
  }

  /** @type {Record<string, string[]>} */
  const configs = { vanilla: [], candidate: o.extensions };
  if (o.baselineExtensions.length) configs.baseline = o.baselineExtensions;

  /** @type {import("./budget.mjs").Measurements} */
  const measurements = {};
  for (const c of o.cases) {
    measurements[c] = {};
    for (const name of Object.keys(configs)) measurements[c][name] = [];
  }
  fs.mkdirSync(o.fixturesDir, { recursive: true });
  const workDir = fs.mkdtempSync(path.join(o.fixturesDir, "work-"));
  try {
    // runs outermost, so a slow drift of the machine hits every configuration alike
    for (let run = 1; run <= o.runs; run++) {
      for (const c of o.cases) {
        for (const [name, extensions] of Object.entries(configs)) {
          let sessionFile = null;
          const src = sessions[c];
          if (src) {
            // pi may append to the session file: every run gets its own copy
            sessionFile = path.join(workDir, `${c}-${name}-${run}.jsonl`);
            fs.copyFileSync(src, sessionFile, fs.constants.COPYFILE_FICLONE);
          }
          const env = { ...process.env, ...o.env };
          const setup = o.setup[c] ?? o.setup["*"];
          if (setup) {
            await runSetup(setup, o.cwd, {
              ...env,
              PMB_CASE: c,
              PMB_CONFIG: name,
              PMB_RUN: String(run),
              PMB_SESSION_FILE: sessionFile ?? "",
            });
          }
          log(`run ${run}/${o.runs} case=${c} config=${name} (${o.window}s)`);
          const r = await measure({
            pi,
            extensions,
            sessionFile,
            cwd: o.cwd,
            env,
            windowSec: o.window,
            steadySec: Math.min(o.steadySeconds, o.window),
            extraArgs: o.piArgs,
          });
          log(
            `  steady ${r.steadyMb.toFixed(1)} MB, spike ${r.spikeMb.toFixed(1)} MB, children ${r.childrenSteadyMb.toFixed(1)} MB, max ping gap ${r.maxGapMs.toFixed(0)} ms`,
          );
          measurements[c][name].push(r);
          if (sessionFile) fs.rmSync(sessionFile, { force: true });
        }
      }
    }
  } finally {
    fs.rmSync(workDir, { recursive: true, force: true });
  }

  const result = evaluate(measurements, {
    budgets: o.budgets,
    waivers: o.waivers,
    windowSec: o.window,
  });
  const meta = {
    piVersion: version,
    piSource: pi.source,
    platform: `${process.platform}-${process.arch}, node ${process.version}, ${os.cpus().length} cpus`,
    runs: o.runs,
    windowSec: o.window,
    steadySec: Math.min(o.steadySeconds, o.window),
    sessionMb: o.sessionMb,
    seed: o.seed,
    cases: o.cases,
    extensions: o.extensions,
    baselineExtensions: o.baselineExtensions,
    cwd: o.cwd,
    generatedAt: new Date().toISOString(),
  };
  return { measurements, result, meta };
}
