# Side-Effects Review — inbound gate: declared credential kind follows the sender's limits

**Version / slug:** `inbound-gate-credential-kind`
**Date:** `2026-11-16`
**Author:** `Echo (security effort, topic 143781)`
**Second-pass reviewer:** `independent reviewer subagent (see below)`

## Summary of the change

Tier 1, 1 source + 1 test file + 2 docs. `src/threadline/InboundMessageGate.ts` `evaluate()` step 2a (credential-share branch, verified pairing enabled): (1) when the sender is not authorized for credential sharing and enforcement is observe-only (dryRun) or not yet armed, the gate still counts and logs its would-block verdict, then continues with `opType = 'message'` through the normal steps (operation permission, inbound-id ledger, per-sender rate limits) instead of returning a pass; (2) the authorized (mutual-verified) credential pass now checks the sender's per-peer message budget first. Step 5's rate checks are extracted into `messageRateBlock` (same checks, same order, same log lines) and reused. Class of problem: a sender-declared message kind could select a branch that skipped the sender's trust and rate checks. Found by the standing security review. User-visible effect: none for peers allowed to message the agent.

## Decision-point inventory

- Inbound credential-kind branch, not-authorized + observe-only — modify — now defers to the ordinary-message checks instead of passing.
- Inbound credential-kind branch, authorized — modify — adds the existing per-peer budget check.

---

## 1. Over-block

A peer whose trust level does not allow ordinary messages, or who is over its message budget, no longer gets a credential-labelled message through while enforcement is observe-only. That is the intent. A mutual-verified peer's credential shares now count against its hourly/daily budget (verified: 10/h, 50/day by default; higher levels more); a burst of credential shares above that is refused with the usual `rate_limited_*` reason and log line.

## 2. Under-block

The observe-only design (FD10) still passes a credential-labelled message from a sender that may send ordinary messages, with the would-block verdict logged, until enforcement is armed. The authorized path still skips the inbound-id ledger's terminal drop by design (the consumer's commit dedups it; the in-memory replay map guards it while the ledger is unavailable).

## 3. Level-of-abstraction fit

Right layer: the single inbound gate every relay message passes through; the fix reuses its existing checks rather than adding new ones.

## 4. Signal vs authority compliance

- [x] The authority remains the resolved sender trust (trust level, mutual-verified source), never the message's self-declared kind — this change makes the code match that stated rule (FD5).

## 4b. Judgment-point check

No new heuristic.

## 5. Interactions

- **Rate limiter:** credential messages now share the sender's message budget with ordinary messages (one counter, as for any message).
- **Metrics/logs:** `credentialDryRunWouldBlock` still counts the observe-only verdict; the would-block log line now ends "judging as an ordinary message" instead of "passing", followed by the gate's normal eval/PASS/BLOCK line.
- **Downstream:** the passed message is unchanged. No post-gate consumer ingests a passed message as a credential because of its declared kind (relay unknown-sender path refuses the op; ingress history only labels it; credential modules handle outbound or the separate mesh command).
- **Small side effects:** a terminal-row redelivery of a credential from a mutual-verified peer now spends one rate slot (that path still skips the ledger drop by design; trusted budget is at least 50/h). The gate's eval/PASS log lines show `op=message` for a credential that fell through; the preceding WOULD-BLOCK line still names it.

## 6. External surfaces

None. No route, config key or file format change.

## 6b. Operator-surface quality

No operator surface.

## 7. Multi-machine posture

Machine-local BY DESIGN: each machine's gate judges its own inbound relay traffic; no new state.

## 8. Rollback cost

Pure code change: revert and ship a patch. No migration.

---

## Conclusion

The gate now matches its stated rule that the sender's trust, not the message's declared kind, decides. Tests on both sides fail on the old code and pass now; second pass concurs. Clear to ship.

---

## Second-pass review

**Reviewer:** independent reviewer subagent (Claude, fresh context, read the diff before this artifact)
**Independent read of the artifact: concur.** No remaining way for a sender to pass with a credential-labelled message where an ordinary message would be refused, other than the deliberate mutual-verified credential path (its own permitted operation, now inside the rate budget). Its suggestions are applied: the stale branch comment is rewritten, and tests now cover the ledger duplicate drop on fall-through, dryRun together with enforcement, and a verified peer whose operations exclude ordinary messages.

---

## Evidence pointers

`tests/unit/threadline-credential-gate.test.ts`: 7 new tests (untrusted sender refused in observe-only and not-yet-armed modes; dryRun with enforcement; operations excluding ordinary messages; ledger duplicate drop on fall-through; credential-labelled messages count against the hourly budget; mutual-verified credential pass stays inside the budget). All 7 fail on the previous code and pass now; 34/34 in the file. Related files (pairing trust, relay unknown sender, local route trust, cross-machine route): 224/224 before the new tests. `tsc --noEmit` clean.

---

## Class-Closure Declaration (display-only mirror)

No agent-authored-artifact defect — not applicable (a code defect in the inbound gate, closed by the unit tests above).
