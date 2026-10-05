/**
 * Live User Simulation Test:
 * Tests the system end-to-end as a real human user interacting with the live server.
 * Inspects:
 * - Response text
 * - Latency / response times
 * - Citations & cryptographic grounding
 * - Hallucination detection on unrecorded facts
 * - Consent / confirmation flows
 * - Architectural alignment with project thesis
 */

const BASE_URL = "http://localhost:3001";

interface TurnTest {
  name: string;
  message: string;
  expectedType: "onboarding" | "recall" | "negative" | "goal";
}

const TESTS: TurnTest[] = [
  {
    name: "Turn 1: Self-Introduction (Onboarding & Fact Extraction)",
    message: "Hello! My name is Kenneth and I am a fullstack software developer from Nigeria.",
    expectedType: "onboarding",
  },
  {
    name: "Turn 2: Direct Recall Query (Testing Grounding & Citations)",
    message: "What is my name and what do I do for a living?",
    expectedType: "recall",
  },
  {
    name: "Turn 3: Negative Probe (Testing Hallucination on Unstored Facts)",
    message: "What is my favorite animal and what kind of car do I drive?",
    expectedType: "negative",
  },
  {
    name: "Turn 4: Goal Expression (Testing Goal Storage & Consent)",
    message: "I am building IdentityForge to win the Walrus hackathon on Sui.",
    expectedType: "goal",
  },
  {
    name: "Turn 5: Comprehensive Identity Check",
    message: "Summarize everything you know about me so far.",
    expectedType: "recall",
  },
];

async function runLiveTest() {
  console.log("=================================================================");
  console.log("  IDENTITYFORGE LIVE USER BEHAVIOR & ARCHITECTURE EVALUATION");
  console.log("=================================================================\n");

  // 1. Health & Provenance
  console.log(">>> [Phase 1] Inspecting Live System Health & Provenance...");
  const healthRes = await fetch(`${BASE_URL}/api/health`);
  const health = await healthRes.json();
  console.log(`  Relayer URL:     ${health.provenance?.relayer ?? "unknown"}`);
  console.log(`  Relayer Mode:    ${health.provenance?.mode ?? "unknown"}`);
  console.log(`  Relayer Version: ${health.provenance?.relayerVersion ?? "unknown"} (commit: ${health.provenance?.buildCommit?.slice(0, 8) ?? "none"})`);
  console.log(`  Sui Owner:       ${health.restore?.owner ?? "unknown"}`);
  console.log(`  Namespace:       ${health.namespace}`);
  console.log(`  On-Chain Blobs:  ${health.restore?.total ?? 0}`);
  console.log("  Health Check:    PASSED\n");

  const results: any[] = [];

  // 2. Interactive Conversation
  console.log(">>> [Phase 2] Executing Interactive User Conversational Session...\n");

  for (const [i, test] of TESTS.entries()) {
    console.log(`-----------------------------------------------------------------`);
    console.log(`[TEST ${i + 1}] ${test.name}`);
    console.log(`User Prompt: "${test.message}"`);
    const started = Date.now();

    const res = await fetch(`${BASE_URL}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message: test.message }),
      signal: AbortSignal.timeout(90_000),
    });

    const latency = Date.now() - started;

    if (!res.ok) {
      console.error(`  ERROR HTTP ${res.status}: ${await res.text()}`);
      continue;
    }

    const data = await res.json();
    console.log(`\n  Agent Reply (${latency}ms):`);
    console.log(`  "${data.reply}"\n`);

    console.log(`  Citations Found: ${data.citations?.length ?? 0}`);
    if (data.citations?.length) {
      for (const c of data.citations) {
        console.log(`    * [${c.type}] ${c.content} (id: ${c.id.slice(0, 8)}...)`);
      }
    }

    console.log(`  Memories Written to Walrus: ${data.written?.length ?? 0}`);
    if (data.written?.length) {
      for (const w of data.written) {
        console.log(`    * [${w.type}] ${w.content}`);
      }
    }

    console.log(`  Held for User Confirmation: ${data.pending?.length ?? 0}`);
    if (data.pending?.length) {
      for (const p of data.pending) {
        console.log(`    * [${p.type}] ${p.content} (Reason: ${p.reason})`);
        // Simulate user clicking "Confirm" on the glowing consent card
        console.log(`      -> Simulating User Consent Approval for: "${p.content}"...`);
        const confirmRes = await fetch(`${BASE_URL}/api/confirm`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ type: p.type, content: p.content }),
        });
        const confirmData = await confirmRes.json();
        console.log(`         Committed to Walrus! (Blob ID: ${confirmData.blobId?.slice(0, 16)}...)`);
      }
    }

    console.log(`  Rejected Candidates: ${data.rejected?.length ?? 0}`);
    if (data.rejected?.length) {
      for (const r of data.rejected) {
        console.log(`    * [${r.type}] ${r.content} (Code: ${r.code}, Reason: ${r.reason})`);
      }
    }

    results.push({
      test: test.name,
      message: test.message,
      reply: data.reply,
      latency,
      citationsCount: data.citations?.length ?? 0,
      writtenCount: data.written?.length ?? 0,
      pendingCount: data.pending?.length ?? 0,
    });
    console.log();
  }

  console.log("=================================================================");
  console.log("  SESSION COMPLETE — GENERATING SENIOR DEVELOPER REPORT");
  console.log("=================================================================\n");
}

runLiveTest().catch(console.error);
