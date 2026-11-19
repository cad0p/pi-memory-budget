// Builders for synthetic measurement data.
import { summarize } from "../src/stats.mjs";

/**
 * A run whose RSS follows fn(t) for a window of `window` seconds at 5 Hz.
 * @param {(t: number) => number} fn
 * @param {{ window?: number, kids?: number, gap?: number, steadySec?: number }} [o]
 * @returns {import("../src/runner.mjs").RunResult}
 */
export function fakeRun(fn, o = {}) {
  const window = o.window ?? 30;
  /** @type {import("../src/stats.mjs").Sample[]} */
  const samples = [];
  for (let t = 0; t <= window + 1e-9; t += 0.2)
    samples.push({ t, rss: fn(t), kids: o.kids ?? 0 });
  return {
    ...summarize(samples, o.steadySec ?? 10),
    samples,
    maxGapMs: o.gap ?? 100,
    readyMs: 500,
    pings: 100,
    stderrTail: "",
  };
}

/** @param {number} mb */
export const flat = (mb) => fakeRun(() => mb);
