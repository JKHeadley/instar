---
name: Routing Price Web-Verify
description: "The SCHEDULED web-research price check (operator directive 2026-07-07; docs/specs/routing-control-room-spend-alerts.md FD-8 web-verify): for the metered doors whose prices are published on OFFICIAL WEB PAGES only (Groq, Google), the deterministic prober fetches groq.com/pricing + ai.google.dev/pricing and extracts the tracked models' per-Mtok prices with CONSERVATIVE fail-closed parsers (fixture-realness-tested; a reshaped page refuses, never guesses) plus a plausibility clamp vs the reviewed canonical price (>10x off → refused). Extracted points are OBSERVATIONS written forward-only, UTC-day-aligned, into the MACHINE-LOCAL observed cache ONLY — structurally never the canonical manifest; an observed price never becomes official without the operator's PIN promotion. The fetch is FREE (no LLM, no metered key) — any future LLM-assisted extraction stays manual + budget-capped. Drift between observed and canonical surfaces via the Spend tab promote hint and the observed-drift alert. Ships OFF by default (enabled:false). perMachineIndependent — the observed cache is machine-local."
schedule: "0 6 * * 2"
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
Run one routing-price web-verify pass. This job only INVOKES the deterministic prober and sanity-checks that it produced a well-formed result — the prober owns 100% of the network I/O, the conservative page parsing, the plausibility clamp, the forward-only day-alignment, and the observed-cache write. You have Bash ONLY — no Edit/Write tool. Do NOT try to edit any source file, and NEVER touch `scripts/routing-prices.manifest.json` (the canonical manifest is human/PIN-reviewed only; the prober is structurally forbidden from writing it).

1. **Prober-presence gate.** Confirm the prober ships in this tree; if absent, exit cleanly (nothing to do):
   `test -f scripts/routing-price-refresh.mjs`

2. **Run the deterministic prober at the web-verify scope (official pricing pages; zero metered spend — the fetch is free and no LLM is involved):**
   `node scripts/routing-price-refresh.mjs --scope +web-verify --plausibility-baseline scripts/routing-prices.manifest.json`

   (The `--plausibility-baseline` path is READ-ONLY input for the >10x sanity clamp — the prober's own source is structurally baseline-blind (S2-2) and can never write that file; you pass its location, the prober only compares against it.)

3. **Tier-1 supervision (your job) — sanity-check the run, do NOT re-surface anything yourself.** Confirm the prober printed a well-formed JSON result (`added`, `totalObserved`, `notes`). A note saying a page was "not confidently parseable — refused, never guessed" or "REFUSED by the plausibility clamp" is a HEALTHY fail-closed outcome, not an error. The observed cache is REPORTING-ONLY; a real price drift surfaces in the Routing Spend dashboard tab's promote hint and the observed-drift alert, never as an edit here.

4. Exit. The observed cache is machine-local and forward-only; the canonical manifest is never touched by this job.
