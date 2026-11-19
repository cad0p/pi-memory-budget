// Spawns pi in RPC mode, samples its RSS and pings it, and cleans up.

import { spawn } from "node:child_process";
import { buildPiArgs } from "./pi.mjs";
import { readRss } from "./sampler.mjs";
import { summarize } from "./stats.mjs";

/** @type {Set<import("node:child_process").ChildProcess>} */
const live = new Set();
let hooksInstalled = false;

/** @param {import("node:child_process").ChildProcess} child @param {NodeJS.Signals} sig */
function killGroup(child, sig) {
  if (child.pid === undefined) return;
  try {
    process.kill(-child.pid, sig); // pi is spawned detached: its own process group
  } catch {
    try {
      child.kill(sig);
    } catch {
      // already gone
    }
  }
}

/** Kills every pi process still alive. Safe to call repeatedly. */
export function killAll() {
  for (const c of live) killGroup(c, "SIGKILL");
}

/** Installs exit and signal hooks once, so no pi process is orphaned. */
export function installCleanupHooks() {
  if (hooksInstalled) return;
  hooksInstalled = true;
  process.on("exit", killAll);
  for (const sig of /** @type {const} */ (["SIGINT", "SIGTERM", "SIGHUP"])) {
    process.on(sig, () => {
      killAll();
      process.exit(sig === "SIGINT" ? 130 : 143);
    });
  }
}

/** @param {number} ms */
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Cap on how far past --window a run extends to make a pending release observable. */
export const RELEASE_EXTEND_CAP_SEC = 60;

/** Total-RSS range (MB) under which a steady window counts as quiet. */
const SETTLE_RANGE_MB = 5;

/**
 * @typedef {object} MeasureSpec
 * @property {{ command: string, args: string[] }} pi
 * @property {string[]} extensions
 * @property {string | null} sessionFile
 * @property {string} cwd
 * @property {NodeJS.ProcessEnv} env
 * @property {number} windowSec minimum sampling window
 * @property {number} steadySec settled-window length for steady RSS
 * @property {number} [settleMaxSec] cap on the quiescence wait (default 120)
 * @property {number} [releaseSec] keep sampling until peak + this (bounded) so a release is observable
 * @property {string[]} [extraArgs]
 * @property {number} [sampleMs]
 * @property {number} [pingMs]
 */

/**
 * @typedef {import("./stats.mjs").RunSummary & {
 *   samples: import("./stats.mjs").Sample[],
 *   maxGapMs: number,
 *   readyMs: number | null,
 *   pings: number,
 *   stderrTail: string,
 *   exitT: number | null,
 *   windowEndSec: number,
 * }} RunResult
 */

/**
 * Runs one pi process for the window and measures it.
 * @param {MeasureSpec} spec
 * @returns {Promise<RunResult>}
 */
export async function measureRun(spec) {
  installCleanupHooks();
  const sampleMs = spec.sampleMs ?? 200;
  const pingMs = spec.pingMs ?? 100;
  const settleMaxSec = spec.settleMaxSec ?? 120;
  const releaseSec = spec.releaseSec ?? 0;
  const args = [
    ...spec.pi.args,
    ...buildPiArgs({
      extensions: spec.extensions,
      sessionFile: spec.sessionFile,
      extraArgs: spec.extraArgs,
    }),
  ];
  const child = spawn(spec.pi.command, args, {
    cwd: spec.cwd,
    env: spec.env,
    stdio: ["pipe", "pipe", "pipe"],
    detached: true,
  });
  live.add(child);
  const t0 = performance.now();
  let exited = false;
  /** @type {number | null} */
  let exitT = null;
  /** @type {{ code: number | null, signal: string | null } | null} */
  let exitInfo = null;
  child.on("exit", (code, signal) => {
    exited = true;
    exitT = (performance.now() - t0) / 1000;
    exitInfo = { code, signal };
  });
  /** @type {Error | null} */
  let spawnError = null;
  child.on("error", (e) => {
    spawnError = e;
    exited = true;
    exitT = (performance.now() - t0) / 1000;
  });
  child.stdin?.on("error", () => {});
  let stderrTail = "";
  child.stderr?.on("data", (d) => {
    stderrTail = (stderrTail + d).slice(-4000);
  });

  /** @type {Map<string, number>} */
  const pending = new Map();
  let seq = 0;
  let maxGap = 0;
  let pings = 0;
  /** @type {number | null} */
  let readyMs = null;
  let buf = "";
  child.stdout?.on("data", (d) => {
    buf += d;
    let i = buf.indexOf("\n");
    while (i >= 0) {
      const line = buf.slice(0, i);
      buf = buf.slice(i + 1);
      i = buf.indexOf("\n");
      if (!line.includes('"response"')) continue;
      try {
        const m = JSON.parse(line);
        const sent = m.type === "response" ? pending.get(m.id) : undefined;
        if (sent !== undefined) {
          pending.delete(m.id);
          const now = performance.now();
          maxGap = Math.max(maxGap, now - sent);
          pings++;
          if (readyMs === null) readyMs = now - t0;
        }
      } catch {
        // not JSON: ignore
      }
    }
  });

  const pinger = setInterval(() => {
    if (exited) return;
    const id = `pmb-${++seq}`;
    pending.set(id, performance.now());
    child.stdin?.write(`${JSON.stringify({ id, type: "get_state" })}\n`);
  }, pingMs);

  /** @type {import("./stats.mjs").Sample[]} */
  const samples = [];
  try {
    // The loop extends past windowSec when needed: until the peak's release is
    // observable (peak + releaseSec), capped.
    while (true) {
      const now = performance.now();
      if (spawnError) throw spawnError;
      if (exited && samples.length === 0) break;
      if (exited) {
        // Died before the steady window is covered: hard error. During the
        // release-observation extension: measurement cut short, exitT < end.
        if ((now - t0) / 1000 < spec.windowSec) {
          throw new Error(
            `pi exited after ${(exitT ?? 0).toFixed(1)}s, before the ${spec.windowSec}s window ended ${JSON.stringify(exitInfo)}\n${stderrTail}`,
          );
        }
        break;
      }
      const r = await readRss(/** @type {number} */ (child.pid));
      if (r.rssMb !== null) {
        samples.push({
          t: (performance.now() - t0) / 1000,
          rss: r.rssMb,
          main: r.mainMb ?? 0,
          kids: r.kidsMb,
        });
      }
      const lastT = (performance.now() - t0) / 1000;
      if (lastT < spec.windowSec) {
        await sleep(Math.max(0, sampleMs - (performance.now() - now)));
        continue;
      }
      // Past the minimum window: two reasons to keep sampling.
      // (a) Quiescence: the process has not been quiet for a full steady
      // window yet (and the run must not stop right before it would settle).
      let quiet = samples.length > 0;
      if (quiet) {
        const last = samples[samples.length - 1];
        if (last.t < spec.steadySec) quiet = false;
        else {
          let lo = Number.POSITIVE_INFINITY;
          let hi = Number.NEGATIVE_INFINITY;
          for (let k = samples.length - 1; k >= 0; k--) {
            const s = samples[k];
            if (last.t - s.t > spec.steadySec) break;
            if (s.rss < lo) lo = s.rss;
            if (s.rss > hi) hi = s.rss;
          }
          quiet = hi - lo < SETTLE_RANGE_MB;
        }
      }
      const waitForSettle = !quiet && lastT < settleMaxSec;
      // (b) Release not yet observable AND RSS still at the peak: keep sampling
      // so the check never has to fail on an unobserved release.
      let waitForRelease = false;
      if (releaseSec > 0 && samples.length) {
        const peak = samples.reduce((a, b) => (b.rss > a.rss ? b : a));
        waitForRelease =
          samples[samples.length - 1].rss >= peak.rss - 0.5 &&
          lastT < peak.t + releaseSec &&
          lastT < spec.windowSec + RELEASE_EXTEND_CAP_SEC;
      }
      if (!waitForSettle && !waitForRelease) break;
      await sleep(Math.max(0, sampleMs - (performance.now() - now)));
    }
    if (spawnError) throw spawnError;
    if (samples.length === 0) {
      throw new Error(`pi produced no RSS samples: ${stderrTail}`);
    }
    for (const sent of pending.values())
      maxGap = Math.max(maxGap, performance.now() - sent);
    return {
      ...summarize(samples, {
        settleMax: settleMaxSec,
        quietSec: spec.steadySec,
      }),
      samples,
      maxGapMs: maxGap,
      readyMs,
      pings,
      stderrTail,
      exitT,
      windowEndSec: samples[samples.length - 1].t,
    };
  } finally {
    clearInterval(pinger);
    await stop(child);
  }
}

/** @param {import("node:child_process").ChildProcess} child */
async function stop(child) {
  try {
    child.stdin?.end();
  } catch {
    // ignore
  }
  killGroup(child, "SIGTERM");
  const deadline = Date.now() + 5000;
  while (
    child.exitCode === null &&
    child.signalCode === null &&
    Date.now() < deadline
  )
    await sleep(50);
  if (child.exitCode === null && child.signalCode === null) {
    killGroup(child, "SIGKILL");
    const d2 = Date.now() + 3000;
    while (
      child.exitCode === null &&
      child.signalCode === null &&
      Date.now() < d2
    )
      await sleep(50);
  }
  // also take down any straggler in the group (extension child processes)
  killGroup(child, "SIGKILL");
  live.delete(child);
}
