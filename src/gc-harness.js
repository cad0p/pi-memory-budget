// pi-memory-budget GC harness. The budget CLI loads this extension in EVERY
// measured pi process — vanilla, candidate and baseline alike — so its own
// footprint cancels out of the delta. It exists because an idle pi allocates
// almost nothing: left to itself V8 never runs a major GC and the settled RSS
// is whatever garbage happened to be uncollected when allocation stopped
// (issue #3: run-to-run swings of -216..+78 MB on 100 MB sessions). With pi
// started under --expose-gc (the runner adds it through NODE_OPTIONS) this
// harness forces full GCs until only retained memory is left.

// Marker grepped out of pi's stderr by the runner to confirm the harness is
// actually live in the measured process.
const MARK = "pmb-gc:";

/** One full, synchronous, compacting collection (V8 "major"). */
function collect() {
  const gc = /** @type {any} */ (globalThis).gc;
  try {
    gc({ type: "major", execution: "sync" });
  } catch {
    // Older Node: gc() takes no options and is already a full GC.
    gc();
  }
}

export default function pmbGcHarness() {
  if (typeof (/** @type {any} */ (globalThis).gc) !== "function") {
    process.stderr.write(
      MARK +
        " unavailable: globalThis.gc missing, pi was not started with --expose-gc; steady RSS will include uncollected garbage\n",
    );
    return;
  }
  process.stderr.write(MARK + " ready\n");

  // Two passes back to back: the second frees what the first pass orphaned.
  const now = () => {
    collect();
    collect();
  };
  now();

  // Re-arm a forced GC whenever the heap grew by STEP_MB since the last pass,
  // and unconditionally every INTERVAL*10 ms for garbage heapUsed does not see
  // (native buffers, external memory). STEP stays under the 5 MB quiet-window
  // range so a step drop inside the steady window cannot break quiescence, and
  // a process that keeps producing garbage simply never settles — the correct
  // verdict for it anyway.
  const STEP_MB = 4;
  const INTERVAL_MS = 500;
  let base = process.memoryUsage().heapUsed;
  let ticks = 0;
  const t = setInterval(() => {
    ticks += 1;
    const used = process.memoryUsage().heapUsed;
    if (used - base >= STEP_MB * 1048576 || ticks % 10 === 0) {
      now();
      const m = process.memoryUsage();
      base = m.heapUsed;
      // Diagnostic only (post-GC numbers); budgets stay on total RSS.
      // heapTotal next to heapUsed: the gap is V8-committed but unused pages,
      // one of the long-session spread suspects (issue #7).
      process.stderr.write(
        `${MARK} diag ${JSON.stringify({ heapUsed: m.heapUsed, heapTotal: m.heapTotal, external: m.external, arrayBuffers: m.arrayBuffers })}\n`,
      );
    }
  }, INTERVAL_MS);
  // Never keep pi alive for the harness alone.
  t.unref();
}
