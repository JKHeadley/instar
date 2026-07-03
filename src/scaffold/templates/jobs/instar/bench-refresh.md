---
name: LLM Bench Refresh
description: "Cadenced INSTAR-Bench refresh + routing-defaults drift check. On the maintainer/benching agent (the only agent that carries the bench harness under research/llm-pathway-bench/), it runs the bench harness + parity-check and raises ONE operator attention item with the routing-defaults DIFF — it NEVER auto-applies a routing change to a critical gate (operator-review-gated by design, INSTAR-Bench-v2 spec §7/§8). On every other agent the harness is absent, so the job exits silently — it is a no-op. Monthly cadence (spec §7: monthly full run + on-demand after a prompt ships / a new model is enrolled; the on-demand triggers + the versioned auto-reslot catalog are S6, tracked follow-ups). Ships OFF by default (like feedback-factory-process) — a bench run is metered/cost-bearing ($3-20/run, spec §7 budget), so it must be a deliberate opt-in. Tier-1 supervised: this haiku job wraps the deterministic harness + parity-check and sanity-checks the run before it dares surface a diff. Spec: research/llm-pathway-bench/INSTAR-BENCH-V2-SPEC.md §7 (cadence) + §9 (provenance); docs/LLM-ROUTING-REGISTRY.md (the routing defaults it diffs against)."
schedule: "0 4 1 * *"
priority: low
expectedDurationMinutes: 20
model: haiku
supervision: tier1
enabled: false
tags:
  - cat:bench
  - role:worker
  - exec:prompt
gate: curl -sf http://localhost:${INSTAR_PORT:-4042}/health >/dev/null 2>&1
toolAllowlist: "*"
unrestrictedTools: true
mcpAccess: none
---
Run one INSTAR-Bench refresh + routing-defaults drift check. This is a deliberate, cost-bearing maintainer job (a bench run spends metered API budget). It is OFF by default and only meaningful on the agent that carries the bench harness. Do NOT auto-apply any routing change — this job only ever RAISES a diff for the operator to review (critical-gate routing is operator-review-gated by design).

AUTH="${INSTAR_AUTH_TOKEN:-$(python3 -c "import json; v=json.load(open('.instar/config.json')).get('authToken',''); print(v if isinstance(v, str) else '')" 2>/dev/null)}"
AGENT_ID="${INSTAR_AGENT_ID:-$(python3 -c "import json; print(json.load(open('.instar/config.json')).get('projectName',''))" 2>/dev/null)}"
PORT="${INSTAR_PORT:-4042}"
BENCH_DIR="research/llm-pathway-bench/instar-bench-v2"

1. **Harness-presence gate.** Confirm this agent actually carries the bench harness:
   `test -f "$BENCH_DIR/run2.mjs" && test -f "$BENCH_DIR/parity-check.mjs" && echo present || echo absent`
   If `absent`, this agent is not the benching agent — EXIT SILENTLY, there is nothing to do (this is the no-op path every non-maintainer agent takes). Do not message anyone.

2. **Parity-check FIRST (the cheap, non-metered gate).** A stale battery makes a whole refresh untrustworthy, so verify the batteries still match PRODUCTION prompt text before spending any budget:
   `node "$BENCH_DIR/parity-check.mjs" 2>&1 | tail -40`
   A stale battery is a NAMED failing verdict (spec §9). If parity FAILS, do NOT run the metered bench — surface the parity failure as ONE attention item (step 5, title "bench-refresh: battery parity FAILED") and stop. The batteries must be re-synced to production prompts before a refresh means anything.

3. **Run the refresh at the Wave-1 (cheap smoke) scope.** Full runs cost $12-20 and are a deliberate manual act; the scheduled cadence runs the cheap Wave-1 smoke ($3-5, spec §7). State the cap up front; an unknown price REFUSES to run (spec §7 budget discipline):
   `node "$BENCH_DIR/run2.mjs" --wave 1 2>&1 | tail -60`
   (If `run2.mjs` does not accept `--wave`, read its `--help` and use the documented cheapest-smoke flag; never run the full universe from the scheduled cadence.) The run writes a `run-manifest.json` (bench SHA, per-battery SHA256, price/caps SHA, observed door→model resolution, a `reproduce` command) — that manifest is the provenance record for this refresh.

4. **Tier-1 supervision (your job) — sanity-check BEFORE surfacing anything.** Do not trust a run blindly:
   - The run must have completed with a written manifest and a non-empty results set. A crashed/partial run (no manifest, zero cells) is NOT a signal — note it once and exit; the next cadence retries.
   - Compare the run's per-task winners against the current intentional defaults in `docs/LLM-ROUTING-REGISTRY.md`. A DIFF is only real when it clears the noise floor (spec: <~1.5-pt differences at 218 cells/route are noise — 99.5% vs 99.1% is a TIE, not a diff). Discard sub-noise-floor "changes".
   - If a diff would move a CRITICAL gate (completion/stop/tone/external-op/sanitizer/coherence), it is ALWAYS operator-review — never auto-apply, never present it as "I changed the routing."

5. **Raise the diff as ONE operator attention item (never auto-apply).** Only if step 4 found a real, above-noise diff (or a parity failure from step 2):
   `curl -s -X POST -H "Authorization: Bearer $AUTH" -H "X-Instar-AgentId: $AGENT_ID" http://localhost:$PORT/attention -H 'Content-Type: application/json' -d '{"id":"bench-refresh:routing-diff","title":"<short>","body":"<the per-task old-chain → new-chain diff + the manifest reproduce command>","priority":"medium","source":"agent"}'`
   Use a STABLE `id` (`bench-refresh:routing-diff`) so a re-run updates the one item instead of flooding. If step 4 found NO real diff, raise NOTHING and exit silently — a clean refresh is not news.

6. Exit. This job produces a review artifact for the operator, not a running commentary. Do NOT relay progress to Telegram, do NOT summarize a clean run, and do NOT retry-flood a failed curl (the failure is recorded server-side). The routing defaults change only when the operator reviews the diff and acts — this job never touches config.
