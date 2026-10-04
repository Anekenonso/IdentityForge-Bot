/**
 * Deterministic write gate — the concrete meaning of "code owns authority".
 *
 * The LLM only ever *proposes* memory candidates. This module decides what is
 * actually written. Every rule here is deterministic and unit-tested; none of
 * them call a model.
 */

import {
  candidateSchema,
  contentLimitFor,
  createMemory,
  normalizeContent,
  MEMORY_TYPES,
  type Candidate,
  type MemoryEnvelope,
  type MemoryType,
} from "./envelope.ts";

/** Types that change who the agent is, so they need a human in the loop. */
export const CONFIRMATION_REQUIRED: ReadonlySet<MemoryType> = new Set<MemoryType>([
  "persona",
  "goal",
]);

export const MAX_WRITES_PER_TURN = 5;
export const MAX_WRITES_PER_SESSION = 20;

/**
 * Fraction of a candidate's content tokens that must also appear in the user's
 * message. This is a heuristic, not a proof — the honest version of "the LLM
 * derived this from what the user said, not from something it recalled".
 * Tuned so "User is a Rust engineer" passes against "I'm a Rust engineer on Sui"
 * while an invented detail does not.
 */
export const USER_OVERLAP_THRESHOLD = 0.4;

const STOPWORDS = new Set([
  "a", "an", "the", "is", "are", "was", "were", "be", "been", "being",
  "to", "of", "in", "on", "at", "for", "with", "and", "or", "but", "as",
  "that", "this", "these", "those", "it", "its", "my", "me", "i", "you",
  "your", "he", "she", "they", "them", "his", "her", "their",
]);

export function tokenize(text: string): string[] {
  return normalizeContent(text)
    .split(/[^a-z0-9+#.@_-]+/)
    .filter((t) => t.length > 1 && !STOPWORDS.has(t));
}

export function userOverlap(candidate: string, userMessage: string): number {
  const contentTokens = new Set(tokenize(candidate));
  if (contentTokens.size === 0) return 0;
  const userTokens = new Set(tokenize(userMessage));
  let shared = 0;
  for (const token of contentTokens) if (userTokens.has(token)) shared += 1;
  return shared / contentTokens.size;
}

export type RejectionCode =
  | "INVALID_SCHEMA"
  | "UNKNOWN_TYPE"
  | "TOO_LONG"
  | "DERIVED_FROM_MEMORY"
  | "NOT_FROM_USER"
  | "DUPLICATE"
  | "TURN_CAP"
  | "SESSION_CAP"
  | "LOW_CONFIDENCE";

/** A candidate below this confidence is treated as a guess, not a stated fact. */
export const MIN_CONFIDENCE = 0.35;

export interface GateInput {
  raw: unknown;
  userMessage: string;
  /** Memories recalled this turn — used for dedupe and provenance checks. */
  recalled: readonly MemoryEnvelope[];
  /** Hashes already written in this session. */
  sessionHashes: ReadonlySet<string>;
  turnWriteCount: number;
  sessionWriteCount: number;
  /** False until the user has confirmed a persona/goal candidate in the UI. */
  confirmed?: boolean;
}

export interface GateDecision {
  accepted: boolean;
  needsConfirmation: boolean;
  memory: MemoryEnvelope | null;
  code: RejectionCode | null;
  reason: string;
  overlap: number;
}

export function evaluateCandidate(input: GateInput): GateDecision {
  const parsed = candidateSchema.safeParse(input.raw);
  if (!parsed.success) {
    return reject("INVALID_SCHEMA", "Candidate did not match the memory schema.");
  }
  const candidate: Candidate = parsed.data;
  const rejectAt = (code: RejectionCode, reason: string, overlap = 0): GateDecision => ({
    accepted: false,
    needsConfirmation: false,
    memory: null,
    code,
    reason,
    overlap,
  });

  if (!MEMORY_TYPES.includes(candidate.type)) {
    return rejectAt("UNKNOWN_TYPE", `Unknown memory type: ${candidate.type}`);
  }

  const limit = contentLimitFor(candidate.type);
  if (candidate.content.length > limit) {
    return rejectAt(
      "TOO_LONG",
      `Content is ${candidate.content.length} chars; ${candidate.type} allows ${limit}.`,
    );
  }

  // Provenance: reject anything that is a restatement of a recalled memory.
  // A memory that merely repeats something already stored adds no information
  // and is the classic vehicle for laundering injected text into the store.
  const normalized = normalizeContent(candidate.content);
  for (const memory of input.recalled) {
    const existing = normalizeContent(memory.content);
    if (existing === normalized || existing.includes(normalized) || normalized.includes(existing)) {
      return rejectAt(
        "DERIVED_FROM_MEMORY",
        "Candidate restates a recalled memory rather than new user information.",
      );
    }
  }

  const overlap = userOverlap(candidate.content, input.userMessage);
  if (overlap < USER_OVERLAP_THRESHOLD) {
    return rejectAt(
      "NOT_FROM_USER",
      `Only ${(overlap * 100).toFixed(0)}% of the candidate's content appears in the user's message.`,
      overlap,
    );
  }

  const memory = createMemory({ type: candidate.type, content: candidate.content });
  if (input.sessionHashes.has(memory.contentHash)) {
    return rejectAt("DUPLICATE", "Identical content already written this session.", overlap);
  }

  if (candidate.confidence < MIN_CONFIDENCE) {
    return rejectAt(
      "LOW_CONFIDENCE",
      `Confidence ${candidate.confidence.toFixed(2)} is below ${MIN_CONFIDENCE}.`,
      overlap,
    );
  }

  if (input.turnWriteCount >= MAX_WRITES_PER_TURN) {
    return rejectAt("TURN_CAP", `Turn cap of ${MAX_WRITES_PER_TURN} writes reached.`, overlap);
  }
  if (input.sessionWriteCount >= MAX_WRITES_PER_SESSION) {
    return rejectAt("SESSION_CAP", `Session cap of ${MAX_WRITES_PER_SESSION} writes reached.`, overlap);
  }

  const needsConfirmation = CONFIRMATION_REQUIRED.has(candidate.type);
  if (needsConfirmation && !input.confirmed) {
    return {
      accepted: false,
      needsConfirmation: true,
      memory,
      code: null,
      reason: `${candidate.type} changes the agent's identity; awaiting user confirmation.`,
      overlap,
    };
  }

  return {
    accepted: true,
    // An accepted decision has already cleared confirmation (if any). Reporting
    // needsConfirmation: true here would let a caller that checks the flag after
    // acceptance re-prompt for a write that is about to happen.
    needsConfirmation: false,
    memory,
    code: null,
    reason: "Accepted.",
    overlap,
  };
}

function reject(code: RejectionCode, reason: string): GateDecision {
  return {
    accepted: false,
    needsConfirmation: false,
    memory: null,
    code,
    reason,
    overlap: 0,
  };
}
