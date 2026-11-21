# pi-memory-budget

Memory budgets for [pi](https://github.com/earendil-works/pi) extensions: how much RSS an extension adds on top of vanilla pi on a fresh session and on long sessions, as a CI gate.

Extensions are loaded in-process, so whatever an extension allocates is added to every pi process. An audit on 2026-11-19 found napkin-context at +810 MB before fixes, pi-devin at about +275 MB on a 420 MB session and pi-steering at about +100 MB. Nothing in review caught it. This package measures it and fails the build.

## How it measures

For every case it starts `pi --mode rpc -ne -ns -np --no-themes --no-mcp -nc -e <extension>…` (the candidate) and the same command without `-e` (vanilla, same pi, same cwd, same env), one process at a time, and samples RSS every 200 ms for at least a minimum window (default 30 s). The isolation flags are always passed so that the only difference between the two is the extension under test: no skills, prompt templates, themes, MCP servers or context files.

A run first **waits for quiescence**, but never before `--settle-min` (default 30 s) has passed — pi does small amounts of work in its first half minute, and the GC harness has forced full GCs by then, identically in every configuration. Quiescence means the first point at which the trailing 10 s of total RSS has a range under 5 MB, capped by `--settle-max` (default 120 s). If the process never settles, steady is reported as *not settled* and the steady check fails with that reason. The run keeps sampling until the release after the peak is observable (peak + `spikeReleaseSeconds`, bounded), so a release is never failed just because the window ended:

- **Offline**: every pi run gets `PI_OFFLINE=1`, `PI_SKIP_VERSION_CHECK=1`, `PI_TELEMETRY=0` — pi's startup network work (model catalog refresh, version check, telemetry) allocates tens of MB at an unpredictable time and made the vanilla level bimodal (120–178 MB on a quiet box). With it off, vanilla settles within a few MB. `--env` overrides these if a different value is genuinely needed. Limitation: an extension whose startup itself needs the network is measured without that traffic — if its cost matters, measure it on a longer window and read the transient spike, not steady.
- **GC-normalized**: an idle pi allocates almost nothing, so left to itself V8 never runs a major GC and the settled level is whatever garbage was uncollected when allocation stopped — run-to-run noise of tens of MB. Every pi run (vanilla and candidate alike, so it cancels out) is therefore started with `--expose-gc` — passed through `NODE_OPTIONS`, which reaches node whether pi is a global launcher, a `node_modules/.bin` shim or a plain `node cli.js` — plus a tiny harness extension (`src/gc-harness.js`) that forces major GCs at start, whenever the heap has grown by ~4 MB, and periodically. *steady* measures retained memory, not GC timing. `--no-gc` disables it. Garbage only collects in the pi process itself; children are measured exactly as before. On glibc, freed V8 pages and large buffers go back to the OS promptly, so the post-GC level is observable directly; anything malloc keeps is stable across runs and simply part of the measured level.

- **the measured tree** = the pi pid plus every descendant process (recursive) — an extension cannot hide memory in a spawned helper; **main** and **children** are still reported separately for diagnosis. Two totals are read from it on every sample:
  - **deduplicated RSS (the budget metric on Linux)** — the anonymous RSS of every process in the tree plus, for each file mapping (device, inode and file offset, from `/proc/<pid>/smaps`), the largest Rss any one process in the tree has for it. A file region mapped by two processes — the node binary and the shared libraries of a forked node child, a `memfd`, a `/dev/shm` object — exists once in RAM, so it is charged once. Without this, an extension that forks node was penalised about 45–50 MB for pages it does not add while one doing the same work in-process was not (issue #10). Applied identically to vanilla, candidate and baseline, so it cancels out of every delta. Approximation: one entry per mapping start, not a per-page union, so two *overlapping but differently aligned* mappings of the same file count twice; that is at most a few MB and never happens for a node child.
  - **summed RSS** — every process's `VmRSS` added up, shared file pages counted once per process. It stays a reported column (*steady summed*, *spike summed*, and `summedSteadyMb`/`summedSpikeMb` in JSON), never a budget. On a tree that forks node it reads 30–50 MB higher.
  Every sample also carries the kernel's breakdown of the summed total from `/proc/<pid>/status`, summed over the same tree: **RssAnon** (heap, stacks, malloc arenas), **RssFile** (page-cache-backed: the session file, shared libraries) and **RssShmem**. They are diagnostic — they are what tells a real regression from a noisy machine. An unreadable `smaps` (permissions) is a hard error, never a silent fallback to summed RSS.
- **steady** = median of the settled 10 s window, **spike** = max, **released** = last sample, all in the metric the checks use; the settle search and the release observation follow the same metric. When the run-to-run steady spread exceeds a budget the report says whether the residual is RssAnon or file-backed pages, so a verdict can still be read (see *Reading the report*).
- Linux reads `/proc/<pid>/status` (`VmRSS`, plus `RssAnon`/`RssFile`/`RssShmem` for the breakdown) and `/proc/<pid>/smaps` (per-mapping Rss, for the deduplicated total). macOS uses `ps`: summed RSS only, no breakdown, and no way to see which pages processes share — see *macOS is report-only* below. Descendant processes of pi are reported separately as *children*.
- It sends RPC `get_state` every 100 ms and reports the largest response gap, as a check on event-loop blocking (reported, not budgeted).
- **allocator behaviour pinned**: every pi run gets `MALLOC_MMAP_THRESHOLD_=65536` (a glibc `mallopt` tunable; ignored on macOS). glibc's default mmap threshold is dynamic and climbs toward 32 MB, so the many large transient buffers of a 100–200 MB session load are served from malloc arenas and stay resident after `free()`. Before this, vanilla's own long-session steady RSS varied by 5–52 MB between runs with an identical post-GC heap (issue #7); with a pinned 64 KiB threshold those buffers `mmap`/`munmap` per call and the kernel takes them back promptly (vanilla long/long2x spread 1–3 MB). This does change glibc's allocation behaviour compared to a plain `pi` launch, which is acceptable because it is applied identically to vanilla, candidate and baseline — it cancels out of every delta, and what it removes is allocator retention noise, not extension cost. `--env MALLOC_MMAP_THRESHOLD_=<n>` overrides it for a run that must reproduce a user's stock environment. The **spike** check is deliberately left on raw total RSS: it is what a user actually feels, allocator retention included.
- Each configuration runs N times (default 3) and the **median** is used. RSS is noisy by a few MB, so the vanilla baseline always runs in the same job, interleaved with the candidate. The report also shows the run-to-run **steady spread** (max−min) per configuration: when the spread of the reference configuration alone exceeds a check's budget, that check is **INCONCLUSIVE** — a distinct non-zero verdict (exit code 3 when nothing else failed) — because no delta can be trusted against a baseline noisier than the budget. Rerun on a quieter machine or with more `--runs`.

Cases:

| Case | Session |
|---|---|
| `fresh` | `--no-session` |
| `long` | synthetic session of `--session-mb` MiB (default 200) |
| `long2x` | synthetic session of twice that size |

The long sessions are generated, never copied from real sessions: deterministic for a seed and size, in pi's session format v3 (user and assistant messages with thinking blocks, tool calls and tool results from a few bytes to about 50 KB, branches, custom entries, labels). They are cached under `--fixtures-dir` (default `<tmpdir>/pi-memory-budget`) and copied for every run, because pi may write to them. `pi-memory-budget fixture --mb 200 --out f.jsonl --seed 1` writes one by hand.

## Budgets

Approved defaults; all in MB except the release time. Every value is "candidate minus vanilla" (medians).

| Budget | Default | Check |
|---|---:|---|
| `steadyFresh` | 20 | steady, fresh |
| `steadyLong` | 20 | steady, long |
| `growth2x` | 5 | delta(long2x) - delta(long): growth proportional to the session size |
| `spike` | 100 | max RSS of the candidate minus vanilla steady, every case |
| `spikeReleaseSeconds` | 30 | seconds from the peak until the delta is back under the steady budget for 3 consecutive samples; the run extends past the window to observe it. If it still cannot be observed (process died, caps), the check is INCONCLUSIVE — a distinct non-zero verdict, never a plain FAIL |
| `regression` | 5 | candidate minus a baseline build (`--baseline-extension`), every case, only when given |

If the candidate's own settled level is over the steady budget, the release check measures against that level (+5 MB noise) so one steady problem is not reported twice.

## Usage

```bash
pnpm add -D github:cad0p/pi-memory-budget#<sha> @earendil-works/pi-coding-agent   # before the first npm publish
pnpm add -D @cad0p/pi-memory-budget @earendil-works/pi-coding-agent               # after

pnpm exec pi-memory-budget run \
  --extension ./extensions/my-ext/index.ts \
  --baseline-extension ./main/extensions/my-ext/index.ts \
  --config budget.json --report memory-report.md --json memory-report.json
```

pi is resolved from `--pi <cmd>`, then `node_modules/.bin/pi` of `--cwd`, then `PATH`. Exit code: 0 everything passes or is waived, 1 a budget FAILs, 2 usage or runtime error, 3 no FAIL but at least one check is INCONCLUSIVE. On a platform without `/proc/<pid>/smaps` (macOS) the checks are report-only and the exit code is 0 unless the run itself failed — see *macOS is report-only*.

| Option | Meaning |
|---|---|
| `--extension <path>` | extension under test, repeatable (several are measured together) |
| `--baseline-extension <path>` | baseline build, e.g. checked out from `main`, repeatable |
| `--config <budget.json>` | budgets, waivers, env, setup hooks |
| `--cwd <dir>` | working directory of pi (a workspace or vault the extension needs) |
| `--env K=V` | environment variable for every pi process, repeatable (overrides the offline/GC/allocator defaults, e.g. `--env MALLOC_MMAP_THRESHOLD_=131072`) |
| `--runs <n>` | runs per configuration and case (default 3) |
| `--settle-min <s>` | no settle before this time; the GC harness has collected by then (default 30) |
| `--window <s>` | minimum window per run (default 30), `--steady-seconds` (default 10), `--settle-max` (default 120) |
| `--session-mb <n>` | long session size in MiB (default 200) |
| `--cases <list>` | `fresh,long,long2x` subset |
| `--seed <n>` | fixture seed (default 1) |
| `--pi <cmd>`, `--pi-arg <arg>` | pi command and extra arguments for every process |
| `--no-gc` | do not start pi with `--expose-gc` and the GC harness (comparison runs, non-node pi) |
| `--report <md>`, `--json <json>` | outputs |
| `--fixtures-dir <dir>` | fixture cache |

A single run needs about `runs x cases x configurations x window` seconds (defaults: 3 x 3 x 2 x 30 s = 9 min). Never more than one pi process runs at a time, and every pi process (and its children) is killed on exit, SIGINT and errors.

### budget.json

```json
{
  "extensions": ["extensions/napkin-context/index.ts"],
  "env": { "NAPKIN_VAULT": "fixtures/vault" },
  "setup": { "*": "scripts/prepare-workspace.sh" },
  "budgets": { "steadyLong": 30 },
  "waivers": { "growth2x": "the index is linear in the session by design, tracked in #42" }
}
```

- Relative paths resolve against the config file; CLI options override the file.
- `setup` (a command, or case name or `*` mapped to a command) runs with `sh -c` in `--cwd` before every pi process, with `PMB_CASE`, `PMB_CONFIG` (vanilla, candidate, baseline), `PMB_RUN` and `PMB_SESSION_FILE` in its environment.
- A **waiver** marks a budget as justified. It needs a non-empty reason and is reported as `WAIVED (would FAIL): <reason>` with the measured value, never skipped silently. Raising a limit in `budgets` is the other option; a waiver keeps the original limit visible.

## Reading the report

```
## Memory budget: FAIL

### Case: long

| Check | Vanilla | Candidate | Delta | Budget | Result |
|---|---:|---:|---:|---:|---|
| steady added RSS, long | 262.5 | 305.3 | +42.8 | <= +20 MB | FAIL |
| transient spike over vanilla steady, long | 262.5 | 305.3 | +42.8 | <= +100 MB | PASS |
| back under the steadyLong budget after the spike, long | | | 0.0 s | <= 30 s | PASS |
```

- *Vanilla* and *Candidate* are medians in MB (steady for the steady check, candidate max for the spike) **in the metric the checks used**, which the paragraph above the tables names: deduplicated RSS on Linux, summed RSS where that is all the platform can measure (and then the checks are report-only). *Delta* is what the extension adds.
- A second table per case lists steady, **steady summed** (the same window on summed RSS), the run-to-run steady spread, spike, **spike summed**, released, children steady, the max ping gap, the steady **RssAnon/RssFile/RssShmem** breakdown with its own **anon/file/shmem spread**, and post-GC **heapUsed/heapTotal/external/arrayBuffers** from the GC harness. All of it is diagnostic. The gap between *steady* and *steady summed* is the shared file-backed memory the tree maps once: a large *children* value with a small gap means the child is mostly mapping what pi already maps, and a large gap with *children* near zero would mean the dedupe is over-merging (it should not happen: anonymous memory is never deduplicated).
- A large vanilla *spread* explains an INCONCLUSIVE verdict, and the breakdown says where it lives. Spread in **RssAnon** with a flat heapTotal is allocator retention or a genuine allocation difference; spread in **RssFile** is this machine's page cache (the session file and shared libraries) moving under host I/O pressure, not the measured process's retention — the note on the affected check says which, by comparing the anon spread against the budget.
- *Growth with session size* compares the long and long2x deltas. A FAIL means the extension's memory scales with the session: fix it, or justify it in the PR.
- JSON (`schema: pi-memory-budget/1`) has the same checks plus aggregates and the raw RSS samples of every run (`[t seconds, rss MB, children MB, anon MB, file MB, shmem MB, dedup MB]`: summed RSS first, the deduplicated total last; the breakdown and the deduplicated total are null where the platform cannot read them). `meta.metric` is `dedup` or `rss`, `meta.reportOnly` says whether the checks decided anything, and every run carries `steadyMb`/`spikeMb` in that metric plus `summedSteadyMb`/`summedSpikeMb`.

### macOS is report-only

macOS has no `/proc/<pid>/smaps` and no way to see which pages two processes share, so it cannot compute the number the budgets are on. It keeps measuring summed RSS and printing the full report, but the checks are **REPORT-ONLY**: each one shows the verdict a Linux run would have given (`REPORT-ONLY (would FAIL): …`) and decides nothing. The exit code is 0 unless the run itself failed (tool error, exit 2); **INCONCLUSIVE included**, because there is no verdict to be unsure about — a noisy macOS box must not fail a job for a number it cannot compute. Pass/fail comes from the Linux run: the `ubuntu-latest` CI job in this repo and in every consumer.

The platform seam `PMB_PLATFORM` exists only so the non-Linux behaviour can be tested on Linux (it switches the sampler to the `ps` path and the checks to report-only); it is not a user option.

## CI

```yaml
- run: pnpm install --frozen-lockfile
- name: Memory budget
  run: >
    pnpm exec pi-memory-budget run
    --extension ./extensions/my-ext/index.ts
    --config budget.json
    --report memory-report.md --json memory-report.json
- if: always()
  run: cat memory-report.md >> "$GITHUB_STEP_SUMMARY"
- if: always()
  uses: actions/upload-artifact@v4
  with: { name: memory-budget, path: "memory-report.*" }
```

Run it on `ubuntu-latest` (stable numbers, and the only place the deduplicated metric exists): that job is the gate. A macOS job can run the same command for information, but its report is report-only and its exit code never fails the build. Use the same pi version for the candidate and the baseline: pi is a devDependency, so both are covered by the lockfile. Copy the "Memory budget" section from [docs/consumer-verification-section.md](docs/consumer-verification-section.md) into your `docs/verification.md`.

## Development

```bash
pnpm install
pnpm lint && pnpm typecheck && pnpm test
PMB_E2E=1 pnpm test:e2e     # real pi, ~15 minutes; CI runs it on ubuntu and macOS
```

The e2e thresholds are deliberately loose where RSS noise is involved and tight where the metric is deterministic (see the "Green means" list in [docs/verification.md](docs/verification.md)): the forked-node-child case asserts summed > +35 MB, deduplicated < +25 MB and a gap > 20 MB, because a fresh node child's *own* anonymous RSS is ~14 MB on a quiet machine (5 MB buffer plus the runtime) — that memory is real and stays in the deduplicated number; what disappears is the ~33 MB of node binary and shared libraries it maps, which is what the issue was about. Vanilla's deduplicated steady must equal its summed steady within 1 MB: one process shares nothing with itself, so that is a direct check of the dedupe arithmetic against the kernel's `VmRSS`.

Plain ESM with JSDoc types, no build step. See [docs/verification.md](docs/verification.md) for the checklist. License: MIT.
