# IdentityForge demo summary

## Verified configuration
- Primary agent: `openai/gpt-oss-20b` via OpenRouter
- Secondary agent: `meta-llama/llama-3.3-70b-instruct` via OpenRouter
- Judge: `openai/gpt-oss-120b` via Groq
- Project preflight: `npm run check` passed

## Evidence from live runs
1. C2 fidelity run
   - Result: 100.0% fidelity
   - Stale: 0%
   - Hallucination: 0%
   - Snapshot: 100%
   - Status: PASS

2. C3 portability run
   - Result: 100.0% fidelity
   - Stale: 0%
   - Hallucination: 0%
   - Snapshot: 100%
   - Status: PASS

3. C4 removal run
   - Result: 0.0% fidelity after forget
   - Leak: 0%
   - Status: PASS (correctly forgets identity)

4. C0 control baseline
   - Result: 0.0% fidelity without memory
   - This confirms the system is not just answering from prior knowledge; the memory layer is doing the work.

## What this proves
- The agent reconstructs identity from Walrus memory and answers from stored facts rather than a hidden session.
- The same core identity remains stable when the model is swapped, proving portability.
- The forget path works: after namespace rotation, the agent resets to a fresh identity state.
- The public Walrus chain audit remains valid, with the relayer reporting the chain-backed state as healthy and the audit path passing.

## Demo narrative
> IdentityForge is a stateless memory-backed identity agent. It reconstructs the user’s identity from Walrus on every turn, uses the delegate key as durable identity, and can be audited publicly. The live eval shows that it remembers correctly, survives a model swap, and resets cleanly after forget.

## Notes
- The Qwen route was tested but the active account does not have purchasable access to the relevant Qwen models; the project therefore used the verified OpenRouter + Groq configuration for demonstration and evaluation.
- The project remains aligned with the judge-independence rule and the Walrus audit model.
