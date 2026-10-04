# IdentityForge — Build Plan v3

**Walrus Memory hackathon · Decentralized Persistent Agent Identity**
**Written:** Sun Oct 4, 2026 · **Target submit:** Thu Oct 8, 12:00 UTC · **Hard deadline:** Fri Oct 9, ~14:00 UTC
**Supersedes:** `IdentityForge_Build_Plan_v2.md` and `IdentityForge_Project_Worksheet.md`

---

## 0. Status correction — read this first

The repository contains two markdown files and no code. It is not a git repository.

The v2 worksheet's closing checklist has 8 of 8 items ticked, including *"Phase 0 Kill Test executed and documented"* and *"Production Next.js 15 compilation verified (`next build` exiting with code 0)"*. **None of that exists.** All eight boxes are reset to unticked in §14. A ticked box is a thing you stop looking at; the ticks were the most dangerous artifact in the repo.

v3 supersedes both documents. The honest one (v2, Oct 1) was replaced by a less honest one (worksheet, Oct 2). Do not let that happen again. **Never tick a box for work that has not been run.**

The Oct 1–3 schedule was not executed. Real remaining days: **Oct 4, 5, 6, 7, 8.** The "≥3 real days" of dogfooding now requires every one of Oct 4–7.

---

## 1. Thesis (revised)

> An agent whose durable identity lives in Walrus Memory can be reconstructed on any machine, any deployment, and any LLM from a single Ed25519 delegate key — and every claim it makes is backed by a content-addressed Walrus blob that anyone can independently verify on Sui.

The word doing the work in that sentence is **verify**. v2's thesis ("we can rebuild it") is weak, because rebuilding a stateless web app is a tautology. The defensible claim is not *recoverable* — it is **auditable and revocable**.

### 1.1 What changed strategically

| v2 | v3 | Why |
|---|---|---|
| Load-bearing test: clear browser storage, app rebuilds | Load-bearing test: **destroy the index, rebuild from chain** | Clearing browser state proves your server has no session. Every Next.js app passes that test. It proves nothing about decentralization. |
| Focus on portability | **Portability + auditability + revocability** — three pillars, each independently verified | Portability alone is a commodity. The verifiability story is what nobody else will have built. |
| 5 assumptions listed as unknown | 9 assumptions **resolved from source** (§3) | Four of the five riskiest unknowns are already answered. The spike is now ~30 minutes, not a day. |
| Encryption framed as a risk (A5) | Encryption framed as a **feature** | Memories are SEAL-encrypted before upload. Claim it. |
| 12-section "Veris" README | 9 tight sections | The 12-section structure is documentation theater that costs a day. |

### 1.2 The three proof pillars

| Pillar | Claim | How it is demonstrated | Verifiable by a judge? |
|---|---|---|---|
| **Portable** | Identity follows the key, not the deployment | Paste the same delegate key + account ID into a fresh deployment in a new browser profile and a different LLM. Same answers, same blob IDs. | Yes — reproducible in 60s |
| **Auditable** | Every claim traces to an immutable, content-addressed record | Each reply cites a `blob_id` (a hash of the stored ciphertext). Ownership is a `MemWalAccount` object on Sui, inspectable by anyone in a public explorer. | **Yes — independently, without our app** |
| **Revocable** | Removal is a hard, verifiable boundary | Forget rotates the namespace (`identity` → `identity_v2`). Recall is scoped by `owner + namespace`, so the old generation is unreachable — a structural guarantee, not a heuristic. | Partially (see limitation 2) |
| *Stretch* | **The index is a cache, not the source of truth** | `restore()` rebuilds missing index entries from Walrus. A full demo needs a second relayer — see §11. | Only with self-hosting (stretch) |

**The auditability pillar is the differentiator.** It is a public URL, not a claim. Lead the demo and the README with it.

---

## 2. Phase 0 — Blocking verification (do this first, before any code)

There is exactly one thing that can still kill this project, and it is not technical.

The plan inherits an unverified submission target: a "DeepSurge" portal and an Oct 9 deadline. **I could not confirm either.** A GitHub search for `DeepSurge hackathon` returns only unrelated student repositories. The one Walrus hackathon I could confirm — themed *"Chatbots That Remember"*, an exact match for this project's thesis — ran **Sept 19–22, 2024** with 100,000 SUI across Walrus, Sui, and Community tracks. No 2026 session page, judging rubric, or submission portal was reachable.

| # | Must answer before writing app code | How | If you cannot answer it |
|---|---|---|---|
| **B1** | What is the real deadline, and in which timezone? | Your invite email / organizer Discord | **Stop and ask the organizer.** Every day below is planned against a guessed date. |
| **B2** | What is the actual submission portal? | Same | Same |
| **B3** | Which track? Walrus, Sui, or Community? | Rules page | Same — the tracks reward different things |
| **B4** | Are the LLM providers in the rules eligible? (An "open models" track may exclude closed models) | Re-read the rules | Pick an open-weights model for the primary agent and note it in the README |
| **B5** | Is there a required submission format (video length, repo visibility, write-up length)? | Rules page | Assume a 3–5 min video + public repo |

**Timebox: 30 minutes. If B1–B3 are not resolved by then, the rest of the plan still executes — but treat Oct 8 as the deadline, not Oct 9, and do not let the ambiguity eat a day.**

### 2.1 Repository init

There is no git repo. Create one before writing any code, so every phase is committable.

```bash
cd "c:/Users/USER/Documents/Software Development/AI SaaS/IdentityForge Bot"
git init
git add -A
git commit -m "docs: add v3 build plan; archive v2 plan and worksheet as reference"
```

Add a `.gitignore` (`.env*`, `node_modules/`, `.next/`, `results/*.tmp`) and `.env.example` in the same commit.

---

## 3. Verified platform facts — replaces the entire assumption table

These were read directly from `@mysten-incubation/memwal@0.1.8` type definitions and the official docs at `docs.wal.app/walrus-memory`. **They are facts, not hypotheses. Do not re-derive them, and do not spend Phase 0 rediscovering them.**

| ID | v2 said | **Reality** | Consequence |
|---|---|---|---|
| **A1** | Unknown — spike required | `MemWal.create({key, accountId, serverUrl, namespace})`; public relayer default `https://relayer.memory.walrus.xyz`. Env var is `MEMWAL_PRIVATE_KEY`, **not** `MEMWAL_KEY`. | Works. Zero-risk. Fix the env var name. |
| **A2** | "Recall returns memory ID / blob ID and timestamp" | `RecallMemory = { blob_id, text, distance, created_at? }`. **No memory ID, no type, no metadata.** | Client UUIDs stay in the envelope text. The evidence panel must show **`blob_id`** — that is the verifiable handle. |
| **A3** | "Can enumerate or filter by tag/metadata" | **No metadata or tag filter exists.** `RecallOptions` accepts only `query, limit, topK, namespace, maxDistance, maxTokens, truncationStrategy, countTokens` + score weights. | **v2's snapshot design is broken as written.** See §5.2 — this is the single most important engineering change in v3. |
| **A4** | "Delete/forget semantics unknown" | **The SDK has no `delete`/`forget`/`erase` method at all.** A separate *Security Delete API* exists but targets **legacy V1** blobs, is gated behind `ENABLE_MEMORY_DELETION=true` **and** `ENABLE_SECURITY_DELETE=true`, and requires a wallet-signed challenge + sponsored Sui tx. On the public relayer it returns `404 FEATURE_DISABLED`. | **Namespace rotation is not a fallback — it is the only implementable forget.** Stop treating A4 as an open risk. |
| **A5** | "If plaintext, don't store sensitive data" | Memories are **SEAL-encrypted before upload**. On-chain Sui contracts enforce ownership and delegate authorization. | A5 is dead. Replace it with a *feature claim* and, if time permits, a client-side SEAL write via `MemWalManual` (§11 stretch). |
| **A6** | "Funding, gas, rate limits" | The public relayer's **server wallet covers WAL storage fees**. No WAL or SUI funding required. Real residual risk: no SLA, and "the service can apply usage limits." | Delete the wallet-funding task. Do not spend Oct 4 on funding. |
| **A7** | "Namespace isolation" — needed a test | Documented as a hard guarantee: *"a recall in namespace A will never surface entries written to namespace B, even for the same owner."* | H3 becomes **structural**, not empirical. Still test it (cheap), but it should pass. |
| **A8** | "Model API + eligible models" | See §2 B4. Model choice is pluggable via env. | Not a technical blocker. |
| **A9** | "Recall quality; measure recall@8" | Still genuinely unknown — semantic recall quality is empirical. | Measure it in Phase 1 (30 min). It is the one assumption that must still be tested. |
| **NEW-1** | — | `health()` returns `{status, mode, write_ready, prompt_versions, relayerVersion, apiVersion, featureFlags, deprecations, build.commit}`. `mode` is `"production" \| "benchmark"`. | **Show this in the evidence panel.** It pre-empts "were your numbers faked?" before a judge asks. Highest credibility-per-hour item in the project. |
| **NEW-2** | — | `restore(namespace, limit?)` rebuilds missing index entries from Walrus. Returns `{restored, skipped, failed, total, truncated}`. No pagination cursor; a per-owner source cap is shared across namespaces. | The real decentralization proof. Ship the audit call in the product (§6.4); full second-relayer demo is a stretch (§11). |
| **NEW-3** | — | `analyze()` / `analyzeAndWait()` extract facts with a **server-side LLM** (`prompt_versions.extract` is relayer-controlled). | **Deliberately declined.** It would put a second, invisible probabilistic component in the write path and destroy the "code owns authority" thesis. Say so in the README — declining a built-in feature is itself evidence of judgment. |
| **NEW-4** | — | `remember()` returns only `{job_id, status}`; you get `blob_id` by polling. Docs warn "indexing can lag by a few seconds." | Use `rememberAndWait` **everywhere**, including the eval harness. Otherwise H1 is noise. |
| **NEW-5** | — | `RecallResult.dropped_count` — matches silently omitted when blob download or decrypt fails. | An unmonitored data-loss channel that will quietly depress recall scores. **Surface it in the evidence panel and treat non-zero as a failure mode.** |
| **NEW-6** | — | `@mysten-incubation/memwal/ai` ships Vercel AI SDK middleware (`withMemWal`). | Available; not used. Our write gate must sit between the LLM and the store, and the middleware bypasses it. |

---

## 4. Architecture

```
Browser (stateless — no localStorage, no cookies, no identity)
   │  HTTPS/JSON
   ▼
Next.js 15 API route (stateless; env secrets only)
   │
   ├── RECONSTRUCT ──► memwal.recall()  ──► relayer ──► Walrus (SEAL blobs) + pgvector index
   │                    (snapshot query + relevance query, see §5.2)
   ├── ASSEMBLE ─────► [snapshot] [facts w/ IDs] [rules]   (recalled text wrapped as DATA)
   ├── INFER ────────► LLM (env-selectable) ──► JSON {reply, cited_ids[], memory_candidates[]}
   ├── VERIFY ───────► citation check vs recalled set (deterministic, code-owned)
   ├── GATE ─────────► deterministic write gate (schema, caps, dedupe, user-derived, confirm)
   └── COMMIT ───────► memwal.rememberAndWait() ──► blob_id
   ▼
Client renders reply + citations + Evidence Panel (incl. relayer provenance)
```

**Statelessness rule.** No identity data in browser storage, server memory, server disk, cache, or any database. Allowed on the server: `MEMWAL_PRIVATE_KEY`, `MEMWAL_ACCOUNT_ID`, model API keys.

**The trust-boundary correction (must appear in the README).** v2 claimed "no identity data in any database." That is true of *our* server and misleading about the system. The platform's own model is:

| Layer | Trust | What lives there |
|---|---|---|
| Onchain (Sui `memwal:account`) | **Trustless** | Ownership + delegate-key authorization |
| Offchain (relayer + PostgreSQL) | **Operator-trusted** | Embeddings, vector index, transient plaintext in transit |
| Decentralized (Walrus) | **Durable** | SEAL-encrypted immutable blobs |

The relayer sees plaintext because it must embed and encrypt, and recall requires its index — but that index is explicitly a **rebuildable cache** (`restore()` reconstructs it from Walrus). Use the platform's own diagram and vocabulary rather than drawing your own and hoping nobody asks. A Web3-native judge will find this; owning it is free credibility.

**Identity root, stated plainly.** The delegate key + account ID *is* the identity. Whoever holds it holds the agent. The wipe proves no *application* state holds the identity; it does not prove the identity is key-independent.

---

## 5. Data contracts

### 5.1 Memory envelope (unchanged — v2's design was sound)

```
[IF1|id=<uuid>|type=<persona|goal|preference|decision|history|snapshot>|ts=<ISO-8601>|v=<n>|supersedes=<id|none>]
<one natural-language sentence, <= 300 chars; snapshots <= 1500 tokens>
```

- `id` is a UUID generated in code, **never** by the LLM.
- `ts` is client write time. Prefer the SDK's `created_at` (relayer write time) for ordering once indexed; keep the envelope `ts` for client-side ordering before index. Do not parse timestamps out of text for conflict resolution — that is what `created_at` is for.
- Idempotency: `sha256(normalized content)`. Skip the write if the hash was already stored.
- Append-only. A change is a new memory with `supersedes`; superseded memories are excluded at read time but retained for audit.

### 5.2 Snapshot retrieval — **the critical fix**

v2 assumed you could `recall(..., filter type=snapshot)` and take `max v`. **No such filter exists (A3).** The design that actually works:

1. Store snapshots with a maximally distinctive literal anchor in the envelope and body — e.g. `IF1-SNAPSHOT-IDENTITY` plus the `type=snapshot` tag.
2. Issue a dedicated recall with a **high limit (25–30)**, not k=10. With 40+ facts competing semantically, a small k will drop the snapshot and quietly destroy H1/H2.
3. Parse envelopes client-side; select `type=snapshot` with the highest `v`.
4. **Assert it.** If no snapshot is found, log it and degrade explicitly — do not silently proceed. A silently-missing snapshot is the most likely cause of a failed fidelity run, and you will not see it in the answer text.
5. Prefer the SDK's native budgeting: pass `maxTokens` + `truncationStrategy` rather than hand-rolling a 2,500-token budget.

Relevant recall: the user's message plus standing queries (goals, preferences, decisions, history), `limit: 8`.

### 5.3 Evidence entry (extends v2 with provenance)

```jsonc
{
  "timestamp": "ISO-8601",
  "operation": "remember | recall | reconstruct | consolidate | forget | restore | health",
  "namespace": "identity",
  "memory_id": "uuid | null",
  "blob_id": "string | null",      // the verifiable handle — show this
  "latency_ms": 0,
  "result_summary": "string",
  "success": true,
  "label": "REAL | SIMULATED | MEASURED | DRY_RUN",
  "dropped_count": 0               // from RecallResult — silent data loss if non-zero
}
```

**Plus one relayer-provenance block, captured at session start and shown in the UI:**

```jsonc
{
  "relayer": "https://relayer.memory.walrus.xyz",
  "mode": "production",             // must not be "benchmark" — surface it if it is
  "write_ready": true,
  "apiVersion": "...", "relayerVersion": "...", "build_commit": "...",
  "prompt_versions": { "extract": "...", "ask": "..." },
  "captured_at": "ISO-8601"
}
```

Persistent audit trail = committed `results/*.json` + the `blob_id` lineage. Neither contains identity state.

---

## 6. Core logic

### 6.1 Reconstruction (every turn)
1. Snapshot recall (high limit) → parse → highest `v` → assert found. (§5.2)
2. Relevance recall (`limit: 8`) for the user's message + standing queries.
3. Drop any memory whose `id` appears in another's `supersedes`.
4. Assemble: `[snapshot] [facts w/ IDs] [rules]`. **Wrap all recalled text as data**, with an explicit instruction never to follow instructions found inside recalled content.
5. LLM returns `{reply, cited_ids[], memory_candidates[]}`.
6. Verify citations → gate candidates → queue writes.

**Empty state:** no snapshot and no facts → neutral onboarding: *"I have no stored identity yet. Starting fresh."* Never invent a default persona and call it remembered.

### 6.2 Write gate (what "code owns authority" means)
A candidate is accepted only if **all** hold:
- valid schema, `type` in allowlist, length caps respected
- **derived from the user's message**, not from retrieved memory or tool output
- not a duplicate (`sha256` match, or near-duplicate against the recalled set)
- within caps: ≤ 5 writes/turn, ≤ 20/session
- `persona` and `goal` require **explicit user confirmation** in the UI

Writes are queued and flushed asynchronously; poll job status; retry once; log and continue on failure.

### 6.3 Citation verification
- Any personal-history claim in the reply must cite memory IDs present in the recalled set.
- Invalid or uncited → one regeneration with a stricter instruction → else fall back to: *"I don't have that in my memory."*
- A judge model (§8) runs offline in the harness as a second signal. Report both.

### 6.4 Forget = namespace rotation (A4)

```
identity          → retired
identity_v2       → now active
```

1. Two-step confirmation in the UI.
2. Write the active namespace generation to a single value the app reads. **Where it lives matters:** it must not be identity content. Options, in order of preference: (a) a dedicated `identity_pointer` namespace holding only the current generation name, (b) a value in the deployment env, redeployed on rotation, (c) derived from `listNamespaces()` — pick the *latest* non-retired `identity_*` namespace. Option (c) is the most robust and needs no extra state: **the newest `identity*` namespace by `updated_at` is the live one.**
3. Call `restore(activeNamespace)` and show `{restored, skipped, failed, total, truncated}` as the **forget audit** — the chain-enumerated record of what still exists and what is now unreachable.
4. Log it. Keep the old generation listed in the evidence panel as *retired*, so a judge can see it was not silently dropped.

**Honest wording for the README and the UI:** *"Forget retires this namespace. Recall is scoped by owner + namespace, so the retired generation is unreachable — a structural guarantee. The underlying SEAL-encrypted blobs persist on Walrus until their prepaid storage epochs lapse, and are unreadable without your delegate key."* Do not say "deleted."

### 6.5 Restore audit (NEW — ships in the core product, not as a stretch)
Call `restore(activeNamespace)` on cold start and after every forget. Display the result in the evidence panel. This is the concrete, honest, shippable half of the decentralization story: the relayer independently enumerates your on-chain blobs for `(owner, namespace)` and reconciles them against its index. Non-zero `failed` is a bug; non-zero `truncated` is a disclosed limitation.

---

## 7. The "differentiator" features — cut or build?

| Feature | Decision | Rationale |
|---|---|---|
| Relayer provenance in evidence panel (`health()` + `compatibility()`) | **BUILD — Day 1** | Highest credibility per hour in the whole project. Pre-empts the "is this real?" attack. |
| `restore()` audit + blob-ID lineage | **BUILD — Day 1** | Turns a limitation into a shipped feature. |
| Sui explorer link to the `MemWalAccount` object | **BUILD — Day 2** | A public URL a judge can open. Not a claim — a receipt. |
| Client-side SEAL write via `MemWalManual` (relayer never sees plaintext) | **STRETCH** | Stronger privacy claim; needs `@mysten/seal` + key management. §11. |
| Second relayer, empty index, full rebuild | **STRETCH** | The strongest possible demo. Requires self-hosting. **Not feasible by Oct 8** — §11 says so plainly. |
| `analyze()` server-side extraction | **DECLINE, and say why** | Puts a hidden LLM in the write path. Documenting the refusal is a strength. |
| `withMemWal` AI SDK middleware | **DECLINE** | Bypasses the write gate, which is the thesis. |
| Persona-consistency 1–5 rubric | **CUT** | Unfalsifiable, self-graded, eats a day. Replace with a deterministic check: does the reply match the stored persona string? |
| 3 runs per condition | **CUT to 1**, repeat C2 only | Report a range where you have one; say plainly that n=1. |
| Client-pasted key mode | **CUT** | Server env + a fresh deployment proves portability more cleanly. |
| Mobile polish | **CUT** | Evidence > polish. Check it works; do not style it. |
| State-machine Mermaid diagram | **CUT** | The one flow diagram is enough. |
| Veris 12-section README | **CUT** | §13 replaces it with 9 sections. |
| Multi-user dogfooding (≥3 users) | **CUT** | Contradicts the stated V1 non-goal of single-user. Replace with a **second seed persona** (cheap, and it defends against "you tuned it to one user"). |
| Optional `session-*` namespaces | **CUT** | — |
| Auto-consolidation | **CUT** | Keep the manual Consolidate button. |
| Renewal / epoch tracking | **NOTE only** | Documented platform capability. One sentence in limitations beats a half-built feature. |

---

## 8. Evaluation harness

**Files**
- `eval/seed_user_a.json` — scripted synthetic user, ~40 facts incl. 6 superseded pairs. Label `SIMULATED`.
- `eval/seed_user_b.json` — a second, structurally different persona. Defends against overfitting. `SIMULATED`.
- `eval/probes.json` — 30 probes: 10 direct recall, 5 persona/style, 5 goals/decisions, 5 superseded traps, 5 never-stored negatives.
- `eval/real_probes.json` — written **after** dogfooding, before inspecting the store (§9).
- `results/run-<timestamp>.json` — raw answers, judge scores, blob IDs, relayer provenance, per-condition latency.

**Conditions**

| ID | Setup |
|---|---|
| C0 | Blank agent, no memory (baseline / removal test) |
| C1 | Pre-wipe agent, same session (reference ceiling) |
| C2 | Cold start, same model, memory only |
| C3 | Cold start, **different** model, memory only |
| C4 | After identity forget (namespace retired) |

**Metrics:** fact recall, hallucination rate (negatives), stale-fact rate (traps), deterministic persona match, snapshot-found rate, latency, `dropped_count` sum.

**Judge model.** Must differ from both agent models, and must be current — v2's "Claude 3.5 Sonnet" is **retired** (Oct 2025) and would fail on model ID alone.

| Role | Model | ID | Why |
|---|---|---|---|
| Offline judge | Claude Haiku 4.5 | `claude-haiku-4-5-20251001` | $1 / $5 per MTok. Scoring 30 probes × 5 conditions is volume work; this is the right cost tier. |
| Judge upgrade (if Haiku looks noisy) | Claude Sonnet 5 | `claude-sonnet-5` | $3 / $15 per MTok. Run both on 20% and report agreement. |

Agent models stay env-selectable (`LLM_PRIMARY`, `LLM_SECONDARY`, `LLM_JUDGE`) so §2 B4 can be resolved without a code change.

**Method**
- Judge differs from both agent models. Human-check 20% of judged items; report agreement.
- **1 run per condition, plus a repeat of C2** for a range. Report `n` honestly. No overclaiming from n=1.
- `rememberAndWait` everywhere — the indexing lag (NEW-4) otherwise adds noise you will misread as fidelity loss.
- Surface `dropped_count` in the results table (NEW-5).
- **Real vs. simulated in separate columns**, never blended.

---

## 9. Hypotheses

| ID | Claim | Pass threshold |
|---|---|---|
| **H1** Fidelity | Cold start, same model vs. pre-wipe | ≥ 90% of pre-wipe fact recall |
| **H2** Portability | Cold start, *different* model | ≥ 80% of pre-wipe fact recall |
| **H3** Removal | After forget, private-fact leakage | ≤ 5% of probes, and agent says it doesn't know |
| **H4** Honesty | Hallucinated claims on never-stored probes | ≤ 5% |
| **H5** Staleness | Agent asserts a superseded fact as current | ≤ 10% on trap probes |
| **H6** Chain audit | `restore()` reconciles index against on-chain blobs | `failed = 0`; report `truncated` |

H6 is new and cheap. It is not a fidelity claim — it is the auditability pillar made numeric.

**Real-data rule (keep v2's, it was good).** After dogfooding, write 10 probes from what you actually remember telling the agent — **before inspecting the memory store.** Run them against C2/C3. Report real and simulated in separate columns. Writing probes after peeking at the store is the single easiest way to invalidate the entire evaluation.

---

## 10. Schedule with commit checkpoints

Days are UTC. **You commit manually at each checkpoint** — the messages below are ready to use. Nothing moves to the next phase until its gate is green.

### Phase 0 — Verify & init · Sun Oct 4, morning
- [ ] Answer B1–B5 (§2). Record the answers in `docs/hackathon-rules.md`.
- [ ] `git init`, `.gitignore`, `.env.example`, first commit.
- [ ] Get credentials at `memory.walrus.xyz`. Set `MEMWAL_PRIVATE_KEY` + `MEMWAL_ACCOUNT_ID`.
- [ ] Write `scripts/spike.ts` (~40 lines): `health()` → `compatibility()` → 5× `rememberAndWait` → `recall` → `listNamespaces` → `restore`. Log raw JSON to `evidence/spike/`.
- [ ] Measure **A9**: seed 30 facts, run 20 queries, record recall@8.
- [ ] Check `health().mode === "production"`. If it is `"benchmark"`, say so in the README.

**Gate:** spike runs clean, A9 measured, relayer mode confirmed.
**Commit:** `feat: Phase 0 — verify platform API, measure recall quality, init repo`

### Phase 1 — Core engine · Sun Oct 4, afternoon
- [ ] `src/lib/envelope.ts` — encode/parse, Zod-validated, unit tests.
- [ ] `src/lib/walrus.ts` — MemWal client wrapper; `rememberAndWait`, `recall`, `listNamespaces`, `restore`, `health`, `compatibility`.
- [ ] `src/lib/snapshot.ts` — the §5.2 in-band snapshot retrieval with the "assert found" guard.
- [ ] `src/lib/writegate.ts` — the §6.2 gate, with tests (dupe, oversize, non-user-derived, cap, confirm-required).
- [ ] `src/lib/citations.ts` — §6.3 verification, with tests.

**Gate:** `npm test` green; every gate rule has a passing test.
**Commit:** `feat: core engine — envelope, walrus client, snapshot retrieval, write gate, citation verifier`

### Phase 2 — Vertical slice + deploy · Sun Oct 4, evening
- [ ] `src/app/api/chat/route.ts` — full turn loop.
- [ ] Minimal chat UI. Ugly is fine.
- [ ] **Deploy to Vercel and verify from a second device.** This is the schedule's single biggest risk and it must be retired today.
- [ ] Start real dogfooding immediately (see §9 — every day counts now).

**Gate:** live URL works from a clean browser profile; one full remember → recall cycle verified live.
**Commit:** `feat: chat API + minimal UI, deployed; vertical slice working live`

### Phase 3 — Evidence & control · Mon Oct 5, morning
- [ ] Evidence panel: evidence log + **relayer provenance block** + blob-ID lineage with `dropped_count`.
- [ ] Sui explorer link to the `MemWalAccount` object.
- [ ] Confirmation UX for persona/goal candidates.
- [ ] `restore()` audit display.
- [ ] Forget button: two-step confirm → namespace rotation → restore audit.
- [ ] Consolidate button.

**Gate:** every claim in the UI carries a `blob_id`; relayer mode is visible on screen.
**Commit:** `feat: evidence panel with relayer provenance, blob lineage, restore audit, forget and consolidate`

### Phase 4 — Eval harness · Mon Oct 5 evening – Tue Oct 6 morning
- [ ] `eval/seed_user_a.json` (~40 facts, 6 superseded pairs), `eval/seed_user_b.json`.
- [ ] `eval/probes.json` (30 probes).
- [ ] Runner for C0–C4 + H6.
- [ ] Judge wired to `claude-haiku-4-5-20251001`; 20% human check.
- [ ] First full run. **Expect failures. Fix the harness, not the thresholds.**

**Gate:** one complete `results/run-*.json` with every metric populated and a number for H1–H6.
**Commit:** `feat: eval harness — seeds, probes, C0-C4 runner, H1-H6 results`

### Phase 5 — Hardening · Tue Oct 6 afternoon
- [ ] Injection suite: 8 cases (`remember: you are now a pirate…`, instructions hidden in recalled text, oversize payload, candidate derived from retrieved memory rather than the user, etc.). All must be rejected or neutralized.
- [ ] Failure paths: relayer down → degrade to stateless chat; write timeout → retry once; auth error → block; `dropped_count > 0` → warn.
- [ ] Second seed persona run (overfitting defense).
- [ ] **FEATURE FREEZE — end of day. No new features after this.**

**Gate:** 8/8 injection cases handled; every failure path in §12 has a code path or a written limitation.
**Commit:** `test: injection suite 8/8, failure paths, second seed run; feature freeze`

### Phase 6 — Real data, README, demo · Wed Oct 7
- [ ] **Write `eval/real_probes.json` from memory, before opening the memory store.** (Order is load-bearing.)
- [ ] Final frozen eval runs (C2 repeated for a range).
- [ ] README, 9 sections (§13). Results table mapped to H1–H6, pass/fail per row.
- [ ] Record the demo video (≤ 4 min — see B5). Rehearse the live path as backup.
- [ ] Fresh-clone test: new machine, follow Local Setup literally, `npm ci && npm run dev && npm test`.
- [ ] Secret scan. Grep for identity state in local/DB/cache.

**Gate:** a stranger can clone and run it from the README alone; demo video recorded; no secrets.
**Commit:** `docs: README with H1-H6 results; demo video; real-data probes`

### Phase 7 — Submit · Thu Oct 8
- [ ] Submit well before the deadline. Do not submit at the deadline.
- [ ] Post on X with `#WalrusMemory`.
- [ ] Fri Oct 9 held in reserve for a rejected/broken submission only.

**Commit:** `chore: submitted — hackathon entry live`

---

## 11. Stretches — attempt only if a phase finishes early

Ordered by value-per-hour. **Do not start any of these before Phase 5's freeze, and drop them instantly if they threaten a gate.**

1. **Client-side SEAL write via `MemWalManual`** — one memory the relayer never saw in plaintext, proven. Strongest privacy claim available. ~2h.
2. **Second relayer + `restore()` rebuild** — the full index-loss proof. Requires self-hosting a Rust relayer with PostgreSQL/pgvector, Sui gRPC, Seal, and a sponsor key. **Realistically not feasible in the remaining window.** If you attempt it, timebox to 3 hours and abandon on failure. The honest fallback is §6.5, which already ships.
3. **Second seed persona full eval** (if not done in Phase 5).
4. **MCP / OpenClaw plugin angle** — a one-paragraph note that the same memory store works from Claude Code via the official MCP server. Cheap, shows depth.

---

## 12. Failure modes

| Failure | Detection | Handling | User sees |
|---|---|---|---|
| Snapshot not found | §5.2 guard | Log, degrade to fact-only recall, flag in evidence panel | Reduced-context warning |
| Empty store | 0 results, no snapshot | Onboarding mode | "No stored identity yet." |
| Write fails/times out | job status ≠ `done` | Retry once, log, continue | Soft warning |
| Duplicate write | hash match | Skip | None |
| Hallucinated past | citation check fails | Regenerate once → fallback | "I don't have that in my memory." |
| Stale fact asserted | superseded ID in `supersedes` | Read-time exclusion | Current fact only |
| Relayer unreachable | network error / `health()` | Degrade to stateless chat, no writes | "Memory service temporarily unavailable." |
| Relayer in `benchmark` mode | `health().mode` | **Proceed, and display the mode** | Badge in evidence panel |
| `dropped_count > 0` | `RecallResult` | Warn, count in metrics | "Some memories could not be retrieved." |
| Auth error | MemWal error | Block | "Identity access denied." |
| Prompt injection | injection suite | Memory treated as data; gate rejects non-user-derived candidates | "Proposed memory rejected by security policy." |
| Restore returns `failed > 0` | `RestoreResult` | Bug — investigate before submit | Badge + log |
| Restore `truncated` | `RestoreResult` | Disclose as a limitation | Badge + note |

---

## 13. Limitations (pre-written, publish verbatim)

1. The delegate key + account ID is the identity root. Whoever holds it holds the agent.
2. **Forget is namespace retirement, not erasure.** Recall is scoped by `owner + namespace`, so a retired generation is unreachable — a structural guarantee. The underlying SEAL-encrypted blobs persist on Walrus until their prepaid storage epochs lapse, and are unreadable without your delegate key. A legacy-only Security Delete API exists behind feature flags we do not control and that is disabled on the public relayer.
3. The relayer sees plaintext in transit (it must, to embed and encrypt) and holds a vector index that recall requires. That index is a cache, not a source of truth: `restore()` rebuilds it from Walrus. This is the platform's documented trust model, not a defect we introduced.
4. WAL storage is prepaid for a finite number of epochs; the public relayer's server wallet pays today, and identity expires unless storage is renewed.
5. The relayer and the LLM provider are trusted third parties. We use the managed relayer for this submission.
6. Semantic recall can miss facts. The versioned snapshot backbone mitigates but does not eliminate this.
7. LLM-as-judge is imperfect; small probe set; n=1 per condition with C2 repeated.
8. Single user, single identity. No multi-tenant isolation claims.
9. `restore()` has a per-owner source cap and no pagination cursor; large namespaces can return `truncated`.

---

## 14. Reset checklist

All items unticked. Tick only after running the thing.

**Proof**
- [ ] B1–B5 answered and recorded in `docs/hackathon-rules.md`
- [ ] Relayer `mode` confirmed `production` (or disclosed)
- [ ] H1–H6 each have a recorded number and pass/fail
- [ ] C0–C4 + H6 run on a frozen build; raw JSON committed
- [ ] Real-data probes written **before** inspecting the store
- [ ] Forget behavior verified and documented against A4 reality

**Engineering**
- [ ] No identity in local/DB/cache state (grep + manual check)
- [ ] Write gate enforced in code, with tests
- [ ] Injection suite 8/8
- [ ] `restore()` audit returns `failed = 0`
- [ ] Every §12 row has a code path or a written limitation
- [ ] Secret scan clean; `next build` exits 0

**Evidence & product**
- [ ] Blob IDs and relayer provenance visible in the UI
- [ ] `dropped_count` surfaced
- [ ] Sui explorer link works
- [ ] ≥ 3 real days, verifiable by blob timestamps across distinct UTC dates
- [ ] Live URL works from a clean browser and from a second device
- [ ] Fresh-clone setup works exactly as the README says

**Submission**
- [ ] Video recorded, live path rehearsed
- [ ] Submitted on the verified portal (B2) before the verified deadline (B1)
- [ ] X post with `#WalrusMemory`

---

## 15. Do this right now

1. **Answer B1–B3.** Everything below is planned against a date nobody has confirmed. 30 minutes, then escalate if unanswered.
2. `git init` and make the first commit.
3. Write `scripts/spike.ts` and run it. You will have the real API surface in your hands in under an hour, and Phase 1 becomes mechanical.
4. Deploy something ugly on Oct 4. The schedule's biggest risk is an unproven deploy, and retiring it costs one evening.

**The winning version of this project is not a prettier chatbot.** It is the one that hands a judge a public Sui URL, a `blob_id` that hashes to the exact ciphertext backing a claim, a relayer version string showing `mode: production`, and an honest limitations section that admits the relayer is trusted. Everything else is decoration.
