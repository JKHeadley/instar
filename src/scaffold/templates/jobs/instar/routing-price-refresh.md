---
name: Routing Price Refresh
description: "Cadenced re-confirmation of published per-token prices for the metered routing doors (docs/specs/routing-control-room-spend-alerts.md, FD-8). A deterministic prober (scripts/routing-price-refresh.mjs) queries only PUBLIC, no-auth model-list endpoints (OpenRouter) at the free scope, validates each price (range + cached<=input), and writes forward-only, UTC-day-aligned points into the MACHINE-LOCAL observed cache (.instar/routing-prices.observed.json) ONLY — STRUCTURALLY never the canonical manifest (a lint + unit test assert this). Observed points feed the REPORTING spend view + the promote-me drift hint; they are gate-INELIGIBLE by construction. Metered / web-verify probes are MANUAL-ONLY, budget-capped, and refuse on no budget (an unknown price refuses rather than guesses). Ships OFF by default (enabled:false). perMachineIndependent — the observed cache is machine-local. Spec: docs/specs/routing-control-room-spend-alerts.md FD-8."
schedule: "0 5 * * 1"
priority: low
expectedDurationMinutes: 5
model: haiku
supervision: tier1
enabled: false
perMachineIndependent: true
tags:
  - cat:maintenance
  - role:worker
  - exec:prompt
gate: curl -sf http://localhost:${INSTAR_PORT:-4042}/health >/dev/null 2>&1
toolAllowlist: ["Bash"]
unrestrictedTools: false
mcpAccess: none
---
Run one routing-price refresh at the FREE scope. This job only INVOKES the deterministic prober and sanity-checks that it produced a well-formed result — the prober owns 100% of the network I/O, the price validation, the forward-only day-alignment, and the observed-cache write (it writes `.instar/routing-prices.observed.json` itself). You have Bash ONLY — no Edit/Write tool. Do NOT try to edit any source file, and NEVER touch `scripts/routing-prices.manifest.json` (the canonical manifest is human/PIN-reviewed only; the prober is structurally forbidden from writing it).

1. **Prober-presence gate.** Confirm the prober ships in this tree; if absent, exit cleanly (nothing to do):
   `test -f scripts/routing-price-refresh.mjs`

2. **Run the deterministic prober at the free scope (public, no-auth, zero metered spend).** Metered/web-verify probes are manual-only and budget-capped — this job never runs them:
   `node scripts/routing-price-refresh.mjs --scope free-probes`

3. **Tier-1 supervision (your job) — sanity-check the run, do NOT re-surface anything yourself.** Confirm the prober printed a well-formed JSON result (`added`, `totalObserved`, `notes`). The observed cache is REPORTING-ONLY; a real price drift surfaces in the Routing Spend dashboard tab's promote hint, never as an edit here.

4. Exit. The observed cache is machine-local and forward-only; the canonical manifest is never touched by this job.
