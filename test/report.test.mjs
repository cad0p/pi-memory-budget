import assert from "node:assert/strict";
import { test } from "node:test";
import { evaluate, resolveBudgets } from "../src/budget.mjs";
import { renderJson, renderMarkdown } from "../src/report.mjs";
import { fakeRun, flat } from "./helpers.mjs";

const meta = {
  piVersion: "1.5.2",
  platform: "linux-x64",
  metric: "dedup",
  reportOnly: false,
  runs: 1,
  windowSec: 30,
  steadySec: 10,
  settleMaxSec: 120,
};

/** @param {Record<string, string> | undefined} waivers */
function build(waivers) {
  const { budgets, waivers: w } = resolveBudgets(undefined, waivers);
  const measurements = {
    fresh: {
      vanilla: [flat(150)],
      candidate: [flat(190)],
      baseline: [flat(185)],
    },
    long: { vanilla: [flat(250)], candidate: [flat(255)] },
    long2x: { vanilla: [flat(350)], candidate: [flat(356)] },
  };
  const result = evaluate(measurements, { budgets, waivers: w, windowSec: 30 });
  return { input: { result, budgets, waivers: w, meta }, measurements };
}

test("markdown has a table per case with vanilla, candidate, delta, budget and a verdict", () => {
  const md = renderMarkdown(build(undefined).input);
  assert.match(md, /^## Memory budget: FAIL/);
  for (const c of ["fresh", "long", "long2x"])
    assert.match(md, new RegExp(`### Case: ${c}\\n`));
  assert.match(
    md,
    /\| Check \| Vanilla \| Candidate \| Delta \| Budget \| Result \|/,
  );
  assert.match(
    md,
    /\| steady added RSS, fresh \| 150\.0 \| 190\.0 \| \+40\.0 \| <= \+20 MB \| FAIL \|/,
  );
  assert.match(
    md,
    /\| steady added RSS, long \| 250\.0 \| 255\.0 \| \+5\.0 \| <= \+20 MB \| PASS \|/,
  );
  assert.match(
    md,
    /regression vs baseline extension, fresh \| baseline 185\.0 \| 190\.0 \| \+5\.0 \| <= \+5 MB \| PASS/,
  );
  assert.match(md, /### Growth with session size/);
  assert.match(md, /\| \+5\.0 \| \+6\.0 \| \+1\.0 \| <= \+5 MB \| PASS \|/);
  assert.match(md, /\| candidate \| [\d.]+ s \| 190\.0 \| 190\.0 \|/);
});

test("markdown shows WAIVED with the reason and a PASS header when only waivers cover the failures", () => {
  const md = renderMarkdown(build({ steadyFresh: "needs the index" }).input);
  assert.match(md, /^## Memory budget: PASS/);
  assert.match(md, /WAIVED \(would FAIL\): needs the index/);
  assert.match(
    md,
    /Waived budgets \(justified in the config, not skipped\):\n\n- steadyFresh: needs the index/,
  );
});

test("json carries the verdict, budgets, waivers, checks, aggregates and raw samples", () => {
  const { input, measurements } = build({ steadyFresh: "r" });
  const j = renderJson({ ...input, measurements });
  assert.equal(j.schema, "pi-memory-budget/1");
  assert.equal(j.ok, true);
  assert.deepEqual(j.waivers, { steadyFresh: "r" });
  assert.equal(j.budgets.spike, 100);
  assert.ok(
    j.checks.some((c) => c.id === "steadyFresh" && c.status === "WAIVED"),
  );
  assert.equal(j.aggregates.fresh.candidate.steadyMb, 190);
  const runs = /** @type {{ samples: number[][] }[]} */ (
    j.runs.fresh.candidate
  );
  const run = runs[0];
  assert.deepEqual(run.samples[0], [0, 190, 0, null, null, null, null]);
  JSON.stringify(j); // serializable (no NaN-only structures that would throw)
});

test("markdown says which metric the checks used, and shows summed RSS next to it", () => {
  const md = renderMarkdown(build(undefined).input);
  assert.match(md, /Checks use DEDUPLICATED RSS \(Linux\)/);
  assert.match(md, /shared file-backed pages|counted once/);
  assert.match(
    md,
    /\| Configuration \| settle at \| steady \| steady summed \| steady spread \| spike \| spike summed \|/,
  );
});

test("markdown: a report-only platform says so, keeps the would-be verdicts and never claims PASS", () => {
  const { budgets, waivers } = resolveBudgets(undefined, {
    steadyFresh: "big index, tracked in #42",
  });
  const measurements = {
    fresh: { vanilla: [flat(150)], candidate: [flat(300)] },
  };
  const result = evaluate(measurements, {
    budgets,
    waivers,
    windowSec: 30,
    reportOnly: true,
  });
  const md = renderMarkdown({
    result,
    budgets,
    waivers,
    meta: {
      ...meta,
      platform: "darwin-arm64, node v22.19.0, 10 cpus",
      metric: "rss",
      reportOnly: true,
    },
  });
  assert.match(md, /^## Memory budget: REPORT-ONLY/);
  assert.doesNotMatch(md, /## Memory budget: (PASS|FAIL)/);
  assert.match(md, /Checks are REPORT-ONLY on this platform \(darwin-arm64/);
  assert.match(md, /no \/proc\/<pid>\/smaps/);
  assert.match(md, /pass\/fail comes from the Linux run/i);
  assert.match(
    md,
    /REPORT-ONLY \(would FAIL\) \(waived: big index, tracked in #42\)/,
  );
  // the waived budget is still listed with its reason
  assert.match(
    md,
    /Waived budgets[\s\S]*- steadyFresh: big index, tracked in #42/,
  );
});

test("markdown reports the per-run RSS breakdown and spread columns", () => {
  const { budgets, waivers } = resolveBudgets(undefined, undefined);
  const measurements = {
    long: {
      vanilla: [
        fakeRun(() => 250, { anon: 240, file: 9, shmem: 1 }),
        fakeRun(() => 260, { anon: 258, file: 1.5, shmem: 0.5 }),
      ],
      candidate: [fakeRun(() => 255, { anon: 250, file: 5 })],
    },
  };
  const result = evaluate(measurements, { budgets, waivers, windowSec: 30 });
  const md = renderMarkdown({
    result,
    budgets,
    waivers,
    meta: {
      piVersion: "1.5.2",
      platform: "linux-x64",
      runs: 2,
      windowSec: 30,
      steadySec: 10,
    },
  });
  assert.match(md, /steady RssAnon\/RssFile\/RssShmem \(Linux\)/);
  assert.match(md, /anon\/file\/shmem spread/);
  assert.match(md, /post-GC heapUsed\/heapTotal\/external\/arrayBuffers/);
  // vanilla anon 240/258 -> median 249.0, spread 18.0; file 9/1.5 -> 5.3, spread 7.5
  assert.match(
    md,
    /\| vanilla \|.*249\.0 \/ 5\.3 \/ 0\.8 \| 18\.0 \/ 7\.5 \/ 0\.5 \|/,
  );
});
