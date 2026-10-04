/**
 * Phase 0 spike — verify the platform API surface against reality.
 *
 * This exists because plan v2 treated nine platform behaviours as unknown and
 * scheduled a day of discovery. Four of the five riskiest have since been read
 * out of the shipped type definitions (see walrus.ts and the v3 plan). What is
 * left is the part that genuinely cannot be known from source: whether semantic
 * recall is any good (assumption A9), and whether the relayer is in production
 * mode.
 *
 * Writes go to a throwaway namespace so the spike cannot corrupt eval data.
 *
 *   cp .env.example .env.local   # then fill in the two Walrus credentials
 *   npm run spike
 */

import { mkdir, writeFile } from "node:fs/promises";
import { createMemory, encode } from "../src/lib/envelope.ts";
import { retrieveSnapshot } from "../src/lib/snapshot.ts";
import {
  captureProvenance,
  listNamespaces,
  recallMemories,
  rememberMemory,
  resolveLiveNamespace,
  restoreNamespace,
} from "../src/lib/walrus.ts";

const SPIKE_NAMESPACE = process.env.SPIKE_NAMESPACE ?? "spike_v3";

/** Deliberately varied so recall@8 is a real measurement, not a trivial one. */
const SEED_FACTS = [
  { type: "persona" as const, content: "The user is Alex, a senior Rust engineer building on Sui." },
  { type: "preference" as const, content: "The user prefers dark mode in every editor and terminal." },
  { type: "goal" as const, content: "The user's goal is to submit a working hackathon entry before the deadline." },
  { type: "decision" as const, content: "The user decided to use Next.js 15 for the frontend." },
  { type: "history" as const, content: "The user mentioned deploying to Vercel as a priority." },
  { type: "preference" as const, content: "The user prefers TypeScript over JavaScript for all new code." },
  { type: "history" as const, content: "The user works in the Hanoi office three days a week." },
  { type: "decision" as const, content: "The user decided against a vector database and to use the relayer's index." },
];

/** Queries whose answers are in SEED_FACTS, used for a rough recall@8. */
const RECALL_PROBES = [
  { query: "What does the user do for a living?", expect: "Rust engineer" },
  { query: "What colour scheme does the user like?", expect: "dark mode" },
  { query: "What is the user trying to accomplish?", expect: "hackathon" },
  { query: "Which frontend framework was chosen?", expect: "Next.js" },
  { query: "Where does the user usually work from?", expect: "Hanoi" },
];

const SNAPSHOT_TEXT =
  "Alex is a senior Rust engineer building on Sui. Alex prefers dark mode and " +
  "TypeScript. Alex's current goal is to submit a working hackathon entry before " +
  "the deadline. Alex decided to use Next.js 15 and to rely on the relayer's " +
  "vector index rather than running a separate vector database.";

function line(label: string, value: unknown): void {
  const text = typeof value === "string" ? value : JSON.stringify(value);
  console.log(`  ${label.padEnd(22)} ${text}`);
}

async function main(): Promise<void> {
  const report: Record<string, unknown> = { startedAt: new Date().toISOString() };
  console.log("\n=== IdentityForge Phase 0 spike ===\n");

  // -- 1. Provenance -------------------------------------------------------
  console.log("[1/6] Relayer provenance");
  const provenance = await captureProvenance();
  report.provenance = provenance;
  line("relayer", provenance.relayer);
  line("status", provenance.status);
  line("mode", provenance.mode ?? "not reported");
  line("write_ready", provenance.writeReady);
  line("apiVersion", provenance.apiVersion);
  line("build", provenance.buildCommit);

  if (provenance.mode === "benchmark") {
    console.log(
      "\n  !! Relayer reports mode=benchmark. Results from this run must be\n" +
        "     disclosed in the README, or re-run against production.",
    );
  }
  if (provenance.status === "unreachable" || provenance.status.startsWith("error")) {
    throw new Error(`Relayer unreachable: ${provenance.status}`);
  }

  // -- 2. Writes -----------------------------------------------------------
  console.log("\n[2/6] Writing seed memories");
  const written: { content: string; blobId: string; latencyMs: number }[] = [];
  for (const fact of SEED_FACTS) {
    const memory = createMemory({ type: fact.type, content: fact.content });
    const result = await rememberMemory(memory, encode(memory), SPIKE_NAMESPACE);
    written.push({
      content: fact.content,
      blobId: result.blobId,
      latencyMs: result.latencyMs,
    });
    console.log(`  wrote  ${result.blobId.slice(0, 18)}…  ${result.latencyMs}ms  ${fact.content.slice(0, 44)}`);
  }
  report.writes = written;
  line("total write latency", `${written.reduce((s, w) => s + w.latencyMs, 0)}ms`);

  // -- 3. Recall quality (A9 — the one genuinely unknown) ------------------
  console.log("\n[3/6] Recall quality (assumption A9)");
  let hits = 0;
  const probeResults = [];
  for (const probe of RECALL_PROBES) {
    const outcome = await recallMemories(probe.query, {
      limit: 8,
      namespace: SPIKE_NAMESPACE,
    });
    const found = outcome.results.some((r) => r.text.toLowerCase().includes(probe.expect.toLowerCase()));
    if (found) hits += 1;
    probeResults.push({
      query: probe.query,
      expected: probe.expect,
      found,
      returned: outcome.results.length,
      droppedCount: outcome.droppedCount,
      unparsed: outcome.unparsed,
    });
    console.log(`  ${found ? "PASS" : "MISS"}  ${probe.query}`);
  }
  const recallAt8 = hits / RECALL_PROBES.length;
  report.recall = { probes: probeResults, recallAt8 };
  line("recall@8", `${(recallAt8 * 100).toFixed(0)}%`);
  if (recallAt8 < 0.85) {
    console.log(
      "\n  !! recall@8 below the 85% bar. The snapshot backbone carries the\n" +
        "     fidelity numbers, so measure H1/H2 with it enabled and say so.",
    );
  }

  // -- 4. Snapshot round-trip (the A3 workaround) --------------------------
  console.log("\n[4/6] Snapshot round-trip (the A3 workaround)");
  const v1 = createMemory({ type: "snapshot", content: SNAPSHOT_TEXT, v: 1 });
  const w1 = await rememberMemory(v1, encode(v1), SPIKE_NAMESPACE);
  console.log(`  wrote snapshot v1  ${w1.blobId.slice(0, 18)}…`);

  const v2 = createMemory({
    type: "snapshot",
    content: `${SNAPSHOT_TEXT} Alex also decided to record a demo video on Oct 7.`,
    v: 2,
    supersedes: v1.id,
  });
  const w2 = await rememberMemory(v2, encode(v2), SPIKE_NAMESPACE);
  console.log(`  wrote snapshot v2  ${w2.blobId.slice(0, 18)}…`);

  const snapshotOutcome = await retrieveSnapshot(SPIKE_NAMESPACE);
  line("snapshot found", snapshotOutcome.found);
  line("rows inspected", snapshotOutcome.inspected);
  line("selected v", snapshotOutcome.snapshot?.v ?? "none");
  line("latency", `${snapshotOutcome.latencyMs}ms`);
  report.snapshot = {
    found: snapshotOutcome.found,
    inspected: snapshotOutcome.inspected,
    selectedVersion: snapshotOutcome.snapshot?.v ?? null,
    diagnostic: snapshotOutcome.diagnostic,
  };
  if (!snapshotOutcome.found) {
    console.log(
      "\n  !! Snapshot not retrieved. H1/H2 are unmeasurable until this works.\n" +
        "     Raise SNAPSHOT_LIMIT or add probe phrasings in src/lib/snapshot.ts.",
    );
  } else if (snapshotOutcome.snapshot?.v !== 2) {
    console.log(
      `\n  !! Retrieved v${snapshotOutcome.snapshot?.v} but v2 is current. ` +
        "Supersession ordering is wrong.",
    );
  }

  // -- 5. Namespace isolation (A7) ----------------------------------------
  console.log("\n[5/6] Namespace isolation (assumption A7)");
  const isolation = await recallMemories("senior Rust engineer building on Sui", {
    limit: 8,
    namespace: "definitely_not_a_real_namespace",
  });
  line("leaked from other ns", isolation.results.length);
  report.isolation = { leaked: isolation.results.length };
  if (isolation.results.length > 0) {
    console.log("  !! Namespace isolation FAILED. Forget cannot be trusted.");
  } else {
    console.log("  OK   a recall in an unused namespace returned nothing");
  }

  // -- 6. Restore audit (the auditability pillar) -------------------------
  console.log("\n[6/6] Restore audit");
  const namespaces = await listNamespaces();
  report.namespaces = namespaces;
  line("namespaces", namespaces.map((n) => n.name).join(", ") || "none");
  const live = await resolveLiveNamespace();
  line("live identity ns", live);

  const restore = await restoreNamespace(SPIKE_NAMESPACE);
  report.restore = restore;
  line("restored", restore.restored);
  line("skipped", restore.skipped);
  line("failed", restore.failed);
  line("total on chain", restore.total);
  line("truncated", restore.truncated);
  if (restore.failed > 0) {
    console.log("  !! restore reported failures — investigate before submitting.");
  }
  if (restore.truncated) {
    console.log("  !! restore truncated; disclose as a limitation (plan §13 item 9).");
  }

  // -- Report --------------------------------------------------------------
  // npm scripts run with cwd at the project root, so this is relative to the
  // repo, not to this file.
  await mkdir("evidence/spike", { recursive: true });
  const path = `evidence/spike/run-${Date.now()}.json`;
  await writeFile(path, JSON.stringify(report, null, 2), "utf8");
  console.log(`\nRaw report written to ${path}`);

  const blockers = [
    provenance.mode === "benchmark" && "relayer in benchmark mode",
    !snapshotOutcome.found && "snapshot not retrieved",
    recallAt8 < 0.85 && "recall@8 below 85%",
    isolation.results.length > 0 && "namespace isolation failed",
    restore.failed > 0 && "restore reported failures",
  ].filter(Boolean) as string[];

  console.log(
    blockers.length === 0
      ? "\n=== Spike clean. Proceed to Phase 1. ===\n"
      : `\n=== ${blockers.length} blocker(s) — address before Phase 1:\n` +
        blockers.map((b) => `  - ${b}`).join("\n") +
        "\n",
  );
  if (blockers.length > 0) process.exitCode = 1;
}

main().catch((error) => {
  console.error("\nSpike failed:", (error as Error).message);
  console.error(
    "\nIf this is a credentials error, generate a delegate key and account id at\n" +
      "https://memory.walrus.xyz and copy .env.example to .env.local.\n",
  );
  process.exitCode = 1;
});
