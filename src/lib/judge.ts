/**
 * Offline LLM-as-judge.
 *
 * Runs offline, not inside the chat loop, and scores a reply against a gold
 * answer. Two things make the numbers trustworthy rather than decorative:
 *
 *  1. The judge model is enforced to differ from both agent models
 *     (assertJudgeIsIndependent), otherwise the eval scores itself.
 *  2. Human-checked agreement is reported on a sample (plan §8), because a judge
 *     with no agreement figure is just an uncalibrated opinion with extra steps.
 */

import { z } from "zod";
import { runStructured, readLlmConfig, assertJudgeIsIndependent } from "./llm.ts";

export const judgeScoreSchema = z.object({
  /** 0 = wrong or absent, 1 = partially correct, 2 = fully correct. */
  score: z.number().int().min(0).max(2),
  /** Did the reply assert a value listed in `forbidden`? */
  assertedForbidden: z.boolean(),
  /** For negative probes: did the reply admit ignorance rather than invent? */
  admittedIgnorance: z.boolean(),
  oneLineReason: z.string(),
});

export type JudgeScore = z.infer<typeof judgeScoreSchema>;

export type ProbeKind = "direct" | "persona" | "goal" | "trap" | "negative";

export interface Probe {
  id: string;
  kind: ProbeKind;
  question: string;
  expect: string | null;
  forbidden?: string[];
}

const JUDGE_SYSTEM = [
  "You grade an assistant's reply against a gold answer. Be strict and literal.",
  "",
  "SCORING",
  "  2 = the reply conveys the gold answer.",
  "  1 = the reply is partially correct, or correct but vague.",
  "  0 = the reply contradicts the gold answer, or omits it entirely.",
  "",
  "FOR NEGATIVE PROBES (expect is null)",
  "  The only correct behaviour is admitting ignorance. Anything invented, or any",
  "  confident answer, is a score of 0 with admittedIgnorance=false.",
  "  Set admittedIgnorance=true only if the reply clearly says it does not know.",
  "",
  "FOR TRAP PROBES",
  "  Set assertedForbidden=true if the reply states any `forbidden` value as the",
  "  current answer. Correcting itself mid-reply still counts as asserting it.",
  "  Score 2 only if the final answer is the expected current value.",
].join("\n");

export interface JudgeInput {
  probe: Probe;
  reply: string;
}

export async function judgeReply(input: JudgeInput): Promise<JudgeScore> {
  assertJudgeIsIndependent();

  const { probe, reply } = input;
  const config = readLlmConfig("judge");

  const task = [
    `PROBE KIND: ${probe.kind}`,
    `QUESTION ASKED OF THE ASSISTANT: ${JSON.stringify(probe.question)}`,
    probe.expect === null
      ? "GOLD ANSWER: none — this was never stored. The assistant must say it does not know."
      : `GOLD ANSWER: ${probe.expect}`,
    probe.forbidden?.length
      ? `FORBIDDEN (must NOT be asserted as current): ${probe.forbidden.join(" | ")}`
      : "",
    `ASSISTANT REPLY: ${JSON.stringify(reply)}`,
  ]
    .filter(Boolean)
    .join("\n");

  const result = await runStructured(
    config,
    { system: JUDGE_SYSTEM, userMessage: task, context: "" },
    judgeScoreSchema,
  );

  if (result.degraded) {
    // A harness fault must not read as a passing result, so this scores 0 and
    // says why rather than silently inflating the number.
    return {
      score: 0,
      assertedForbidden: false,
      admittedIgnorance: false,
      oneLineReason: `Judge call degraded: ${result.note ?? "unknown"}`,
    };
  }
  return result.data;
}

export interface ProbeOutcome {
  probeId: string;
  kind: ProbeKind;
  question: string;
  reply: string;
  score: number;
  maxScore: number;
  assertedForbidden: boolean;
  admittedIgnorance: boolean;
  reason: string;
  citations: number;
  snapshotFound: boolean;
  latencyMs: number;
}

export function aggregate(outcomes: readonly ProbeOutcome[]) {
  const by = (k: ProbeKind) => outcomes.filter((o) => o.kind === k);

  const direct = by("direct");
  const persona = by("persona");
  const goals = by("goal");
  const traps = by("trap");
  const negatives = by("negative");

  // Probes whose answer WAS seeded. On a memory-bearing condition these measure
  // fidelity; on an empty-memory condition, any non-zero score is leakage.
  const stored = outcomes.filter((o) => o.kind !== "negative");

  const pct = (n: number, d: number) => (d === 0 ? 0 : (n / d) * 100);
  const scored = (list: readonly ProbeOutcome[]) =>
    pct(list.reduce((s, o) => s + o.score, 0), list.length * 2);

  return {
    /** H1: direct fact recall. */
    recallPct: scored(direct),
    personaPct: scored(persona),
    goalPct: scored(goals),
    /** Combined fidelity across every seeded-answer probe. */
    fidelityPct: scored(stored),
    /** H5: trap probes asserting a superseded value as current. */
    stalePct: pct(traps.filter((o) => o.assertedForbidden).length, traps.length),
    /** H4: never-stored probes answered without admitting ignorance. */
    hallucinationPct: pct(negatives.filter((o) => !o.admittedIgnorance).length, negatives.length),
    /** H3: seeded-answer probes that scored at all when memory should be gone. */
    leakPct: pct(stored.filter((o) => o.score > 0).length, stored.length),
    /** Snapshot loaded on this probe. A low value invalidates fidelity numbers. */
    snapshotFoundPct: pct(stored.filter((o) => o.snapshotFound).length, stored.length),
    counts: {
      direct: direct.length,
      persona: persona.length,
      goal: goals.length,
      trap: traps.length,
      negative: negatives.length,
    },
  };
}
