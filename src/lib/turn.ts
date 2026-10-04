/**
 * The turn orchestrator — the single place where the pieces are composed.
 *
 *   RECONSTRUCT -> ASSEMBLE -> INFER -> VERIFY -> GATE -> COMMIT
 *
 * Every step records evidence. Nothing here holds identity state between calls;
 * the caller owns the session object.
 */

import { encode, type MemoryEnvelope } from "./envelope.ts";
import { assemblePrompt, ONBOARDING_NOTE } from "./prompt.ts";
import { reconstruct } from "./snapshot.ts";
import { chatTurn, readLlmConfig, type LlmRole } from "./llm.ts";
import { verifyCitations, resolvableCitations, NO_MEMORY_REPLY } from "./citations.ts";
import { evaluateCandidate, type RejectionCode } from "./writegate.ts";
import { rememberMemory, type RecalledMemory } from "./walrus.ts";
import { entry, type EvidenceEntry, type Label } from "./evidence.ts";

export interface PendingWrite {
  memory: MemoryEnvelope;
  encoded: string;
  reason: string;
}

export interface RejectedWrite {
  type: string;
  content: string;
  code: RejectionCode | null;
  reason: string;
  overlap: number;
}

export interface TurnResult {
  reply: string;
  citations: MemoryEnvelope[];
  /** Memories the gate approved and that were written. */
  written: MemoryEnvelope[];
  /** Persona/goal candidates held for user confirmation. */
  pending: PendingWrite[];
  rejected: RejectedWrite[];
  evidence: EvidenceEntry[];
  empty: boolean;
  degraded: boolean;
  diagnostic: string | null;
  model: string;
  snapshotFound: boolean;
  droppedCount: number;
  latencyMs: number;
}

export interface TurnOptions {
  namespace: string;
  userMessage: string;
  role?: LlmRole;
  label?: Label;
  sessionHashes?: Set<string>;
  turnWriteCount?: number;
  sessionWriteCount?: number;
  /** Ids the user has confirmed this turn, for persona/goal candidates. */
  confirmedIds?: Set<string>;
  /** Prose for a snapshot consolidation, when one is requested. */
  consolidate?: string | null;
}

export async function runTurn(options: TurnOptions): Promise<TurnResult> {
  const started = Date.now();
  const {
    namespace,
    userMessage,
    role = "primary",
    label = "REAL",
    sessionHashes = new Set<string>(),
    turnWriteCount = 0,
    sessionWriteCount = 0,
    confirmedIds = new Set<string>(),
    consolidate = null,
  } = options;

  const evidence: EvidenceEntry[] = [];

  // 1. RECONSTRUCT ---------------------------------------------------------
  const reconstruction = await reconstruct(namespace, userMessage);
  evidence.push(
    entry({
      operation: "reconstruct",
      namespace,
      memoryId: null,
      blobId: null,
      latencyMs: reconstruction.latencyMs,
      resultSummary: reconstruction.snapshotMissing
        ? `Snapshot MISSING. ${reconstruction.facts.length} facts, ${reconstruction.inspectedSnapshotRows ?? 0} rows inspected.`
        : `${reconstruction.facts.length} facts, snapshot v${reconstruction.snapshot?.v ?? "-"}`,
      success: !reconstruction.snapshotMissing,
      label: "MEASURED",
      droppedCount: reconstruction.droppedCount,
      detail: {
        empty: reconstruction.empty,
        unparsed: reconstruction.unparsed,
        diagnostic: reconstruction.diagnostic,
      },
    }),
  );

  // 2. Empty state -> onboarding, no model call ---------------------------
  if (reconstruction.empty) {
    return {
      reply: ONBOARDING_NOTE,
      citations: [],
      written: [],
      pending: [],
      rejected: [],
      evidence,
      empty: true,
      degraded: false,
      diagnostic: null,
      model: "none",
      snapshotFound: false,
      droppedCount: 0,
      latencyMs: Date.now() - started,
    };
  }

  // 3. ASSEMBLE ------------------------------------------------------------
  const prompt = assemblePrompt(reconstruction, userMessage);
  const availableIds = new Set(prompt.availableIds);

  // 4. INFER ---------------------------------------------------------------
  const config = readLlmConfig(role);
  const turn = await chatTurn(
    { context: prompt.context, userMessage, system: consolidate ? prompt.system : undefined },
    role,
  );

  // 5. VERIFY citations ----------------------------------------------------
  let reply = turn.response.reply;
  let citedIds = turn.response.cited_ids;
  let degraded = turn.degraded;

  let check = verifyCitations({
    reply,
    citedIds,
    availableIds,
  });

  if (!check.valid && check.shouldRegenerate) {
    // One regeneration with a stricter instruction, then fall back. Never loop.
    const retry = await chatTurn(
      {
        context: prompt.context,
        userMessage: `${userMessage}\n\n[CONSTRAINT] Your previous answer cited memories that were not in the retrieved context, or asserted personal history without citing anything. Either cite only ids that appear in the context, or state plainly that you do not have that information.`,
      },
      role,
    );
    const retryCheck = verifyCitations({
      reply: retry.response.reply,
      citedIds: retry.response.cited_ids,
      availableIds,
    });

    if (retryCheck.valid) {
      reply = retry.response.reply;
      citedIds = retry.response.cited_ids;
      check = retryCheck;
      degraded = degraded || retry.degraded;
    } else {
      evidence.push(
        entry({
          operation: "citations",
          namespace,
          memoryId: null,
          blobId: null,
          latencyMs: retry.latencyMs,
          resultSummary: `Citation check failed twice; fell back. First: ${check.reason}. Retry: ${retryCheck.reason}`,
          success: false,
          label: "MEASURED",
        }),
      );
      reply = NO_MEMORY_REPLY;
      citedIds = [];
      degraded = true;
      return {
        reply,
        citations: [],
        written: [],
        pending: [],
        rejected: [],
        evidence,
        empty: false,
        degraded: true,
        diagnostic: `Unverifiable claim suppressed. ${retryCheck.reason}`,
        model: config.model,
        snapshotFound: reconstruction.snapshot !== null,
        droppedCount: reconstruction.droppedCount,
        latencyMs: Date.now() - started,
      };
    }
  }

  evidence.push(
    entry({
      operation: "citations",
      namespace,
      memoryId: null,
      blobId: null,
      latencyMs: 0,
      resultSummary: `${citedIds.length} cited, ${check.fabricated.length} fabricated`,
      success: check.valid,
      label: "MEASURED",
    }),
  );

  // 6. GATE candidates -----------------------------------------------------
  const written: MemoryEnvelope[] = [];
  const pending: PendingWrite[] = [];
  const rejected: RejectedWrite[] = [];
  const seen = new Set(sessionHashes);
  let writesThisTurn = turnWriteCount;
  let writesThisSession = sessionWriteCount;

  for (const raw of turn.response.memory_candidates) {
    const memoryKey = `${raw.type}:${raw.content.trim().toLowerCase()}`;
    const decision = evaluateCandidate({
      raw,
      userMessage,
      recalled: [
        ...(reconstruction.snapshot ? [reconstruction.snapshot] : []),
        ...reconstruction.facts.map((f) => f.memory),
      ],
      sessionHashes: seen,
      turnWriteCount: writesThisTurn,
      sessionWriteCount: writesThisSession,
      confirmed: true,
    });

    if (decision.accepted && decision.memory) {
      const outcome = await rememberMemory(decision.memory, encode(decision.memory), namespace);
      seen.add(decision.memory.contentHash);
      written.push(decision.memory);
      writesThisTurn += 1;
      writesThisSession += 1;
      evidence.push(
        entry({
          operation: "remember",
          namespace,
          memoryId: decision.memory.id,
          blobId: outcome.blobId,
          latencyMs: outcome.latencyMs,
          resultSummary: decision.memory.content,
          success: true,
          label,
        }),
      );
    } else if (decision.needsConfirmation && decision.memory) {
      const holdKey = `${decision.memory.type}:${decision.memory.content.trim().toLowerCase()}`;
      pending.push({ memory: decision.memory, encoded: encode(decision.memory), reason: decision.reason });
      evidence.push(
        entry({
          operation: "writegate",
          namespace,
          memoryId: decision.memory.id,
          blobId: null,
          latencyMs: 0,
          resultSummary: `Held for confirmation: ${decision.memory.content}`,
          success: true,
          label: "MEASURED",
          detail: { held: true, key: holdKey },
        }),
      );
    } else {
      rejected.push({
        type: raw.type,
        content: raw.content,
        code: decision.code,
        reason: decision.reason,
        overlap: decision.overlap,
      });
      evidence.push(
        entry({
          operation: "writegate",
          namespace,
          memoryId: null,
          blobId: null,
          latencyMs: 0,
          resultSummary: `Rejected (${decision.code}): ${raw.content.slice(0, 80)}`,
          success: false,
          label: "MEASURED",
          detail: { code: decision.code, reason: decision.reason },
        }),
      );
    }
  }

  return {
    reply,
    citations: resolvableCitations(
      citedIds,
      [
        ...(reconstruction.snapshot ? [reconstruction.snapshot] : []),
        ...reconstruction.facts.map((f) => f.memory),
      ],
    ),
    written,
    pending,
    rejected,
    evidence,
    empty: false,
    degraded,
    diagnostic: reconstruction.diagnostic,
    model: config.model,
    snapshotFound: reconstruction.snapshot !== null,
    droppedCount: reconstruction.droppedCount,
    latencyMs: Date.now() - started,
  };
}
