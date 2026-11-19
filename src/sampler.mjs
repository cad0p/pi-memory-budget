// RSS sampling of a process and its descendants.
// Linux: /proc/<pid>/status VmRSS. macOS (and other unix): ps.

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

/** @param {string[]} args @returns {Promise<string>} */
function run(args) {
  return new Promise((resolve) => {
    execFile("ps", args, { encoding: "utf8" }, (err, stdout) =>
      resolve(err ? "" : stdout),
    );
  });
}

/** Process table on Linux, from /proc (no ps dependency). */
function linuxTable() {
  /** @type {{ pid: number, ppid: number, rssKb: number }[]} */
  const rows = [];
  for (const name of fs.readdirSync("/proc")) {
    if (!/^\d+$/.test(name)) continue;
    try {
      const stat = fs.readFileSync(`/proc/${name}/stat`, "utf8");
      // comm may contain spaces and parens: parse after the last ")"
      const rest = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
      const ppid = Number(rest[1]);
      const status = fs.readFileSync(`/proc/${name}/status`, "utf8");
      rows.push({ pid: Number(name), ppid, rssKb: parseVmRss(status) ?? 0 });
    } catch {
      // process vanished while scanning
    }
  }
  return rows;
}

/**
 * RSS of pid in MB (null when the process is gone) and of its descendants.
 * @param {number} pid
 * @param {{ withChildren?: boolean }} [opts]
 * @returns {Promise<{ rssMb: number | null, kidsMb: number }>}
 */
export async function readRss(pid, opts = {}) {
  const withChildren = opts.withChildren ?? true;
  if (process.platform === "linux") {
    let rssKb = null;
    try {
      rssKb = parseVmRss(fs.readFileSync(`/proc/${pid}/status`, "utf8"));
    } catch {
      return { rssMb: null, kidsMb: 0 };
    }
    const kidsKb = withChildren ? descendantsRssKb(linuxTable(), pid) : 0;
    return {
      rssMb: rssKb === null ? null : rssKb / KB_PER_MB,
      kidsMb: kidsKb / KB_PER_MB,
    };
  }
  // macOS / other unix: one ps call for the whole table (rows include pid itself).
  const table = parsePsTable(await run(["-A", "-o", "pid=,ppid=,rss="]));
  const self = table.find((r) => r.pid === pid);
  if (!self) return { rssMb: null, kidsMb: 0 };
  return {
    rssMb: self.rssKb / KB_PER_MB,
    kidsMb: descendantsRssKb(table, pid) / KB_PER_MB,
  };
}
