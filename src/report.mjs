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
  return c.status === "FAIL" && c.note ? `FAIL: ${c.note}` : c.status;
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
  const verdict = result.ok ? "PASS" : "FAIL";
  out.push(`## Memory budget: ${verdict}`, "");
  out.push(
    `pi ${meta.piVersion}, ${meta.platform}, ${meta.runs} run(s) per configuration (median), ${meta.windowSec}s window, steady = median of the last ${meta.steadySec}s. Deltas are candidate minus vanilla pi in the same job. Values in MB.`,
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
      "| Configuration | steady | spike | released | children steady | max ping gap |",
      "|---|---:|---:|---:|---:|---:|",
    );
    for (const [name, a] of Object.entries(agg)) {
      out.push(
        `| ${name} | ${fmt(a.steadyMb)} | ${fmt(a.spikeMb)} | ${fmt(a.releasedMb)} | ${fmt(a.childrenSteadyMb)} | ${fmt(a.maxGapMs, 0)} ms |`,
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
        steadyMb: r.steadyMb,
        spikeMb: r.spikeMb,
        releasedMb: r.releasedMb,
        peakT: r.peakT,
        childrenSteadyMb: r.childrenSteadyMb,
        childrenSpikeMb: r.childrenSpikeMb,
        maxGapMs: r.maxGapMs,
        readyMs: r.readyMs,
        pings: r.pings,
        samples: r.samples.map((s) => [
          Number(s.t.toFixed(2)),
          Number(s.rss.toFixed(1)),
          Number(s.kids.toFixed(1)),
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
