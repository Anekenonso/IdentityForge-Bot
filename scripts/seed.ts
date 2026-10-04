/**
 * Bulk seed a namespace from an eval seed file.
 *
 * Bulk matters: a single write measures 29s on mainnet, so seeding 44 facts
 * sequentially would take ~21 minutes. rememberBulk runs 20 per call and brought
 * that to ~5s per fact (see the spike report).
 *
 *   npm run seed -- eval/seed_user_a.json identity
 *   npm run seed -- eval/seed_user_b.json identity_b
 */

import { readFile } from "node:fs/promises";
import { basename } from "node:path";
import {
  createMemory,
  encode,
  type MemoryEnvelope,
  type MemoryType,
} from "../src/lib/envelope.ts";
import { rememberMemoriesBulk, BULK_MAX } from "../src/lib/walrus.ts";

interface SeedFact {
  key: string;
  type: MemoryType;
  content: string;
  supersedes?: string;
}

interface SeedFile {
  name: string;
  facts: SeedFact[];
  snapshot: string;
}

async function main(): Promise<void> {
  const file = process.argv[2] ?? "eval/seed_user_a.json";
  const namespace = process.argv[3] ?? "identity";

  const seed = JSON.parse(await readFile(file, "utf8")) as SeedFile;
  console.log(`\nSeeding "${seed.name}" (${basename(file)}) into namespace "${namespace}"\n`);

  // Build every memory first so `supersedes` can reference a real UUID. The
  // superseded (old) facts are written too — append-only storage means the
  // staleness test only works if they are actually on chain.
  const idByKey = new Map<string, string>();
  const memories: MemoryEnvelope[] = [];

  for (const fact of seed.facts) {
    const supersedesId = fact.supersedes ? idByKey.get(fact.supersedes) : undefined;
    if (fact.supersedes && !supersedesId) {
      throw new Error(
        `Fact "${fact.key}" supersedes "${fact.supersedes}", which has not been written yet. ` +
          `Superseding facts must appear after the fact they replace.`,
      );
    }
    const memory = createMemory({
      type: fact.type,
      content: fact.content,
      supersedes: supersedesId ?? "none",
    });
    idByKey.set(fact.key, memory.id);
    memories.push(memory);
  }

  const snapshot = createMemory({ type: "snapshot", content: seed.snapshot, v: 1 });
  memories.push(snapshot);

  const supersededCount = seed.facts.filter((f) => f.supersedes).length;
  console.log(`  ${seed.facts.length} facts (${supersededCount} superseding), 1 snapshot`);
  console.log(`  writing in chunks of ${BULK_MAX}\n`);

  let written = 0;
  const failures: string[] = [];

  for (let i = 0; i < memories.length; i += BULK_MAX) {
    const chunk = memories.slice(i, i + BULK_MAX);
    const outcome = await rememberMemoriesBulk(
      chunk.map((memory) => ({ memory, encoded: encode(memory) })),
      namespace,
    );
    written += outcome.succeeded;
    chunk.forEach((memory, j) => {
      const result = outcome.results[j];
      if (!result?.blobId) failures.push(`${memory.type}: ${memory.content.slice(0, 50)}`);
    });
    console.log(
      `  ${written}/${memories.length} written  (chunk ${Math.floor(i / BULK_MAX) + 1}, ${outcome.latencyMs}ms)`,
    );
  }

  console.log(`\nDone. ${written}/${memories.length} written.`);
  if (failures.length > 0) {
    console.log(`\n${failures.length} failed:`);
    for (const f of failures) console.log(`  - ${f}`);
    process.exitCode = 1;
  } else {
    console.log(
      `\nNext: run the eval against this namespace. Forgetting is namespace\n` +
        `rotation, so a fresh seed is always into a fresh namespace.`,
    );
  }
}

main().catch((error) => {
  console.error("\nSeed failed:", (error as Error).message);
  process.exitCode = 1;
});
