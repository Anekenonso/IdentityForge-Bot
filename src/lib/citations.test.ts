import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { createMemory } from "./envelope.ts";
import {
  verifyCitations,
  looksLikeHistoryClaim,
  resolvableCitations,
} from "./citations.ts";

const a = createMemory({ type: "persona", content: "User is a Rust engineer." });
const b = createMemory({ type: "preference", content: "User prefers dark mode." });
const available = new Set([a.id, b.id]);

describe("history-claim detection", () => {
  test("detects second-person assertions", () => {
    assert.equal(looksLikeHistoryClaim("You are a Rust engineer."), true);
    assert.equal(looksLikeHistoryClaim("Your name is Alex."), true);
  });

  test("detects shared-history phrasings", () => {
    assert.equal(looksLikeHistoryClaim("We decided to use Sui."), true);
    assert.equal(looksLikeHistoryClaim("Earlier you mentioned TypeScript."), true);
  });

  test("does not fire on generic chatter", () => {
    assert.equal(looksLikeHistoryClaim("The weather is fine today."), false);
    assert.equal(looksLikeHistoryClaim("What would you like to do?"), false);
  });

  test("a question about the user is not a claim about the user", () => {
    assert.equal(looksLikeHistoryClaim("What would you like to work on?"), false);
    assert.equal(looksLikeHistoryClaim("Do you prefer TypeScript or JavaScript?"), false);
  });

  test("an assertion in the same reply as a question still counts", () => {
    assert.equal(
      looksLikeHistoryClaim("What should we build? You are a Rust engineer on Sui."),
      true,
    );
  });
});

describe("verifyCitations", () => {
  test("accepts a reply with no history claim and no citations", () => {
    const c = verifyCitations({
      reply: "I can help with that.",
      citedIds: [],
      availableIds: available,
    });
    assert.equal(c.valid, true);
    assert.equal(c.uncited, false);
  });

  test("rejects a history claim with no citation", () => {
    const c = verifyCitations({
      reply: "You are a Rust engineer working on Sui.",
      citedIds: [],
      availableIds: available,
    });
    assert.equal(c.valid, false);
    assert.equal(c.uncited, true);
    assert.equal(c.shouldRegenerate, true);
  });

  test("rejects a fabricated citation", () => {
    const c = verifyCitations({
      reply: "You are a Rust engineer.",
      citedIds: [a.id, "00000000-0000-4000-8000-000000000000"],
      availableIds: available,
    });
    assert.equal(c.valid, false);
    assert.equal(c.fabricated.length, 1);
  });

  test("accepts a correctly cited history claim", () => {
    const c = verifyCitations({
      reply: "You are a Rust engineer working on Sui.",
      citedIds: [a.id],
      availableIds: available,
    });
    assert.equal(c.valid, true);
    assert.equal(c.fabricated.length, 0);
  });

  test("flags every fabricated id, not just the first", () => {
    const c = verifyCitations({
      reply: "You are a Rust engineer who prefers dark mode.",
      citedIds: [a.id, b.id, "fake-1", "fake-2"],
      availableIds: available,
    });
    assert.equal(c.fabricated.length, 2);
  });
});

describe("resolvableCitations", () => {
  test("returns only the memories that were actually cited", () => {
    const out = resolvableCitations([a.id, "nope", b.id], [a, b]);
    assert.equal(out.length, 2);
    assert.deepEqual(
      out.map((m) => m.id).sort(),
      [a.id, b.id].sort(),
    );
  });

  test("returns empty when nothing resolves", () => {
    assert.deepEqual(resolvableCitations(["nope"], [a, b]), []);
  });
});
