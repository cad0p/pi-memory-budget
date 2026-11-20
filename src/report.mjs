// Markdown and JSON rendering of the evaluation.

import { CASE_ORDER } from "./budget.mjs";

/** @param {number | null | undefined} n @param {number} [d] */
function fmt(n, d = 1) {
  return n === null || n === undefined || Number.isNaN(n)
    ? "n/a"
    : n.toFixed(d);
}

/** @param {number | null | undefined} n */
function signed(n) {
  return n === null || n === undefined || Number.isNaN(n)
    ? "n/a"
    : `${n >= 0 ? "+" : ""}${n.toFixed(1)}`;
}

/** @param {import("./budget.mjs").Check} c */
function statusCell(c) {
  if (c.status === "WAIVED")
    return `WAIVED (${(c.note ?? "").replace(/^.*would /, "would ")}): ${c.reason}`;
  if (c.status === "SKIP") return `SKIP: ${c.note ?? "not applicable"}`;
  if (c.status === "INCONCLUSIVE")
    return `INCONCLUSIVE: ${c.note ?? "could not be measured"}`;
  return c.status === "FAIL" && c.note ? `FAIL: ${c.note}` : c.status;
}

/** @param {{ heapUsedMb: number, heapTotalMb: number | null, externalMb: number, arrayBuffersMb: number } | null | undefined} d */
function gcDiagCell(d) {
  return d
    ? `${fmt(d.heapUsedMb)} / ${fmt(d.heapTotalMb)} / ${fmt(d.externalMb)} / ${fmt(d.arrayBuffersMb)}`
    : "n/a";
}

/** Three nullable values as "a / b / c".
 * @param {(number | null | undefined)[]} v */
function tripleCell(v) {
  return v.every((x) => x === null || x === undefined || Number.isNaN(x))
    ? "n/a"
    : v.map((x) => fmt(x)).join(" / ");
}

/**
 * @typedef {object} ReportInput
 * @property {ReturnType<typeof import("./budget.mjs").evaluate>} result
 * @property {import("./budget.mjs").Budgets} budgets
 * @property {Record<string, string>} waivers
 * @property {Record<string, unknown>} meta
 */

/**
 * @param {ReportInput} input
 * @returns {string}
 */
export function renderMarkdown(input) {
  const { result, meta } = input;
  const out = [];
  const verdict = result.checks.some((x) => x.status === "FAIL")
    ? "FAIL"
    : result.ok
      ? "PASS"
      : "INCONCLUSIVE";
  out.push(`## Memory budget: ${verdict}`, "");
  out.push(
    `pi ${meta.piVersion}, ${meta.platform}, ${meta.runs} run(s) per configuration (median), ${meta.windowSec}s minimum window, steady = median of the settled ${meta.steadySec}s (total-RSS range < 5 MB, settle capped at ${meta.settleMaxSec}s). Deltas are candidate minus vanilla pi in the same job on TOTAL RSS: the pi pid plus every descendant. Values in MB.`,
    "",
  );
  out.push(
    meta.gc === false
      ? "GC normalization is OFF (--no-gc): settled RSS includes whatever garbage was uncollected when the window was sampled."
      : "GC normalization is ON: every pi run (vanilla and candidate alike) starts with --expose-gc and a harness extension that forces major GCs, so steady measures retained memory, not GC timing. A check is INCONCLUSIVE when the run-to-run spread of the vanilla baseline alone exceeds the check's budget.",
    "",
  );
  for (const c of CASE_ORDER) {
    const agg = result.aggregates[c];
    if (!agg) continue;
    const checks = result.checks.filter(
      (x) => x.case === c && x.id !== "growth2x",
    );
    out.push(`### Case: ${c}`, "");
    out.push(
      "| Check | Vanilla | Candidate | Delta | Budget | Result |",
      "|---|---:|---:|---:|---:|---|",
    );
    for (const k of checks) {
      const d = k.detail;
      const unit = k.unit === "s" ? " s" : " MB";
      if (k.key === "spikeReleaseSeconds") {
        out.push(
          `| ${k.label} | | | ${k.value === null ? "never" : `${fmt(k.value)} s`} | <= ${k.limit} s | ${statusCell(k)} |`,
        );
      } else if (k.key === "regression") {
        out.push(
          `| ${k.label} | baseline ${fmt(d.baseline)} | ${fmt(d.candidate)} | ${signed(k.value)} | <= +${k.limit}${unit} | ${statusCell(k)} |`,
        );
      } else {
        out.push(
          `| ${k.label} | ${fmt(d.vanilla)} | ${fmt(d.candidate)} | ${signed(k.value)} | <= +${k.limit}${unit} | ${statusCell(k)} |`,
        );
      }
    }
    out.push("");
    out.push(
      "| Configuration | settle at | steady | steady spread | spike | released | main steady | children steady | max ping gap | steady RssAnon/RssFile/RssShmem (Linux) | anon/file/shmem spread | post-GC heapUsed/heapTotal/external/arrayBuffers (diagnostic) |",
      "|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|",
    );
    for (const [name, a] of Object.entries(agg)) {
      const settle =
        a.settleT === null
          ? a.settled
            ? "n/a"
            : "never"
          : `${a.settleT.toFixed(0)} s`;
      const spread =
        a.steadySpreadMb === null
          ? "n/a"
          : a.steadySpreadMb === 0
            ? "0.0"
            : `${fmt(a.steadySpreadMb)} (${fmt(a.steadyMinMb)}-${fmt(a.steadyMaxMb)})`;
      out.push(
        `| ${name} | ${settle} | ${a.steadyMb === null ? "not settled" : fmt(a.steadyMb)} | ${spread} | ${fmt(a.spikeMb)} | ${fmt(a.releasedMb)} | ${fmt(a.mainSteadyMb)} | ${fmt(a.childrenSteadyMb)} | ${fmt(a.maxGapMs, 0)} ms | ${tripleCell([a.anonSteadyMb, a.fileSteadyMb, a.shmemSteadyMb])} | ${tripleCell([a.anonSteadySpreadMb, a.fileSteadySpreadMb, a.shmemSteadySpreadMb])} | ${gcDiagCell(a.gcDiag)} |`,
      );
    }
    out.push("");
  }
  const growth = result.checks.find((x) => x.id === "growth2x");
  if (growth) {
    out.push("### Growth with session size", "");
    out.push(
      "| Check | Delta long | Delta long2x | Growth | Budget | Result |",
      "|---|---:|---:|---:|---:|---|",
    );
    out.push(
      `| ${growth.label} | ${signed(growth.detail.deltaLong)} | ${signed(growth.detail.deltaLong2x)} | ${signed(growth.value)} | <= +${growth.limit} MB | ${statusCell(growth)} |`,
    );
    out.push("");
  }
  if (Number(meta.runs) < 3) {
    out.push(
      "Note: fewer than 3 runs per configuration — the median cannot absorb noise; RSS varies by tens of MB on big sessions.",
      "",
    );
  }
  const waived = result.checks.filter((x) => x.status === "WAIVED");
  if (waived.length) {
    out.push("Waived budgets (justified in the config, not skipped):", "");
    for (const w of waived) out.push(`- ${w.id}: ${w.reason}`);
    out.push("");
  }
  return `${out.join("\n")}\n`;
}

/**
 * @param {ReportInput & { measurements: import("./budget.mjs").Measurements }} input
 */
export function renderJson(input) {
  /** @type {Record<string, Record<string, unknown>>} */
  const raw = {};
  for (const [c, configs] of Object.entries(input.measurements)) {
    raw[c] = {};
    for (const [name, runs] of Object.entries(configs)) {
      raw[c][name] = runs.map((r) => ({
        settleT: r.settleT,
        settled: r.settled,
        steadyMb: r.steadyMb,
        mainSteadyMb: r.mainSteadyMb,
        spikeMb: r.spikeMb,
        releasedMb: r.releasedMb,
        peakT: r.peakT,
        childrenSteadyMb: r.childrenSteadyMb,
        childrenSpikeMb: r.childrenSpikeMb,
        anonSteadyMb: r.anonSteadyMb,
        fileSteadyMb: r.fileSteadyMb,
        shmemSteadyMb: r.shmemSteadyMb,
        gcReady: r.gcReady,
        gcDiag: r.gcDiag,
        maxGapMs: r.maxGapMs,
        readyMs: r.readyMs,
        pings: r.pings,
        samples: r.samples.map((s) => [
          Number(s.t.toFixed(2)),
          Number(s.rss.toFixed(1)),
          Number(s.kids.toFixed(1)),
          s.anon === null || s.anon === undefined
            ? null
            : Number(s.anon.toFixed(1)),
          s.file === null || s.file === undefined
            ? null
            : Number(s.file.toFixed(1)),
          s.shmem === null || s.shmem === undefined
            ? null
            : Number(s.shmem.toFixed(1)),
        ]),
      }));
    }
  }
  return {
    schema: "pi-memory-budget/1",
    ok: input.result.ok,
    meta: input.meta,
    budgets: input.budgets,
    waivers: input.waivers,
    aggregates: input.result.aggregates,
    checks: input.result.checks,
    runs: raw,
  };
}
