import assert from "node:assert/strict";
import { test } from "node:test";
import {
  aggregate,
  DEFAULT_BUDGETS,
  evaluate,
  resolveBudgets,
} from "../src/budget.mjs";
import { fakeRun, flat } from "./helpers.mjs";

const opts = { ...resolveBudgets(undefined, undefined), windowSec: 30 };

/** @param {import("../src/budget.mjs").Check[]} checks @param {string} id */
const get = (checks, id) => {
  const c = checks.find((x) => x.id === id);
  assert.ok(c, `check ${id} exists`);
  return c;
};

/** vanilla fresh 150, long 250, long2x 350 */
const vanilla = { fresh: [flat(150)], long: [flat(250)], long2x: [flat(350)] };
/** @param {number} fresh @param {number} long @param {number} long2x */
const mk = (fresh, long, long2x) => ({
  fresh: { vanilla: vanilla.fresh, candidate: [flat(150 + fresh)] },
  long: { vanilla: vanilla.long, candidate: [flat(250 + long)] },
  long2x: { vanilla: vanilla.long2x, candidate: [flat(350 + long2x)] },
});

test("approved default budgets", () => {
  assert.deepEqual(DEFAULT_BUDGETS, {
    steadyFresh: 20,
    steadyLong: 20,
    growth2x: 5,
    spike: 100,
    spikeReleaseSeconds: 30,
    regression: 5,
  });
});

test("an extension within budgets passes everything", () => {
  const r = evaluate(mk(5, 5, 7), opts);
  assert.equal(r.ok, true);
  assert.ok(
    r.checks.every((c) => c.status === "PASS"),
    JSON.stringify(r.checks.map((c) => [c.id, c.status])),
  );
  assert.equal(get(r.checks, "growth2x").value, 2);
  assert.equal(get(r.checks, "steadyFresh").value, 5);
});

test("boundary: exactly at the budget passes, just over fails", () => {
  assert.equal(
    get(evaluate(mk(20, 20, 25), opts).checks, "steadyFresh").status,
    "PASS",
  );
  assert.equal(
    get(evaluate(mk(20, 20, 25), opts).checks, "growth2x").status,
    "PASS",
  );
  const over = evaluate(mk(20.5, 20.5, 26), opts);
  assert.equal(get(over.checks, "steadyFresh").status, "FAIL");
  assert.equal(get(over.checks, "steadyLong").status, "FAIL");
  assert.equal(get(over.checks, "growth2x").status, "FAIL");
  assert.equal(over.ok, false);
});

test("growth2x is delta(long2x) - delta(long); proportional growth fails even when steady passes", () => {
  const r = evaluate(mk(0, 15, 30), opts);
  assert.equal(get(r.checks, "steadyLong").status, "PASS");
  assert.equal(get(r.checks, "growth2x").value, 15);
  assert.equal(get(r.checks, "growth2x").status, "FAIL");
});

test("medians over runs absorb one noisy run", () => {
  const m = {
    fresh: {
      vanilla: [flat(150), flat(151), flat(149)],
      candidate: [flat(160), flat(200), flat(161)],
    },
  };
  const r = evaluate(m, opts);
  assert.equal(get(r.checks, "steadyFresh").value, 11); // median 161 - median 150
  assert.equal(aggregate(m.fresh.candidate).steadyMb, 161);
});

test("spike vs vanilla steady, and release time under the steady budget", () => {
  // vanilla 150. candidate peaks at 400 at t~2 and is back to 160 at t=10
  const run = fakeRun((t) => (t < 2 ? 150 + t * 125 : t < 10 ? 380 : 160));
  const r = evaluate(
    { fresh: { vanilla: [flat(150)], candidate: [run] } },
    opts,
  );
  const spike = get(r.checks, "spike:fresh");
  assert.ok(spike.value !== null && spike.value > 200);
  assert.equal(spike.status, "FAIL");
  const rel = get(r.checks, "release:fresh");
  assert.equal(rel.status, "PASS");
  assert.ok(
    rel.value !== null && rel.value > 6 && rel.value < 9,
    `release ${rel.value}`,
  );
});

test("release: unobservable is INCONCLUSIVE (distinct, non-zero exit), never-released-in-window is FAIL", () => {
  // keeps climbing to the end of the window: peak is the last sample, the 30 s
  // release budget cannot be observed (runner would extend a real run; fake
  // windowEndSec stays at the window)
  const ramp = fakeRun((t) => 150 + t * 5);
  const rel = get(
    evaluate({ fresh: { vanilla: [flat(150)], candidate: [ramp] } }, opts)
      .checks,
    "release:fresh",
  );
  assert.equal(rel.status, "INCONCLUSIVE");
  assert.equal(rel.value, null);

  // observed the whole peak+30s window and never released: FAIL
  // (declining to the end of the window: observable, still over budget)
  const neverReleases = fakeRun((t) => 500 - t * 3, { window: 35 });
  const rel2 = get(
    evaluate(
      { fresh: { vanilla: [flat(150)], candidate: [neverReleases] } },
      { ...opts, windowSec: 40 },
    ).checks,
    "release:fresh",
  );
  assert.equal(rel2.status, "FAIL");
  assert.equal(rel2.value, null);
  assert.match(rel2.note ?? "", /over vanilla at the end of the window/);

  // peak at t=1, released at t=25: 24 s after the peak, under the 30 s limit
  const slow = fakeRun((t) => (t < 1 ? 300 : t < 25 ? 250 : 155), {
    window: 60,
  });
  assert.equal(
    get(
      evaluate(
        { fresh: { vanilla: [flat(150)], candidate: [slow] } },
        { ...opts, windowSec: 60 },
      ).checks,
      "release:fresh",
    ).status,
    "PASS",
  );
  const slower = fakeRun((t) => (t < 1 ? 300 : t < 45 ? 250 : 155), {
    window: 60,
  });
  assert.equal(
    get(
      evaluate(
        { fresh: { vanilla: [flat(150)], candidate: [slower] } },
        { ...opts, windowSec: 60 },
      ).checks,
      "release:fresh",
    ).status,
    "FAIL",
  );
});

test("release: a steady level over budget is judged by the steady check, release uses its own level", () => {
  const stuck = evaluate(
    { fresh: { vanilla: [flat(150)], candidate: [flat(300)] } },
    opts,
  );
  assert.equal(get(stuck.checks, "steadyFresh").status, "FAIL");
  const rel = get(stuck.checks, "release:fresh");
  assert.equal(rel.status, "PASS");
  assert.match(rel.note ?? "", /measured against its own steady level/);
  // a transient that falls back to the (over-budget) own level within the limit passes
  const peaky = fakeRun((t) => (t < 25 ? 400 : 330), { window: 40 });
  assert.equal(
    get(
      evaluate(
        { fresh: { vanilla: [flat(150)], candidate: [peaky] } },
        { ...opts, windowSec: 40 },
      ).checks,
      "release:fresh",
    ).status,
    "PASS",
  );
  // a transient that takes longer than the limit to come back down fails
  const late = fakeRun((t) => (t < 35 ? 400 : 330), { window: 45 });
  const lateRel = get(
    evaluate(
      { fresh: { vanilla: [flat(150)], candidate: [late] } },
      { ...opts, windowSec: 45 },
    ).checks,
    "release:fresh",
  );
  assert.equal(lateRel.status, "FAIL");
  assert.ok(lateRel.value !== null && lateRel.value > 30);
});

test("regression vs baseline extension, per case, only when a baseline ran", () => {
  const without = evaluate(mk(5, 5, 5), opts);
  assert.equal(
    without.checks.some((c) => c.key === "regression"),
    false,
  );
  const m = mk(10, 10, 10);
  const withBase = evaluate(
    {
      fresh: { ...m.fresh, baseline: [flat(150 + 8)] }, // candidate 160 vs baseline 158: +2
      long: { ...m.long, baseline: [flat(250 + 2)] }, // 260 vs 252: +8
    },
    opts,
  );
  assert.equal(get(withBase.checks, "regression:fresh").status, "PASS");
  assert.equal(get(withBase.checks, "regression:fresh").value, 2);
  assert.equal(get(withBase.checks, "regression:long").status, "FAIL");
  assert.equal(get(withBase.checks, "regression:long").value, 8);
});

test("waivers turn a FAIL into WAIVED with the reason and let the run pass", () => {
  const { budgets, waivers } = resolveBudgets(undefined, {
    steadyFresh: "index is needed for search, see #12",
  });
  const r = evaluate(mk(30, 5, 6), { budgets, waivers, windowSec: 30 });
  const c = get(r.checks, "steadyFresh");
  assert.equal(c.status, "WAIVED");
  assert.equal(c.reason, "index is needed for search, see #12");
  assert.match(c.note ?? "", /would FAIL/);
  assert.equal(c.value, 30, "the value is still measured and reported");
  assert.equal(r.ok, true);
  // other failing budgets are not waived by it
  assert.equal(
    evaluate(mk(30, 30, 30), { budgets, waivers, windowSec: 30 }).ok,
    false,
  );
});

test("a waiver on a passing budget reports WAIVED (would PASS), never silent", () => {
  const { budgets, waivers } = resolveBudgets(undefined, {
    growth2x: { reason: "justified" },
  });
  const c = get(
    evaluate(mk(1, 1, 1), { budgets, waivers, windowSec: 30 }).checks,
    "growth2x",
  );
  assert.equal(c.status, "WAIVED");
  assert.match(c.note ?? "", /would PASS/);
});

test("waiver without a reason, unknown budget keys and bad values are refused", () => {
  assert.throws(
    () => resolveBudgets(undefined, { spike: "" }),
    /needs a non-empty reason/,
  );
  assert.throws(
    () => resolveBudgets(undefined, { spike: { reason: "  " } }),
    /needs a non-empty reason/,
  );
  assert.throws(
    () => resolveBudgets(undefined, { nope: "x" }),
    /unknown budget/,
  );
  assert.throws(() => resolveBudgets({ nope: 1 }, undefined), /unknown budget/);
  assert.throws(() => resolveBudgets({ spike: -1 }, undefined), /non-negative/);
  assert.throws(
    () => resolveBudgets({ spike: "5" }, undefined),
    /non-negative number/,
  );
  assert.equal(resolveBudgets({ spike: 50 }, undefined).budgets.spike, 50);
  assert.equal(
    resolveBudgets({ spike: 50 }, undefined).budgets.steadyFresh,
    20,
    "others keep defaults",
  );
});

test("aggregate reports the run-to-run steady spread (min, max, max-min)", () => {
  const a = aggregate([flat(150), flat(163), flat(157)]);
  assert.equal(a.steadyMinMb, 150);
  assert.equal(a.steadyMaxMb, 163);
  assert.equal(a.steadySpreadMb, 13);
  assert.equal(
    aggregate([flat(150)]).steadySpreadMb,
    null,
    "one run: no spread",
  );
  const drifting = aggregate([fakeRun((t) => 150 + t)]);
  assert.equal(drifting.steadySpreadMb, null, "never settled: no spread");
});

test("an INCONCLUSIVE note names file-backed pages when the spread is in RssFile", () => {
  // Total RSS spread 21 MB, but RssAnon is stable and RssFile moves: the
  // machine's page cache, not the process's retention (issue #7).
  const m = {
    long: {
      vanilla: [
        fakeRun(() => 210, { anon: 163, file: 47 }),
        fakeRun(() => 231, { anon: 164, file: 67 }),
      ],
      candidate: [fakeRun(() => 220, { anon: 173, file: 47 })],
    },
  };
  const c = get(evaluate(m, opts).checks, "steadyLong");
  assert.equal(c.status, "INCONCLUSIVE");
  assert.match(c.note ?? "", /outside the JS heap in file-backed pages/);
  assert.match(c.note ?? "", /RssAnon spread 1\.0 MB and RssFile 20\.0 MB/);
});

test("vanilla run-to-run spread over the budget makes the check INCONCLUSIVE", () => {
  // vanilla settles at 150 in one run, 171 in the other: spread 21 > 20.
  // The measured delta (10) would PASS, but the baseline is too noisy to say.
  const m = {
    fresh: {
      vanilla: [flat(150), flat(171)],
      candidate: [flat(160), flat(181)],
    },
  };
  const r = evaluate(m, opts);
  const c = get(r.checks, "steadyFresh");
  assert.equal(c.status, "INCONCLUSIVE");
  assert.equal(c.value, 10, "the measured delta is still reported");
  assert.match(c.note ?? "", /spread across 2 runs is 21\.0 MB/);
  assert.equal(r.ok, false);
  // No breakdown in these synthetic runs: nothing to add about page cache.
  assert.doesNotMatch(c.note ?? "", /file-backed pages/);
  // one settled run only: no spread can be observed, the check stands
  const one = evaluate(
    { fresh: { vanilla: [flat(150)], candidate: [flat(160)] } },
    opts,
  );
  assert.equal(get(one.checks, "steadyFresh").status, "PASS");
  // spread under the budget: the check stands
  const tight = evaluate(
    {
      fresh: {
        vanilla: [flat(150), flat(155)],
        candidate: [flat(160), flat(165)],
      },
    },
    opts,
  );
  assert.equal(get(tight.checks, "steadyFresh").status, "PASS");
});

test("spread inconclusive covers spike, release and growth too, each against its own budget", () => {
  // vanilla fresh spread 120 > spike budget 100: even a passing spike is inconclusive
  const m = {
    fresh: {
      vanilla: [flat(150), flat(270)],
      candidate: [flat(300), flat(300)],
    },
  };
  const checks = evaluate(m, opts).checks;
  assert.equal(get(checks, "spike:fresh").status, "INCONCLUSIVE");
  assert.equal(get(checks, "release:fresh").status, "INCONCLUSIVE");

  // growth: vanilla long spread 8 > growth2x budget 5
  const g = evaluate(
    {
      long: {
        vanilla: [flat(250), flat(258)],
        candidate: [flat(255), flat(263)],
      },
      long2x: {
        vanilla: [flat(350), flat(351)],
        candidate: [flat(356), flat(357)],
      },
    },
    opts,
  ).checks;
  const growth = get(g, "growth2x");
  assert.equal(growth.status, "INCONCLUSIVE");
  assert.match(growth.note ?? "", /vanilla \(long\) steady RSS spread/);
});

test("a never-settled candidate still FAILs even on a noisy vanilla", () => {
  const m = {
    fresh: {
      vanilla: [flat(150), flat(200)],
      candidate: [fakeRun((t) => 200 + t)],
    },
  };
  const c = get(evaluate(m, opts).checks, "steadyFresh");
  assert.equal(c.status, "FAIL");
  assert.match(c.note ?? "", /candidate never settled/);
});

test("a settled candidate on a never-settled vanilla is INCONCLUSIVE, not a silent FAIL", () => {
  const m = {
    fresh: {
      vanilla: [fakeRun((t) => 150 + t)],
      candidate: [flat(160)],
    },
  };
  const c = get(evaluate(m, opts).checks, "steadyFresh");
  assert.equal(c.status, "INCONCLUSIVE");
  assert.match(c.note ?? "", /vanilla never settled/);
});

test("regression is INCONCLUSIVE when the baseline extension itself is too noisy", () => {
  const c = get(
    evaluate(
      {
        fresh: {
          vanilla: [flat(150)],
          candidate: [flat(160)],
          baseline: [flat(152), flat(160)], // spread 8 > regression budget 5
        },
      },
      opts,
    ).checks,
    "regression:fresh",
  );
  assert.equal(c.status, "INCONCLUSIVE");
  assert.match(c.note ?? "", /baseline steady RSS spread/);
});

test("checks read the deduplicated metric; summed RSS stays a reported aggregate", () => {
  // The candidate forks a node child: summed +48 MB, of which 34 are the node
  // binary and libs pi already maps; the deduplicated metric reads +14 MB.
  const van = fakeRun(() => 150, { dedup: 150, metric: "dedup" });
  const cand = fakeRun(() => 198, { dedup: 164, metric: "dedup" });
  const r = evaluate(
    { fresh: { vanilla: [van], candidate: [cand] } },
    { ...opts, metric: "dedup" },
  );
  const c = get(r.checks, "steadyFresh");
  assert.equal(c.status, "PASS");
  assert.equal(c.value, 14, "the check measures the deduplicated delta");
  assert.equal(c.detail.vanilla, 150);
  assert.equal(c.detail.candidate, 164);
  assert.equal(r.aggregates.fresh.candidate.steadyMb, 164);
  assert.equal(
    r.aggregates.fresh.candidate.summedSteadyMb,
    198,
    "summed RSS is still reported",
  );
  assert.equal(r.aggregates.fresh.candidate.summedSpikeMb, 198);
});

test("a spike made of shared file pages passes on dedupe and fails on summed RSS", () => {
  /** @param {"rss" | "dedup"} metric */
  const m = (metric) => ({
    fresh: {
      vanilla: [fakeRun(() => 150, { dedup: 150, metric })],
      candidate: [
        fakeRun((t) => (t < 3 ? 150 + t * 40 : 165), {
          window: 40,
          dedup: (t) => (t < 3 ? 150 + t * 4 : 165),
          metric,
        }),
      ],
    },
  });
  const dedup = evaluate(m("dedup"), { ...opts, metric: "dedup" });
  assert.equal(get(dedup.checks, "steadyFresh").status, "PASS");
  const spike = get(dedup.checks, "spike:fresh");
  assert.equal(spike.status, "PASS");
  assert.ok(spike.value !== null && spike.value < 20, `spike ${spike.value}`);
  // the same samples read as summed RSS: +120 MB transient, FAIL
  const summed = evaluate(m("rss"), opts);
  assert.equal(get(summed.checks, "spike:fresh").status, "FAIL");
  assert.ok(
    (get(summed.checks, "spike:fresh").value ?? 0) > 100,
    "summed RSS charges the shared pages as a spike",
  );
});

test("report-only: no check decides and every check keeps the verdict it would have had", () => {
  const { budgets, waivers } = resolveBudgets(undefined, {
    steadyFresh: "big index, tracked in #42",
  });
  const r = evaluate(
    { fresh: { vanilla: [flat(150)], candidate: [flat(300)] } },
    { budgets, waivers, windowSec: 30, reportOnly: true },
  );
  assert.equal(r.reportOnly, true);
  assert.equal(r.ok, true, "a platform without the metric decides nothing");
  assert.equal(
    r.checks.some((c) => c.status === "FAIL"),
    false,
  );
  const c = get(r.checks, "steadyFresh");
  assert.equal(c.status, "REPORT-ONLY");
  assert.equal(c.wouldBe, "FAIL");
  assert.equal(c.value, 150, "the measured value is still reported");
  assert.equal(
    c.reason,
    "big index, tracked in #42",
    "the waiver stays visible",
  );

  // an INCONCLUSIVE check is report-only too: there is no verdict to be
  // unsure about, and macOS must not exit 3 on every noisy run
  const noisy = evaluate(
    {
      fresh: {
        vanilla: [flat(150), flat(171)],
        candidate: [flat(160), flat(181)],
      },
    },
    { ...opts, reportOnly: true },
  );
  assert.equal(get(noisy.checks, "steadyFresh").status, "REPORT-ONLY");
  assert.equal(get(noisy.checks, "steadyFresh").wouldBe, "INCONCLUSIVE");
  assert.equal(noisy.ok, true);
});

test("growth is reported as SKIP (not silently absent) when only one long case ran", () => {
  const m = mk(5, 5, 5);
  const r = evaluate({ fresh: m.fresh, long: m.long }, opts);
  const g = get(r.checks, "growth2x");
  assert.equal(g.status, "SKIP");
  assert.equal(r.ok, true);
  assert.equal(
    evaluate({ fresh: m.fresh }, opts).checks.some((c) => c.id === "growth2x"),
    false,
  );
});
