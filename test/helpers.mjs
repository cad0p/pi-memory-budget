// Builders for synthetic measurement data.
import { summarize } from "../src/stats.mjs";

/**
 * A run whose TOTAL RSS follows fn(t) for a window of `window` seconds at 5 Hz.
 * dedup (issue #10) is either a constant, a function of t, or absent (null: a
 * platform without smaps, where the checks read summed RSS).
 * @param {(t: number) => number} fn
 * @param {{ window?: number, kids?: number, gap?: number, steadySec?: number, exitT?: number | null, anon?: number | null, file?: number | null, shmem?: number | null, dedup?: number | ((t: number) => number), metric?: "rss" | "dedup" }} [o]
 * @returns {import("../src/runner.mjs").RunResult}
 */
export function fakeRun(fn, o = {}) {
  const window = o.window ?? 30;
  /** @param {number} t */
  const dedupAt = (t) =>
    typeof o.dedup === "function" ? o.dedup(t) : (o.dedup ?? null);
  /** @type {import("../src/stats.mjs").Sample[]} */
  const samples = [];
  for (let t = 0; t <= window + 1e-9; t += 0.2) {
    const rss = fn(t);
    samples.push({
      t,
      rss,
      main: rss - (o.kids ?? 0),
      kids: o.kids ?? 0,
      anon: o.anon ?? null,
      file: o.file ?? null,
      shmem: o.shmem ?? null,
      dedup: dedupAt(t),
    });
  }
  const metric = o.metric ?? "rss";
  const summary = summarize(samples, {
    quietSec: o.steadySec ?? 10,
    field: metric,
  });
  const summed = summarize(samples, {
    quietSec: o.steadySec ?? 10,
    field: "rss",
  });
  return {
    ...summary,
    metric,
    summedSteadyMb: summed.steadyMb,
    summedSpikeMb: summed.spikeMb,
    summedReleasedMb: summed.releasedMb,
    samples,
    maxGapMs: o.gap ?? 100,
    readyMs: 500,
    pings: 100,
    stderrTail: "",
    exitT: o.exitT ?? null,
    windowEndSec: window,
    gcReady: null,
    gcDiag: null,
  };
}

/** @param {number} mb */
export const flat = (mb) => fakeRun(() => mb);
