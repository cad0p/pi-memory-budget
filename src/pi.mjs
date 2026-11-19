// Resolving the pi binary and building the pi command line.

import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

/**
 * Splits a --pi value such as "node /path/cli.js" into command and args.
 * @param {string} cmd
 * @returns {{ command: string, args: string[] }}
 */
export function splitCommand(cmd) {
  const parts = cmd.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) throw new Error("--pi is empty");
  return { command: parts[0], args: parts.slice(1) };
}

/**
 * @param {string} name
 * @param {string} [pathEnv]
 * @returns {string | null}
 */
function which(name, pathEnv = process.env.PATH ?? "") {
  for (const dir of pathEnv.split(path.delimiter)) {
    if (!dir) continue;
    const p = path.join(dir, name);
    try {
      fs.accessSync(p, fs.constants.X_OK);
      if (fs.statSync(p).isFile()) return p;
    } catch {
      // not here
    }
  }
  return null;
}

/**
 * Resolution order: --pi, then node_modules/.bin/pi of the cwd, then PATH.
 * @param {{ pi?: string, cwd: string }} opts
 * @returns {{ command: string, args: string[], source: string }}
 */
export function resolvePi(opts) {
  if (opts.pi) return { ...splitCommand(opts.pi), source: "--pi" };
  const local = path.join(opts.cwd, "node_modules", ".bin", "pi");
  if (fs.existsSync(local))
    return { command: local, args: [], source: "node_modules/.bin" };
  const onPath = which("pi");
  if (onPath) return { command: onPath, args: [], source: "PATH" };
  throw new Error(
    "could not find pi: pass --pi <cmd>, or install @earendil-works/pi-coding-agent in the project (node_modules/.bin/pi), or put pi on PATH",
  );
}

/**
 * @typedef {object} PiRunSpec
 * @property {string[]} extensions absolute extension paths (-e)
 * @property {string | null} sessionFile session file to open, null for --no-session
 * @property {string[]} [extraArgs]
 */

/**
 * @param {PiRunSpec} spec
 * @returns {string[]}
 */
export function buildPiArgs(spec) {
  const args = ["--mode", "rpc"];
  if (spec.sessionFile) args.push("--session", spec.sessionFile);
  else args.push("--no-session");
  // Isolation: the only difference between vanilla and candidate is the
  // extension under test. -ne explicit-only extensions, -ns skills, -np prompt
  // templates, --no-themes, --no-mcp (MCP servers would also show up as child
  // processes), -nc AGENTS.md/CLAUDE.md discovery.
  args.push("-ne", "-ns", "-np", "--no-themes", "--no-mcp", "-nc");
  for (const e of spec.extensions) args.push("-e", e);
  args.push(...(spec.extraArgs ?? []));
  return args;
}

/**
 * @param {{ command: string, args: string[] }} pi
 * @param {string} cwd
 * @returns {Promise<string>} output of `pi --version` (or "unknown")
 */
export function piVersion(pi, cwd) {
  return new Promise((resolve) => {
    execFile(
      pi.command,
      [...pi.args, "--version"],
      { cwd, encoding: "utf8", timeout: 30000 },
      (err, stdout, stderr) => {
        resolve(
          err
            ? "unknown"
            : (stdout || stderr).trim().split("\n").pop() || "unknown",
        );
      },
    );
  });
}
