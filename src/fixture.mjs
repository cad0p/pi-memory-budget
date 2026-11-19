// Deterministic generator for synthetic pi session files (JSONL, version 3).
// Format reference: pi docs/session-format.md and docs/message-types.md.
// Everything is generated from the seed: no real session content is used.

import fs from "node:fs";
import path from "node:path";

const MB = 1024 * 1024;
export const FIXTURE_FORMAT = 1;

/** @param {number} seed */
export function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const WORDS = (
  "the of and to in is it that for with as on be this by from or an are was not " +
  "file path error build test run line code value function module config result " +
  "session entry message agent tool call output input memory buffer string array " +
  "object import export const let return async await promise stream parse render " +
  "commit branch merge review issue check status warn info debug trace request " +
  "response handler server client socket timeout retry cache index search query " +
  "update delete create read write append remove list map filter reduce sort"
).split(" ");

/** @type {{ name: string, args: (r: () => number) => Record<string, unknown> }[]} */
const TOOLS = [
  {
    name: "bash",
    args: (r) => ({ command: `echo ${word(r)} && ls -la ${word(r)}` }),
  },
  { name: "read", args: (r) => ({ path: `src/${word(r)}/${word(r)}.ts` }) },
  {
    name: "edit",
    args: (r) => ({
      path: `src/${word(r)}.ts`,
      edits: [{ oldText: sentence(r, 6), newText: sentence(r, 8) }],
    }),
  },
  {
    name: "write",
    args: (r) => ({ path: `docs/${word(r)}.md`, content: sentence(r, 40) }),
  },
  { name: "grep", args: (r) => ({ pattern: word(r), path: "src" }) },
];
const CUSTOM_TYPES = [
  "synthetic-ext-state",
  "synthetic-tracker",
  "synthetic-usage-note",
];

/** @param {() => number} r */
function word(r) {
  return WORDS[Math.floor(r() * WORDS.length)];
}

/**
 * @param {() => number} r
 * @param {number} n
 */
function sentence(r, n) {
  const out = [];
  for (let i = 0; i < n; i++) out.push(word(r));
  return out.join(" ");
}

/**
 * Pool of pseudo-random text that payloads are sliced from (cheap to generate
 * 200 MB of content from).
 * @param {() => number} r
 */
function makePool(r) {
  const parts = [];
  let len = 0;
  while (len < 1.5 * MB) {
    const line = sentence(r, 4 + Math.floor(r() * 14));
    parts.push(line);
    len += line.length + 1;
  }
  return parts.join("\n");
}

/**
 * @typedef {object} FixtureOptions
 * @property {number} mb target size in MiB
 * @property {number} [seed]
 * @property {string} [cwd] cwd recorded in the session header (default: filesystem root, which always exists)
 */

/**
 * @typedef {object} FixtureStats
 * @property {number} bytes
 * @property {number} entries
 * @property {number} branches entries whose parent already has a child
 * @property {Record<string, number>} types counts per entry type (messages by role)
 */

/**
 * Writes a synthetic session file of about `mb` MiB.
 * @param {string} file output path
 * @param {FixtureOptions} opts
 * @returns {FixtureStats}
 */
export function writeFixture(file, opts) {
  const seed = opts.seed ?? 1;
  const targetBytes = Math.round(opts.mb * MB);
  const r = mulberry32(seed);
  const pool = makePool(r);
  const salt = Math.floor(r() * 0xffffffff) >>> 0;
  const baseMs = Date.UTC(2026, 0, 1);
  // pi refuses a session whose stored cwd does not exist, so default to one that does.
  const sessionCwd = opts.cwd ?? path.parse(process.cwd()).root;

  let counter = 0;
  let clock = 0;
  const nextId = () => {
    // Bijective 32-bit mixing of a counter: unique ids without a lookup set.
    let x = (counter++ ^ salt) >>> 0;
    x = Math.imul(x ^ (x >>> 16), 0x45d9f3b) >>> 0;
    x = Math.imul(x ^ (x >>> 16), 0x45d9f3b) >>> 0;
    x = (x ^ (x >>> 16)) >>> 0;
    return x.toString(16).padStart(8, "0");
  };
  /** @param {number} n */
  const text = (n) => {
    const start = Math.floor(r() * (pool.length - n));
    return pool.slice(start, start + n);
  };
  /** log-uniform integer in [lo, hi]
   * @param {number} lo @param {number} hi */
  const logInt = (lo, hi) =>
    Math.floor(Math.exp(Math.log(lo) + r() * (Math.log(hi) - Math.log(lo))));

  const fd = fs.openSync(file, "w");
  let bytes = 0;
  let entries = 0;
  let branches = 0;
  /** @type {Record<string, number>} */
  const types = {};
  /** @type {string[]} */
  let chunk = [];
  let chunkBytes = 0;
  const flush = () => {
    if (chunk.length) fs.writeSync(fd, chunk.join(""));
    chunk = [];
    chunkBytes = 0;
  };
  /** @param {object} obj @param {string} [kind] */
  const emit = (obj, kind) => {
    const line = `${JSON.stringify(obj)}\n`;
    const n = Buffer.byteLength(line);
    chunk.push(line);
    chunkBytes += n;
    bytes += n;
    if (kind) types[kind] = (types[kind] ?? 0) + 1;
    if (chunkBytes > 4 * MB) flush();
  };

  const uuid = () => {
    const h = () =>
      Math.floor(r() * 0xffffffff)
        .toString(16)
        .padStart(8, "0");
    const a = h();
    const b = h();
    const c = h();
    const d = h();
    return `${a}-${b.slice(0, 4)}-7${b.slice(5, 8)}-a${c.slice(1, 4)}-${c.slice(4)}${d}`;
  };

  try {
    emit(
      {
        type: "session",
        version: 3,
        id: uuid(),
        timestamp: new Date(baseMs).toISOString(),
        cwd: sessionCwd,
      },
      "session",
    );

    /** @type {string | null} */
    /** @type {string | null} */
    let tip = null;
    /** @type {string[]} recent user entries usable as branch points */
    const branchPoints = [];
    /** @type {Set<string>} parents that already have a child */
    const hasChild = new Set();
    /** @type {string[]} */
    const labelable = [];
    const stamp = () => {
      clock += 1500 + Math.floor(r() * 6000);
      return {
        iso: new Date(baseMs + clock).toISOString(),
        ms: baseMs + clock,
      };
    };
    /**
     * @param {object} body
     * @param {string} kind
     * @param {string | null} [parent]
     */
    const add = (body, kind, parent) => {
      const id = nextId();
      const parentId = parent === undefined ? tip : parent;
      if (parentId !== null && hasChild.has(parentId)) branches++;
      if (parentId !== null) hasChild.add(parentId);
      emit({ ...body, id, parentId, timestamp: stamp().iso }, kind);
      entries++;
      tip = id;
      return id;
    };
    /** @param {Record<string, unknown>} body */
    const message = (body) => ({
      type: "message",
      message: { ...body, timestamp: baseMs + clock },
    });
    /** @param {number} out */
    const usage = (out) => {
      const input = 800 + Math.floor(r() * 40000);
      return {
        input,
        output: out,
        cacheRead: Math.floor(r() * 90000),
        cacheWrite: Math.floor(r() * 3000),
        totalTokens: input + out,
        cost: {
          input: 0.003,
          output: 0.004,
          cacheRead: 0.001,
          cacheWrite: 0.002,
          total: 0.01,
        },
      };
    };

    add(
      message({
        role: "system",
        content: "",
        sections: { preamble: text(600), cwd: sessionCwd },
        toolsAdded: TOOLS.map((t) => ({
          name: t.name,
          description: text(120),
          parameters: { type: "object" },
        })),
      }),
      "message:system",
    );
    add(
      {
        type: "model_change",
        provider: "anthropic",
        modelId: "claude-sonnet-4-5",
      },
      "model_change",
    );
    add(
      { type: "thinking_level_change", thinkingLevel: "medium" },
      "thinking_level_change",
    );
    add({ type: "session_info", name: "synthetic session" }, "session_info");

    let turn = 0;
    while (bytes < targetBytes) {
      turn++;
      // Occasionally continue from an earlier user entry: a branch.
      /** @type {string | null} */
      let parent = tip;
      if (turn > 20 && branchPoints.length > 5 && r() < 0.004) {
        parent = branchPoints[Math.floor(r() * branchPoints.length)];
        if (r() < 0.5) {
          parent = add(
            {
              type: "branch_summary",
              fromId: tip,
              summary: text(200 + Math.floor(r() * 800)),
              details: { readFiles: [`src/${word(r)}.ts`], modifiedFiles: [] },
            },
            "branch_summary",
            parent,
          );
        }
      }
      const userId = add(
        message({ role: "user", content: text(logInt(20, 2500)) }),
        "message:user",
        parent,
      );
      branchPoints.push(userId);
      if (branchPoints.length > 400) branchPoints.splice(0, 100);
      labelable.push(userId);

      const steps = 1 + Math.floor(r() * 4);
      for (let s = 0; s < steps; s++) {
        const nCalls = r() < 0.15 ? 0 : 1 + Math.floor(r() * 3);
        /** @type {object[]} */
        const content = [];
        if (r() < 0.8) {
          content.push({
            type: "thinking",
            thinking: text(logInt(100, 4000)),
            thinkingSignature: text(120).replace(/\s+/g, ""),
          });
        }
        if (r() < 0.7 || nCalls === 0)
          content.push({ type: "text", text: text(logInt(30, 1800)) });
        /** @type {{id: string, name: string}[]} */
        const calls = [];
        for (let c = 0; c < nCalls; c++) {
          const tool = TOOLS[Math.floor(r() * TOOLS.length)];
          const callId = `toolu_${nextIdLike(r)}`;
          calls.push({ id: callId, name: tool.name });
          content.push({
            type: "toolCall",
            id: callId,
            name: tool.name,
            arguments: tool.args(r),
          });
        }
        const out = 50 + Math.floor(r() * 1500);
        add(
          message({
            role: "assistant",
            content,
            api: "anthropic-messages",
            provider: "anthropic",
            model: "claude-sonnet-4-5",
            thinkingLevel: "medium",
            usage: usage(out),
            stopReason: nCalls ? "toolUse" : "stop",
          }),
          "message:assistant",
        );
        for (const call of calls) {
          // tiny (tens of bytes) up to ~50 KB, heavy on the small side
          const size = r() < 0.04 ? logInt(20000, 50000) : logInt(20, 6000);
          const id = add(
            message({
              role: "toolResult",
              toolCallId: call.id,
              toolName: call.name,
              content: [{ type: "text", text: text(size) }],
              isError: r() < 0.05,
            }),
            "message:toolResult",
          );
          if (r() < 0.02) labelable.push(id);
        }
        if (nCalls === 0) break;
      }
      if (r() < 0.06) {
        add(
          {
            type: "custom",
            customType: CUSTOM_TYPES[Math.floor(r() * CUSTOM_TYPES.length)],
            data: { count: turn, note: text(logInt(10, 300)) },
          },
          "custom",
        );
      }
      if (r() < 0.012) {
        add(
          {
            type: "custom_message",
            customType: "synthetic-injected-context",
            content: text(logInt(100, 2000)),
            display: r() < 0.5,
          },
          "custom_message",
        );
      }
      if (r() < 0.02) {
        // usage: model-attributed accounting that is not a message (e.g. cache
        // warming); hidden from the conversation tree
        add(
          {
            type: "usage",
            kind: "cache_warm",
            provider: "anthropic",
            model: "claude-sonnet-4-5",
            usage: {
              input: 0,
              output: 0,
              cacheRead: 20000 + Math.floor(r() * 80000),
              cacheWrite: 0,
              totalTokens: 0,
              cost: {
                input: 0,
                output: 0,
                cacheRead: 0.01,
                cacheWrite: 0,
                total: 0.01,
              },
            },
          },
          "usage",
        );
      }
      if (r() < 0.004) {
        // compaction: summary + prompt checkpoint; firstKeptEntryId keeps the
        // tail of the history, like a real long session
        const kept = branchPoints[Math.max(0, branchPoints.length - 1)];
        add(
          {
            type: "compaction",
            summary: text(logInt(500, 4000)),
            firstKeptEntryId: kept,
            tokensBefore: 60000 + Math.floor(r() * 100000),
            systemMessage: {
              role: "system",
              content: "",
              sections: { preamble: text(600) },
              toolsAdded: [],
              timestamp: baseMs + clock,
            },
            details: {
              readFiles: [`src/${word(r)}.ts`, `docs/${word(r)}.md`],
              modifiedFiles: [`src/${word(r)}.ts`],
            },
          },
          "compaction",
        );
      }
      if (r() < 0.01) {
        add(
          {
            type: "label",
            targetId: labelable[Math.floor(r() * labelable.length)],
            label: `checkpoint-${turn}`,
          },
          "label",
        );
      }
    }
    flush();
  } finally {
    fs.closeSync(fd);
  }
  return { bytes, entries, branches, types };
}

/** @param {() => number} r */
function nextIdLike(r) {
  let s = "";
  for (let i = 0; i < 16; i++) s += Math.floor(r() * 16).toString(16);
  return s;
}

/**
 * Cache path of a fixture for (seed, mb) under dir.
 * @param {string} dir
 * @param {number} mb
 * @param {number} seed
 */
export function fixturePath(dir, mb, seed) {
  return path.join(dir, `session-v${FIXTURE_FORMAT}-seed${seed}-${mb}mb.jsonl`);
}

/**
 * Returns the cached fixture for (seed, mb), generating it when absent. The
 * file is written under a temporary name and renamed, so a half-written file
 * is never reused.
 * @param {string} dir
 * @param {number} mb
 * @param {number} seed
 * @returns {{ file: string, generated: boolean }}
 */
export function ensureFixture(dir, mb, seed) {
  fs.mkdirSync(dir, { recursive: true });
  const file = fixturePath(dir, mb, seed);
  if (fs.existsSync(file) && fs.statSync(file).size > 0)
    return { file, generated: false };
  const tmp = `${file}.${process.pid}.tmp`;
  try {
    writeFixture(tmp, { mb, seed });
    fs.renameSync(tmp, file);
  } catch (err) {
    fs.rmSync(tmp, { force: true });
    throw err;
  }
  return { file, generated: true };
}
