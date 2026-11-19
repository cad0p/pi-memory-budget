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

/** RSS noise allowance when judging a spike against the candidate's own steady level. */
const RELEASE_NOISE_MB = 5;

export const BUDGET_KEYS = Object.keys(DEFAULT_BUDGETS);
export const CASE_ORDER = ["fresh", "long", "long2x"];

/**
 * @typedef {typeof DEFAULT_BUDGETS} Budgets
 * @typedef {"PASS" | "FAIL" | "WAIVED" | "SKIP"} Status
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
 * @property {number} steadyMb
 * @property {number} spikeMb
 * @property {number} releasedMb
 * @property {number} childrenSteadyMb
 * @property {number} maxGapMs median of the per-run max ping gap
 * @property {number} worstGapMs worst ping gap over all runs
 */

/**
 * @param {RunResult[]} runs
 * @returns {Agg}
 */
export function aggregate(runs) {
  return {
    runs: runs.length,
    steadyMb: median(runs.map((r) => r.steadyMb)),
    spikeMb: median(runs.map((r) => r.spikeMb)),
    releasedMb: median(runs.map((r) => r.releasedMb)),
    childrenSteadyMb: median(runs.map((r) => r.childrenSteadyMb)),
    maxGapMs: median(runs.map((r) => r.maxGapMs)),
    worstGapMs: max(runs.map((r) => r.maxGapMs)),
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
 * @param {number} steadyBudget
 * @param {number} peakT
 * @param {number} windowSec
 * @param {number} limitSec
 */
function releaseNote(
  runs,
  vanillaSteadyMb,
  steadyBudget,
  peakT,
  windowSec,
  limitSec,
) {
  const endDelta = median(runs.map((r) => r.releasedMb)) - vanillaSteadyMb;
  const left = windowSec - peakT;
  let note = `still ${endDelta.toFixed(1)} MB over vanilla at the end of the window (allowed +${steadyBudget.toFixed(1)} MB)`;
  if (left < limitSec)
    note += `; only ${left.toFixed(0)}s of window after the peak, raise --window to tell a slow release from a leak`;
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

  /** @param {Omit<Check, "status" | "reason">} c @param {boolean | null} pass */
  const push = (c, pass) => {
    /** @type {Status} */
    let status = pass === null ? "SKIP" : pass ? "PASS" : "FAIL";
    /** @type {Check} */
    const check = { ...c, status };
    if (waivers[c.key] && status !== "SKIP") {
      check.reason = waivers[c.key];
      check.note = `${c.note ? `${c.note}; ` : ""}would ${status}`;
      status = "WAIVED";
      check.status = status;
    }
    checks.push(check);
  };

  const cases = CASE_ORDER.filter((c) => m[c]);
  for (const c of cases) {
    const agg = aggregates[c];
    const van = agg.vanilla;
    const cand = agg.candidate;
    if (!van || !cand) continue;
    const steadyKey = c === "fresh" ? "steadyFresh" : "steadyLong";

    if (c === "fresh" || c === "long") {
      const d = cand.steadyMb - van.steadyMb;
      push(
        {
          id: steadyKey,
          key: steadyKey,
          case: c,
          label: `steady added RSS, ${c}`,
          value: d,
          limit: budgets[steadyKey],
          unit: "MB",
          detail: { vanilla: van.steadyMb, candidate: cand.steadyMb },
        },
        d <= budgets[steadyKey],
      );
    }

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

    // The spike must fall back under the steady budget. When the candidate's own
    // steady level is already over that budget (reported by the steady check),
    // a transient is judged against where it settles (+ RSS noise) instead, so
    // one steady-state problem is not reported twice and a justified steady
    // level (waiver) does not make the release check unsatisfiable.
    const steadyDelta = cand.steadyMb - van.steadyMb;
    const settles = steadyDelta + RELEASE_NOISE_MB > budgets[steadyKey];
    const threshold = settles
      ? steadyDelta + RELEASE_NOISE_MB
      : budgets[steadyKey];
    const runs = median(
      (m[c].candidate ?? []).map(
        (r) =>
          releaseSeconds(r.samples, van.steadyMb, threshold) ??
          Number.POSITIVE_INFINITY,
      ),
    );
    const never = !Number.isFinite(runs);
    const peakT = median((m[c].candidate ?? []).map((r) => r.peakT));
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
              m[c].candidate,
              van.steadyMb,
              threshold,
              peakT,
              opts.windowSec,
              budgets.spikeReleaseSeconds,
            )
          : settles
            ? `steady is over the budget: measured against its own steady level (+${threshold.toFixed(1)} MB)`
            : undefined,
        detail: { peakT, thresholdMb: threshold },
      },
      !never && runs <= budgets.spikeReleaseSeconds,
    );

    if (agg.baseline) {
      const d = cand.steadyMb - agg.baseline.steadyMb;
      push(
        {
          id: `regression:${c}`,
          key: "regression",
          case: c,
          label: `regression vs baseline extension, ${c}`,
          value: d,
          limit: budgets.regression,
          unit: "MB",
          detail: { baseline: agg.baseline.steadyMb, candidate: cand.steadyMb },
        },
        d <= budgets.regression,
      );
    }
  }

  const a1 = aggregates.long;
  const a2 = aggregates.long2x;
  if (a1?.vanilla && a1.candidate && a2?.vanilla && a2.candidate) {
    const d1 = a1.candidate.steadyMb - a1.vanilla.steadyMb;
    const d2 = a2.candidate.steadyMb - a2.vanilla.steadyMb;
    push(
      {
        id: "growth2x",
        key: "growth2x",
        case: "long2x",
        label: "growth with session size (delta long2x minus delta long)",
        value: d2 - d1,
        limit: budgets.growth2x,
        unit: "MB",
        detail: { deltaLong: d1, deltaLong2x: d2 },
      },
      d2 - d1 <= budgets.growth2x,
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

  const ok = checks.every((c) => c.status !== "FAIL");
  return { aggregates, checks, ok };
}
