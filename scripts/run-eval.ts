/**
 * Evaluation harness.
 *
 *   npm run seed -- eval/seed_user_a.json eval_a
 *   npm run eval -- --namespace eval_a --seed eval/seed_user_a.json
 *
 * Conditions
 *   C0  control   no memory, primary model. Proves the memory is load-bearing:
 *                  without it the model should score near zero, so any C2 score
 *                  is attributable to reconstruction rather than to the LLM
 *                  already knowing the answer.
 *   C2  fidelity  seeded namespace, primary model.
 *   C3  portable  seeded namespace, secondary model — the model swap for H2.
 *   C4  removal   empty namespace, primary model — what the agent answers after
 *                  forget. Any score above zero on a seeded probe is leakage.
 *
 * A note on the original C1. The plan defined C1 as "pre-wipe agent, same
 * session" to measure cold start against a warm reference. This app reconstructs
 * from Walrus on *every* turn, so there is no warm session to preserve: C1 and
 * C2 are the same condition by construction. Rather than report a difference
 * that cannot exist, the no-memory control C0 does the work a reference
 * condition would have done, and this is stated in the results file.
 *
 * Probes never write. Candidate memories are discarded, so a probe run cannot
 * contaminate the store it is measuring.
 */

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { reconstruct } from "../src/lib/snapshot.ts";
import { assemblePrompt, ONBOARDING_NOTE } from "../src/lib/prompt.ts";
import { chatTurn, readLlmConfig, type LlmRole } from "../src/lib/llm.ts";
import { captureProvenance, restoreNamespace } from "../src/lib/walrus.ts";
import {
  aggregate,
  judgeReply,
  type Probe,
  type ProbeOutcome,
} from "../src/lib/judge.ts";

// -- args -------------------------------------------------------------------

function arg(name: string, fallback?: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : fallback;
}

const NAMESPACE = arg("namespace", "eval_a")!;
const SEED_FILE = arg("seed", "eval/seed_user_a.json")!;
const PROBE_FILE = arg("probes", "eval/probes.json")!;
const ONLY = arg("only")?.toUpperCase();
const LIMIT = Number(arg("limit", "0") ?? 0);

const EMPTY_NAMESPACE = `${NAMESPACE}_postforget`;

const CONDITIONS: { id: string; namespace: string; role: LlmRole; label: string }[] = [
  { id: "C0", namespace: `${NAMESPACE}_control`, role: "primary", label: "control (no memory)" },
  { id: "C2", namespace: NAMESPACE, role: "primary", label: "fidelity (primary model)" },
  { id: "C3", namespace: NAMESPACE, role: "secondary", label: "portability (model swap)" },
  { id: "C4", namespace: EMPTY_NAMESPACE, role: "primary", label: "removal (post-forget)" },
];

// -- one probe --------------------------------------------------------------

async function runProbe(probe: Probe, namespace: string, role: LlmRole): Promise<ProbeOutcome> {
  const started = Date.now();

  const reconstruction = await reconstruct(namespace, probe.question);
  const prompt = assemblePrompt(reconstruction, probe.question);

  let reply: string;
  let citations = 0;

  if (reconstruction.empty) {
    reply = ONBOARDING_NOTE;
  } else {
    const turn = await chatTurn(
      { context: prompt.context, userMessage: probe.question },
      role,
    );
    reply = turn.response.reply;
    // Candidate memories are intentionally discarded — see header.
    citations = turn.response.cited_ids.filter((id) => prompt.availableIds.includes(id)).length;
  }

  const verdict = await judgeReply({ probe, reply });

  return {
    probeId: probe.id,
    kind: probe.kind,
    question: probe.question,
    reply,
    score: verdict.score,
    maxScore: 2,
    assertedForbidden: verdict.assertedForbidden,
    admittedIgnorance: verdict.admittedIgnorance,
    reason: verdict.oneLineReason,
    citations,
    snapshotFound: reconstruction.snapshot !== null,
    latencyMs: Date.now() - started,
  };
}

// -- main -------------------------------------------------------------------

async function main(): Promise<void> {
  const probesFile = JSON.parse(await readFile(PROBE_FILE, "utf8")) as {
    probes: Probe[];
  };
  const probes: Probe[] = LIMIT > 0 ? probesFile.probes.slice(0, LIMIT) : probesFile.probes;
  const seedFile = JSON.parse(await readFile(SEED_FILE, "utf8")) as { name: string };

  console.log(`\n=== IdentityForge evaluation ===`);
  console.log(`seed:    ${seedFile.name} (${SEED_FILE})`);
  console.log(`probes:  ${probes.length}`);
  console.log(`primary: ${readLlmConfig("primary").model}`);
  console.log(`second:  ${readLlmConfig("secondary").model}`);
  console.log(`judge:   ${readLlmConfig("judge").model}\n`);

  const conditions = ONLY ? CONDITIONS.filter((c) => c.id === ONLY) : CONDITIONS;
  const provenance = await captureProvenance();
  const restore = await restoreNamespace(NAMESPACE).catch(() => null);

  const results: Record<string, unknown> = {
    runAt: new Date().toISOString(),
    seed: SEED_FILE,
    seedName: seedFile.name,
    probes: probes.length,
    models: {
      primary: readLlmConfig("primary").model,
      secondary: readLlmConfig("secondary").model,
      judge: readLlmConfig("judge").model,
    },
    provenance,
    restore,
    methodologyNote:
      "C1 (pre-wipe, same session) was dropped: this app reconstructs from " +
      "Walrus on every turn, so there is no warm session state and C1 would " +
      "equal C2. The no-memory control C0 serves as the reference instead.",
    conditions: {} as Record<string, unknown>,
  };

  for (const condition of conditions) {
    console.log(`── ${condition.id}: ${condition.label}`);
    console.log(`   namespace ${condition.namespace}\n`);

    const outcomes: ProbeOutcome[] = [];
    for (const [i, probe] of probes.entries()) {
      let outcome: ProbeOutcome;
      try {
        outcome = await runProbe(probe, condition.namespace, condition.role);
      } catch (err) {
        outcome = {
          probeId: probe.id,
          kind: probe.kind,
          question: probe.question,
          reply: `[Error: ${(err as Error).message}]`,
          score: 0,
          maxScore: 2,
          assertedForbidden: false,
          admittedIgnorance: false,
          reason: `Execution failed: ${(err as Error).message}`,
          citations: 0,
          snapshotFound: false,
          latencyMs: 0,
        };
      }
      outcomes.push(outcome);
      const mark = outcome.score === 2 ? "OK " : outcome.score === 1 ? "~  " : "X  ";
      process.stdout.write(
        `   ${mark}${probe.id} ${probe.kind.padEnd(9)} ${outcome.score}/2  ${outcome.latencyMs}ms\n`,
      );
      if (i === 0) {
        console.log(`      reply: ${outcome.reply.slice(0, 100).replace(/\n/g, " ")}…`);
      }
    }

    const summary = aggregate(outcomes);
    (results.conditions as Record<string, unknown>)[condition.id] = {
      label: condition.label,
      namespace: condition.namespace,
      role: condition.role,
      summary,
      outcomes,
    };

    console.log(
      `   fidelity ${summary.fidelityPct.toFixed(1)}%  ` +
        `stale ${summary.stalePct.toFixed(0)}%  ` +
        `halluc ${summary.hallucinationPct.toFixed(0)}%  ` +
        `leak ${summary.leakPct.toFixed(0)}%  ` +
        `snapshot ${summary.snapshotFoundPct.toFixed(0)}%\n`,
    );

    // Save incrementally so results are never lost if interrupted
    await mkdir("results", { recursive: true });
    await writeFile(`results/run-latest.json`, JSON.stringify(results, null, 2), "utf8");
  }

  await mkdir("results", { recursive: true });
  const path = `results/run-${Date.now()}.json`;
  await writeFile(path, JSON.stringify(results, null, 2), "utf8");

  console.log(`\nResults written to ${path}`);

  const c = results.conditions as Record<string, { summary: ReturnType<typeof aggregate> }>;
  const verdict = (id: string, pass: boolean) => (pass ? "PASS" : "FAIL");
  const c2 = c.C2?.summary;
  const c3 = c.C3?.summary;
  const c4 = c.C4?.summary;

  console.log("\n── Hypothesis results");
  if (c2) {
    console.log(
      `   H1 fidelity   ${verdict("H1", c2.fidelityPct >= 90)}  ${c2.fidelityPct.toFixed(1)}%  (target ≥90%)`,
    );
    console.log(
      `   H2 portability ${c3 ? verdict("H2", c3.fidelityPct >= 80 * (c2.fidelityPct / 100)) : "—"}  ` +
        `${c3?.fidelityPct.toFixed(1) ?? "—"}%  (target ≥80% of C2)`,
    );
    console.log(
      `   H4 honesty    ${verdict("H4", c2.hallucinationPct <= 5)}  ${c2.hallucinationPct.toFixed(0)}%  (target ≤5%)`,
    );
    console.log(
      `   H5 staleness  ${verdict("H5", c2.stalePct <= 10)}  ${c2.stalePct.toFixed(0)}%  (target ≤10%)`,
    );
  }
  if (c4) {
    console.log(
      `   H3 removal    ${verdict("H3", c4.leakPct <= 5)}  ${c4.leakPct.toFixed(0)}%  (target ≤5%)`,
    );
  }
  if (restore) {
    console.log(
      `   H6 chain audit ${verdict("H6", restore.failed === 0)}  ` +
        `${restore.total} on chain, ${restore.restored} restored, ${restore.skipped} indexed, ${restore.failed} failed`,
    );
  }
  console.log();
}

main().catch((error) => {
  console.error("\nEval failed:", (error as Error).message);
  process.exitCode = 1;
});
