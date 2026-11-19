<!-- Paste this section into your repo's docs/verification.md. Replace the extension path. -->

## Memory budget

Every pi extension must stay within strict memory budgets compared with vanilla pi (`pi -ne`), on a fresh session and on long sessions. The check is [`@cad0p/pi-memory-budget`](https://github.com/cad0p/pi-memory-budget); do not copy the harness into this repo.

| Check | Budget (added RSS vs vanilla) |
|---|---|
| Steady, fresh session | <= +20 MB |
| Steady, long session (200 MB synthetic) | <= +20 MB |
| Growth with session size (2x vs 1x) | <= +5 MB more; growth proportional to the session needs a justification in the PR |
| Transient spike | <= +100 MB, and back under the steady budget within 30 s of the peak (held for 3 samples) |
| Regression vs `main` | <= +5 MB, otherwise justified in the PR |

- **CI:** the `memory-budget` step runs `pnpm exec pi-memory-budget run --extension <path> --config budget.json` on `ubuntu-latest` and fails the job on any FAIL. The report is in the job summary and the `memory-budget` artifact.
- **Before a PR that touches code loaded at startup or per session entry:** run it locally, with the `main` build as `--baseline-extension`, and paste the markdown report under `## Memory budget` in the PR body:

  ```bash
  pnpm exec pi-memory-budget run --extension ./extensions/<name>/index.ts \
    --baseline-extension <path to main checkout>/extensions/<name>/index.ts \
    --config budget.json --report memory-report.md
  ```

- **Regression tests:** a fix for a memory problem lands with a test that fails on the old behaviour (for example a bound on what is retained per session entry), not only with the budget run.
- **Waivers:** a budget that cannot be met is never skipped. Put it in `budget.json` under `waivers` with a reason that links the issue; the report prints it as WAIVED with the measured value, and the PR body must say why.
- **Needs a workspace** (a vault, a repo)? Pass `--cwd` and `--env`, or a `setup` command, in `budget.json`.
- **What is measured:** total RSS of the pi process plus every descendant (an extension cannot hide memory in a spawned helper), after a quiescence wait (RSS stable for 10 s, capped at `--settle-max` 120 s), with every pi process running `--expose-gc` and a GC harness so steady is retained memory, not uncollected garbage. An INCONCLUSIVE verdict (release could not be observed, never-settled reference, or vanilla's own run-to-run spread larger than the budget) fails the job like a FAIL and needs a human look, not a waiver.
- **Reading the numbers:** medians of 3 runs; RSS noise is a few MB but tens of MB on big sessions. A result within 5 MB of a budget deserves a rerun with `--runs 5` before a verdict.
