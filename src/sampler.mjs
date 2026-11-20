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
 * RSS breakdown of /proc/<pid>/status: VmRSS = RssAnon + RssFile + RssShmem.
 * RssAnon is heap, stacks and malloc arenas; RssFile is page-cache-backed
 * (the session file, shared libraries); RssShmem is SysV/POSIX shared memory
 * (absent before Linux 4.15). Every field is nullable: a field that is not in
 * the file stays null so the caller can report "unavailable" instead of a
 * wrong 0.
 * @param {string} text contents of /proc/<pid>/status
 * @returns {{ rssKb: number | null, anonKb: number | null, fileKb: number | null, shmemKb: number | null }}
 */
export function parseStatusRss(text) {
  /** @param {string} name */
  const field = (name) => {
    const re = new RegExp(`^${name}:\\s+(\\d+)\\s*kB`, "m");
    const m = re.exec(text);
    return m ? Number(m[1]) : null;
  };
  return {
    rssKb: field("VmRSS"),
    anonKb: field("RssAnon"),
    fileKb: field("RssFile"),
    shmemKb: field("RssShmem"),
  };
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

/** @param {number} pid @returns {ReturnType<typeof parseStatusRss> | null} */
function procStatus(pid) {
  try {
    return parseStatusRss(fs.readFileSync(`/proc/${pid}/status`, "utf8"));
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
 * On Linux anonMb/fileMb/shmemMb are the same sum per /proc RssAnon/RssFile/
 * RssShmem (null when the kernel does not report them); on other platforms
 * they are null.
 * @param {number} pid
 * @param {{ withChildren?: boolean }} [opts]
 * @returns {Promise<{ rssMb: number | null, mainMb: number | null, kidsMb: number, anonMb: number | null, fileMb: number | null, shmemMb: number | null }>}
 *   rssMb null when the process is gone (kidsMb is still the last read: descendants may outlive it)
 */
export async function readRss(pid, opts = {}) {
  const withChildren = opts.withChildren ?? true;
  if (process.platform === "linux") {
    /** @type {(ReturnType<typeof parseStatusRss> | null)[]} */
    const stats = [procStatus(pid)];
    if (withChildren) {
      for (const d of linuxDescendants(pid)) stats.push(procStatus(d));
    }
    const mainKb = stats[0]?.rssKb ?? null;
    let kidsKb = 0;
    for (let i = 1; i < stats.length; i++) kidsKb += stats[i]?.rssKb ?? 0;
    /** Sum of one /proc field over main + descendants; null when nobody
     * reports it.
     * @param {"anonKb" | "fileKb" | "shmemKb"} k */
    const sumField = (k) => {
      let t = 0;
      let any = false;
      for (const s of stats) {
        if (s && s[k] !== null) {
          t += /** @type {number} */ (s[k]);
          any = true;
        }
      }
      return any ? t / KB_PER_MB : null;
    };
    return {
      rssMb:
        mainKb === null
          ? kidsKb > 0
            ? kidsKb / KB_PER_MB
            : null
          : (mainKb + kidsKb) / KB_PER_MB,
      mainMb: mainKb === null ? null : mainKb / KB_PER_MB,
      kidsMb: kidsKb / KB_PER_MB,
      anonMb: sumField("anonKb"),
      fileMb: sumField("fileKb"),
      shmemMb: sumField("shmemKb"),
    };
  }
  // macOS / other unix: one ps call for the whole table (main row included).
  // No anon/file breakdown there: report nulls.
  const table = parsePsTable(await run(["-A", "-o", "pid=,ppid=,rss="]));
  const self = table.find((r) => r.pid === pid);
  const kidsKb = withChildren ? descendantsRssKb(table, pid) : 0;
  if (!self)
    return {
      rssMb: kidsKb > 0 ? kidsKb / KB_PER_MB : null,
      mainMb: null,
      kidsMb: kidsKb / KB_PER_MB,
      anonMb: null,
      fileMb: null,
      shmemMb: null,
    };
  const kids = withChildren ? kidsKb : 0;
  return {
    rssMb: (self.rssKb + kids) / KB_PER_MB,
    mainMb: self.rssKb / KB_PER_MB,
    kidsMb: kids / KB_PER_MB,
    anonMb: null,
    fileMb: null,
    shmemMb: null,
  };
}
