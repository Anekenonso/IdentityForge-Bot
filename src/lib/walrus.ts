/**
 * Walrus Memory client wrapper.
 *
 * Everything the app knows about the platform lives here, so the rest of the
 * codebase never imports the SDK directly. The comments marked (A#) record
 * verified platform facts — see IdentityForge_Build_Plan_v3.md §3. Do not
 * "fix" these against intuition; they were read from the shipped type
 * definitions for memwal@0.1.8.
 */

import { MemWal } from "@mysten-incubation/memwal";
import { parse, type MemoryEnvelope } from "./envelope.ts";

export interface WalrusConfig {
  privateKey: string;
  accountId: string;
  serverUrl: string;
  namespace: string;
}

export function readConfig(): WalrusConfig {
  const privateKey = process.env.MEMWAL_PRIVATE_KEY;
  const accountId = process.env.MEMWAL_ACCOUNT_ID;
  if (!privateKey || !accountId) {
    throw new Error(
      "Missing MEMWAL_PRIVATE_KEY or MEMWAL_ACCOUNT_ID. " +
        "Generate a delegate key at https://memory.walrus.xyz and copy .env.example to .env.local.",
    );
  }
  return {
    privateKey,
    accountId,
    serverUrl:
      process.env.MEMWAL_SERVER_URL ?? "https://relayer.memory.walrus.xyz",
    namespace: process.env.MEMWAL_NAMESPACE ?? "identity",
  };
}

let client: MemWal | null = null;

/**
 * Measured on mainnet 2026-10-04: a single `rememberAndWait` took 35.3s, and
 * writes at 30s timeout failed intermittently. The SDK documents a 90s poll
 * budget as a real scenario, so the timeout has to be generous. This is the
 * single biggest latency in the system and it is on the write path only —
 * reads are fast.
 */
export const WRITE_TIMEOUT_MS = 120_000;

export function getClient(): MemWal {
  if (client) return client;
  const config = readConfig();
  client = MemWal.create({
    key: config.privateKey,
    accountId: config.accountId,
    serverUrl: config.serverUrl,
    namespace: config.namespace,
    requestTimeoutMs: WRITE_TIMEOUT_MS,
  });
  return client;
}

export function resetClient(): void {
  client?.destroy();
  client = null;
}

// ---------------------------------------------------------------------------
// Relayer provenance — the credibility surface.
//
// (NEW-1) health() reports `mode: "production" | "benchmark"`. Showing this in
// the UI pre-empts "were your numbers real?" before a judge asks it.
// ---------------------------------------------------------------------------

export interface Provenance {
  relayer: string;
  mode: string | null;
  writeReady: boolean | null;
  status: string;
  apiVersion: string | null;
  relayerVersion: string | null;
  buildCommit: string | null;
  promptVersions: { extract: string | null; ask: string | null };
  capturedAt: string;
}

export async function captureProvenance(): Promise<Provenance> {
  const config = readConfig();
  const base: Provenance = {
    relayer: config.serverUrl,
    mode: null,
    writeReady: null,
    status: "unreachable",
    apiVersion: null,
    relayerVersion: null,
    buildCommit: null,
    promptVersions: { extract: null, ask: null },
    capturedAt: new Date().toISOString(),
  };

  try {
    const memwal = getClient();
    const [health, compat] = await Promise.all([
      memwal.health(),
      memwal.compatibility().catch(() => null),
    ]);
    return {
      ...base,
      status: health.status ?? "unknown",
      mode: health.mode ?? null,
      writeReady: health.write_ready ?? null,
      apiVersion: compat?.apiVersion ?? null,
      relayerVersion: compat?.relayerVersion ?? null,
      buildCommit: compat?.build?.commit ?? null,
      promptVersions: {
        extract: health.prompt_versions?.extract ?? null,
        ask: health.prompt_versions?.ask ?? null,
      },
    };
  } catch (error) {
    return { ...base, status: `error: ${(error as Error).message}` };
  }
}

// ---------------------------------------------------------------------------
// Recall
// ---------------------------------------------------------------------------

export interface RecalledMemory {
  blobId: string;
  text: string;
  distance: number;
  /** (NEW-5) relayer write time, when the relayer reports it. */
  createdAt: string | null;
  memory: MemoryEnvelope | null;
}

export interface RecallOutcome {
  results: RecalledMemory[];
  total: number;
  /** (NEW-5) matches silently dropped on download/decrypt failure. Non-zero is a
   *  data-loss signal that would otherwise quietly depress recall scores. */
  droppedCount: number;
  /** Rows we could not parse as IF1 envelopes. */
  unparsed: number;
  latencyMs: number;
}

export async function recallMemories(
  query: string,
  options: { limit?: number; namespace?: string; maxTokens?: number } = {},
): Promise<RecallOutcome> {
  const started = Date.now();
  const memwal = getClient();

  // (A3) RecallOptions accepts only query / limit / topK / namespace /
  // maxDistance / maxTokens / truncationStrategy + score weights. There is NO
  // tag or metadata filter — that is why snapshot retrieval is in-band.
  const result = await memwal.recall({
    query,
    limit: options.limit ?? 8,
    ...(options.namespace ? { namespace: options.namespace } : {}),
    ...(options.maxTokens ? { maxTokens: options.maxTokens } : {}),
  });

  let unparsed = 0;
  const results: RecalledMemory[] = result.results.map((r) => {
    const memory = parse(r.text);
    if (!memory) unparsed += 1;
    return {
      blobId: r.blob_id,
      text: r.text,
      distance: r.distance,
      createdAt: r.created_at ?? null,
      memory,
    };
  });

  return {
    results,
    total: result.total,
    droppedCount: result.dropped_count ?? 0,
    unparsed,
    latencyMs: Date.now() - started,
  };
}

// ---------------------------------------------------------------------------
// Writes
//
// (NEW-4) remember() returns only {job_id, status} and the docs warn that
// indexing lags by a few seconds. Using the async form anywhere in the eval
// harness would add noise that reads as fidelity loss. Always use *AndWait.
// ---------------------------------------------------------------------------

export interface WriteOutcome {
  memory: MemoryEnvelope;
  blobId: string;
  latencyMs: number;
  owner: string;
}

export async function rememberMemory(
  memory: MemoryEnvelope,
  encoded: string,
  namespace?: string,
): Promise<WriteOutcome> {
  const started = Date.now();
  const memwal = getClient();
  const result = await memwal.rememberAndWait(encoded, namespace, {
    timeoutMs: WRITE_TIMEOUT_MS,
  });
  return {
    memory,
    blobId: result.blob_id,
    latencyMs: Date.now() - started,
    owner: result.owner,
  };
}

// ---------------------------------------------------------------------------
// Bulk writes — the seeding path.
//
// At the measured 35s per write, seeding 40 facts one at a time would take ~23
// minutes. rememberBulk accepts up to 20 items per call, so a seed is 2 round
// trips. This matters most for the eval harness, which re-seeds per condition.
// ---------------------------------------------------------------------------

export const BULK_MAX = 20;

export interface BulkWriteOutcome {
  succeeded: number;
  failed: number;
  /** Parallel to the input order. */
  results: { blobId: string | null; error: string | null; memory: MemoryEnvelope }[];
  latencyMs: number;
}

export async function rememberMemoriesBulk(
  items: { memory: MemoryEnvelope; encoded: string }[],
  namespace?: string,
): Promise<BulkWriteOutcome> {
  const started = Date.now();
  const memwal = getClient();

  if (items.length > BULK_MAX) {
    throw new Error(`Bulk write takes at most ${BULK_MAX} items; got ${items.length}.`);
  }

  const result = await memwal.rememberBulkAndWait(
    items.map((i) => ({ text: i.encoded, namespace })),
    { timeoutMs: WRITE_TIMEOUT_MS * 2 },
  );

  return {
    succeeded: result.succeeded,
    failed: result.failed,
    results: result.results.map((r, i) => ({
      blobId: r.status === "done" ? r.blob_id : null,
      error: r.status === "done" ? null : (r.error ?? r.status),
      memory: items[i]?.memory as MemoryEnvelope,
    })),
    latencyMs: Date.now() - started,
  };
}

// ---------------------------------------------------------------------------
// Namespaces and forget
//
// (A4) The SDK has no delete/forget/erase. The Security Delete API is
// legacy-V1 only and disabled on the public relayer. Namespace rotation is not
// a fallback — it is the only implementable forget.
// (A7) Recall is scoped by owner + namespace, so a retired generation is
// unreachable by construction.
// ---------------------------------------------------------------------------

export interface NamespaceInfo {
  name: string;
  memoryCount: number;
  updatedAt: string;
}

export async function listNamespaces(): Promise<NamespaceInfo[]> {
  const memwal = getClient();
  const out: NamespaceInfo[] = [];
  let cursor: string | undefined;
  // (A) listNamespaces is paginated with an authoritative has_more signal —
  // do not infer completion from page length.
  do {
    const page = await memwal.listNamespaces({ cursor, limit: 100 });
    for (const ns of page.namespaces) {
      out.push({
        name: ns.name,
        memoryCount: ns.memory_count,
        updatedAt: ns.updated_at,
      });
    }
    cursor = page.has_more ? (page.next_cursor ?? undefined) : undefined;
  } while (cursor);
  return out;
}

/**
 * The live generation is the most recently updated identity namespace.
 * Deriving it from listNamespaces() means forget needs no extra stored pointer.
 */
export async function resolveLiveNamespace(prefix = "identity"): Promise<string> {
  const namespaces = await listNamespaces();
  const candidates = namespaces
    .filter((ns) => ns.name === prefix || ns.name.startsWith(`${prefix}_v`))
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  return candidates[0]?.name ?? prefix;
}

export interface ForgetResult {
  retiredNamespace: string;
  liveNamespace: string;
  retiredMemoryCount: number;
}

// ---------------------------------------------------------------------------
// Restore — the auditability pillar.
//
// (NEW-2) The relayer's vector index is explicitly a rebuildable cache. restore()
// makes it enumerate our on-chain blobs for (owner, namespace) and reconcile
// them against the index. That reconciliation, shown in the UI, is the concrete
// shippable half of the decentralization story.
// ---------------------------------------------------------------------------

export interface RestoreOutcome {
  restored: number;
  skipped: number;
  failed: number;
  total: number;
  truncated: boolean;
  namespace: string;
  owner: string;
  latencyMs: number;
}

export async function restoreNamespace(
  namespace: string,
  limit?: number,
): Promise<RestoreOutcome> {
  const started = Date.now();
  const memwal = getClient();
  const result = await memwal.restore(namespace, limit);
  return {
    restored: result.restored,
    skipped: result.skipped,
    failed: result.failed,
    total: result.total,
    truncated: result.truncated,
    namespace: result.namespace,
    owner: result.owner,
    latencyMs: Date.now() - started,
  };
}

export async function healthCheck(): Promise<{
  ok: boolean;
  writeReady: boolean | null;
  mode: string | null;
  status: string;
}> {
  try {
    const health = await getClient().health();
    return {
      ok: health.status === "ok" || health.status === "healthy",
      writeReady: health.write_ready ?? null,
      mode: health.mode ?? null,
      status: health.status,
    };
  } catch {
    return { ok: false, writeReady: null, mode: null, status: "unreachable" };
  }
}
