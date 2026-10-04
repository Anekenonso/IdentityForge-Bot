import { NextResponse } from "next/server";
import { z } from "zod";
import { runTurn } from "@/lib/turn.ts";
import { readLlmConfig, type LlmRole } from "@/lib/llm.ts";
import type { EvidenceEntry } from "@/lib/evidence.ts";

export const runtime = "nodejs";
// The reconstruction path issues several vector recalls; give it room.
export const maxDuration = 60;

const requestSchema = z.object({
  message: z.string().min(1).max(4000),
  namespace: z.string().min(1).optional(),
  role: z.enum(["primary", "secondary", "judge"]).optional(),
  entries: z.array(z.unknown()).optional(),
});

export async function POST(req: Request) {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  }

  const parsed = requestSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Invalid request.", detail: parsed.error.issues },
      { status: 400 },
    );
  }

  const { message, namespace, role = "primary" } = parsed.data;
  const namespaceName = namespace ?? process.env.MEMWAL_NAMESPACE ?? "identity";

  try {
    const result = await runTurn({
      namespace: namespaceName,
      userMessage: message,
      role: role as LlmRole,
    });

    return NextResponse.json({
      reply: result.reply,
      citations: result.citations.map((c) => ({
        id: c.id,
        type: c.type,
        content: c.content,
      })),
      written: result.written.map((w) => ({ id: w.id, type: w.type, content: w.content })),
      pending: result.pending.map((p) => ({
        id: p.memory.id,
        type: p.memory.type,
        content: p.memory.content,
        reason: p.reason,
      })),
      rejected: result.rejected,
      evidence: result.evidence,
      empty: result.empty,
      degraded: result.degraded,
      diagnostic: result.diagnostic,
      model: result.model,
      namespace: namespaceName,
      snapshotFound: result.snapshotFound,
      droppedCount: result.droppedCount,
      latencyMs: result.latencyMs,
    });
  } catch (error) {
    const message_ = (error as Error).message;
    const configError =
      message_.includes("MEMWAL_PRIVATE_KEY") || message_.includes("API key");
    return NextResponse.json(
      {
        error: configError ? "Not configured." : "Memory service unavailable.",
        detail: message_,
      },
      { status: configError ? 503 : 502 },
    );
  }
}
