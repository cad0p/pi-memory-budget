import assert from "node:assert/strict";
import { test } from "node:test";
import { max, median, releaseSeconds, summarize } from "../src/stats.mjs";
import { fakeRun } from "./helpers.mjs";

test("median: odd, even, unsorted, infinity", () => {
  assert.equal(median([3, 1, 2]), 2);
  assert.equal(median([4, 1, 2, 3]), 2.5);
  assert.equal(median([10]), 10);
  assert.ok(Number.isNaN(median([])));
  assert.equal(median([1, 2, Number.POSITIVE_INFINITY]), 2);
  assert.equal(
    median([1, Number.POSITIVE_INFINITY, Number.POSITIVE_INFINITY]),
    Number.POSITIVE_INFINITY,
  );
});

test("max", () => {
  assert.equal(max([1, 5, 3]), 5);
  assert.equal(max([]), Number.NEGATIVE_INFINITY);
});

test("summarize: steady is the median of the last steadySec, spike the max, released the last", () => {
  // 200 MB spike for the first 2 s, then 100 MB
  const r = fakeRun((t) => (t < 2 ? 200 : 100), { window: 30 });
  assert.equal(r.steadyMb, 100);
  assert.equal(r.spikeMb, 200);
  assert.equal(r.releasedMb, 100);
  assert.ok(r.peakT < 2);
});

test("summarize: steady ignores a spike older than the steady slice and uses the right slice length", () => {
  const samples = [];
  for (let t = 0; t <= 20 + 1e-9; t += 1)
    samples.push({ t, rss: t < 15 ? 50 : 80, kids: t < 15 ? 0 : 7 });
  const s = summarize(samples, 5);
  assert.equal(s.steadyMb, 80);
  assert.equal(s.childrenSteadyMb, 7);
  assert.equal(s.childrenSpikeMb, 7);
  assert.equal(
    summarize(samples, 20).steadyMb,
    50,
    "a long slice covers the low part",
  );
});

test("summarize: rejects empty input", () => {
  assert.throws(() => summarize([], 10), /no RSS samples/);
});

test("releaseSeconds: time from the peak until the delta is back under the steady budget", () => {
  // vanilla 100, budget +20, peak 250 at t=3, back to 115 at t=9
  const r = fakeRun((t) =>
    t < 3 ? 100 + t * 50 : t === 3 ? 250 : t < 9 ? 200 : 115,
  );
  const rel = releaseSeconds(r.samples, 100, 20);
  assert.ok(rel !== null && rel > 5 && rel < 7, `release ${rel}`);
});

test("releaseSeconds: 0 when the peak is within budget, null when it never releases", () => {
  assert.equal(releaseSeconds(fakeRun(() => 110).samples, 100, 20), 0);
  assert.equal(releaseSeconds(fakeRun(() => 300).samples, 100, 20), null);
  assert.equal(releaseSeconds([], 100, 20), null);
});
