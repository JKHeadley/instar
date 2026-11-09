# Convergence Report — Telegram test groups through the browser broker

## Cross-model review: codex-cli:gpt-6-astra

A real GPT-tier external pass ran through the agent's codex CLI on every one of the six rounds (status `ok` each round; the spec body changed every round, so no round was delta-skipped). Gemini is not installed on this machine and grok is not enabled; codex was the only cross-family reviewer. The Standards-Conformance Gate ran in round 1 and returned `degraded: true` with reason `no-intelligence` (97 standards loaded, none judged); it was not authoritative, and the lessons-aware reviewer carried the constitutional pass in every round.

## ELI10 Overview

Echo needs throwaway Telegram groups to test features live, and only Justin's own Telegram account can make groups. That account's web page is now locked inside one careful component (the broker), which until now could only read the screen and send signed messages. This spec adds three tightly limited actions to the broker: make a test group, list the test groups, and delete one.

The hard part was making sure these actions can never touch one of Justin's real chats. The final design puts a short code at the end of every test group's name. Half the code is a signature only Echo can produce. Delete works only on a group Justin's account created, that is still a forum group, and whose code checks out. Because that proof lives on Telegram itself, a lost or damaged local file can never make Echo forget a group or delete the wrong one.

Making groups is off until Echo writes a time-limited setting naming the approved test bots. There are caps (5 groups at a time, 10 per day), Telegram "slow down" replies are honoured, and test-group work never gets in the way of Justin's replies.

## Original vs Converged

- **Who decides what is ours.** Originally a local list (the ledger) was the only proof a group was made by this feature, with a reconcile step to recover lost outcomes. Reviewers showed that design kept leaking: groups could fall out of a 100-chat window and be forgotten, crashes left rows stuck, a lost file reset everything, and recovered groups skipped checks. After round 3 the design flipped: a marker signed with a dedicated key sits in the group's title, the account itself is read to find and count groups, and the local file became an audit log. Reconcile, orphan adoption and the whole state machine disappeared.
- **Replies come first, structurally.** Originally a 35 s deadline was supposed to keep Justin's replies inside their 60 s reservation. Reviewers showed the arithmetic did not hold. Now a waiting reply renews its reservation until its send finishes (an existing store call nobody was using), and test-group work is only admitted when nothing else is queued.
- **Fewer rights for the bot.** `change_info` was dropped because it would let the bot rename the group out of its own delete check; the rights check accepts Telegram's implied `other` right and names a forbidden set.
- **Cleanup never strands.** The grant now gates create only, expires within 30 days, and must cite a logged decision; list and delete work without it.
- **Boot wiring.** The boot code wraps the driver and forwards only named methods; the spec now requires forwarding the new ones, with a wiring test on the real boot path.
- **Smaller fixes.** Atomic admission, per-step re-authorization (a revocation between phases deletes the new group instead of inviting the bot), typed outcomes with a clear "might have happened" line, the probe given a deadline, list results cached briefly with a cap on account reads, the marker key added to the existing key-material list so the dashboard can never serve it.

## Iteration Summary

| Iteration | Reviewers who flagged | Design findings (internal + codex) | Left behind (precision) | Spec changes |
|-----------|-----------------------|-----------------|-------------|--------------|
| 1 | all six + codex | 45 + 5 | 11 | marker in title, atomic admission, crash recovery, boot forwarding, drop change_info, typed outcomes, grant framing, awareness migration |
| 2 | all six + codex | 16 + 4 | 16 | claim renewal, `incomplete` state, orphan adoption, grant expiry, cleanup without grant, per-step re-auth, origin-local registration |
| 3 | all six + codex | 20 + 4 | 15 | redesign: issuer-keyed marker is the authority; account is the source of truth; ledger becomes an audit log |
| 4 | all six + codex | 15 + 2 | 13 | rights check with `other`, dedicated marker key, read cache and flood hold on reads, unverified visible, decisionRef shape, renewal through invoke, self-healing audit damage; accepted risks recorded |
| 5 | five of six + codex | 12 + 2 | 15 | key-loss behaviour, unverified ceiling separate from cap, decisionRef = attribution source marker, delete gone vs not-a-test-group, key in KEY_MATERIAL_PATHS |
| 6 | four of six + codex | 8 + 1 | 15 | at cap: renewal-failure refusal, read-rate cap, admission-time spacing, 15 s before createChannel, rollback removes key, State-Coherence Registry; all applied in passing |

Standards-Conformance Gate: round 1 unavailable (`degraded: no-intelligence`); rounds 2-6 not re-run (same server state, same reason). Internal reviewers ran on the authoring session's model (claude-opus-5-5) every round.

## Proportion

Tier 2 (touches the operator's real account), about 240 spec lines, 6 rounds of 6. The rounds were not wasted: round 3 found a structural flaw that a narrower review would have shipped. Still flagged: ⚠ six full rounds for a feature whose immediate need is two live proofs; most cost came from rounds 1-3 on a design that was later replaced.

## Left behind

Accepted at the cap (design, not safety or data loss):
- Groups left unverified by a lost marker key can only be removed outside these routes. Accepted: requires loss of the agent's own state; groups are inert and labelled; Echo reports them as one exact list.
- The decisionRef is checked for shape, not resolved against the logged message at read time. Accepted: Echo resolves it when writing the grant; the grant expires within 30 days.
- The 10-per-day and 20-unverified numbers are judged ceilings, not measured. Accepted: constants changed by PR; the live proof records timings and counts.

Precision items (not iterated): page-kept channel objects should be keyed to one operation id; "gone" from absence in a complete `getAllChats` is inferred, not proven; a damaged audit log's 24 h hold has no signal outside the refused request; flood-hold `until` has no upper bound; the probe runs three times per create (live proof to record durations); schema listing for every result (now required to live in one module); exact wording of reply-latency bounds; "dark by default" applies to create only.

## Full Findings Catalog

Raw per-round reviewer outputs (JSON, one entry per lens) were kept during the run and are summarized above by round. The design findings that changed the spec are listed in "Original vs Converged" and the Iteration Summary; every codex finding is quoted in substance in the round notes: R1 reconcile proof, bounded absence, interrupted operations, re-auth after queueing, atomic admission. R2 ledger-forgery claim, lease arithmetic, duplicate handling, recovered groups skipping verification. R3 forbidden recovery transition, lost ledger resetting caps, adoption trusting syntax, scan overflow. R4 copied markers (accepted), missing history (accepted), held-status wording. R5 cache after mutation, key-loss contradiction, renewal stop point, key terminology. R6 renewal-failure refusal, latency wording, result schemas.

## Convergence verdict

Converged at round 6 (the Tier 2 cap). The final round's design findings were small and were applied in passing; none concerned safety, security or data loss beyond what is now handled. Three design items are accepted with reasons above. The spec is ready for Echo's review and approval.
