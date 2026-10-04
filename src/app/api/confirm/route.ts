import { NextResponse } from "next/server";
import { z } from "zod";
import { createMemory, encode, MEMORY_TYPES } from "@/lib/envelope.ts";
import { rememberMemory } from "@/lib/walrus.ts";

export const runtime = "nodejs";
export const maxDuration = 30;

const requestSchema = z.object({
  type: z.enum(MEMORY_TYPES),
  content: z.string().min(1).max(1500),
  namespace: z.string().min(1).optional(),
});

/**
 * Writes a candidate the gate held for confirmation.
 *
 * The gate already ran and accepted the content; this endpoint records the
 * user's explicit "yes". It deliberately does not re-derive anything — the
 * candidate text came from the gate's own decision, and re-running the LLM here
 * would be a fresh chance to smuggle something past it.
 */
export async function POST(req: Request) {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  }

  const parsed = requestSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid confirmation." }, { status: 400 });
  }

  const { type, content, namespace } = parsed.data;
  const namespaceName = namespace ?? process.env.MEMWAL_NAMESPACE ?? "identity";

  try {
    const memory = createMemory({ type, content });
    const outcome = await rememberMemory(memory, encode(memory), namespaceName);
    return NextResponse.json({
      ok: true,
      memoryId: memory.id,
      blobId: outcome.blobId,
      latencyMs: outcome.latencyMs,
    });
  } catch (error) {
    return NextResponse.json(
      { error: "Write failed.", detail: (error as Error).message },
      { status: 502 },
    );
  }
}
