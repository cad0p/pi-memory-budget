import assert from "node:assert/strict";
import { test } from "node:test";
import {
  findSettle,
  max,
  median,
  releaseSeconds,
  summarize,
} from "../src/stats.mjs";
import { fakeRun } from "./helpers.mjs";

test("median: odd, even, unsorted, infinity", () => {
  assert.equal(median([3, 1, 2]), 2);
  assert.equal(median([4, 1, 2, 3]), 2.5);
  assert.equal(median([10]), 10);
  assert.ok(Number.isNaN(median([])));
  assert.equal(median([1, 2, Number.POSITIVE_INFINITY]), 2);
  assert.equal(
    median([1, 2, Number.POSITIVE_INFINITY, Number.POSITIVE_INFINITY]),
    Number.POSITIVE_INFINITY,
  );
});

test("max", () => {
  assert.equal(max([1, 5, 3]), 5);
  assert.equal(max([]), Number.NEGATIVE_INFINITY);
});

test("findSettle: the first 10 s window whose RSS range stays under 5 MB with no peak after", () => {
  // spike 200 for 2 s, then flat 100
  const r = fakeRun((t) => (t < 2 ? 200 : 100));
  const s = findSettle(r.samples, { quietSec: 10 });
  assert.equal(s.settled, true);
  assert.ok(s.t !== null && s.t >= 12 && s.t <= 13, `settle at ${s.t}`);
});

test("findSettle: never for a permanently climbing process or a window shorter than quietSec", () => {
  const climb = fakeRun((t) => 100 + t * 2, { window: 60 });
  assert.equal(findSettle(climb.samples, { quietSec: 10 }).settled, false);
  const short = fakeRun(() => 100, { window: 5 });
  assert.equal(findSettle(short.samples, { quietSec: 10 }).settled, false);
});

test("findSettle: a new peak after a quiet window means not settled there", () => {
  // flat 100 for 20 s, jump to 400 at t=21, flat after: settles at the end, not at 10
  const r = fakeRun((t) => (t < 21 ? 100 : 400), { window: 40 });
  const s = findSettle(r.samples, { quietSec: 10 });
  assert.ok(s.t !== null && s.t >= 31, `settle at ${s.t}`);
});

test("findSettle: settleMax rejects a settle it cannot wait for", () => {
  // flat at 200 until t=125, then flat at 100: settles around t=135
  const r = fakeRun((t) => (t < 125 ? 200 : 100), { window: 145 });
  assert.equal(
    findSettle(r.samples, { quietSec: 10, settleMax: 120 }).settled,
    false,
  );
  const s = findSettle(r.samples, { quietSec: 10, settleMax: 140 });
  assert.equal(s.settled, true);
  assert.ok(s.t !== null && s.t >= 135 && s.t <= 136, `settle at ${s.t}`);
});

test("findSettle: a process that ramps again after a quiet window is not settled", () => {
  const r = fakeRun((t) => (t < 40 ? 100 : 100 + (t - 40) * 3), { window: 60 });
  assert.equal(findSettle(r.samples, { quietSec: 10 }).settled, false);
});

test("findSettle: a flat plateau at the spike level is not an early settle when the level drops later", () => {
  const r = fakeRun((t) => (t < 5 ? 200 : 100), { window: 30 });
  const s = findSettle(r.samples, { quietSec: 10 });
  assert.ok(
    s.t !== null && s.t >= 14.5,
    `settle at ${s.t}, not the 200 MB plateau`,
  );
});

test("summarize: steady is the median of the settled window, children and main split", () => {
  const samples = [];
  for (let t = 0; t <= 20 + 1e-9; t += 1)
    samples.push({
      t,
      rss: t < 15 ? 50 : 80,
      main: t < 15 ? 50 : 73,
      kids: t < 15 ? 0 : 7,
    });
  const s = summarize(samples, { quietSec: 5 });
  assert.equal(s.steadyMb, 80);
  assert.equal(s.mainSteadyMb, 73);
  assert.equal(s.childrenSteadyMb, 7);
  assert.equal(s.childrenSpikeMb, 7);
  assert.equal(s.settled, true);
  assert.ok(s.settleT !== null && s.settleT <= 20.1);
  const s2 = summarize(samples, { quietSec: 20 });
  assert.equal(s2.settled, false);
  assert.equal(s2.steadyMb, null);
});

test("summarize: spike is the total-RSS max, released the last sample", () => {
  const r = fakeRun((t) => (t < 2 ? 200 : 100), { window: 30 });
  assert.equal(r.spikeMb, 200);
  assert.equal(r.releasedMb, 100);
  assert.ok(r.peakT < 2);
});

test("summarize: rejects empty input", () => {
  assert.throws(() => summarize([]), /no RSS samples/);
});

test("releaseSeconds: time from the peak until the delta stays under the steady budget", () => {
  // vanilla 100, budget +20, peak 250 at t=3, back to 115 at t=9
  const r = fakeRun((t) =>
    t < 3 ? 100 + t * 50 : t === 3 ? 250 : t < 9 ? 200 : 115,
  );
  const rel = releaseSeconds(r.samples, 100, 20);
  assert.ok(rel !== null && rel > 5 && rel < 7, `release ${rel}`);
});

test("releaseSeconds: one dip is not a release (3 consecutive samples required)", () => {
  // dips to 115 for a single 0.2 s sample at t=5, rebounds to 200, releases at t=14
  const r = fakeRun((t) =>
    t < 4.8 ? 400 : t < 5.2 ? 115 : t < 14 ? 200 : 115,
  );
  const rel = releaseSeconds(r.samples, 100, 20);
  assert.ok(
    rel !== null && rel > 7,
    `release ${rel} (dip at t=5 must not count)`,
  );
});

test("releaseSeconds: 0 when the peak is within budget, null when it never releases", () => {
  assert.equal(releaseSeconds(fakeRun(() => 110).samples, 100, 20), 0);
  assert.equal(releaseSeconds(fakeRun(() => 300).samples, 100, 20), null);
  assert.equal(releaseSeconds([], 100, 20), null);
});
