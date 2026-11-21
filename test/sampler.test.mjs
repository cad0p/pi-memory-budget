import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { test } from "node:test";
import {
  dedupeMappings,
  descendantsRssKb,
  mappingKey,
  parsePsTable,
  parseSmaps,
  parseStatusRss,
  parseVmRss,
  procSmaps,
  readRss,
} from "../src/sampler.mjs";

/**
 * One mapping of a synthetic /proc/<pid>/smaps: the header plus the same
 * ~20 diagnostic lines the kernel writes, of which only Rss is read.
 * @param {{ start?: string, perms?: string, offset?: string, dev?: string, inode?: string, path?: string, rssKb: number }} m
 */
function smapsEntry(m) {
  const start = m.start ?? "7f0000000000";
  const end = `${start.slice(0, 8)}1000`;
  const header = `${start}-${end} ${m.perms ?? "rw-p"} ${m.offset ?? "00000000"} ${m.dev ?? "00:00"} ${m.inode ?? "0"}${m.path ? `    ${m.path}` : ""}`;
  const pad = (/** @type {string} */ label, /** @type {number} */ kb) =>
    `${label}${" ".repeat(22 - label.length)}${kb} kB`;
  return [
    header,
    pad("Size:", m.rssKb),
    pad("KernelPageSize:", 4),
    pad("MMUPageSize:", 4),
    pad("Rss:", m.rssKb),
    pad("Pss:", Math.floor(m.rssKb / 2)),
    pad("Shared_Clean:", 0),
    pad("Private_Dirty:", m.rssKb),
    pad("Referenced:", m.rssKb),
    pad("Anonymous:", m.rssKb),
    pad("AnonHugePages:", 0),
    "VmFlags: rd wr mr mw me ac sd",
    "",
  ].join("\n");
}

test("parseVmRss reads the VmRSS line of /proc/<pid>/status", () => {
  const status =
    "Name:\tnode\nVmPeak:\t  900000 kB\nVmRSS:\t  123456 kB\nVmHWM:\t  200000 kB\n";
  assert.equal(parseVmRss(status), 123456);
  assert.equal(parseVmRss("Name:\tx\n"), null);
});

test("parsePsTable parses macOS/BSD ps output and ignores junk lines", () => {
  const out =
    "    1     0   1000\n  200     1  50000\n  201   200   2048\nheader junk\n";
  assert.deepEqual(parsePsTable(out), [
    { pid: 1, ppid: 0, rssKb: 1000 },
    { pid: 200, ppid: 1, rssKb: 50000 },
    { pid: 201, ppid: 200, rssKb: 2048 },
  ]);
});

test("descendantsRssKb sums all descendants, not the root nor siblings", () => {
  const rows = [
    { pid: 1, ppid: 0, rssKb: 10 },
    { pid: 2, ppid: 1, rssKb: 100 },
    { pid: 3, ppid: 2, rssKb: 1000 },
    { pid: 4, ppid: 3, rssKb: 10000 },
    { pid: 5, ppid: 1, rssKb: 7 },
    { pid: 6, ppid: 99, rssKb: 5 },
  ];
  assert.equal(descendantsRssKb(rows, 2), 11000);
  assert.equal(descendantsRssKb(rows, 1), 100 + 1000 + 10000 + 7);
  assert.equal(descendantsRssKb(rows, 4), 0);
});

test("readRss reports this process and a child process separately", async () => {
  const me = await readRss(process.pid);
  assert.ok(me.rssMb !== null && me.rssMb > 10, `rss ${me.rssMb}`);
  const kid = spawn(
    process.execPath,
    ["-e", "const b=Buffer.alloc(40*1024*1024,1);setInterval(()=>b[0]++,500)"],
    { stdio: "ignore" },
  );
  try {
    await new Promise((r) => setTimeout(r, 1500));
    const withKid = await readRss(process.pid);
    assert.ok(withKid.kidsMb > 40, `children ${withKid.kidsMb}`);
    const noKids = await readRss(process.pid, { withChildren: false });
    if (process.platform === "linux") assert.equal(noKids.kidsMb, 0);
  } finally {
    kid.kill("SIGKILL");
  }
});

test("readRss returns null for a process that does not exist", async () => {
  const r = await readRss(2 ** 22 - 3);
  assert.equal(r.rssMb, null);
});

test("parseStatusRss reads VmRSS and the anon/file/shmem breakdown", () => {
  const status = [
    "Name:\tnode",
    "VmRSS:\t  200000 kB",
    "RssAnon:\t  150000 kB",
    "RssFile:\t   49000 kB",
    "RssShmem:\t    1000 kB",
    "VmHWM:\t  210000 kB",
  ].join("\n");
  assert.deepEqual(parseStatusRss(status), {
    rssKb: 200000,
    anonKb: 150000,
    fileKb: 49000,
    shmemKb: 1000,
  });
  // Pre-4.15 kernels have no RssShmem: the field stays null, not 0.
  const noShmem = parseStatusRss("VmRSS:\t 100 kB\nRssAnon:\t 90 kB\n");
  assert.deepEqual(noShmem, {
    rssKb: 100,
    anonKb: 90,
    fileKb: null,
    shmemKb: null,
  });
});

test("parseSmaps keeps the dedupe key and Rss of every mapping", () => {
  const text = [
    smapsEntry({
      offset: "00000000",
      dev: "08:02",
      inode: "4242",
      path: "/usr/lib/libc.so.6",
      rssKb: 1200,
    }),
    smapsEntry({ path: "[heap]", rssKb: 300 }),
    smapsEntry({
      path: "/usr/bin/node",
      perms: "r-xp",
      inode: "99",
      rssKb: 40,
    }),
  ].join("");
  assert.deepEqual(parseSmaps(text), [
    { key: "08:02:4242:00000000", rssKb: 1200 },
    { key: null, rssKb: 300 },
    { key: "00:00:99:00000000", rssKb: 40 },
  ]);
  // An empty or headerless file is no mappings, not an error.
  assert.deepEqual(parseSmaps(""), []);
  assert.deepEqual(parseSmaps("Name: x\nRss: 4 kB\n"), []);
});

test("mappingKey: anonymous vs file-backed, shmem and deleted files by inode", () => {
  // no pathname, [heap], [stack], [anon:...]: anonymous, summed per process
  assert.equal(mappingKey("00:00", "0", "00000000", undefined), null);
  assert.equal(mappingKey("00:00", "0", "00000000", ""), null);
  assert.equal(mappingKey("00:00", "0", "00000000", "[heap]"), null);
  assert.equal(mappingKey("00:00", "0", "00000000", "[stack]"), null);
  assert.equal(mappingKey("00:00", "0", "00000000", "[anon:thread]"), null);
  // the kernel's shared objects: one copy per machine, counted once
  assert.equal(mappingKey("00:00", "0", "00000000", "[vdso]"), "vdso");
  assert.equal(mappingKey("00:00", "0", "00000000", "[vvar]"), "vvar");
  // files, memfd, /dev/shm, deleted files: by device, inode and offset
  assert.equal(
    mappingKey("08:02", "4242", "00000000", "/usr/bin/node"),
    "08:02:4242:00000000",
  );
  assert.equal(
    mappingKey("00:1e", "777", "00100000", "/memfd:session (deleted)"),
    "00:1e:777:00100000",
  );
  assert.equal(
    mappingKey("00:1e", "778", "00000000", "/dev/shm/pi-index"),
    "00:1e:778:00000000",
  );
  assert.equal(
    mappingKey("08:02", "4242", "00000000", "/usr/bin/node (deleted)"),
    "08:02:4242:00000000",
    "a deleted file keeps its inode key",
  );
});

test("dedupeMappings: anonymous summed, a shared file mapping counted once", () => {
  // two node processes: the same node binary and libc (same dev:inode:offset,
  // different Rss), each with its own anonymous heap
  const parent = parseSmaps(
    [
      smapsEntry({ inode: "99", path: "/usr/bin/node", rssKb: 20000 }),
      smapsEntry({ inode: "77", path: "/usr/lib/libc.so.6", rssKb: 4000 }),
      smapsEntry({ path: "[heap]", rssKb: 50000 }),
      smapsEntry({ rssKb: 1000 }),
    ].join(""),
  );
  const child = parseSmaps(
    [
      smapsEntry({ inode: "99", path: "/usr/bin/node", rssKb: 18000 }),
      smapsEntry({ inode: "77", path: "/usr/lib/libc.so.6", rssKb: 4000 }),
      smapsEntry({ path: "[heap]", rssKb: 5000 }),
    ].join(""),
  );
  const d = dedupeMappings([parent, child]);
  // anon 50000 + 1000 + 5000; files: max(20000,18000) + 4000
  assert.equal(d.anonKb, 56000);
  assert.equal(d.fileKb, 24000);
  assert.equal(d.totalKb, 80000);
  // summed RSS of the same two processes would be 20000+4000+50000+1000
  // +18000+4000+5000 = 102000 KB: the shared pages are 22000 KB of it.
  assert.equal(
    dedupeMappings([parent]).totalKb,
    75000,
    "one process: no dedupe",
  );
  // a process that is already gone contributes nothing
  assert.equal(dedupeMappings([parent, null]).totalKb, 75000);
});

test("dedupeMappings takes the max Rss of a key, not the sum", () => {
  const a = [{ key: "08:02:1:00000000", rssKb: 2000 }];
  const b = [{ key: "08:02:1:00000000", rssKb: 5000 }];
  const c = [{ key: "08:02:1:00000000", rssKb: 1000 }];
  assert.equal(dedupeMappings([a, b, c]).fileKb, 5000);
  // different offsets in the same file are different keys (two regions)
  const d = [{ key: "08:02:1:00000000", rssKb: 2000 }];
  const e = [{ key: "08:02:1:00100000", rssKb: 3000 }];
  assert.equal(dedupeMappings([d, e]).fileKb, 5000);
});

test("procSmaps returns null for a gone process and refuses to guess on EACCES", () => {
  assert.equal(procSmaps(2 ** 22 - 3), null);
  if (process.platform === "linux" && process.getuid?.() !== 0) {
    // /proc/1/smaps is not ours to read: the metric must fail loudly, never
    // silently fall back to summed RSS (which is the number it corrects).
    assert.throws(() => procSmaps(1), /refusing to fall back to summed RSS/);
  }
});

test("readRss dedupes the file pages a node child shares with this process", async () => {
  if (process.platform !== "linux") return;
  const kid = spawn(
    process.execPath,
    ["-e", "const b=Buffer.alloc(5*1024*1024,1);setInterval(()=>b[0]++,500)"],
    { stdio: "ignore" },
  );
  try {
    await new Promise((r) => setTimeout(r, 1500));
    const r = await readRss(process.pid);
    assert.ok(r.dedupMb !== null && r.rssMb !== null);
    // The child maps the same node binary and libs: summed RSS charges them
    // twice, the deduplicated metric once (issue #10).
    assert.ok(
      r.rssMb - r.dedupMb > 20,
      `summed ${r.rssMb.toFixed(1)} vs dedupe ${r.dedupMb.toFixed(1)}: child file pages not deduplicated`,
    );
    assert.ok(r.dedupMb > 30, `dedupe ${r.dedupMb}`);
  } finally {
    kid.kill("SIGKILL");
  }
});

test("readRss reports the anon/file breakdown on Linux", async () => {
  const r = await readRss(process.pid, { withChildren: false });
  if (process.platform !== "linux") {
    assert.equal(r.anonMb, null);
    return;
  }
  assert.ok(r.anonMb !== null && r.anonMb > 0, `anon ${r.anonMb}`);
  assert.ok(r.fileMb !== null && r.fileMb > 0, `file ${r.fileMb}`);
  // RssAnon + RssFile + RssShmem = VmRSS on Linux.
  assert.ok(
    Math.abs(
      (r.anonMb ?? 0) + (r.fileMb ?? 0) + (r.shmemMb ?? 0) - (r.rssMb ?? 0),
    ) < 0.5,
    `breakdown ${r.anonMb}+${r.fileMb}+${r.shmemMb} vs ${r.rssMb}`,
  );
});
