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
 * diagnosis. anon/file/shmem are the same total split by /proc RssAnon,
 * RssFile and RssShmem on Linux (issue #7 locates the long-session spread);
 * null or absent where the platform does not report them. dedup is the
 * deduplicated total (issue #10): anonymous RSS of the subtree plus every file
 * mapping counted once, so shared file-backed pages are not charged twice; null
 * or absent where smaps does not exist (macOS).
 * @typedef {{ t: number, rss: number, main: number, kids: number, anon?: number | null, file?: number | null, shmem?: number | null, dedup?: number | null }} Sample
 */

/**
 * What a measurement reads off a sample.
 * - "rss": summed RSS of the subtree, every file mapping counted per process.
 * - "dedup": deduplicated RSS (Linux only; falls back to rss where the
 *   platform cannot see shared pages).
 * - "anon": RssAnon (release checks in older reports; falls back to rss).
 * @typedef {"rss" | "dedup" | "anon"} MetricField
 */

/**
 * @param {Sample} s
 * @param {MetricField} [field]
 * @returns {number}
 */
export function metricValue(s, field = "rss") {
  if (field === "dedup") return s.dedup ?? s.rss;
  if (field === "anon") return s.anon ?? s.rss;
  return s.rss;
}

/**
 * The first quiescent point: the earliest T, at least quietSec after spawn,
 * whose trailing quietSec window has a range under maxRangeMb in the measured
 * field and whose level then holds for the rest of the run. Settling late is a
 * real signal (still-loading process, deferred work), so the caller caps it
 * with settleMax.
 * @param {Sample[]} samples
 * @param {{ quietSec?: number, maxRangeMb?: number, settleMax?: number, settleMin?: number, field?: MetricField }} [o]
 * @returns {{ settled: boolean, t: number | null, quietSec: number }}
 */
export function findSettle(samples, o = {}) {
  const field = o.field ?? "rss";
  const quietSec = o.quietSec ?? 10;
  const maxRangeMb = o.maxRangeMb ?? 5;
  const settleMax = o.settleMax ?? Number.POSITIVE_INFINITY;
  const settleMin = o.settleMin ?? 0; // no settle before this many seconds (late startup work)
  const slack = 0.5;
  // The settled point is the earliest T, at least quietSec after the start,
  // where the last quietSec form a quiet window AND the whole suffix after T
  // stays at that level. Requiring the suffix to hold is what keeps a flat
  // spike plateau, a process that ramps again after T, or a still-loading
  // process from counting as steady.
  for (let i = 0; i < samples.length; i++) {
    const T = samples[i].t;
    if (T > settleMax) break;
    if (T < settleMin) continue;
    if (T - samples[0].t < quietSec - slack) continue; // window not long enough yet
    if (i > 0 && T - samples[i - 1].t > 1) continue; // sampling gap: do not guess
    let lo = Number.POSITIVE_INFINITY;
    let hi = Number.NEGATIVE_INFINITY;
    for (let j = i; j >= 0; j--) {
      const s = samples[j];
      if (T - s.t > quietSec) break;
      const v = metricValue(s, field);
      if (v < lo) lo = v;
      if (v > hi) hi = v;
    }
    if (!Number.isFinite(lo) || hi - lo >= maxRangeMb) continue;
    let holds = true;
    for (let j = i + 1; j < samples.length; j++) {
      const v = metricValue(samples[j], field);
      if (v > hi + slack || v < lo - slack) {
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
 * @property {number | null} steadyMb median RSS of the settled 10 s window in the measured field; null when not settled
 * @property {number} spikeMb max RSS of the run in the measured field
 * @property {number | null} releasedMb RSS of the last sample in the measured field
 * @property {number} peakT seconds since spawn at which the spike happened
 * @property {number | null} mainSteadyMb median main-pid RSS of the settled window
 * @property {number | null} childrenSteadyMb median descendant RSS of the settled window
 * @property {number} childrenSpikeMb max descendant RSS
 * @property {number | null} anonSteadyMb median RssAnon of the settled window
 * @property {number | null} fileSteadyMb median RssFile of the settled window
 * @property {number | null} shmemSteadyMb median RssShmem of the settled window
 */

/**
 * @param {Sample[]} samples
 * @param {{ settleMax?: number, quietSec?: number, settleMin?: number, field?: MetricField }} [o]
 *   field: which metric steady/spike/released are computed on (default rss)
 * @returns {RunSummary}
 */
export function summarize(samples, o = {}) {
  if (samples.length === 0) throw new Error("no RSS samples collected");
  const field = o.field ?? "rss";
  const last = samples[samples.length - 1];
  const settle = findSettle(samples, {
    quietSec: o.quietSec,
    settleMax: o.settleMax,
    settleMin: o.settleMin,
    field,
  });
  let peak = samples[0];
  for (const s of samples)
    if (metricValue(s, field) > metricValue(peak, field)) peak = s;
  const tail =
    settle.t === null
      ? []
      : samples.filter(
          (s) => s.t >= /** @type {number} */ (settle.t) - settle.quietSec,
        );
  return {
    settled: settle.settled,
    settleT: settle.t,
    steadyMb: tail.length
      ? median(tail.map((s) => metricValue(s, field)))
      : null,
    spikeMb: metricValue(peak, field),
    releasedMb: metricValue(last, field),
    peakT: peak.t,
    mainSteadyMb: tail.length ? median(tail.map((s) => s.main)) : null,
    childrenSteadyMb: tail.length ? median(tail.map((s) => s.kids)) : null,
    childrenSpikeMb: max(samples.map((s) => s.kids)),
    anonSteadyMb: medSampleField(tail, "anon"),
    fileSteadyMb: medSampleField(tail, "file"),
    shmemSteadyMb: medSampleField(tail, "shmem"),
  };
}

/**
 * Median of a nullable per-sample breakdown field over the settled window;
 * null when the window is empty or the field is not reported (non-Linux).
 * @param {Sample[]} tail
 * @param {"anon" | "file" | "shmem"} k
 * @returns {number | null}
 */
function medSampleField(tail, k) {
  const v = /** @type {number[]} */ (
    tail
      .map((s) => s[k])
      .filter((x) => typeof x === "number" && !Number.isNaN(x))
  );
  return v.length ? median(v) : null;
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
 * @param {MetricField} [field] sample field the release is measured on
 * @returns {number | null}
 */
export function releaseSeconds(
  samples,
  vanillaSteadyMb,
  steadyBudgetMb,
  hold = 3,
  field = "rss",
) {
  if (samples.length === 0) return null;
  /** @param {Sample} s */
  const value = (s) => metricValue(s, field);
  let peakIdx = 0;
  for (let i = 0; i < samples.length; i++) {
    if (value(samples[i]) > value(samples[peakIdx])) peakIdx = i;
  }
  const peak = samples[peakIdx];
  if (value(peak) - vanillaSteadyMb <= steadyBudgetMb) return 0;
  let streak = 0;
  for (let i = peakIdx + 1; i < samples.length; i++) {
    if (value(samples[i]) - vanillaSteadyMb <= steadyBudgetMb) {
      streak++;
      if (streak >= hold) return samples[i - streak + 1].t - peak.t;
    } else {
      streak = 0;
    }
  }
  return null;
}
