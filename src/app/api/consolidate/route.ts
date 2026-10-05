import { NextResponse } from "next/server";
import { z } from "zod";
import { reconstruct } from "@/lib/snapshot.ts";
import { createMemory, encode } from "@/lib/envelope.ts";
import { rememberMemory } from "@/lib/walrus.ts";
import { chatTurn } from "@/lib/llm.ts";

export const runtime = "nodejs";
export const maxDuration = 60;

const requestSchema = z.object({
  namespace: z.string().min(1).optional(),
});

export async function POST(req: Request) {
  let body: unknown = {};
  try {
    body = await req.json();
  } catch {
    // Empty body is allowed
  }

  const parsed = requestSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid request." }, { status: 400 });
  }

  const namespace = parsed.data.namespace ?? process.env.MEMWAL_NAMESPACE ?? "identity";

  try {
    const reconstruction = await reconstruct(namespace, "the user's identity goals and background");
    
    if (reconstruction.facts.length === 0 && !reconstruction.snapshot) {
      return NextResponse.json(
        { error: "No stored memories found to consolidate in this namespace." },
        { status: 400 },
      );
    }

    const factsText = reconstruction.facts
      .map((f) => `- [${f.memory.type}] ${f.memory.content}`)
      .join("\n");
    const currentSnapshotText = reconstruction.snapshot?.content ?? "(no prior snapshot)";

    const promptContext = [
      "You are a memory consolidation engine.",
      "Consolidate the following existing snapshot and individual memories into a single, cohesive, authoritative identity summary.",
      "",
      "PRIOR SNAPSHOT:",
      currentSnapshotText,
      "",
      "RECORDED MEMORIES:",
      factsText,
      "",
      "OUTPUT FORMAT:",
      "Provide a clear, dense, multi-section summary covering:",
      "- Persona & Profession",
      "- Tech Stack & Tools",
      "- Current Goals & Focus",
      "- Preferences & Decisions",
      "Do not invent facts. Only include information supported by the memories above.",
    ].join("\n");

    const turn = await chatTurn(
      {
        context: promptContext,
        userMessage: "Generate the consolidated identity snapshot for this user.",
      },
      "primary",
    );

    const consolidatedProse = turn.response.reply.trim();
    const nextVersion = (reconstruction.snapshot?.v ?? 0) + 1;
    const supersedesId = reconstruction.snapshot?.id ?? "none";

    const snapshotEnvelope = createMemory({
      type: "snapshot",
      v: nextVersion,
      supersedes: supersedesId,
      content: consolidatedProse,
    });

    const writeOutcome = await rememberMemory(
      snapshotEnvelope,
      encode(snapshotEnvelope),
      namespace,
    );

    return NextResponse.json({
      ok: true,
      version: nextVersion,
      blobId: writeOutcome.blobId,
      summary: consolidatedProse,
      latencyMs: writeOutcome.latencyMs,
    });
  } catch (error) {
    return NextResponse.json(
      { error: "Consolidation failed.", detail: (error as Error).message },
      { status: 502 },
    );
  }
}
