import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import {
  ensureFixture,
  fixturePath,
  mulberry32,
  writeFixture,
} from "../src/fixture.mjs";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pmb-fixture-test-"));
process.on("exit", () => fs.rmSync(dir, { recursive: true, force: true }));

/** @param {string} f */
const sha = (f) =>
  crypto.createHash("sha256").update(fs.readFileSync(f)).digest("hex");

test("mulberry32 is deterministic and in [0,1)", () => {
  const a = mulberry32(7);
  const b = mulberry32(7);
  for (let i = 0; i < 100; i++) {
    const x = a();
    assert.equal(x, b());
    assert.ok(x >= 0 && x < 1);
  }
  assert.notEqual(mulberry32(1)(), mulberry32(2)());
});

test("fixture follows pi's session format (v3 header, tree, entry types)", () => {
  const f = path.join(dir, "format.jsonl");
  const st = writeFixture(f, { mb: 8, seed: 3 });
  const lines = fs.readFileSync(f, "utf8").split("\n");
  assert.equal(lines.pop(), "", "file ends with a newline");
  const entries = lines.map((l) => JSON.parse(l));

  const [header, ...rest] = entries;
  assert.equal(header.type, "session");
  assert.equal(header.version, 3);
  assert.match(header.id, /^[0-9a-f]{8}-[0-9a-f]{4}-/);
  assert.ok(
    fs.existsSync(header.cwd),
    "header cwd exists (pi refuses a missing stored cwd)",
  );
  assert.ok(!Number.isNaN(Date.parse(header.timestamp)));
  assert.equal(header.parentId, undefined, "header has no tree fields");

  assert.equal(rest.length, st.entries);
  const ids = new Set();
  const calls = new Map();
  /** @type {Record<string, number>} */
  const types = {};
  let roots = 0;
  const children = new Map();
  for (const e of rest) {
    assert.match(e.id, /^[0-9a-f]{8}$/);
    assert.ok(!ids.has(e.id), "unique ids");
    if (e.parentId === null) roots++;
    else assert.ok(ids.has(e.parentId), "parentId points at an earlier entry");
    children.set(e.parentId, (children.get(e.parentId) ?? 0) + 1);
    ids.add(e.id);
    assert.ok(!Number.isNaN(Date.parse(e.timestamp)));
    types[e.type] = (types[e.type] ?? 0) + 1;
    if (e.type === "message") {
      const m = e.message;
      assert.equal(typeof m.timestamp, "number");
      if (m.role === "user") assert.equal(typeof m.content, "string");
      if (m.role === "assistant") {
        assert.ok(Array.isArray(m.content));
        assert.ok(
          m.usage && typeof m.usage.totalTokens === "number" && m.usage.cost,
        );
        assert.ok(["stop", "toolUse"].includes(m.stopReason));
        assert.ok(m.model && m.provider && m.api);
        for (const b of m.content) {
          assert.ok(["text", "thinking", "toolCall"].includes(b.type));
          if (b.type === "toolCall") calls.set(b.id, b.name);
        }
      }
      if (m.role === "toolResult") {
        assert.equal(
          calls.get(m.toolCallId),
          m.toolName,
          "toolResult answers an earlier toolCall",
        );
        assert.equal(typeof m.isError, "boolean");
        assert.equal(m.content[0].type, "text");
      }
    }
    if (e.type === "label") assert.ok(ids.has(e.targetId));
    if (e.type === "custom") assert.ok(e.customType && e.data);
    if (e.type === "custom_message")
      assert.ok(e.customType && typeof e.content === "string");
  }
  assert.equal(roots, 1);
  for (const t of [
    "message",
    "custom",
    "model_change",
    "thinking_level_change",
    "session_info",
  ]) {
    assert.ok(types[t] > 0, `has ${t} entries`);
  }
  assert.ok(st.types["message:user"] > 50);
  assert.ok(st.types["message:assistant"] > 50);
  assert.ok(st.types["message:toolResult"] > 50);
  assert.ok(st.types["message:system"] === 1);
  assert.ok(st.types.label > 0, "labels");
});

test("fixture has branches, thinking blocks and varied tool result sizes", () => {
  const f = path.join(dir, "mix.jsonl");
  const st = writeFixture(f, { mb: 40, seed: 5 });
  assert.ok(st.branches >= 3, `branches: ${st.branches}`);
  let thinking = 0;
  let min = Infinity;
  let max = 0;
  for (const line of fs.readFileSync(f, "utf8").split("\n")) {
    if (!line) continue;
    const e = JSON.parse(line);
    if (e.type !== "message") continue;
    if (
      e.message.role === "assistant" &&
      e.message.content.some(
        (/** @type {{type: string}} */ b) => b.type === "thinking",
      )
    )
      thinking++;
    if (e.message.role === "toolResult") {
      const n = e.message.content[0].text.length;
      min = Math.min(min, n);
      max = Math.max(max, n);
    }
  }
  assert.ok(thinking > 100);
  assert.ok(min < 100, `tiny tool results: ${min}`);
  assert.ok(
    max > 20000 && max <= 50000,
    `large tool results up to ~50 KB: ${max}`,
  );
});

test("fixture is deterministic per seed and size, and the size is on target", () => {
  const a = path.join(dir, "a.jsonl");
  const b = path.join(dir, "b.jsonl");
  const c = path.join(dir, "c.jsonl");
  const d = path.join(dir, "d.jsonl");
  const sa = writeFixture(a, { mb: 6, seed: 11 });
  writeFixture(b, { mb: 6, seed: 11 });
  writeFixture(c, { mb: 6, seed: 12 });
  writeFixture(d, { mb: 9, seed: 11 });
  assert.equal(sha(a), sha(b));
  assert.notEqual(sha(a), sha(c));
  assert.notEqual(sha(a), sha(d));
  const target = 6 * 1024 * 1024;
  assert.equal(fs.statSync(a).size, sa.bytes);
  assert.ok(
    sa.bytes >= target && sa.bytes < target + 200 * 1024,
    `size ${sa.bytes}`,
  );
});

test("ensureFixture caches by seed and size and leaves no temp files", () => {
  const cache = path.join(dir, "cache");
  const first = ensureFixture(cache, 2, 4);
  assert.equal(first.generated, true);
  assert.equal(first.file, fixturePath(cache, 2, 4));
  const second = ensureFixture(cache, 2, 4);
  assert.equal(second.generated, false);
  assert.equal(sha(first.file), sha(second.file));
  assert.deepEqual(fs.readdirSync(cache), [path.basename(first.file)]);
  assert.equal(ensureFixture(cache, 3, 4).generated, true);
});
