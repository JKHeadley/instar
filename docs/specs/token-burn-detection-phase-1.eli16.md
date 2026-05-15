# Token-Burn Detection — Phase 1 ELI16

## What this ships

The first piece of the bleeding-detector you approved. This phase lays the foundation that the next four phases build on.

There is nothing user-visible in this phase. The agent doesn't yet notice burns, doesn't yet send alerts, doesn't yet throttle anything. What it does is install the four things the later phases need:

1. **A new column on the token ledger** that says "this LLM call came from this component." Today every call lands under "unknown" — a placeholder we will fill in over the next two phases. The column is there now so the later phases don't have to do a schema migration on a live database.

2. **A small piece called the rate gate.** It's the lever the auto-throttle pulls. Phase 1 ships it as a switch that's always "on" — no throttling happens yet. The shape is in place so the alert-and-throttle runbook can wire into it later without changing the gate. One important detail: the gate refuses to throttle itself. If the runbook is composing an alert, its own LLM call is exempt by design, so we never deadlock.

3. **A small helper** that takes a component name plus a prompt and produces a stable "attribution key" like InputDetector::a1b2c3d4. The same prompt from the same component always produces the same key. That stability is what lets the detector see "the same call shape is running 4,500 times an hour" — the very signal we missed two days ago.

4. **A rule that catches future bleeds.** A new check that runs before code can be pushed: if anyone tries to add a direct call to an LLM provider outside the central provider module, the push is refused. There are a few files in the tree today that already do this — the rule grandfathered them with a comment that says which future phase will migrate them. That keeps the rule from blocking pushes that fix unrelated bugs, while still catching new violations the day they appear.

## What you'd notice if it went wrong

Nothing on this phase alone. Worst case for Phase 1: a bug in the new column migration would prevent the token ledger from opening — but the schema migration uses the same idempotent ALTER-TABLE pattern that has worked for the file_offsets table since launch. The test suite covers the re-open case explicitly.

If the rate gate somehow refused a legitimate call, the LLM call would throw a "throttled" error and the calling code would fall back to its heuristic-only path (which is the existing safety pattern across every IntelligenceProvider caller). The gate is structurally "always on" in Phase 1, so this can't happen unless someone modifies the gate.

If the new lint rule produced a false positive, a developer would see the rejection at push time and add the file to the grandfathered list — the rule is intentionally easy to override for known cases.

## How we know it works

Twenty-one tests in `tests/unit/burn-detection-phase-1.test.ts`. They cover: attribution-key composition with the right shape, the rate gate's always-on Phase 1 behavior, the self-attribution exempt prefix, the ledger column working under both ingest paths (the existing JSONL reader and the new direct-API recorder), the lint rule rejecting a synthetic violation, and the lint rule accepting the IntelligenceProvider files (no allowlist regression).

The existing token-ledger tests (sixteen of them) still pass — no regression on the parts I didn't touch.

## What's next

Phase 2 ships an AttributionResolver that reads the existing JSONL telemetry and fills in the attribution key for events the chokepoint didn't capture directly. After Phase 2 lands, the column will be populated for the dominant case (calls made by the Claude CLI), and the detector in Phase 3 can start watching the per-key rates.
