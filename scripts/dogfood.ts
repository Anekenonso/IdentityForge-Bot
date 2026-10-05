/**
 * Dogfooding runner: sends Kenneth's real conversational turns to the live agent,
 * logging replies, verified citations, and written memories on Walrus.
 */

const MESSAGES = [
  "My immediate goal is to submit IdentityForge to the Walrus hackathon",
  "I used to use TailwindCSS, but for this project I switched to Vanilla CSS",
  "I also moved from Enugu to Italy for my Masters degree program",
];

async function main() {
  console.log("=== IdentityForge Dogfooding Session ===");
  console.log(`Sending ${MESSAGES.length} real conversation turns...\n`);

  for (const [i, msg] of MESSAGES.entries()) {
    console.log(`[Turn ${i + 1}] User: "${msg}"`);
    const started = Date.now();
    try {
      const res = await fetch("http://localhost:3001/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message: msg }),
        signal: AbortSignal.timeout(90_000),
      });

      if (!res.ok) {
        const text = await res.text();
        console.error(`  Error HTTP ${res.status}: ${text}\n`);
        continue;
      }

      const data = await res.json();
      console.log(`  Agent: ${data.reply.slice(0, 140)}...`);
      console.log(`  Latency: ${Date.now() - started}ms`);
      if (data.citations?.length) {
        console.log(`  Citations (${data.citations.length}): ${data.citations.map((c: any) => c.content).join("; ")}`);
      }
      if (data.written?.length) {
        console.log(`  Written to Walrus (${data.written.length}):`);
        for (const w of data.written) {
          console.log(`    - [${w.type}] ${w.content}`);
        }
      }
      if (data.pending?.length) {
        console.log(`  Pending Confirmation (${data.pending.length}):`);
        for (const p of data.pending) {
          console.log(`    - [${p.type}] ${p.content} (${p.reason})`);
        }
      }
      console.log();
    } catch (err) {
      console.error(`  Turn error: ${(err as Error).message}\n`);
    }
  }

  console.log("=== Dogfooding Session Complete ===");
}

main().catch(console.error);
