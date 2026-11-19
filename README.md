# pi-memory-budget

Memory budgets for [pi](https://github.com/earendil-works/pi) extensions: how much RSS an extension adds on top of vanilla pi on a fresh session and on long sessions, as a CI gate.

Extensions are loaded in-process, so whatever an extension allocates is added to every pi process. An audit on 2026-11-19 found napkin-context at +810 MB before fixes, pi-devin at about +275 MB on a 420 MB session and pi-steering at about +100 MB. Nothing in review caught it. This package measures it and fails the build.

## How it measures

For every case it starts `pi --mode rpc -ne -e <extension>…` (the candidate) and `pi --mode rpc -ne` (vanilla, same pi, same cwd, same env), one process at a time, and samples RSS every 200 ms for a window (default 30 s):

- **steady** = median RSS over the last 10 s; **spike** = max RSS; **released** = last sample.
- Linux reads `/proc/<pid>/status` (`VmRSS`), macOS uses `ps`. Descendant processes of pi are reported separately as *children*.
- It sends RPC `get_state` every 100 ms and reports the largest response gap, as a check on event-loop blocking (reported, not budgeted).
- Each configuration runs N times (default 3) and the **median** is used. RSS is noisy by a few MB, so the vanilla baseline always runs in the same job, interleaved with the candidate.

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
| `spikeReleaseSeconds` | 30 | seconds from the peak until the delta is back under the steady budget |
| `regression` | 5 | candidate minus a baseline build (`--baseline-extension`), every case, only when given |

If the candidate's own steady level is over the steady budget, the release check measures against that level (+5 MB noise) so one steady problem is not reported twice.

## Usage

```bash
pnpm add -D github:cad0p/pi-memory-budget#<sha> @earendil-works/pi-coding-agent   # before the first npm publish
pnpm add -D @cad0p/pi-memory-budget @earendil-works/pi-coding-agent               # after

pnpm exec pi-memory-budget run \
  --extension ./extensions/my-ext/index.ts \
  --baseline-extension ./main/extensions/my-ext/index.ts \
  --config budget.json --report memory-report.md --json memory-report.json
```

pi is resolved from `--pi <cmd>`, then `node_modules/.bin/pi` of `--cwd`, then `PATH`. Exit code: 0 everything passes or is waived, 1 a budget FAILs, 2 usage or runtime error.

| Option | Meaning |
|---|---|
| `--extension <path>` | extension under test, repeatable (several are measured together) |
| `--baseline-extension <path>` | baseline build, e.g. checked out from `main`, repeatable |
| `--config <budget.json>` | budgets, waivers, env, setup hooks |
| `--cwd <dir>` | working directory of pi (a workspace or vault the extension needs) |
| `--env K=V` | environment variable for every pi process, repeatable |
| `--runs <n>` | runs per configuration and case (default 3) |
| `--window <s>` | window per run (default 30), `--steady-seconds` (default 10) |
| `--session-mb <n>` | long session size in MiB (default 200) |
| `--cases <list>` | `fresh,long,long2x` subset |
| `--seed <n>` | fixture seed (default 1) |
| `--pi <cmd>`, `--pi-arg <arg>` | pi command and extra arguments for every process |
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

- *Vanilla* and *Candidate* are medians in MB (steady for the steady check, candidate max for the spike); *Delta* is what the extension adds.
- A second table per case lists steady, spike, released, children steady and the max ping gap of every configuration. A large *children* value means the extension spawns processes that the budget on the pi process does not see.
- *Growth with session size* compares the long and long2x deltas. A FAIL means the extension's memory scales with the session: fix it, or justify it in the PR.
- JSON (`schema: pi-memory-budget/1`) has the same checks plus aggregates and the raw RSS samples of every run (`[t seconds, rss MB, children MB]`).

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

Run it on `ubuntu-latest` (stable numbers). Use the same pi version for the candidate and the baseline: pi is a devDependency, so both are covered by the lockfile. Copy the "Memory budget" section from [docs/consumer-verification-section.md](docs/consumer-verification-section.md) into your `docs/verification.md`.

## Development

```bash
pnpm install
pnpm lint && pnpm typecheck && pnpm test
PMB_E2E=1 pnpm test:e2e     # real pi, a few minutes; CI runs it on ubuntu and macOS
```

Plain ESM with JSDoc types, no build step. See [docs/verification.md](docs/verification.md) for the checklist. License: MIT.
