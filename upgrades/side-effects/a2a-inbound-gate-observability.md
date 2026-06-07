# Side-Effects Review — A2A Inbound Gate Observability (PR4a)

**Version / slug:** `a2a-inbound-gate-observability`
**Date:** `2026-06-07`
**Author:** `echo`
**Tier:** `1` (small, low-risk, behavior-preserving — pure observability)
**Second-pass reviewer:** `not-required (Tier-1 logging-only; correctness self-owned per Tier-1-no-review)`

## Summary of the change

Makes `InboundMessageGate` verdicts visible in `server.log`. Previously a blocked
inbound A2A message was **silent** — the decision lived only in the returned
`GateDecision` and in aggregate, restart-volatile metric counters, never the log.
That silence is the exact mechanism by which the dawn→echo remote-relay leg went
dark for ~1.5 days unnoticed (`/threadline/peers/health` showed Dawn's fp with
zero recorded inbound; no block line anywhere in `server.log`).

`evaluate()` now emits: one `[inbound-gate] eval from=<fp12> trust=<level>
op=<type>` line per inbound; a `[inbound-gate] BLOCK <reason> from=<fp12> …` line
on each of the five block paths (the `insufficient_trust` line carries the
**resolved trust level + allowed-ops**, so a fingerprint/trust-key mismatch is
diagnosable from the log alone); and a `PASS` line on success. A private
`logBlock(reason, fingerprint, extra?)` helper centralizes the block lines.

Files: `src/threadline/InboundMessageGate.ts` (logging only),
`tests/unit/InboundMessageGate.test.ts` (+3 observability tests),
`docs/specs/A2A-DURABLE-DELIVERY-SPEC.md` (§6 + Tier-1 note).

## Decision-point inventory

- **Does it change routing / trust / rate-limit / delivery behavior?** No. Every
  `console.log` is additive and side-effect-free; the `evaluate()` return values,
  metric increments, and control flow are byte-for-byte unchanged. A test run
  shows all 37 pre-existing gate tests still GREEN alongside the 3 new ones.
- **New dependency / state / route?** None. No injected dependency added (the gate
  still takes `trustManager`, `router`, `config`), no SQLite store, no HTTP route,
  no config key, no `migrateClaudeMd` section → trips none of the SqliteRegistry-
  wiring / feature-delivery-completeness / docs-coverage guard classes.
- **Silent fallbacks?** None added — no new `try/catch`; the change is pure logging
  (no `@silent-fallback-ok` annotations needed).
- **Log volume / PII?** A2A inbound is low-volume (peer messages, not user chat),
  so per-message logging is not a flood risk. Fingerprints are truncated to 12
  chars; **no payload content** is ever logged (only reason + resolved trust +
  allowed-ops + byte size). No secrets, no message text.
- **Migration parity?** Ships in code via npm; existing agents receive it on the
  normal AutoUpdater path. No agent-installed file (settings/config/hook/skill)
  changes → no PostUpdateMigrator step required. It is internal observability, not
  a user-surfaced capability → no CLAUDE.md template (Agent Awareness) entry.
- **Rollback?** Trivial — revert the single source file; logging vanishes, gate
  behavior is identical (it never depended on the logs).

## Why this is correct to ship before the fix (PR4b)

The drop is silent on **both** remaining hypotheses (gate-blocks-her vs
relay-client-never-emits-for-her), so a Dawn live re-test alone cannot
disambiguate (her prior test left zero trace) and the fix cannot be written
without guessing. PR4a converts the next live test into a self-diagnosing event:
a gate block prints the exact reason + resolved trust (→ trust-resolution fix), or
no `eval` line prints at all (→ upstream relay-client fix). Observability-first is
the verify-claim-honest path to a targeted PR4b.
