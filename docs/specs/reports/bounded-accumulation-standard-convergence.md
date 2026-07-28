# Convergence Report — Bounded Accumulation Standard

## ⚠ Cross-model review: SKIPPED (abbreviated — internal multi-round, external CLI not built)

The external non-Claude (codex/gemini) pass was NOT run: it requires a `dist/` build that this
spec-only worktree does not have. **Mitigating context:** convergence ran **four internal rounds**
(8 distinct reviewer perspectives total), and the dominant defect class in every round was
*ungrounded prior-art claims* — each was caught by reviewers reading the actual worktree code
(`CoherenceJournal.ts`, `jsonl-rotation.ts`, `SafeGitExecutor.ts`, `TokenLedger.ts`,
`state-coherence-registry.json`, `PostUpdateMigrator.ts`, `SafeFsExecutor.ts`). The final verifier
exhaustively re-grounded every remaining code claim. The operator (Justin) reads this banner and
approves with the reduced-external-assurance state as an informed, pre-approved choice.

## ELI10 Overview

Echo saves lots of little data files and databases on disk — logs of what happened, a map of the
code, a record of tokens used. The problem: a bunch of them only ever grow and nobody trims them,
so one hit 256 MB, another 91 MB, and a dozen logs are 5–14 MB each. Worse, reading one of the
giant files all at once freezes the whole program for a few seconds (part of why Echo had those
"unresponsive" blips). This spec adds an enforced rule — **Bounded Accumulation: every place we
save data must declare a ceiling and stay under it** — plus the machinery to enforce it: a
registry of every store and its limit, two build-time checks (one fails the build if a new store
has no limit, one if someone reads a huge file all at once), a test that proves trimming actually
works, and a fix to the existing trimmer (which ironically did the very whole-file-freeze this
rule forbids). Trimming drops the oldest first and says what it dropped — never silently, never an
audit/security trail (those are archived, never deleted), and never a still-pending to-do.

The hardest part the review surfaced: some of these files are the **replication journals** that
keep Echo's memory consistent across machines, and they carry "this contact was deleted" markers.
Naively trimming them would resurrect deleted people. So those are carved out and bounded by a
peer-aware rule (keep an archive until every machine has seen its deletions) instead of a blind
size cap. The one-time cleanup of the *current* bloat deletes real history, so it runs only with
heavy safety guards and explicit operator authorization (granted as part of this session's
pre-approval).

## Original vs Converged

The v1 draft had the right *idea* (a storage-mass standard, the twin of the existing
"No Unbounded Loops" compute standard) but, reviewed against the live code, would have **built the
wrong thing**:

- **It invented a parallel registry.** Converged: it now EXTENDS the existing 85-entry
  `state-coherence-registry.json` (one census, not two that drift).
- **It would have re-used a trimmer that does the forbidden whole-file freeze.** Converged: it
  FIXES `jsonl-rotation.ts` to rotate by renaming a segment + opening a fresh file (an instant
  metadata op), never read-filter-rewrite.
- **It would have broken cross-machine replication and resurrected deleted contacts** by trimming
  the coherence-journals. Converged: those are carved out and bounded by a peer-ack seq-floor
  guard (a named build sub-item), never a blind size cap.
- **It would have silently destroyed the audit/security trail.** Converged: audit logs are a
  "compliance-hold" class — archived forever, never drop-deleted — and the work REPLACES the two
  existing drop-deleting audit rotators.
- **Its retention exemption for "actionable" stores was a self-applied loophole.** Converged: a
  closed allowlist of 8 stores, each needing a drain invariant + a loud backstop ceiling.
- **It reached only new installs.** Converged: a PostUpdateMigrator backfill reaches deployed
  agents (Migration Parity).
- **Several prior-art claims were factually wrong** (cartographer "unguarded" — it's guarded by
  instar#1069; token-ledger "like feature-metrics" — feature-metrics is a different store;
  "rotateKeep:0 reconciles the compliance comment" — the comment says the OPPOSITE). All corrected
  and grounded.

## Iteration Summary

| Round | Reviewers | Material findings | Spec changes |
|-------|-----------|-------------------|--------------|
| 1 | security, scalability, adversarial, integration/multi-machine, decision-completeness, lessons-aware (5 agents, 6 lenses) | ~25 | Full v2 rewrite: extend existing registry; segment-rotation fix; replication + audit carve-outs; Migration Parity; verified boundedByResolution; concrete ceilings; SafeFs cleanup |
| 2 | lessons+adversarial; decision+integration (2 agents) | 3 (NEW-1 false tombstone-horizon guard claim; NEW-2 AuditTrail misattribution; NEW-3 8MB/16MB unreconciled) | Corrected R-class guard claim; corrected C-class attribution; added R-class 8MB exemption |
| 3 | convergence verifier (1 agent) | 1 (NEW-4: destructive-ops "no rotator" wrong) | Corrected C-class to note existing drop-deleting rotators that the work REPLACES |
| 4 | final verifier (1 agent) | 1 (NEW-5: §4(a) inverted the rotateKeep:0 compliance comment) | Corrected §4(a): keep rotateKeep:4 + layer a peer-ack seq-floor guard, NOT a flip to 0 |
| 5 | (converged) | 0 | none |

Standards-Conformance Gate: unavailable (route timed out at 90s — signal-only, fail-open per the skill; not authoritative this run).

## Full Findings Catalog (material findings by round)

**Round 1 (selected criticals/highs):** parallel-registry-vs-state-coherence-registry; `jsonl-rotation.ts`
does forbidden whole-file IO; cartographer already guarded (instar#1069); token-ledger attribution
wrong; coherence-journals are replication substrate (rotation resurrects PII); audit logs silently
destroyed by oldest-first drop; boundedByResolution self-label loophole; lint registry-membership
opt-out + wrapper/dynamic-path evasion; ratchet count-swap gaming; Migration Parity absent; SQLite
retention needs VACUUM/auto_vacuum; retention machinery must not itself block the loop; Self-Hosting
+ SafeFsExecutor for cleanup; concrete per-store ceilings missing; Tier-3 "feature-alive" E2E missing.
→ Resolved in the v2 rewrite (§3, §3.5, §4, §4.5, §5, §6, §7).

**Round 2:** NEW-1 (R-class "already guards with tombstone-horizon" — false; the real prune is
count-only) → fixed (named seq-floor guard sub-item). NEW-2 ("reuse AuditTrail" — wrong store, and
AuditTrail itself non-conformant) → fixed (C-class is new machinery; AuditTrail disavowed + flagged).
NEW-3 (8MB streamed rule vs 16MB journal kinds) → fixed (R-class accessor exemption).

**Round 3:** NEW-4 (C-class "NO existing rotator" — false; destructive-ops has
`SafeGitExecutor.maybeRotateAuditLog`, security.jsonl has `SecurityLog`/`maybeRotateJsonl`, both
drop-deleting) → fixed (C-class REPLACES the drop-deleting rotators).

**Round 4:** NEW-5 (§4(a) inverted the `CoherenceJournal` comment — claimed `rotateKeep:0`
"reconciles" it, but the comment forbids `rotateKeep:0` as a compliance defect; PII kinds are
`rotateKeep:4` today) → fixed (keep `rotateKeep:4`, layer a peer-ack seq-floor guard). Final
verifier confirmed every other code claim grounded + accurate.

## Convergence verdict

**Converged at round 5 (after the round-4 NEW-5 fix).** The round-4 verifier performed an
exhaustive prior-art sweep and confirmed every concrete code claim in §3/§3.5/§4/§4.5/§5 grounds
out accurately; NEW-5 was the single remaining material finding and is now corrected with the
exact, code-grounded fix the verifier prescribed. `## Open questions` (§8) is empty (D1 token-ledger
window + D2 audit posture ship with safe defaults, operator-tunable at approval). The spec is ready
for operator review and build.
