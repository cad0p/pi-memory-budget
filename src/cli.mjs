#!/usr/bin/env node
// pi-memory-budget CLI entry point.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { parseFixtureArgs, parseRunArgs, USAGE, UsageError } from "./args.mjs";
import { resolveOptions } from "./config.mjs";
import { writeFixture } from "./fixture.mjs";
import { runBudget } from "./orchestrate.mjs";
import { renderJson, renderMarkdown } from "./report.mjs";
import { installCleanupHooks } from "./runner.mjs";

/**
 * @param {string[]} argv process arguments without node and script
 * @returns {Promise<number>} exit code
 */
export async function main(argv) {
  const [cmd, ...rest] = argv;
  try {
    if (!cmd || cmd === "--help" || cmd === "-h" || cmd === "help") {
      process.stdout.write(USAGE);
      return cmd ? 0 : 2;
    }
    if (cmd === "--version" || cmd === "-v") {
      const pkg = JSON.parse(
        fs.readFileSync(new URL("../package.json", import.meta.url), "utf8"),
      );
      process.stdout.write(`${pkg.version}\n`);
      return 0;
    }
    if (cmd === "fixture") {
      const a = parseFixtureArgs(rest);
      if (a.help) {
        process.stdout.write(USAGE);
        return 0;
      }
      fs.mkdirSync(path.dirname(path.resolve(a.out)), { recursive: true });
      const st = writeFixture(a.out, { mb: a.mb, seed: a.seed, cwd: a.cwd });
      process.stdout.write(
        `${a.out}: ${(st.bytes / 1048576).toFixed(1)} MiB, ${st.entries} entries, ${st.branches} branch points\n`,
      );
      return 0;
    }
    if (cmd === "run") {
      const a = parseRunArgs(rest);
      if (a.help) {
        process.stdout.write(USAGE);
        return 0;
      }
      installCleanupHooks();
      const o = resolveOptions(a, os.tmpdir());
      fs.mkdirSync(o.fixturesDir, { recursive: true });
      const log = a.quiet
        ? () => {}
        : (/** @type {string} */ m) =>
            process.stderr.write(`[pi-memory-budget] ${m}\n`);
      const { measurements, result, meta } = await runBudget(o, { log });
      const input = { result, budgets: o.budgets, waivers: o.waivers, meta };
      const md = renderMarkdown(input);
      if (a.report) {
        fs.mkdirSync(path.dirname(path.resolve(a.report)), { recursive: true });
        fs.writeFileSync(a.report, md);
      }
      if (a.json) {
        fs.mkdirSync(path.dirname(path.resolve(a.json)), { recursive: true });
        fs.writeFileSync(
          a.json,
          `${JSON.stringify(renderJson({ ...input, measurements }), null, 2)}\n`,
        );
      }
      process.stdout.write(md);
      // 1 a budget FAILs; 3 no FAIL but an INCONCLUSIVE check (noisy baseline,
      // unobserved release): a distinct non-zero so CI can tell them apart.
      if (result.checks.some((c) => c.status === "FAIL")) return 1;
      return result.ok ? 0 : 3;
    }
    throw new UsageError(`unknown command "${cmd}"\n\n${USAGE}`);
  } catch (e) {
    process.stderr.write(
      `pi-memory-budget: ${e instanceof Error ? e.message : String(e)}\n`,
    );
    return 2;
  }
}

import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";

// Run only when executed as a script (also through the node_modules/.bin symlink).
if (
  process.argv[1] &&
  realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  main(process.argv.slice(2)).then((code) => process.exit(code));
}
