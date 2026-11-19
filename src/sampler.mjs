// RSS sampling of a process and its descendants (recursive).
// Linux: /proc/<pid>/status VmRSS plus /proc/<pid>/task/*/children for the
// descendant walk (cheap: only the subtree, not all of /proc). macOS: ps.

import { execFile } from "node:child_process";
import fs from "node:fs";

const KB_PER_MB = 1024;

/**
 * @param {string} text contents of /proc/<pid>/status
 * @returns {number | null} VmRSS in KB
 */
export function parseVmRss(text) {
  const m = /^VmRSS:\s+(\d+)\s*kB/m.exec(text);
  return m ? Number(m[1]) : null;
}

/**
 * @param {string} text output of `ps -A -o pid=,ppid=,rss=`
 * @returns {{ pid: number, ppid: number, rssKb: number }[]}
 */
export function parsePsTable(text) {
  /** @type {{ pid: number, ppid: number, rssKb: number }[]} */
  const rows = [];
  for (const line of text.split("\n")) {
    const m = /^\s*(\d+)\s+(\d+)\s+(\d+)\s*$/.exec(line);
    if (m)
      rows.push({ pid: Number(m[1]), ppid: Number(m[2]), rssKb: Number(m[3]) });
  }
  return rows;
}

/**
 * Sum of RSS (KB) of all descendants of root in a process table.
 * @param {{ pid: number, ppid: number, rssKb: number }[]} rows
 * @param {number} root
 */
export function descendantsRssKb(rows, root) {
  /** @type {Map<number, number[]>} */
  const kids = new Map();
  for (const r of rows) {
    const list = kids.get(r.ppid);
    if (list) list.push(r.pid);
    else kids.set(r.ppid, [r.pid]);
  }
  const rss = new Map(rows.map((r) => [r.pid, r.rssKb]));
  let total = 0;
  const stack = [...(kids.get(root) ?? [])];
  const seen = new Set();
  while (stack.length) {
    const pid = /** @type {number} */ (stack.pop());
    if (seen.has(pid)) continue;
    seen.add(pid);
    total += rss.get(pid) ?? 0;
    stack.push(...(kids.get(pid) ?? []));
  }
  return total;
}

/** @param {number} pid @returns {number | null} VmRSS in KB */
function procRssKb(pid) {
  try {
    return parseVmRss(fs.readFileSync(`/proc/${pid}/status`, "utf8"));
  } catch {
    return null;
  }
}

/**
 * Pids of all descendants of pid, via /proc/<pid>/task/<tid>/children (each task
 * lists the same child pids). BFS over the subtree only: cheap enough to run
 * every sample tick without stalling the harness event loop.
 * @param {number} pid
 * @returns {Set<number>}
 */
export function linuxDescendants(pid) {
  /** @type {Set<number>} */
  const out = new Set();
  const queue = [pid];
  /** @type {Set<number>} */
  const seen = new Set([pid]);
  while (queue.length) {
    const p = /** @type {number} */ (queue.pop());
    let tasks;
    try {
      tasks = fs.readdirSync(`/proc/${p}/task`);
    } catch {
      continue; // process gone
    }
    for (const t of tasks) {
      let children;
      try {
        children = fs.readFileSync(`/proc/${p}/task/${t}/children`, "utf8");
      } catch {
        continue;
      }
      for (const c of children.trim().split(/\s+/)) {
        const cp = Number(c);
        if (cp > 0 && !seen.has(cp)) {
          seen.add(cp);
          out.add(cp);
          queue.push(cp);
        }
      }
    }
  }
  return out;
}

/** @param {string[]} args @returns {Promise<string>} */
function run(args) {
  return new Promise((resolve) => {
    execFile("ps", args, { encoding: "utf8" }, (err, stdout) =>
      resolve(err ? "" : stdout),
    );
  });
}

/**
 * Total RSS of pid plus all descendants, and the split for diagnosis.
 * @param {number} pid
 * @param {{ withChildren?: boolean }} [opts]
 * @returns {Promise<{ rssMb: number | null, mainMb: number | null, kidsMb: number }>}
 *   rssMb null when the process is gone (kidsMb is still the last read: descendants may outlive it)
 */
export async function readRss(pid, opts = {}) {
  const withChildren = opts.withChildren ?? true;
  if (process.platform === "linux") {
    const mainKb = procRssKb(pid);
    let kidsKb = 0;
    if (withChildren) {
      for (const d of linuxDescendants(pid)) kidsKb += procRssKb(d) ?? 0;
    }
    return {
      rssMb:
        mainKb === null
          ? kidsKb > 0
            ? kidsKb / KB_PER_MB
            : null
          : (mainKb + kidsKb) / KB_PER_MB,
      mainMb: mainKb === null ? null : mainKb / KB_PER_MB,
      kidsMb: kidsKb / KB_PER_MB,
    };
  }
  // macOS / other unix: one ps call for the whole table (main row included).
  const table = parsePsTable(await run(["-A", "-o", "pid=,ppid=,rss="]));
  const self = table.find((r) => r.pid === pid);
  const kidsKb = withChildren ? descendantsRssKb(table, pid) : 0;
  if (!self)
    return {
      rssMb: kidsKb > 0 ? kidsKb / KB_PER_MB : null,
      mainMb: null,
      kidsMb: kidsKb / KB_PER_MB,
    };
  const kids = withChildren ? kidsKb : 0;
  return {
    rssMb: (self.rssKb + kids) / KB_PER_MB,
    mainMb: self.rssKb / KB_PER_MB,
    kidsMb: kids / KB_PER_MB,
  };
}
