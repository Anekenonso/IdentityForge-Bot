import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  createMemory,
  encode,
  parse,
  parseAll,
  resolveCurrent,
  latestSnapshot,
  contentHash,
  normalizeContent,
  SNAPSHOT_ANCHOR,
  MEMORY_TYPES,
  type MemoryType,
} from "./envelope.ts";

describe("envelope round-trip", () => {
  test("encodes and parses a persona unchanged", () => {
    const m = createMemory({ type: "persona", content: "User is Alex, a Rust engineer on Sui." });
    const parsed = parse(encode(m));
    assert.ok(parsed, "should parse");
    assert.equal(parsed.id, m.id);
    assert.equal(parsed.type, "persona");
    assert.equal(parsed.content, m.content);
    assert.equal(parsed.contentHash, m.contentHash);
    assert.equal(parsed.supersedes, "none");
    assert.equal(parsed.v, 1);
  });

  test("ids are uuids generated in code", () => {
    const m = createMemory({ type: "goal", content: "Ship the hackathon entry." });
    assert.match(m.id, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
  });

  test("every memory type survives a round-trip", () => {
    for (const type of MEMORY_TYPES) {
      const m = createMemory({ type: type as MemoryType, content: `A fact of type ${type}.` });
      const parsed = parse(encode(m));
      assert.ok(parsed, `${type} should parse`);
      assert.equal(parsed.type, type);
      assert.equal(parsed.content, m.content);
    }
  });
});

describe("snapshot handling", () => {
  test("injects the anchor so in-band retrieval can find it", () => {
    const m = createMemory({ type: "snapshot", content: "Alex is a Sui engineer." });
    const raw = encode(m);
    assert.ok(raw.includes(SNAPSHOT_ANCHOR), "anchor must be present in stored text");
  });

  test("stripping the anchor on parse returns the original prose", () => {
    const m = createMemory({ type: "snapshot", content: "Alex is a Sui engineer." });
    const parsed = parse(encode(m));
    assert.ok(parsed);
    assert.equal(parsed.content, "Alex is a Sui engineer.");
  });

  test("does not double-inject the anchor", () => {
    const m = createMemory({ type: "snapshot", content: "Alex is a Sui engineer." });
    const once = encode(m);
    const twice = encode({ ...m, content: once });
    assert.equal(twice.split(SNAPSHOT_ANCHOR).length - 1, 1);
  });

  test("latestSnapshot picks the highest version", () => {
    const v1 = createMemory({ type: "snapshot", content: "v1", v: 1 });
    const v3 = createMemory({ type: "snapshot", content: "v3", v: 3 });
    const v2 = createMemory({ type: "snapshot", content: "v2", v: 2 });
    assert.equal(latestSnapshot([v1, v3, v2])?.v, 3);
  });

  test("latestSnapshot returns null when absent", () => {
    const fact = createMemory({ type: "preference", content: "prefers dark mode" });
    assert.equal(latestSnapshot([fact]), null);
  });
});

describe("supersession", () => {
  test("resolveCurrent drops superseded memories", () => {
    const old = createMemory({ type: "preference", content: "Lives in Berlin" });
    const next = createMemory({
      type: "preference",
      content: "Lives in Hanoi",
      supersedes: old.id,
    });
    const current = resolveCurrent([old, next]);
    assert.equal(current.length, 1);
    assert.equal(current[0]?.content, "Lives in Hanoi");
  });

  test("a three-way chain leaves only the newest", () => {
    const a = createMemory({ type: "preference", content: "one" });
    const b = createMemory({ type: "preference", content: "two", supersedes: a.id });
    const c = createMemory({ type: "preference", content: "three", supersedes: b.id });
    const current = resolveCurrent([a, b, c]);
    assert.equal(current.length, 1);
    assert.equal(current[0]?.id, c.id);
  });
});

describe("hashing and dedupe", () => {
  test("hash ignores case, whitespace and trailing punctuation", () => {
    const a = contentHash("Prefers dark mode.");
    const b = contentHash("  prefers   DARK mode  ");
    assert.equal(a, b);
  });

  test("different facts hash differently", () => {
    assert.notEqual(contentHash("Lives in Berlin"), contentHash("Lives in Hanoi"));
  });

  test("normalizeContent collapses inner whitespace but preserves content", () => {
    assert.equal(normalizeContent("a   b\n\nc."), "a b c");
  });
});

describe("parse is defensive", () => {
  test("returns null for non-envelope text instead of throwing", () => {
    assert.equal(parse("just some prose"), null);
    assert.equal(parse(""), null);
  });

  test("returns null for a malformed header", () => {
    assert.equal(parse("[IF1|id=not-a-uuid|type=persona|ts=x|v=1|supersedes=none]\nbody"), null);
  });

  test("returns null for an unknown type", () => {
    assert.equal(parse("[IF1|id=550e8400-e29b-41d4-a716-446655440000|type=bogus|ts=2026-01-01T00:00:00Z|v=1|supersedes=none]\nbody"), null);
  });

  test("parseAll counts unparseable rows instead of losing them silently", () => {
    const good = encode(createMemory({ type: "goal", content: "a goal" }));
    const { memories, skipped } = parseAll([good, "garbage", "more garbage"]);
    assert.equal(memories.length, 1);
    assert.equal(skipped, 2);
  });
});

describe("multi-line content", () => {
  test("snapshots preserve newlines in the body", () => {
    const body = "Line one.\nLine two.\nLine three.";
    const m = createMemory({ type: "snapshot", content: body });
    const parsed = parse(encode(m));
    assert.ok(parsed);
    assert.equal(parsed.content, body);
  });
});
