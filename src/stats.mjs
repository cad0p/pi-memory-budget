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
 * One RSS sample. t is seconds since spawn. rss is the TOTAL memory of the pi
 * process: main pid plus every descendant, in MB. main and kids split it for
 * diagnosis.
 * @typedef {{ t: number, rss: number, main: number, kids: number }} Sample
 */

/**
 * The first quiescent point: the earliest T, at least quietSec after spawn,
 * whose trailing quietSec window has a total-RSS range under maxRangeMb and
 * whose level then holds for the rest of the run. Settling late is a real
 * signal (still-loading process, deferred work), so the caller caps it with
 * settleMax.
 * @param {Sample[]} samples
 * @param {{ quietSec?: number, maxRangeMb?: number, settleMax?: number }} [o]
 * @returns {{ settled: boolean, t: number | null, quietSec: number }}
 */
export function findSettle(samples, o = {}) {
  const quietSec = o.quietSec ?? 10;
  const maxRangeMb = o.maxRangeMb ?? 5;
  const settleMax = o.settleMax ?? Number.POSITIVE_INFINITY;
  const slack = 0.5;
  // The settled point is the earliest T, at least quietSec after the start,
  // where the last quietSec form a quiet window AND the whole suffix after T
  // stays at that level. Requiring the suffix to hold is what keeps a flat
  // spike plateau, a process that ramps again after T, or a still-loading
  // process from counting as steady.
  for (let i = 0; i < samples.length; i++) {
    const T = samples[i].t;
    if (T > settleMax) break;
    if (T - samples[0].t < quietSec - slack) continue; // window not long enough yet
    if (i > 0 && T - samples[i - 1].t > 1) continue; // sampling gap: do not guess
    let lo = Number.POSITIVE_INFINITY;
    let hi = Number.NEGATIVE_INFINITY;
    for (let j = i; j >= 0; j--) {
      const s = samples[j];
      if (T - s.t > quietSec) break;
      if (s.rss < lo) lo = s.rss;
      if (s.rss > hi) hi = s.rss;
    }
    if (!Number.isFinite(lo) || hi - lo >= maxRangeMb) continue;
    let holds = true;
    for (let j = i + 1; j < samples.length; j++) {
      if (samples[j].rss > hi + slack || samples[j].rss < lo - slack) {
        holds = false;
        break;
      }
    }
    if (holds) return { settled: true, t: T, quietSec };
  }
  return { settled: false, t: null, quietSec };
}

/**
 * @typedef {object} RunSummary
 * @property {boolean} settled whether quiescence was found before settleMax
 * @property {number | null} settleT seconds since spawn at which the process settled
 * @property {number | null} steadyMb median total RSS of the settled 10 s window; null when not settled
 * @property {number} spikeMb max total RSS over the whole run
 * @property {number | null} releasedMb total RSS of the last sample
 * @property {number} peakT seconds since spawn at which the spike happened
 * @property {number | null} mainSteadyMb median main-pid RSS of the settled window
 * @property {number | null} childrenSteadyMb median descendant RSS of the settled window
 * @property {number} childrenSpikeMb max descendant RSS
 */

/**
 * @param {Sample[]} samples
 * @param {{ settleMax?: number, quietSec?: number }} [o]
 * @returns {RunSummary}
 */
export function summarize(samples, o = {}) {
  if (samples.length === 0) throw new Error("no RSS samples collected");
  const last = samples[samples.length - 1];
  const settle = findSettle(samples, {
    quietSec: o.quietSec,
    settleMax: o.settleMax,
  });
  let peak = samples[0];
  for (const s of samples) if (s.rss > peak.rss) peak = s;
  const tail =
    settle.t === null
      ? []
      : samples.filter(
          (s) => s.t >= /** @type {number} */ (settle.t) - settle.quietSec,
        );
  return {
    settled: settle.settled,
    settleT: settle.t,
    steadyMb: tail.length ? median(tail.map((s) => s.rss)) : null,
    spikeMb: peak.rss,
    releasedMb: last.rss,
    peakT: peak.t,
    mainSteadyMb: tail.length ? median(tail.map((s) => s.main)) : null,
    childrenSteadyMb: tail.length ? median(tail.map((s) => s.kids)) : null,
    childrenSpikeMb: max(samples.map((s) => s.kids)),
  };
}

/**
 * Seconds from the RSS peak until the delta over the vanilla steady RSS first
 * holds at or below the steady budget for `hold` consecutive samples (one dip
 * does not count: RSS rebounds all the time). 0 when the peak itself is within
 * the budget, null when it never releases within the samples.
 * @param {Sample[]} samples
 * @param {number} vanillaSteadyMb
 * @param {number} steadyBudgetMb
 * @param {number} [hold]
 * @returns {number | null}
 */
export function releaseSeconds(
  samples,
  vanillaSteadyMb,
  steadyBudgetMb,
  hold = 3,
) {
  if (samples.length === 0) return null;
  let peakIdx = 0;
  for (let i = 0; i < samples.length; i++) {
    if (samples[i].rss > samples[peakIdx].rss) peakIdx = i;
  }
  const peak = samples[peakIdx];
  if (peak.rss - vanillaSteadyMb <= steadyBudgetMb) return 0;
  let streak = 0;
  for (let i = peakIdx + 1; i < samples.length; i++) {
    if (samples[i].rss - vanillaSteadyMb <= steadyBudgetMb) {
      streak++;
      if (streak >= hold) return samples[i - streak + 1].t - peak.t;
    } else {
      streak = 0;
    }
  }
  return null;
}
