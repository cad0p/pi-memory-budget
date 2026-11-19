import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { test } from "node:test";
import {
  descendantsRssKb,
  parsePsTable,
  parseVmRss,
  readRss,
} from "../src/sampler.mjs";

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
