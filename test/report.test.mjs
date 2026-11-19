import assert from "node:assert/strict";
import { test } from "node:test";
import { evaluate, resolveBudgets } from "../src/budget.mjs";
import { renderJson, renderMarkdown } from "../src/report.mjs";
import { flat } from "./helpers.mjs";

const meta = {
  piVersion: "1.5.2",
  platform: "linux-x64",
  runs: 1,
  windowSec: 30,
  steadySec: 10,
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
  assert.match(md, /\| candidate \| 190\.0 \|/);
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
  assert.deepEqual(run.samples[0], [0, 190, 0]);
  JSON.stringify(j); // serializable (no NaN-only structures that would throw)
});
