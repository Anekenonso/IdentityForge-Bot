/**
 * IF1 memory envelope.
 *
 *   [IF1|id=<uuid>|type=<...>|ts=<ISO-8601>|v=<n>|supersedes=<id|none>]
 *   <content>
 *
 * Design notes (see IdentityForge_Build_Plan_v3.md §5):
 *  - The `id` is generated in code, never by the LLM.
 *  - Content stays natural language because the relayer embeds the whole string;
 *    structure rides in the one-line header so semantic recall still works.
 *  - The SDK exposes NO metadata or tag filter on recall (assumption A3), so the
 *    header is the only carrier of `type` / `v` / `supersedes`. Everything that
 *    needs to filter by type must parse this in-band.
 */

import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";

export const MEMORY_TYPES = [
  "persona",
  "goal",
  "preference",
  "decision",
  "history",
  "snapshot",
] as const;

export type MemoryType = (typeof MEMORY_TYPES)[number];

export interface MemoryEnvelope {
  id: string;
  type: MemoryType;
  /** Client write time (ISO-8601). Prefers the relayer's `created_at` once indexed. */
  ts: string;
  /** Snapshot version; 1 for everything else. */
  v: number;
  /** Prior memory id this one replaces, or "none". */
  supersedes: string;
  content: string;
  /** sha256 of the normalized content. Used for idempotency and dedupe. */
  contentHash: string;
}

export const SNAPSHOT_ANCHOR = "IF1-SNAPSHOT-IDENTITY";

/** Non-snapshot content cap. Snapshots are much larger by design. */
export const CONTENT_MAX_CHARS = 300;
export const SNAPSHOT_MAX_CHARS = 6000;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const envelopeSchema = z.object({
  id: z.string().regex(UUID_RE),
  type: z.enum(MEMORY_TYPES),
  ts: z.string().min(1),
  v: z.number().int().min(1),
  supersedes: z.string().min(1),
});

export const candidateSchema = z.object({
  type: z.enum(MEMORY_TYPES),
  content: z.string().min(1),
  confidence: z.number().min(0).max(1),
});

export type Candidate = z.infer<typeof candidateSchema>;

const HEADER_RE = /^\[IF1\|([^\]]*)\]\s*\n?([\s\S]*)$/;

/**
 * Normalize content for hashing. Deliberately conservative: casefold, collapse
 * whitespace, strip trailing punctuation. Anything more aggressive risks treating
 * two genuinely different facts as duplicates.
 */
export function normalizeContent(content: string): string {
  return content
    .trim()
    .toLowerCase()
    .replace(/\s+/g, " ")
    .replace(/[.!?;,]+$/, "");
}

export function contentHash(content: string): string {
  return createHash("sha256").update(normalizeContent(content), "utf8").digest("hex");
}

export function contentLimitFor(type: MemoryType): number {
  return type === "snapshot" ? SNAPSHOT_MAX_CHARS : CONTENT_MAX_CHARS;
}

export interface NewMemory {
  type: MemoryType;
  content: string;
  supersedes?: string;
  v?: number;
}

export function createMemory(input: NewMemory): MemoryEnvelope {
  return {
    id: randomUUID(),
    type: input.type,
    ts: new Date().toISOString(),
    v: input.v ?? 1,
    supersedes: input.supersedes ?? "none",
    content: input.content,
    contentHash: contentHash(input.content),
  };
}

/** Render an envelope to the exact string stored in Walrus Memory. */
export function encode(memory: MemoryEnvelope): string {
  const header =
    `[IF1|id=${memory.id}|type=${memory.type}|ts=${memory.ts}` +
    `|v=${memory.v}|supersedes=${memory.supersedes}]`;
  const body =
    memory.type === "snapshot" && !memory.content.includes(SNAPSHOT_ANCHOR)
      ? `${SNAPSHOT_ANCHOR}\n${memory.content}`
      : memory.content;
  return `${header}\n${body}`;
}

/**
 * Parse a stored memory back into an envelope.
 *
 * Returns null rather than throwing: recall can surface text that is not one of
 * ours (a partially written blob, a truncated header), and a single bad row must
 * not take down a whole reconstruction. Callers count the misses.
 */
export function parse(text: string): MemoryEnvelope | null {
  const match = HEADER_RE.exec(text.trim());
  if (!match?.[1]) return null;

  const fields: Record<string, string> = {};
  for (const part of match[1].split("|")) {
    const eq = part.indexOf("=");
    if (eq > 0) fields[part.slice(0, eq).trim()] = part.slice(eq + 1).trim();
  }

  const raw = {
    id: fields.id ?? "",
    type: fields.type ?? "",
    ts: fields.ts ?? "",
    v: Number(fields.v ?? "0"),
    supersedes: fields.supersedes ?? "none",
  };

  const parsed = envelopeSchema.safeParse(raw);
  if (!parsed.success) return null;

  // Strip the snapshot anchor back off so callers see just the prose.
  const content = (match[2] ?? "")
    .replace(new RegExp(`^${SNAPSHOT_ANCHOR}\\n`), "")
    .trim();

  return { ...parsed.data, content, contentHash: contentHash(content) };
}

/** Parse a batch, returning hits and the count of unparseable rows. */
export function parseAll(
  texts: readonly string[],
): { memories: MemoryEnvelope[]; skipped: number } {
  const memories: MemoryEnvelope[] = [];
  let skipped = 0;
  for (const text of texts) {
    const parsed = parse(text);
    if (parsed) memories.push(parsed);
    else skipped += 1;
  }
  return { memories, skipped };
}

/**
 * Drop superseded memories and return the highest-version snapshot.
 * This is the deterministic backbone — semantic recall alone can miss core facts.
 */
export function resolveCurrent(
  memories: readonly MemoryEnvelope[],
): MemoryEnvelope[] {
  const superseded = new Set(
    memories.map((m) => m.supersedes).filter((s) => s !== "none"),
  );
  return memories.filter((m) => !superseded.has(m.id));
}

export function latestSnapshot(
  memories: readonly MemoryEnvelope[],
): MemoryEnvelope | null {
  let best: MemoryEnvelope | null = null;
  for (const m of memories) {
    if (m.type !== "snapshot") continue;
    if (!best || m.v > best.v) best = m;
  }
  return best;
}
