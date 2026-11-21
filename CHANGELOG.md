# Changelog

All notable changes to this project will be documented in this file.

## [calver-released]

<!-- USER-EDITABLE SECTION START -->
<!-- Add your curated release notes here. -->
<!-- USER-EDITABLE SECTION END -->

### 🚀 Features

- Count shared file pages once across the process tree on Linux, macOS report-only (closes #10) ([#11](https://github.com/cad0p/pi-memory-budget/pull/11))

### 🐛 Bug Fixes

- RSS breakdown per sample and a pinned malloc mmap threshold for the long cases (closes #7) ([#8](https://github.com/cad0p/pi-memory-budget/pull/8))


## [0.1.0] - 2026-11-19

<!-- USER-EDITABLE SECTION START -->
**First release: memory budgets for pi extensions.**

- `pi-memory-budget run` measures how much RSS an extension adds on top of vanilla `pi -ne` on a fresh session and on synthetic long sessions (default 200 MB and 2x), and exits 1 when it is over budget.
- Budgets: steady +20 MB (fresh and long), growth with session size +5 MB, transient spike +100 MB and back under the steady budget within 30 s, regression vs a baseline build +5 MB. Each budget can be overridden or waived with a written reason in `budget.json`; waivers are reported, never silent.
- `pi-memory-budget fixture` writes the deterministic synthetic session (pi session format v3) used for the long cases.
- Markdown report for PR bodies and JSON for CI artefacts; RSS from `/proc` on Linux and `ps` on macOS, child processes of pi reported separately, event-loop responsiveness via RPC `get_state` pings.
- Works as a git dependency (`github:cad0p/pi-memory-budget#<sha>`) before the first npm publish: plain ESM, no build step.
<!-- USER-EDITABLE SECTION END -->

### 🚀 Features

- Memory budget CLI for pi extensions (closes #1)
