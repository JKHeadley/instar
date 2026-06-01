## What Changed

**The feedback-factory migration's parity check no longer flags two systems as
"diverged" just because they spell the same status differently.** As Portal's
feedback processor is ported into Instar, the two run side-by-side and a parity
comparator confirms they reach the same conclusions before any cutover. But Portal
still writes the legacy status words (`open`, `fixed`, `resolved`) while the ported
Instar processor emits the canonical lifecycle words (`new`, `fix_applied`,
`closed`). The comparator compared those words literally, so a cluster Portal
marked `resolved` and Instar marked `closed` — the *same* outcome — was reported as
a divergence, which structurally blocks the cutover. That was benign vocabulary
skew being treated as a real history fork.

The fix adds the canonical status-normalization primitives Dawn (Portal's owner)
pinned as the authoritative contract — a legacy→canonical projection map, a
terminal-state check evaluated on the normalized status, and an idempotent
`normalizeStatus()` — and applies the projection to **both sides** before the
parity comparator comparison. A genuine lifecycle mismatch still surfaces, and the
reported values stay raw so an operator still sees each side's actual stored status.

## What to Tell Your User

Nothing to configure, and nothing changes for any current capability. This is
internal plumbing for the in-progress feedback-factory migration: the
Portal↔Instar parity check that gates cutover now reconciles the two status
vocabularies instead of failing on the difference. No routes, jobs, or user-facing
behavior are affected.

## Summary of New Capabilities

- `normalizeStatus()` / `isTerminalStatus()` / `V1_TO_V2_STATUS` / `TERMINAL_STATUSES`
  (`src/feedback-factory/processor/transitions.ts`) — the canonical status-vocabulary
  primitives, byte-mirrored from Portal's reference (`feedback-processor.py` :1035 / :379).
  Normalize-before-terminal-check so a legacy `resolved` correctly reads terminal.
- `compareClusterOutcomes` (`src/feedback-factory/processor/parity.ts`) now normalizes
  both sides before comparing status — eliminating false cutover-blocking divergences
  from v1↔v2 vocabulary skew while still flagging real lifecycle mismatches.

## Evidence

Reproduction: feed the parity comparator one cluster (same fingerprint) whose
outcome is expressed in the two vocabularies — Instar `closed` vs Portal `resolved`
(the same terminal outcome) — and observe the status-branch verdict before vs after
the change. Ran live against the worktree source:

```
input: { instar: "closed", portal: "resolved" }
BEFORE (raw `i.status !== p.status`):        divergent = true   ← false positive, blocks cutover
AFTER  (normalizeStatus both sides):         divergent = false  (both → "closed")
genuine mismatch (instar "investigating" vs portal "resolved"): still_flagged = true
```

So the benign vocabulary skew that previously produced a red parity verdict now
reconciles, while a real lifecycle divergence (`investigating` vs `resolved`→`closed`)
still surfaces. Confirmed across the full pair set + recurrence-not-masked + a green
`compareInvariants` verdict over a vocabulary-skewed window in
`tests/unit/feedback-factory/parity.test.ts` (156 unit + 4 integration green, `tsc` clean).
