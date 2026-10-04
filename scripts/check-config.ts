/**
 * Preflight check — verify configuration before spending a run on it.
 *
 * The eval makes ~240 model calls. Discovering a missing key or a judge that is
 * also an agent model after 20 minutes of reconstruction calls is a waste, so
 * this checks everything that can be checked in two seconds.
 *
 *   npm run check
 */

import { existsSync } from "node:fs";
import { readLlmConfig, assertJudgeIsIndependent, type LlmRole } from "../src/lib/llm.ts";
import { healthCheck } from "../src/lib/walrus.ts";

const ROLES: LlmRole[] = ["primary", "secondary", "judge"];

function ok(label: string, detail: string): void {
  console.log(`  \x1b[32m✓\x1b[0m ${label.padEnd(24)} ${detail}`);
}
function bad(label: string, detail: string): void {
  console.log(`  \x1b[31m✗\x1b[0m ${label.padEnd(24)} ${detail}`);
}
function warn(label: string, detail: string): void {
  console.log(`  \x1b[33m!\x1b[0m ${label.padEnd(24)} ${detail}`);
}

async function main(): Promise<void> {
  console.log("\n=== IdentityForge preflight ===\n");
  let problems = 0;

  // 1. Env files
  const hasLocal = existsSync(".env.local");
  const hasPlain = existsSync(".env");
  if (hasLocal || hasPlain) {
    ok("env file", [hasLocal && ".env.local", hasPlain && ".env"].filter(Boolean).join(", "));
  } else {
    bad("env file", "neither .env.local nor .env found");
    problems += 1;
  }

  // 2. Walrus credentials
  if (process.env.MEMWAL_PRIVATE_KEY && process.env.MEMWAL_ACCOUNT_ID) {
    ok("walrus credentials", "MEMWAL_PRIVATE_KEY + MEMWAL_ACCOUNT_ID set");
  } else {
    bad(
      "walrus credentials",
      `missing ${[
        !process.env.MEMWAL_PRIVATE_KEY && "MEMWAL_PRIVATE_KEY",
        !process.env.MEMWAL_ACCOUNT_ID && "MEMWAL_ACCOUNT_ID",
      ]
        .filter(Boolean)
        .join(", ")} — generate at https://memory.walrus.xyz`,
    );
    problems += 1;
  }

  // 3. Model roles
  const configs = new Map<LlmRole, { provider: string; model: string }>();
  for (const role of ROLES) {
    try {
      const config = readLlmConfig(role);
      configs.set(role, { provider: config.provider, model: config.model });
      ok(`${role} model`, `${config.model}  (${config.provider})`);
    } catch (error) {
      bad(`${role} model`, (error as Error).message);
      problems += 1;
    }
  }

  // 4. Judge independence — the check that silently invalidates every number.
  if (configs.size === ROLES.length) {
    try {
      assertJudgeIsIndependent();
      ok("judge independent", "judge model differs from both agent models");
    } catch (error) {
      bad("judge independent", (error as Error).message);
      problems += 1;
    }

    const models = [...configs.values()].map((c) => c.model);
    if (new Set(models).size !== models.length) {
      bad("model variety", "models are not all distinct — the H2 swap needs two different models");
      problems += 1;
    }
  }

  // 5. Live relayer
  if (process.env.MEMWAL_PRIVATE_KEY && process.env.MEMWAL_ACCOUNT_ID) {
    const health = await healthCheck().catch(() => null);
    if (!health || health.status === "unreachable") {
      bad("relayer", "unreachable");
      problems += 1;
    } else {
      const mode = health.mode ?? "not reported";
      if (mode === "production") {
        ok("relayer", `status ${health.status}, mode ${mode}, write_ready ${health.writeReady}`);
      } else {
        warn("relayer", `mode is "${mode}" — disclose this in the README if it is benchmark`);
      }
    }
  }

  console.log();
  if (problems > 0) {
    console.log(`\x1b[31m${problems} problem(s) found.\x1b[0m Fix the above before running the eval.\n`);
    process.exitCode = 1;
  } else {
    console.log("Ready. Next: npm run seed -- eval/seed_user_a.json eval_a\n");
  }
}

main().catch((error) => {
  console.error("\nPreflight failed:", (error as Error).message);
  process.exitCode = 1;
});
