# Verification checklist: pi-memory-budget

What must be true before a change to this repo merges, and how to prove it.

## CI gates

CI (`.github/workflows/ci.yml`) runs the `test` job on `ubuntu-latest` and `macos-latest`; the contexts are `test (ubuntu-latest)` and `test (macos-latest)`. The job runs, in order:

1. `pnpm install --frozen-lockfile`
2. `pnpm lint` (biome)
3. `pnpm typecheck` (`tsc --noEmit`, `checkJs`)
4. `pnpm test` (unit tests, offline, a few seconds)
5. `PMB_E2E=1 pnpm test:e2e`: the real CLI against a real pi (devDependency) and the fixture extensions in `test/fixtures`.

The two validators (`validate-package-version`, `validate-release-pr`) only check version and changelog conventions. Correctness lives in the `test` matrix, so both `test` contexts are required checks.

The `macos-latest` job runs the same commands but its budget checks are report-only (no `/proc/<pid>/smaps`, so no deduplicated metric): its CLI exits 0 on what would be a FAIL on Linux, and the e2e test asserts exactly that. The gate is `test (ubuntu-latest)`.

**Green means:**

- lint, typecheck and unit tests pass on both OSes;
- the e2e run shows that `ext-pass.js` (about 5 MB) passes with exit 0, `ext-leak.js` (about 60 MB) fails the steady budget with exit 1 and is WAIVED (exit 0) when the config carries a reason, `ext-grow.js` (memory proportional to the session) fails `growth2x`, pi loads the generated fixture with the same entry count, and no pi process is left behind;
- the deduplicated metric (issue #10) is right, on the same run:
  - `ext-fork-5mb.js` forks a node child holding 5 MB. Asserted on the medians of 2 runs: **summed** delta over vanilla > +35 MB (the old metric, which charges the child the node binary pi already maps), **deduplicated** delta < +25 MB, and the gap between the two > 20 MB. The numbers are not tighter because a fresh node child's own anonymous RSS is ~14 MB here (5 MB buffer + runtime) and that memory is real; only the ~33 MB of shared file-backed pages disappear. Do not widen these to make a flake go away: a smaller gap means the dedupe stopped working, a larger deduplicated delta means anon memory leaked;
  - vanilla (one process, nothing shared with itself) has deduplicated steady within 1 MB of summed steady on both `fresh` and `long`: a direct check of the dedupe arithmetic against the kernel's `VmRSS`;
  - with `PMB_PLATFORM=darwin` (the test seam) the CLI measures through `ps`, prints `## Memory budget: REPORT-ONLY`, keeps `wouldBe: FAIL` on a check that measured +60 MB, and exits 0 where the Linux run exits 1.

Every measured pi runs with `PI_OFFLINE=1`, `PI_SKIP_VERSION_CHECK=1` and `PI_TELEMETRY=0` (startup network work made the vanilla level bimodal), and no settle is accepted before `--settle-min` (default 30 s). Steady is GC-normalized since #3: every pi process runs with `--expose-gc` and the harness extension in `src/gc-harness.js`, so the margin being measured is retained memory, not uncollected garbage. On top of that, a check whose reference configuration (vanilla, or the baseline extension for `regression`) has a run-to-run steady spread larger than the check's own budget is INCONCLUSIVE — the CLI then exits 3 (no FAIL) — instead of turning baseline noise into a red-herring PASS or FAIL. A runner flake should therefore show as INCONCLUSIVE, never as a wrong verdict.

If an e2e assertion flakes on a runner, do not widen it silently: the margins are 5 MB (pass) against 20 MB budget and 60 MB (fail) against it, and the GC harness keeps steady noise in the low MB range. A flake means the measurement got noisier than that: check the run-to-run spread in the JSON report (`aggregates.<case>.<config>.steadySpreadMb`) and investigate the sampler or the window first.

## Offline gates (before pushing)

```bash
pnpm lint && pnpm typecheck && pnpm test
```

Every commit must pass these three. Do not edit `CHANGELOG.md` or the version on feature branches (the validator rejects it); user-facing notes go in the PR body under `## Release notes`.

## Independent review

A second reviewer (human or agent) who did not write the change checks:

- the budget numbers against the approved defaults (README table, `DEFAULT_BUDGETS`, the vault note `open-source/github/pi-memory-budget/_about`), and that the checks read the metric those numbers were approved for — deduplicated RSS on Linux (issue #10), with summed RSS still reported and macOS report-only;
- that waivers can never be silent: a waiver without a reason is refused, and a waived check is still printed with its measured value;
- that no pi process can be orphaned (exit, SIGINT, errors) and that at most one pi process runs at a time;
- that fixtures contain no real session content.

## Live proof, by change type

| Change | Proof |
|---|---|
| Sampler, runner, settle/window logic | run `pi-memory-budget run` with `--runs 1` on a known extension, compare against `grep VmRSS /proc/<pid>/status` plus the `task/*/children` descendants, taken by hand at the same moment; check `pgrep -f -- "--mode rpc"` is empty afterwards |
| The deduplicated metric, the settle metric, the report-only mode | one real run on an extension that forks node (`napkin-context` on a real vault, `--runs 3 --cases fresh`): the report names the metric, the *steady summed*/*spike summed* columns are above the deduplicated ones by roughly the child's file-backed RSS, and the spike delta drops by that amount against a previous summed run (issue #10: +86.6 summed vs +40.5 deduplicated on napkin-context). Vanilla's deduplicated steady must equal its summed steady (single process). Then the same command with `PMB_PLATFORM=darwin`: verdict `REPORT-ONLY`, exit 0. Per-sample cost: `readRss` reads `smaps` for every process in the tree; on a 260 MB node process with a node child it is ~8 ms median (16 ms worst) per 200 ms sample, and a fresh pi (~50 MB, 113 mappings) ~1–3 ms — well inside the interval |
| Fixture generator | `pi-memory-budget fixture --mb 5 --out f.jsonl`, open it with `pi --mode rpc --session f.jsonl -ne` and RPC `get_entries`: the count must equal the generator's entry count (the e2e test automates this); two runs with the same seed must be byte-identical (`cmp`) |
| Budgets, evaluation, report | unit tests plus one real run with a waiver and one without, pasting both reports in the PR |
| pi version bump (devDependency) | full e2e on both OSes; if the session format changed, update `src/fixture.mjs` against pi's `docs/session-format.md` |
| Before the first publish | `npm pack --dry-run --json` lists `src`, `docs`, `README.md`, `CHANGELOG.md`, `LICENSE`; install the git dependency into a scratch project and run the CLI from `node_modules/.bin` |

## Memory budget of this package

The CLI itself is not loaded into pi. It is a separate Node process and adds nothing to the pi processes it measures.
