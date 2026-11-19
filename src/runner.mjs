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

/**
 * @typedef {object} MeasureSpec
 * @property {{ command: string, args: string[] }} pi
 * @property {string[]} extensions
 * @property {string | null} sessionFile
 * @property {string} cwd
 * @property {NodeJS.ProcessEnv} env
 * @property {number} windowSec
 * @property {number} steadySec
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
  /** @type {{ code: number | null, signal: string | null } | null} */
  let exitInfo = null;
  child.on("exit", (code, signal) => {
    exited = true;
    exitInfo = { code, signal };
  });
  let spawnError = null;
  child.on("error", (e) => {
    spawnError = e;
    exited = true;
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
    const end = t0 + spec.windowSec * 1000;
    let tick = 0;
    while (true) {
      const now = performance.now();
      if (spawnError) throw spawnError;
      if (exited) {
        throw new Error(
          `pi exited after ${((now - t0) / 1000).toFixed(1)}s, before the ${spec.windowSec}s window ended ${JSON.stringify(exitInfo)}\n${stderrTail}`,
        );
      }
      // children are scanned every 5th sample (process-table scans cost more)
      const r = await readRss(/** @type {number} */ (child.pid), {
        withChildren: tick % 5 === 0,
      });
      const prevKids = samples.length ? samples[samples.length - 1].kids : 0;
      if (r.rssMb !== null) {
        samples.push({
          t: (performance.now() - t0) / 1000,
          rss: r.rssMb,
          kids: tick % 5 === 0 ? r.kidsMb : prevKids,
        });
      }
      tick++;
      if (performance.now() >= end) break;
      await sleep(Math.max(0, sampleMs - (performance.now() - now)));
    }
    if (samples.length === 0)
      throw new Error(`pi produced no RSS samples: ${stderrTail}`);
    for (const sent of pending.values())
      maxGap = Math.max(maxGap, performance.now() - sent);
    return {
      ...summarize(samples, spec.steadySec),
      samples,
      maxGapMs: maxGap,
      readyMs,
      pings,
      stderrTail,
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
