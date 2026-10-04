/**
 * Identity snapshot retrieval — the A3 workaround, and the single most
 * important engineering piece in the project.
 *
 * v2 designed this as `recall(filter: type=snapshot)` and take `max v`. The SDK
 * has no metadata or tag filter (A3), so that is unimplementable. The versioned
 * snapshot is the deterministic backbone of H1 and H2 — if it silently fails to
 * load, fidelity numbers collapse for reasons that have nothing to do with the
 * thesis, and nothing in the reply text will tell you why.
 *
 * Strategy: issue several differently-worded probes at a high limit, union the
 * results by blob id, then select in-band by parsing the envelope header.
 */

import {
  createMemory,
  latestSnapshot,
  resolveCurrent,
  SNAPSHOT_ANCHOR,
  type MemoryEnvelope,
} from "./envelope.ts";
import { recallMemories, type RecallOutcome, type RecalledMemory } from "./walrus.ts";

/**
 * Probe phrasings. One is not enough: the relayer ranks by meaning, and the
 * anchor token alone is semantically thin. A union across three angles is
 * materially more reliable for the cost of two extra recalls.
 */
export const SNAPSHOT_PROBES = [
  SNAPSHOT_ANCHOR,
  "IF1 type=snapshot consolidated identity state goals preferences",
  "IF1|v= snapshot version current identity summary",
] as const;

/**
 * Deliberately high. With 40+ facts competing semantically, a small k will drop
 * the snapshot and quietly destroy the fidelity result.
 */
export const SNAPSHOT_LIMIT = 30;

export interface SnapshotOutcome {
  snapshot: MemoryEnvelope | null;
  found: boolean;
  /** Rows inspected while looking for the snapshot. */
  inspected: number;
  unparsed: number;
  droppedCount: number;
  latencyMs: number;
  /** Populated when not found, so the failure is legible in the evidence panel. */
  diagnostic: string | null;
}

export async function retrieveSnapshot(
  namespace: string,
): Promise<SnapshotOutcome> {
  const started = Date.now();
  const byBlob = new Map<string, RecalledMemory>();
  let unparsed = 0;
  let droppedCount = 0;

  for (const query of SNAPSHOT_PROBES) {
    try {
      const outcome = await recallMemories(query, {
        limit: SNAPSHOT_LIMIT,
        namespace,
      });
      unparsed += outcome.unparsed;
      droppedCount += outcome.droppedCount;
      for (const hit of outcome.results) {
        if (!byBlob.has(hit.blobId)) byBlob.set(hit.blobId, hit);
      }
    } catch {
      // A failed probe is not fatal — the remaining probes may still find it.
    }
  }

  const hits = [...byBlob.values()];
  const memories = hits
    .map((h) => h.memory)
    .filter((m): m is MemoryEnvelope => m !== null);

  const snapshot = latestSnapshot(memories);

  return {
    snapshot,
    found: snapshot !== null,
    inspected: hits.length,
    unparsed,
    droppedCount,
    latencyMs: Date.now() - started,
    diagnostic:
      snapshot === null
        ? `No snapshot found in ${hits.length} recalled rows across ${SNAPSHOT_PROBES.length} probes. ` +
          `The identity backbone was unavailable for this turn; fidelity numbers from this turn are not comparable.`
        : null,
  };
}

// ---------------------------------------------------------------------------
// Full reconstruction
// ---------------------------------------------------------------------------

export interface ReconstructedMemory {
  memory: MemoryEnvelope;
  blobId: string;
  distance: number;
  createdAt: string | null;
}

export interface Reconstruction {
  snapshot: MemoryEnvelope | null;
  facts: ReconstructedMemory[];
  empty: boolean;
  /** True when a snapshot was expected (facts exist) but not retrieved. */
  snapshotMissing: boolean;
  /** Rows the snapshot probes inspected. Low when the snapshot is missing. */
  inspectedSnapshotRows: number;
  unparsed: number;
  droppedCount: number;
  latencyMs: number;
  diagnostic: string | null;
}

export const STANDING_QUERIES = [
  "the user's goals",
  "the user's preferences",
  "the user's decisions",
  "key history with the user",
] as const;

const RELEVANCE_LIMIT = 8;

export async function reconstruct(
  namespace: string,
  userMessage: string,
): Promise<Reconstruction> {
  const started = Date.now();

  // Reconstruction issues up to 8 concurrent connections. The relayer
  // occasionally exceeds undici's 10s connect timeout under that burst, and a
  // single timed-out recall must not fail the whole turn — degrade to whatever
  // came back (plan §12: relayer unreachable -> degraded, not fatal).
  const settled = await Promise.allSettled([
    retrieveSnapshot(namespace),
    recallMemories(userMessage, { limit: RELEVANCE_LIMIT, namespace }),
    ...STANDING_QUERIES.map((q) =>
      recallMemories(q, { limit: RELEVANCE_LIMIT, namespace }),
    ),
  ]);

  let failures = 0;
  const snapshotOutcome: SnapshotOutcome =
    settled[0]?.status === "fulfilled"
      ? settled[0].value
      : { snapshot: null, found: false, inspected: 0, unparsed: 0, droppedCount: 0, latencyMs: 0, diagnostic: "Snapshot retrieval failed." };
  if (settled[0]?.status === "rejected") failures += 1;

  const relevanceOutcomes: RecallOutcome[] = [];
  for (const item of settled.slice(1)) {
    if (item.status === "fulfilled") relevanceOutcomes.push(item.value as RecallOutcome);
    else failures += 1;
  }

  // Union by blob id: the user message and the standing queries frequently
  // surface the same memory, and a duplicate would otherwise be counted twice.
  const byBlob = new Map<string, ReconstructedMemory>();
  for (const outcome of relevanceOutcomes) {
    for (const hit of outcome.results) {
      if (hit.memory && !byBlob.has(hit.blobId)) {
        byBlob.set(hit.blobId, {
          memory: hit.memory,
          blobId: hit.blobId,
          distance: hit.distance,
          createdAt: hit.createdAt,
        });
      }
    }
  }

  const resolved = resolveCurrent([...byBlob.values()].map((f) => f.memory));
  const liveIds = new Set(resolved.map((m) => m.id));
  const facts = [...byBlob.values()].filter((f) => liveIds.has(f.memory.id));

  // Drop the snapshot from the fact list — it is assembled separately.
  const factOnly = facts.filter((f) => f.memory.type !== "snapshot");

  const unparsed =
    snapshotOutcome.unparsed +
    relevanceOutcomes.reduce((sum, o) => sum + o.unparsed, 0);
  const droppedCount =
    snapshotOutcome.droppedCount +
    relevanceOutcomes.reduce((sum, o) => sum + o.droppedCount, 0);

  const empty = snapshotOutcome.snapshot === null && factOnly.length === 0;

  // A partial recall set is a degraded turn, not a clean one. Say so, so the
  // fidelity numbers and the evidence panel never quietly overstate coverage.
  const notes = [snapshotOutcome.diagnostic];
  if (failures > 0) {
    notes.push(
      `${failures} of ${settled.length} recall calls failed (relayer connect timeout). ` +
        `This turn ran on partial context.`,
    );
  }

  return {
    snapshot: snapshotOutcome.snapshot,
    facts: factOnly,
    empty,
    snapshotMissing: !snapshotOutcome.found && factOnly.length > 0,
    inspectedSnapshotRows: snapshotOutcome.inspected,
    unparsed,
    droppedCount,
    latencyMs: Date.now() - started,
    diagnostic: notes.filter(Boolean).join(" ") || null,
  };
}

// ---------------------------------------------------------------------------
// Snapshot writing
// ---------------------------------------------------------------------------

export interface SnapshotDraft {
  previous: MemoryEnvelope | null;
  additions: readonly ReconstructedMemory[];
}

/**
 * Consolidation is manual-only in this build (feature freeze decision, plan §7).
 * The LLM produces prose; code owns the version bump, the supersede link, and
 * the invariant that no unconfirmed persona/goal change slipped in.
 */
export function nextSnapshot(
  previous: MemoryEnvelope | null,
  draftedContent: string,
): MemoryEnvelope {
  const content =
    previous === null
      ? draftedContent
      : `${previous.content}\n\n---\n\n${draftedContent}`;
  return createMemory({
    type: "snapshot",
    content,
    v: (previous?.v ?? 0) + 1,
    supersedes: previous?.id ?? "none",
  });
}
