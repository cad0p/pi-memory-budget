import assert from "node:assert/strict";
import { test } from "node:test";
import {
  findSettle,
  max,
  median,
  metricValue,
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

test("findSettle: settleMin pushes the settle point past the minimum", () => {
  /** @type {import("../src/stats.mjs").Sample[]} */
  const s = [];
  for (let t = 0; t <= 60; t += 0.2)
    s.push({ t, rss: 150, main: 150, kids: 0 });
  const early = findSettle(s, { quietSec: 10 });
  assert.ok(early.settled && (early.t ?? 99) < 11);
  const late = findSettle(s, { quietSec: 10, settleMin: 30 });
  assert.ok(late.settled && (late.t ?? 0) >= 30);
  assert.equal(findSettle(s, { quietSec: 10, settleMin: 90 }).settled, false);
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

test("metricValue: dedup and anon fall back to summed RSS where they are not reported", () => {
  const s = { t: 0, rss: 200, main: 200, kids: 0, dedup: 150, anon: 120 };
  assert.equal(metricValue(s, "rss"), 200);
  assert.equal(metricValue(s, "dedup"), 150);
  assert.equal(metricValue(s, "anon"), 120);
  // a platform without smaps: dedup is null, the checks then read summed RSS
  const mac = { t: 0, rss: 200, main: 200, kids: 0, dedup: null, anon: null };
  assert.equal(metricValue(mac, "dedup"), 200);
  assert.equal(metricValue(mac, "anon"), 200);
  assert.equal(metricValue(mac), 200);
});

test("findSettle on dedup: a noisy summed total does not stop the metric settling", () => {
  /** @type {import("../src/stats.mjs").Sample[]} */
  const samples = [];
  let i = 0;
  for (let t = 0; t <= 40 + 1e-9; t += 0.2) {
    // summed oscillates by 20 MB (page cache of a forked child), dedupe flat
    samples.push({
      t,
      rss: 250 + (i++ % 2 ? 10 : -10),
      main: 250,
      kids: 0,
      dedup: 200,
    });
  }
  assert.equal(findSettle(samples, { quietSec: 10 }).settled, false);
  const s = findSettle(samples, { quietSec: 10, field: "dedup" });
  assert.equal(s.settled, true);
});

test("summarize on the dedup field: steady, spike and released follow the metric", () => {
  /** @type {import("../src/stats.mjs").Sample[]} */
  const samples = [];
  for (let t = 0; t <= 40 + 1e-9; t += 0.2) {
    const rss = t < 15 ? 200 : 230;
    samples.push({ t, rss, main: rss, kids: 0, dedup: t < 15 ? 200 : 205 });
  }
  const summed = summarize(samples, { quietSec: 10 });
  const dedup = summarize(samples, { quietSec: 10, field: "dedup" });
  assert.equal(summed.steadyMb, 230);
  assert.equal(summed.spikeMb, 230);
  assert.equal(dedup.steadyMb, 205, "the level the checks read");
  assert.equal(dedup.spikeMb, 205);
  assert.equal(dedup.releasedMb, 205);
  assert.equal(dedup.settled, true);
});

test("releaseSeconds on dedup: a summed plateau of shared pages is not a release problem", () => {
  /** @type {import("../src/stats.mjs").Sample[]} */
  const samples = [];
  for (let t = 0; t <= 30 + 1e-9; t += 0.2) {
    // summed stays 60 MB over vanilla after a child maps node; dedupe is flat
    const rss = t < 5 ? 400 : 260;
    samples.push({ t, rss, main: rss, kids: 0, dedup: 205 });
  }
  assert.equal(releaseSeconds(samples, 200, 20, 3, "rss"), null);
  assert.equal(releaseSeconds(samples, 200, 20, 3, "dedup"), 0);
});
