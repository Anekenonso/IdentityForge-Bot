import { NextResponse } from "next/server";
import { captureProvenance, healthCheck, resolveLiveNamespace, restoreNamespace } from "@/lib/walrus.ts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Everything the evidence panel needs to make its claims auditable:
 * relayer provenance (including mode: production | benchmark), the live
 * namespace generation, and the restore audit that reconciles the relayer's
 * index against the blobs on chain.
 */
export async function GET() {
  try {
    const [provenance, health, namespace, restore] = await Promise.all([
      captureProvenance(),
      healthCheck(),
      resolveLiveNamespace(),
      restoreNamespace(process.env.MEMWAL_NAMESPACE ?? "identity").catch(() => null),
    ]);

    return NextResponse.json({
      provenance,
      health,
      namespace,
      restore,
      accountId: process.env.MEMWAL_ACCOUNT_ID ?? null,
      model: readPrimaryModel(),
      suiExplorer: suiExplorerUrl(),
    });
  } catch (error) {
    return NextResponse.json(
      { error: "Health check failed.", detail: (error as Error).message },
      { status: 503 },
    );
  }
}

function readPrimaryModel(): string {
  return process.env.LLM_PRIMARY_MODEL ?? "unset";
}

/**
 * A public receipt, not a claim: anyone can open this and see the MemWalAccount,
 * its owner, and its authorized delegate keys without touching our app.
 */
function suiExplorerUrl(): string | null {
  const accountId = process.env.MEMWAL_ACCOUNT_ID;
  if (!accountId) return null;
  const base =
    process.env.SUI_NETWORK === "testnet"
      ? "https://suiscan.xyz/testnet/object"
      : "https://suiscan.xyz/mainnet/object";
  return `${base}/${accountId}`;
}
