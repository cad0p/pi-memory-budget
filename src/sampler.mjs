// RSS sampling of a process and its descendants (recursive).
// Linux: /proc/<pid>/status VmRSS plus /proc/<pid>/task/*/children for the
// descendant walk (cheap: only the subtree, not all of /proc), plus
// /proc/<pid>/smaps for the deduplicated metric (issue #10: file-backed pages
// that several processes in the subtree map are one copy in RAM, but every
// VmRSS counts them). macOS: ps, summed RSS only.

import { execFile } from "node:child_process";
import fs from "node:fs";
import { measurePlatform } from "./platform.mjs";

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

/**
 * One /proc/<pid>/smaps mapping, reduced to what the deduplicated metric needs.
 * @typedef {object} SmapsMapping
 * @property {string | null} key dedupe key for a file-backed mapping
 *   ("dev:inode:offset", the header's raw tokens), null for anonymous memory
 * @property {number} rssKb Rss of this mapping in this process
 */

// Header line of an smaps mapping:
//   7f8a4c000000-7f8a4c021000 r-xp 00000000 08:02 1234567    /usr/bin/node
// address range, perms, file offset, device, inode, pathname (may be absent,
// may contain spaces, may end with " (deleted)").
const SMAPS_HEADER =
  /^[0-9a-f]+-[0-9a-f]+\s+[rwxps-]{4}\s+([0-9a-f]+)\s+([0-9a-f]+:[0-9a-f]+)\s+(\d+)(?:\s+(.*))?$/;

/**
 * Dedupe key of a mapping: null for anonymous memory (summed per process),
 * a string for anything the kernel backs by a file, so that the same file
 * region mapped by two processes is counted once.
 *
 * Anonymous memory is a mapping with no pathname (the [heap], [stack],
 * [anon:...] bracket names are the kernel's names for the same thing) — it is
 * never shared between unrelated processes, so it is summed. [vdso] and [vvar]
 * are the kernel's shared objects, one copy for every process on the machine,
 * so they get a fixed key and are counted once. Everything else — including
 * memfd, /dev/shm and " (deleted)" files — is keyed by device, inode and file
 * offset: an inode is unique for a shmem object, deleted or not.
 * @param {string} dev device token from the header, e.g. "08:02"
 * @param {string} inode inode token from the header
 * @param {string} offset file offset token from the header (hex)
 * @param {string | undefined} pathname pathname column, may be absent
 * @returns {string | null}
 */
export function mappingKey(dev, inode, offset, pathname) {
  const path = pathname?.trim() ?? "";
  if (path === "" || path.startsWith("[")) {
    if (path === "[vdso]") return "vdso";
    if (path === "[vvar]") return "vvar";
    return null;
  }
  return `${dev}:${inode}:${offset}`;
}

/**
 * Parses /proc/<pid>/smaps down to one entry per mapping: its dedupe key and
 * its Rss. Only the header line and the Rss line of each mapping are read (an
 * smaps entry is ~24 lines of which 22 are diagnostics); smaps is a snapshot,
 * not a stream, so the whole text is parsed in one pass.
 * @param {string} text contents of /proc/<pid>/smaps
 * @returns {SmapsMapping[]}
 */
export function parseSmaps(text) {
  /** @type {SmapsMapping[]} */
  const out = [];
  /** @type {string | null} */
  let key = null;
  /** @type {boolean} */
  let inMapping = false;
  const len = text.length;
  let start = 0;
  while (start < len) {
    let end = text.indexOf("\n", start);
    if (end < 0) end = len;
    const line = text.slice(start, end);
    start = end + 1;
    const c = line.charCodeAt(0);
    if (inMapping && c === 82 /* R */ && line.startsWith("Rss:")) {
      // "Rss:                 132 kB"
      const kb = Number.parseInt(line.slice(4).trim(), 10);
      if (Number.isFinite(kb)) out.push({ key, rssKb: kb });
      inMapping = false;
      continue;
    }
    // Mapping headers start with a hex address; the other value lines start
    // with a letter (Size:, Pss:, VmFlags:, ...), so only "Anonymous:" and
    // "AnonHugePages:" reach the regex and fail it.
    const hex =
      (c >= 48 && c <= 57) || (c >= 97 && c <= 102) || (c >= 65 && c <= 70);
    if (!hex || line.length < 30) continue;
    const h = SMAPS_HEADER.exec(line);
    if (h) {
      key = mappingKey(h[2], h[3], h[1], h[4]);
      inMapping = true;
    }
  }
  return out;
}

/**
 * Deduplicated RSS of a process subtree: the anonymous mappings of every
 * process summed, each file-backed mapping counted once across the subtree by
 * taking the largest Rss any one process has for the same key.
 *
 * This is an approximation of "RAM the subtree actually uses", deliberately
 * cheaper and more stable than a per-page union: the key is the mapping start
 * (device, inode, offset), so two processes that map the same file region with
 * different mapping splits (one maps 4 KiB at offset 0, the other 64 KiB at
 * offset 0) are counted once, but two overlapping regions with different starts
 * are counted twice. node children of pi map the node binary and the same
 * shared libraries at the same offsets, which is the case this is for; the
 * error on a partial overlap is at most the overlap of two mappings, a few MB.
 * @param {(SmapsMapping[] | null)[]} procs one entry per process, null when the
 *   process is already gone
 * @returns {{ totalKb: number, anonKb: number, fileKb: number }}
 */
export function dedupeMappings(procs) {
  let anonKb = 0;
  /** @type {Map<string, number>} */
  const file = new Map();
  for (const mappings of procs) {
    if (!mappings) continue;
    for (const m of mappings) {
      if (m.key === null) {
        anonKb += m.rssKb;
        continue;
      }
      const prev = file.get(m.key);
      if (prev === undefined || m.rssKb > prev) file.set(m.key, m.rssKb);
    }
  }
  let fileKb = 0;
  for (const kb of file.values()) fileKb += kb;
  return { totalKb: anonKb + fileKb, anonKb, fileKb };
}

/**
 * smaps of one process. A process that is gone (ENOENT) is skipped, like
 * procStatus; anything else — EACCES on a process we may not inspect, a kernel
 * without smaps — throws: the deduplicated metric must not silently degrade to
 * summed RSS, which is the number it exists to correct.
 * @param {number} pid
 * @returns {SmapsMapping[] | null}
 */
export function procSmaps(pid) {
  let text;
  try {
    text = fs.readFileSync(`/proc/${pid}/smaps`, "utf8");
  } catch (e) {
    const code = /** @type {NodeJS.ErrnoException} */ (e).code;
    if (code === "ENOENT") return null;
    throw new Error(
      `cannot read /proc/${pid}/smaps (${code ?? String(e)}): the deduplicated RSS metric needs it, refusing to fall back to summed RSS silently`,
    );
  }
  return parseSmaps(text);
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
 * they are null. dedupMb is the deduplicated total (issue #10): anonymous RSS
 * of every process in the subtree plus every file mapping counted once, taken
 * from /proc/<pid>/smaps. It is null where smaps does not exist, i.e. everywhere
 * but Linux.
 * @param {number} pid
 * @param {{ withChildren?: boolean }} [opts]
 * @returns {Promise<{ rssMb: number | null, mainMb: number | null, kidsMb: number, anonMb: number | null, fileMb: number | null, shmemMb: number | null, dedupMb: number | null }>}
 *   rssMb null when the process is gone (kidsMb is still the last read: descendants may outlive it)
 */
export async function readRss(pid, opts = {}) {
  const withChildren = opts.withChildren ?? true;
  if (measurePlatform() === "linux") {
    const pids = [pid];
    if (withChildren) for (const d of linuxDescendants(pid)) pids.push(d);
    /** @type {(ReturnType<typeof parseStatusRss> | null)[]} */
    const stats = pids.map(procStatus);
    // Separate reads: status is the cheap per-field breakdown, smaps the
    // per-mapping view the dedupe needs. A process that disappears between
    // the two reads is skipped by both (null).
    const mappings = pids.map(procSmaps);
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
    const dedupe = mappings.some((x) => x !== null)
      ? dedupeMappings(mappings)
      : null;
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
      dedupMb: dedupe === null ? null : dedupe.totalKb / KB_PER_MB,
    };
  }
  // macOS / other unix: one ps call for the whole table (main row included).
  // No anon/file breakdown and no way to see which pages processes share:
  // those stay null, and the checks are report-only there.
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
      dedupMb: null,
    };
  const kids = withChildren ? kidsKb : 0;
  return {
    rssMb: (self.rssKb + kids) / KB_PER_MB,
    mainMb: self.rssKb / KB_PER_MB,
    kidsMb: kids / KB_PER_MB,
    anonMb: null,
    fileMb: null,
    shmemMb: null,
    dedupMb: null,
  };
}
