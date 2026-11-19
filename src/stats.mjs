// Pure statistics helpers (no I/O).

/**
 * @param {number[]} values
 * @returns {number} median, NaN for an empty list (Infinity sorts last)
 */
export function median(values) {
  if (values.length === 0) return Number.NaN;
  const s = [...values].sort((a, b) => a - b);
  const mid = s.length >> 1;
  const lo = s[mid - 1];
  const hi = s[mid];
  if (s.length % 2) return hi;
  return lo === hi ? hi : (lo + hi) / 2;
}

/**
 * @param {number[]} values
 * @returns {number} max, -Infinity for an empty list
 */
export function max(values) {
  let m = Number.NEGATIVE_INFINITY;
  for (const v of values) if (v > m) m = v;
  return m;
}

/**
 * One RSS sample. t is seconds since spawn, rss and kids are MB (kids = sum of
 * all descendant processes of pi, reported separately).
 * @typedef {{ t: number, rss: number, kids: number }} Sample
 */

/**
 * @typedef {object} RunSummary
 * @property {number} steadyMb median RSS over the last steadySec seconds
 * @property {number} spikeMb max RSS over the whole window
 * @property {number} releasedMb RSS of the last sample
 * @property {number} peakT seconds since spawn at which the spike happened
 * @property {number} childrenSteadyMb median descendant RSS over the steady slice
 * @property {number} childrenSpikeMb max descendant RSS
 */

/**
 * @param {Sample[]} samples
 * @param {number} steadySec length of the steady slice at the end of the window
 * @returns {RunSummary}
 */
export function summarize(samples, steadySec) {
  if (samples.length === 0) throw new Error("no RSS samples collected");
  const last = samples[samples.length - 1];
  const tail = samples.filter((s) => s.t >= last.t - steadySec);
  let peak = samples[0];
  for (const s of samples) if (s.rss > peak.rss) peak = s;
  return {
    steadyMb: median(tail.map((s) => s.rss)),
    spikeMb: peak.rss,
    releasedMb: last.rss,
    peakT: peak.t,
    childrenSteadyMb: median(tail.map((s) => s.kids)),
    childrenSpikeMb: max(samples.map((s) => s.kids)),
  };
}

/**
 * Seconds from the RSS peak until the delta over the vanilla steady RSS first
 * drops to or below the steady budget. 0 when the peak itself is within the
 * budget, null when it never drops within the window.
 * @param {Sample[]} samples
 * @param {number} vanillaSteadyMb
 * @param {number} steadyBudgetMb
 * @returns {number | null}
 */
export function releaseSeconds(samples, vanillaSteadyMb, steadyBudgetMb) {
  if (samples.length === 0) return null;
  let peakIdx = 0;
  for (let i = 0; i < samples.length; i++) {
    if (samples[i].rss > samples[peakIdx].rss) peakIdx = i;
  }
  const peak = samples[peakIdx];
  if (peak.rss - vanillaSteadyMb <= steadyBudgetMb) return 0;
  for (let i = peakIdx + 1; i < samples.length; i++) {
    if (samples[i].rss - vanillaSteadyMb <= steadyBudgetMb) {
      return samples[i].t - peak.t;
    }
  }
  return null;
}
