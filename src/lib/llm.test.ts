import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { requestMaxTokens } from "./llm.ts";

describe("requestMaxTokens", () => {
  test("uses a lower default for OpenAI-compatible providers like OpenRouter", () => {
    assert.equal(
      requestMaxTokens({
        provider: "openai-compatible",
        model: "openai/gpt-6.1-sol",
        apiKey: "test-key",
      }),
      4000,
    );
  });

  test("allows an environment override for stricter limits", () => {
    process.env.LLM_MAX_TOKENS = "2048";
    try {
      assert.equal(
        requestMaxTokens({
          provider: "openai-compatible",
          model: "openai/gpt-6.1-sol",
          apiKey: "test-key",
        }),
        2048,
      );
    } finally {
      delete process.env.LLM_MAX_TOKENS;
    }
  });
});
