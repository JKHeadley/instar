# Convergence Report — Commitments Coherence (P1.5)

Spec: `docs/specs/COMMITMENTS-COHERENCE-SPEC.md`
Converged: 2026-06-06 (3 rounds)
Reviewers: 4 internal lenses (security, adversarial+scalability,
integration, lessons-aware) + cross-model `codex-cli:gpt-5.5` each round.

## Round summary

| Round | Material findings | Outcome |
|-------|-------------------|---------|
| 1 | ~20 across 4 reviewers + codex (MINOR ISSUES) | Full spec rewrite |
| 2 | Internal combined verify: CONVERGED. Codex: 6 minor text refinements | Folded |
| 3 | Fold-verify (codex's own text, additive honesty clauses) | **CONVERGED** |

## Material findings caught on paper (would have been production bugs)

**The headline (caught independently by 3 of 4 reviewers + grounded in
code):** commitment ids are PER-MACHINE SEQUENTIAL (`CMT-001…`), not
unique — the draft's id-keyed merge would have collided on EVERY
two-machine pair, silently masking real obligations (the exact bug the
feature exists to fix) and routing "deliver CMT-007" to the WRONG
commitment with a valid-looking success. Fixed: composite key
`(originMachineId, id)` everywhere + bare-id 409 ambiguity.

**Round 1, the rest:**
- storeVersion name-collided with the frozen schema literal AND regressed
  on backup-restore, permanently stranding replication behind the
  sinceVersion short-circuit → renamed `replicationSeq` (additive field,
  loadStore guard untouched) + `storeIncarnation` fencing (the journal's
  cure, inherited deliberately this time).
- Flat 256KB snapshot truncation left tail commitments PERMANENTLY
  unreplicated and un-closeable from peers → seq-windowed delta pages.
- A stored `pendingMutation` flag had NO clearing path when the owner
  refuses a transition (refusal doesn't bump the owner's seq → no
  overwrite ever arrives) → computed merge-time field joined from the
  live ledger.
- The beacon-stays-home deferral CREATES duplicate logical promises
  (silent beacon → user re-asks on the other machine) → named,
  heuristically surfaced (`possibleDuplicateOf`), accepted-limitation
  declared, deferral registered against the P3 round item.
- opKey replay: the envelope nonce window is only 60s — the durable
  owner-side opKey window (TTL ≥ pending TTL, restart-surviving) is the
  ONLY replay control and is now pinned.
- Queue-apply trust paradox: a 7-day-old signed envelope can't pass a 30s
  timestamp tolerance → queues store INTENT; a FRESH envelope is
  re-issued at fire time, so the live acceptance gate always applies.
- Snapshot forgery: rows claiming other machines' originMachineId now
  rejected against the authenticated sender (the journal-sync rule, with
  a field to bind it to this time).
- Disclosure honesty: P1 deliberately shipped id+status only; P1.5 ships
  full text — acknowledged, per-field credential-shape redaction added
  (closeability never depends on the scan).
- Nonexistent surfaces corrected against real code: no "commitment-check
  job"; real routes are deliver/withdraw/resume/PATCH; owner-side apply
  needs verdict-bearing wrappers (the existing null-on-terminal collapses
  outcomes the design depends on distinguishing).
- Online forward: single attempt + 5s timeout; timeout = AMBIGUOUS →
  queue with the SAME opKey + honest "queued, confirming" (B24).
- Mutating-verb mixed-version: 501 from an old owner = queue + honest
  answer, never the read-path's quiet back-off (a dropped close is a
  broken promise-close).
- Beacon bookkeeping writes excluded from replicationSeq bumps (the
  write-amplification PromiseBeacon was already tuned to avoid).

**Round 2 (codex):** atomic write-boundary stated (single-file store
write; opKey written after, crash-between recovered as idempotent-noop);
cursor semantics pinned (exclusive, lastMutatedSeq asc + id tiebreak,
oversize-record page); duplicate detection framed as explicitly
heuristic; "serializable at the owner" wording (arrival order is
nondeterministic; the CAS guarantees a valid serialization, not a
predictable winner) + refused-queued-op verdicts surfaced.

## Approval

Standing directive (Justin, topic 13481, 2026-06-06 ~03:05 PDT): "Yes,
please enter a 24 hour autonomy session and continue to proceed through
each project step making sure you implement each one and tested
extremely thoroughly." ELI16 companion sent to topic 13481 at approval.
