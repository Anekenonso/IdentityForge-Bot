/**
 * Citation verification — the deterministic half of the hallucination guard.
 *
 * This is a *check*, not a proof that the reply is truthful. It establishes one
 * narrow, checkable property: every memory the reply claims to rely on was
 * actually in the recalled set. That is mechanically verifiable, which is why
 * it carries the H4 number; the free-text LLM judge runs separately as a
 * second signal (see plan §8).
 */

import type { MemoryEnvelope } from "./envelope.ts";
import { tokenize } from "./writegate.ts";

export const NO_MEMORY_REPLY = "I don't have that in my memory.";

/**
 * Signals that a reply is asserting something about the user's personal
 * history. Used only to decide whether an *empty* citation list is suspicious.
 * A heuristic, deliberately — it exists to catch the common case, not to
 * adjudicate truth.
 */
const HISTORY_CLAIM_PATTERNS: readonly RegExp[] = [
  /\byou (?:are|were|have|had|prefer|like|mentioned|said|told|work|live|use)\b/i,
  /\byour (?:name|goal|project|stack|team|email|deadline|role)\b/i,
  /\bwe (?:decided|agreed|chose|discussed|said)\b/i,
  /\b(?:you|we) (?:mentioned|discussed|talked about)\b/i,
  /\bearlier you\b/i,
  /\blast time\b/i,
  /\bpreviously\b/i,
];

/**
 * A question is not a history claim. "What would you like to work on?" contains
 * the same tokens as "You like working on Sui" but asserts nothing, and treating
 * it as a claim would force a citation on every ordinary reply.
 */
function isQuestion(sentence: string): boolean {
  const trimmed = sentence.trim();
  if (trimmed.endsWith("?")) return true;
  return /^(what|who|when|where|why|how|which|do|does|did|is|are|was|were|can|could|would|should|will|shall|may|might)\b/i.test(
    trimmed,
  );
}

export function looksLikeHistoryClaim(reply: string, userMessage?: string): boolean {
  const sentences = reply.split(/(?<=[.!?])\s+/).filter((s) => s.trim().length > 0);
  const userTokens = userMessage ? new Set(tokenize(userMessage)) : null;

  return sentences.some((sentence) => {
    if (isQuestion(sentence)) return false;
    const matches = HISTORY_CLAIM_PATTERNS.some((pattern) => pattern.test(sentence));
    if (!matches) return false;

    // If the sentence is merely echoing or acknowledging what the user literally said in this turn's message,
    // it is not a claim about unrecorded past history.
    if (userTokens && userTokens.size > 0) {
      const sentenceTokens = tokenize(sentence);
      if (sentenceTokens.length > 0) {
        let overlap = 0;
        for (const token of sentenceTokens) {
          if (userTokens.has(token)) overlap++;
        }
        if (overlap / sentenceTokens.length >= 0.35) {
          return false;
        }
      }
    }
    return true;
  });
}

export interface CitationCheck {
  valid: boolean;
  /** Cited ids that were not in the recalled set. */
  fabricated: string[];
  /** True when the reply makes a history claim but cites nothing. */
  uncited: boolean;
  /** Whether a regeneration is worth attempting, or we should fall back. */
  shouldRegenerate: boolean;
  reason: string;
}

export interface VerifyInput {
  reply: string;
  citedIds: readonly string[];
  /** Ids actually available in the reconstructed context this turn. */
  availableIds: ReadonlySet<string>;
  userMessage?: string;
}

export function verifyCitations(input: VerifyInput): CitationCheck {
  const { reply, citedIds, availableIds, userMessage } = input;

  if (citedIds.length === 0) {
    const uncited = looksLikeHistoryClaim(reply, userMessage);
    if (uncited) {
      return {
        valid: false,
        fabricated: [],
        uncited: true,
        shouldRegenerate: true,
        reason:
          "Reply asserts personal history with no citation. A claim with no " +
          "supporting memory is exactly the failure mode H4 measures.",
      };
    }
    return {
      valid: true,
      fabricated: [],
      uncited: false,
      shouldRegenerate: false,
      reason: "No history claim, so no citation was required.",
    };
  }

  const fabricated = citedIds.filter((id) => !availableIds.has(id));

  if (fabricated.length > 0) {
    return {
      valid: false,
      fabricated,
      uncited: false,
      shouldRegenerate: true,
      reason:
        `Cited ${fabricated.length} memory id(s) that were not in the recalled set: ` +
        fabricated.join(", "),
    };
  }

  return {
    valid: true,
    fabricated: [],
    uncited: false,
    shouldRegenerate: false,
    reason: "All cited ids are present in the recalled set.",
  };
}

/** Ids cited by the reply that actually exist, for rendering citations. */
export function resolvableCitations(
  citedIds: readonly string[],
  memories: readonly MemoryEnvelope[],
): MemoryEnvelope[] {
  const byId = new Map(memories.map((m) => [m.id, m]));
  return citedIds
    .map((id) => byId.get(id))
    .filter((m): m is MemoryEnvelope => m !== undefined);
}
