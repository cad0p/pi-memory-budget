// Aggregation of runs and budget evaluation (pure, no I/O).

import { max, median, releaseSeconds } from "./stats.mjs";

/** Approved defaults (owner, 2026-11-19). MB, except spikeReleaseSeconds. */
export const DEFAULT_BUDGETS = Object.freeze({
  steadyFresh: 20,
  steadyLong: 20,
  growth2x: 5,
  spike: 100,
  spikeReleaseSeconds: 30,
  regression: 5,
});

export const BUDGET_KEYS = Object.keys(DEFAULT_BUDGETS);
export const CASE_ORDER = ["fresh", "long", "long2x"];

/** RSS noise allowance when judging a spike against the candidate's own steady level. */
const RELEASE_NOISE_MB = 5;

/** Samples at the threshold required for "released" (a single dip is not a release). */
const RELEASE_HOLD = 3;

/**
 * @typedef {typeof DEFAULT_BUDGETS} Budgets
 * @typedef {"PASS" | "FAIL" | "WAIVED" | "SKIP" | "INCONCLUSIVE"} Status
 * @typedef {import("./runner.mjs").RunResult} RunResult
 */

/**
 * Validates the budgets and waivers of a config file / CLI.
 * @param {Record<string, unknown> | undefined} budgets
 * @param {Record<string, unknown> | undefined} waivers
 * @returns {{ budgets: Budgets, waivers: Record<string, string> }}
 */
export function resolveBudgets(budgets, waivers) {
  const out = { ...DEFAULT_BUDGETS };
  for (const [k, v] of Object.entries(budgets ?? {})) {
    if (!BUDGET_KEYS.includes(k))
      throw new Error(
        `unknown budget "${k}" (known: ${BUDGET_KEYS.join(", ")})`,
      );
    if (typeof v !== "number" || !Number.isFinite(v) || v < 0)
      throw new Error(`budget "${k}" must be a non-negative number`);
    /** @type {Record<string, number>} */ (out)[k] = v;
  }
  /** @type {Record<string, string>} */
  const w = {};
  for (const [k, v] of Object.entries(waivers ?? {})) {
    if (!BUDGET_KEYS.includes(k))
      throw new Error(
        `cannot waive unknown budget "${k}" (known: ${BUDGET_KEYS.join(", ")})`,
      );
    const reason =
      typeof v === "string"
        ? v
        : v && typeof v === "object"
          ? /** @type {{reason?: unknown}} */ (v).reason
          : undefined;
    if (typeof reason !== "string" || reason.trim() === "") {
      throw new Error(
        `waiver for "${k}" needs a non-empty reason (there is no silent skip)`,
      );
    }
    w[k] = reason.trim();
  }
  return { budgets: /** @type {Budgets} */ (out), waivers: w };
}

/**
 * @typedef {object} Agg median over the runs of one configuration
 * @property {number} runs
 * @property {number | null} steadyMb median of per-run steady total RSS (null when no run settled)
 * @property {number | null} steadyMinMb lowest per-run steady (null when no run settled)
 * @property {number | null} steadyMaxMb highest per-run steady
 * @property {number | null} steadySpreadMb max-min of per-run steady; null with fewer than 2 settled runs
 * @property {number} spikeMb
 * @property {number | null} releasedMb
 * @property {number | null} mainSteadyMb
 * @property {number | null} childrenSteadyMb
 * @property {number | null} settleT median of per-run settle time (null when a run never settled)
 * @property {boolean} settled whether every run settled
 * @property {number} maxGapMs median of the per-run max ping gap
 * @property {number} worstGapMs worst ping gap over all runs
 * @property {number | null} anonSteadyMb median of per-run steady RssAnon (Linux only)
 * @property {number | null} anonSteadySpreadMb max-min of per-run steady RssAnon
 * @property {number | null} fileSteadyMb median of per-run steady RssFile
 * @property {number | null} fileSteadySpreadMb max-min of per-run steady RssFile
 * @property {number | null} shmemSteadyMb median of per-run steady RssShmem
 * @property {number | null} shmemSteadySpreadMb max-min of per-run steady RssShmem
 * @property {{ heapUsedMb: number, heapTotalMb: number | null, externalMb: number, arrayBuffersMb: number } | null} gcDiag median post-GC heap numbers (diagnostic)
 */

/** @param {RunResult[]} runs */
function aggDiag(runs) {
  const d = runs.map((r) => r.gcDiag).filter((x) => x);
  if (!d.length) return null;
  /** @param {"heapUsedMb"|"heapTotalMb"|"externalMb"|"arrayBuffersMb"} k */
  const m = (k) => {
    const v = d
      .map((x) => /** @type {NonNullable<typeof x>} */ (x)[k])
      .filter((x) => x !== null);
    return v.length ? median(v) : null;
  };
  return {
    heapUsedMb: /** @type {number} */ (m("heapUsedMb")),
    heapTotalMb: m("heapTotalMb"),
    externalMb: /** @type {number} */ (m("externalMb")),
    arrayBuffersMb: /** @type {number} */ (m("arrayBuffersMb")),
  };
}

/**
 * Per-run values of a nullable summary field, for a median or a spread.
 * @param {RunResult[]} runs
 * @param {"anonSteadyMb"|"fileSteadyMb"|"shmemSteadyMb"} k
 * @returns {number[]}
 */
function fieldValues(runs, k) {
  return /** @type {number[]} */ (
    runs.map((r) => r[k]).filter((x) => x !== null && !Number.isNaN(x))
  );
}

/**
 * Median and max-min spread of a per-run breakdown field; both null when the
 * platform does not report it, spread null with fewer than 2 values.
 * @param {RunResult[]} runs
 * @param {"anonSteadyMb"|"fileSteadyMb"|"shmemSteadyMb"} k
 * @returns {{ med: number | null, spread: number | null }}
 */
function fieldStats(runs, k) {
  const v = fieldValues(runs, k);
  return {
    med: v.length ? median(v) : null,
    spread: v.length >= 2 ? Math.max(...v) - Math.min(...v) : null,
  };
}

/**
 * @param {RunResult[]} runs
 * @returns {Agg}
 */
export function aggregate(runs) {
  const settled = runs.every((r) => r.settled);
  /** @param {(number | null)[]} v */
  const med = (v) => {
    const ok = /** @type {number[]} */ (
      v.filter((x) => x !== null && !Number.isNaN(x))
    );
    return ok.length ? median(ok) : null;
  };
  const steady = /** @type {number[]} */ (
    runs.map((r) => r.steadyMb).filter((x) => x !== null && !Number.isNaN(x))
  );
  const steadyMinMb = steady.length ? Math.min(...steady) : null;
  const steadyMaxMb = steady.length ? Math.max(...steady) : null;
  return {
    runs: runs.length,
    settled,
    steadyMinMb,
    steadyMaxMb,
    steadySpreadMb:
      steady.length >= 2 ? Math.max(...steady) - Math.min(...steady) : null,
    settleT: settled
      ? median(runs.map((r) => /** @type {number} */ (r.settleT)))
      : null,
    steadyMb: med(runs.map((r) => r.steadyMb)),
    spikeMb: median(runs.map((r) => r.spikeMb)),
    releasedMb: med(runs.map((r) => r.releasedMb)),
    mainSteadyMb: med(runs.map((r) => r.mainSteadyMb)),
    childrenSteadyMb: med(runs.map((r) => r.childrenSteadyMb)),
    maxGapMs: median(runs.map((r) => r.maxGapMs)),
    worstGapMs: max(runs.map((r) => r.maxGapMs)),
    anonSteadyMb: fieldStats(runs, "anonSteadyMb").med,
    anonSteadySpreadMb: fieldStats(runs, "anonSteadyMb").spread,
    fileSteadyMb: fieldStats(runs, "fileSteadyMb").med,
    fileSteadySpreadMb: fieldStats(runs, "fileSteadyMb").spread,
    shmemSteadyMb: fieldStats(runs, "shmemSteadyMb").med,
    shmemSteadySpreadMb: fieldStats(runs, "shmemSteadyMb").spread,
    gcDiag: aggDiag(runs),
  };
}

/**
 * @typedef {object} Check
 * @property {string} id unique id, e.g. "steadyLong" or "spike:fresh"
 * @property {string} key budget key
 * @property {string} case
 * @property {string} label
 * @property {number | null} value measured value (delta MB, or seconds), null when not available
 * @property {number} limit
 * @property {"MB" | "s"} unit
 * @property {Status} status
 * @property {string} [reason] waiver reason
 * @property {string} [note]
 * @property {Record<string, number | null>} detail raw numbers behind the value
 */

/**
 * @typedef {Record<string, Record<string, RunResult[]>>} Measurements
 *   case -> configuration ("vanilla" | "candidate" | "baseline") -> runs
 */

/**
 * Explains a release that never happened.
 * @param {RunResult[]} runs
 * @param {number} vanillaSteadyMb
 * @param {number} threshold
 * @param {number} peakT
 * @param {number} limitSec
 */
function releaseNote(runs, vanillaSteadyMb, threshold, peakT, limitSec) {
  const endDelta =
    median(
      runs
        .map((r) => r.releasedMb ?? Number.NaN)
        .filter((x) => !Number.isNaN(x)),
    ) - vanillaSteadyMb;
  let note = `still ${endDelta.toFixed(1)} MB over vanilla at the end of the window (allowed +${threshold.toFixed(1)} MB)`;
  if (runs.some((r) => r.exitT !== null)) {
    const t = median(runs.map((r) => r.exitT ?? 0));
    note += `; pi exited ${(peakT + limitSec - t).toFixed(0)}s before the release could be observed (peak at ${peakT.toFixed(0)}s)`;
  }
  return note;
}

/**
 * @param {Measurements} m
 * @param {{ budgets: Budgets, waivers: Record<string, string>, windowSec: number }} opts
 * @returns {{ aggregates: Record<string, Record<string, Agg>>, checks: Check[], ok: boolean }}
 */
export function evaluate(m, opts) {
  const { budgets, waivers } = opts;
  /** @type {Record<string, Record<string, Agg>>} */
  const aggregates = {};
  for (const [c, configs] of Object.entries(m)) {
    aggregates[c] = {};
    for (const [name, runs] of Object.entries(configs))
      aggregates[c][name] = aggregate(runs);
  }
  /** @type {Check[]} */
  const checks = [];

  /** @param {Omit<Check, "status" | "reason">} c @param {boolean | null | "inconclusive"} pass */
  const push = (c, pass) => {
    /** @type {Status} */
    const status =
      pass === null
        ? "SKIP"
        : pass === "inconclusive"
          ? "INCONCLUSIVE"
          : pass
            ? "PASS"
            : "FAIL";
    /** @type {Check} */
    const check = { ...c, status };
    if (waivers[c.key] && status !== "SKIP" && status !== "INCONCLUSIVE") {
      check.reason = waivers[c.key];
      check.note = `${c.note ? `${c.note}; ` : ""}would ${status}`;
      check.status = "WAIVED";
    }
    checks.push(check);
  };

  /**
   * When the reference configuration's own run-to-run steady spread exceeds
   * the check's limit, the baseline is noisier than what the check can
   * distinguish: the verdict is INCONCLUSIVE, never PASS nor FAIL.
   * @param {Agg} ref
   * @param {number} limitMb
   * @param {string} name
   * @returns {string | null}
   */
  const spreadNote = (ref, limitMb, name) => {
    const s = ref.steadySpreadMb;
    if (s === null || s <= limitMb) return null;
    let note = `${name} steady RSS spread across ${ref.runs} runs is ${s.toFixed(1)} MB (max-min), over the ${limitMb} MB budget of this check: too noisy for a verdict; rerun on a quieter machine or with more runs`;
    // Issue #7: the residual total-RSS spread on long sessions is usually
    // file-backed pages (page cache of the session file plus shared
    // libraries) moving with host I/O pressure, not retention. Say so, and
    // point at the column that is comparable run to run.
    const anon = ref.anonSteadySpreadMb;
    if (anon !== null && anon <= limitMb) {
      const file =
        ref.fileSteadySpreadMb === null
          ? ""
          : ` and RssFile ${ref.fileSteadySpreadMb.toFixed(1)} MB`;
      note += `; it sits outside the JS heap in file-backed pages (RssAnon spread ${anon.toFixed(1)} MB${file}), so this machine's page cache is moving, not the measured process's retention`;
    }
    return note;
  };

  const cases = CASE_ORDER.filter((c) => m[c]);
  for (const c of cases) {
    const agg = aggregates[c];
    const van = agg.vanilla;
    const cand = agg.candidate;
    if (!van || !cand) continue;
    const steadyKey = c === "fresh" ? "steadyFresh" : "steadyLong";

    const d =
      cand.steadyMb === null || van.steadyMb === null
        ? null
        : cand.steadyMb - van.steadyMb;
    if (c === "fresh" || c === "long") {
      // A run that never settles is not a passing number: FAIL with the reason.
      // A settled candidate needs a settled, quiet vanilla to be judged: no
      // baseline or a baseline noisier than the budget is INCONCLUSIVE.
      const noise = spreadNote(van, budgets[steadyKey], "vanilla");
      const note = !cand.settled
        ? "candidate never settled (no 10 s window with total-RSS range < 5 MB within the settle cap)"
        : !van.settled
          ? "vanilla never settled: no steady baseline"
          : (noise ?? undefined);
      push(
        {
          id: steadyKey,
          key: steadyKey,
          case: c,
          label: `steady added RSS, ${c}`,
          value: d,
          limit: budgets[steadyKey],
          unit: "MB",
          note,
          detail: {
            vanilla: van.steadyMb,
            candidate: cand.steadyMb,
            vanillaSpread: van.steadySpreadMb,
          },
        },
        !cand.settled
          ? false
          : !van.settled || noise !== null
            ? "inconclusive"
            : d !== null && d <= budgets[steadyKey],
      );
    }

    if (van.steadyMb === null) {
      push(
        {
          id: `spike:${c}`,
          key: "spike",
          case: c,
          label: `transient spike over vanilla steady, ${c}`,
          value: null,
          limit: budgets.spike,
          unit: "MB",
          note: "vanilla never settled: no reference",
          detail: {},
        },
        "inconclusive",
      );
    } else if (spreadNote(van, budgets.spike, "vanilla")) {
      push(
        {
          id: `spike:${c}`,
          key: "spike",
          case: c,
          label: `transient spike over vanilla steady, ${c}`,
          value: cand.spikeMb - van.steadyMb,
          limit: budgets.spike,
          unit: "MB",
          note: /** @type {string} */ (
            spreadNote(van, budgets.spike, "vanilla")
          ),
          detail: {
            vanilla: van.steadyMb,
            candidate: cand.spikeMb,
            vanillaSpread: van.steadySpreadMb,
          },
        },
        "inconclusive",
      );
    } else {
      const spike = cand.spikeMb - van.steadyMb;
      push(
        {
          id: `spike:${c}`,
          key: "spike",
          case: c,
          label: `transient spike over vanilla steady, ${c}`,
          value: spike,
          limit: budgets.spike,
          unit: "MB",
          detail: { vanilla: van.steadyMb, candidate: cand.spikeMb },
        },
        spike <= budgets.spike,
      );
    }

    if (van.steadyMb === null) {
      push(
        {
          id: `release:${c}`,
          key: "spikeReleaseSeconds",
          case: c,
          label: `back under the ${steadyKey} budget after the spike, ${c}`,
          value: null,
          limit: budgets.spikeReleaseSeconds,
          unit: "s",
          note: "vanilla never settled: no reference",
          detail: {},
        },
        "inconclusive",
      );
    } else {
      // The spike must fall back under the steady budget. When the candidate's
      // own settled level is already over that budget (the steady check
      // reports it), a transient is judged against where it settles (+ RSS
      // noise) instead: one steady problem is not reported twice, and a
      // justified steady level does not make the check unsatisfiable.
      const steadyDelta =
        cand.steadyMb === null
          ? Number.POSITIVE_INFINITY
          : cand.steadyMb - van.steadyMb;
      const settles = steadyDelta + RELEASE_NOISE_MB > budgets[steadyKey];
      const threshold =
        settles && Number.isFinite(steadyDelta)
          ? steadyDelta + RELEASE_NOISE_MB
          : budgets[steadyKey];
      const noise = spreadNote(van, threshold, "vanilla");
      const perRun = (m[c].candidate ?? []).map((r) =>
        releaseSeconds(r.samples, van.steadyMb ?? 0, threshold, RELEASE_HOLD),
      );
      const runs = median(perRun.map((x) => x ?? Number.POSITIVE_INFINITY));
      const never = !Number.isFinite(runs);
      const peakT = median((m[c].candidate ?? []).map((r) => r.peakT));
      // The runner extends the window so a release is observable; when the
      // samples still end before peak + limit (process died, cap hit), the
      // outcome is INCONCLUSIVE, never a plain FAIL.
      const observable = (m[c].candidate ?? []).every(
        (r) => r.windowEndSec >= r.peakT + budgets.spikeReleaseSeconds,
      );
      if (noise !== null) {
        push(
          {
            id: `release:${c}`,
            key: "spikeReleaseSeconds",
            case: c,
            label: `back under the ${steadyKey} budget after the spike, ${c}`,
            value: never ? null : runs,
            limit: budgets.spikeReleaseSeconds,
            unit: "s",
            note: noise,
            detail: {
              peakT,
              thresholdMb: threshold,
              vanillaSpread: van.steadySpreadMb,
            },
          },
          "inconclusive",
        );
      } else if (never && !observable) {
        push(
          {
            id: `release:${c}`,
            key: "spikeReleaseSeconds",
            case: c,
            label: `back under the ${steadyKey} budget after the spike, ${c}`,
            value: null,
            limit: budgets.spikeReleaseSeconds,
            unit: "s",
            note: releaseNote(
              m[c].candidate ?? [],
              van.steadyMb,
              threshold,
              peakT,
              budgets.spikeReleaseSeconds,
            ),
            detail: { peakT, thresholdMb: threshold },
          },
          "inconclusive",
        );
      } else {
        push(
          {
            id: `release:${c}`,
            key: "spikeReleaseSeconds",
            case: c,
            label: `back under the ${steadyKey} budget after the spike, ${c}`,
            value: never ? null : runs,
            limit: budgets.spikeReleaseSeconds,
            unit: "s",
            note: never
              ? releaseNote(
                  m[c].candidate ?? [],
                  van.steadyMb,
                  threshold,
                  peakT,
                  budgets.spikeReleaseSeconds,
                )
              : settles && Number.isFinite(steadyDelta)
                ? `steady is over the budget: measured against its own steady level (+${threshold.toFixed(1)} MB)`
                : undefined,
            detail: { peakT, thresholdMb: threshold },
          },
          !never && runs <= budgets.spikeReleaseSeconds,
        );
      }
    }

    if (agg.baseline) {
      const d =
        cand.steadyMb === null || agg.baseline.steadyMb === null
          ? null
          : cand.steadyMb - agg.baseline.steadyMb;
      const noise = spreadNote(agg.baseline, budgets.regression, "baseline");
      push(
        {
          id: `regression:${c}`,
          key: "regression",
          case: c,
          label: `regression vs baseline extension, ${c}`,
          value: d,
          limit: budgets.regression,
          unit: "MB",
          note: !cand.settled
            ? "candidate never settled"
            : !agg.baseline.settled
              ? "baseline never settled: no reference"
              : (noise ?? undefined),
          detail: {
            baseline: agg.baseline.steadyMb,
            candidate: cand.steadyMb,
            baselineSpread: agg.baseline.steadySpreadMb,
          },
        },
        !cand.settled
          ? false
          : !agg.baseline.settled || noise !== null
            ? "inconclusive"
            : d !== null && d <= budgets.regression,
      );
    }
  }

  const a1 = aggregates.long;
  const a2 = aggregates.long2x;
  if (a1?.vanilla && a1.candidate && a2?.vanilla && a2.candidate) {
    const settled = a1.candidate.settled && a2.candidate.settled;
    const d1 =
      a1.candidate.steadyMb !== null && a1.vanilla.steadyMb !== null
        ? a1.candidate.steadyMb - a1.vanilla.steadyMb
        : null;
    const d2 =
      a2.candidate.steadyMb !== null && a2.vanilla.steadyMb !== null
        ? a2.candidate.steadyMb - a2.vanilla.steadyMb
        : null;
    const vanSettled = a1.vanilla.settled && a2.vanilla.settled;
    const noise =
      spreadNote(a1.vanilla, budgets.growth2x, "vanilla (long)") ??
      spreadNote(a2.vanilla, budgets.growth2x, "vanilla (long2x)");
    push(
      {
        id: "growth2x",
        key: "growth2x",
        case: "long2x",
        label: "growth with session size (delta long2x minus delta long)",
        value: d1 !== null && d2 !== null ? d2 - d1 : null,
        limit: budgets.growth2x,
        unit: "MB",
        note: !settled
          ? "candidate never settled on a long case"
          : !vanSettled
            ? "vanilla never settled on a long case: no baseline"
            : (noise ?? undefined),
        detail: {
          deltaLong: d1,
          deltaLong2x: d2,
          vanillaSpreadLong: a1.vanilla.steadySpreadMb,
          vanillaSpreadLong2x: a2.vanilla.steadySpreadMb,
        },
      },
      !settled
        ? false
        : !vanSettled || noise !== null
          ? "inconclusive"
          : d1 !== null && d2 !== null && d2 - d1 <= budgets.growth2x,
    );
  } else if (m.long || m.long2x) {
    push(
      {
        id: "growth2x",
        key: "growth2x",
        case: "long2x",
        label: "growth with session size (delta long2x minus delta long)",
        value: null,
        limit: budgets.growth2x,
        unit: "MB",
        note: "needs both cases long and long2x",
        detail: {},
      },
      null,
    );
  }

  const ok = checks.every(
    (c) => c.status === "PASS" || c.status === "WAIVED" || c.status === "SKIP",
  );
  return { aggregates, checks, ok };
}
