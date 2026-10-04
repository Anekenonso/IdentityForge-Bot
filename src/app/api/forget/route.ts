import { NextResponse } from "next/server";
import { z } from "zod";
import { listNamespaces, restoreNamespace, resolveLiveNamespace } from "@/lib/walrus.ts";

export const runtime = "nodejs";
export const maxDuration = 60;

const requestSchema = z.object({
  /** Must be true — the UI's two-step confirmation resolves to this. */
  confirm: z.literal(true),
  reason: z.string().max(500).optional(),
});

/**
 * Forget = namespace rotation.
 *
 * The SDK has no delete/forget/erase (A4), and the Security Delete API is
 * legacy-V1 only and disabled on the public relayer. Because recall is scoped by
 * owner + namespace, retiring the generation makes every memory in it
 * unreachable by construction.
 *
 * What this does NOT do: destroy the SEAL-encrypted blobs. They persist on
 * Walrus until their prepaid storage epochs lapse. That wording is deliberate —
 * see plan §13 item 2.
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
    return NextResponse.json(
      { error: "Forget requires explicit confirmation (confirm: true)." },
      { status: 400 },
    );
  }

  try {
    const base = process.env.MEMWAL_NAMESPACE ?? "identity";
    const retired = await resolveLiveNamespace(base);

    // Find the next unused generation so a rotation never collides with a
    // namespace that already holds memories.
    const namespaces = await listNamespaces();
    let generation = 2;
    while (namespaces.some((n) => n.name === `${base}_v${generation}`)) {
      generation += 1;
    }
    const next = `${base}_v${generation}`;

    // Audit what still exists on chain for the retired generation. This is the
    // honest record: the blobs are still there, they are simply unreachable.
    const audit = await restoreNamespace(retired).catch(() => null);

    return NextResponse.json({
      retired,
      active: next,
      retiredMemoryCount:
        namespaces.find((n) => n.name === retired)?.memoryCount ?? null,
      audit,
      disclosure:
        `Retired namespace "${retired}". Recall is scoped by owner + namespace, ` +
        `so these memories are now unreachable. The underlying SEAL-encrypted ` +
        `blobs persist on Walrus until their prepaid storage epochs lapse.`,
    });
  } catch (error) {
    return NextResponse.json(
      { error: "Forget failed.", detail: (error as Error).message },
      { status: 502 },
    );
  }
}
