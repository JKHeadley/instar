# Side-Effects Review — only the owner's own words teach the owner's preferences

**Version / slug:** `team-words-not-learned`
**Date:** `2026-11-17`
**Author:** `Echo (security effort, topic 143781)`
**Second-pass reviewer:** `independent reviewer subagent (see below)`

## Summary of the change

Tier 1: 4 source files, 4 test files and 2 docs.

- `src/core/ownerWords.ts` adds `isOwnersOwnWords(entry, ownerUserId)`. It is an allowlist on the owner. A message counts only when it is:
  - a Telegram row whose verified sender id is the owner's (any verified sender when no owner is configured), or
  - an app message with role `owner`, or from a paired app device that has no role,

  and never when it is forwarded. Team members, `msp` phones (another person's), other people in a shared topic, and unverified senders (sender id cleared) never count.
- `TelegramAdapter.logInboundMessage` now keeps the team mark that the route already passed. Before, it was dropped, which is the defect.
- `onMessageLogged` now carries `senderRole` and `via` in its type.
- `server.ts` applies the rule to the Layer-0 classify and to the turn's `fromUser` in the correction window. A team member's turn stays in the window for context but is marked as not the owner's, so the distill prompt (which learns only from owner turns) cannot attribute it to the owner.
- `JevCorrectionShadow.observe` takes the owner id and filters the same way.

Class of problem: a lost provenance mark let another person's words be learned as the owner's preferences.

## Decision-point inventory

- Correction learning input: modify. A deterministic provenance rule (an allowlist on the owner).

---

## 1. Over-block

- **Owner forwards someone else's text:** it is no longer learned from, by design. Lifeline rows mark this explicitly (`forwarded:false` for the owner's own text), so the owner's own messages are unaffected.
- **Multi-owner setups:** only the configured or verified owner's words count. Other authorized Telegram users in a shared topic are no longer learned from as the owner, which is the point of the fix.
- **Agents with no configured owner:** a verified sender id is enough, so single-person agents learn exactly as before.
- **Polling voice and photo rows:** these carry the owner's Telegram id, so they still count when the owner sent them.

## 2. Under-block

- **Shared message logger:** when enabled (off by default) it drops the mark on disk. Live learning reads the callback entry, not the disk, so learning is unaffected, but history replay loses the mark (named, low).
- **Topic-intent capture and the coherence-miss metric:** these still read any user row. That is a policy and metrics question, not preference learning; left as is and named.

## 3. Level-of-abstraction fit

There is one rule module, called by every preference-learning path. The mark is persisted at the single logging seam.

## 4. Signal vs authority compliance

- [x] A deterministic provenance rule; no content judgment.

## 4b. Judgment-point check

No new heuristic.

## 5. Interactions

- Standing authorization and skill learning already use the same owner-id allowlist. This rule matches them.
- Command and intercept gating reads a separate metadata field, which is unchanged.

## 6. External surfaces

None.

## 6b. Operator-surface quality

No change to anything the operator sees.

## 7. Multi-machine posture

Machine-local: learning runs where the message is logged.

## 8. Rollback cost

Revert and ship a patch. Learned records that already exist are untouched.

---

## Conclusion

Closes the class with an allowlist, matching the existing owner-id checks. Clear to ship.

---

## Second-pass review

**Reviewer:** independent reviewer subagent (Claude, fresh context, read the diff and every learning consumer).

**Independent read:** concerns, now addressed.

- **Fixed:** team turns entered the distill window marked as the owner's. The turn's `fromUser` now comes from the rule.
- **Fixed:** the rule was a denylist, so `msp` phones, unverified senders and other users in shared topics passed. It is now an allowlist on the owner's id or role.
- **Fixed:** the callback type lacked `senderRole`. Added, with `via`.
- **Fixed:** an import sat mid-file. Moved.
- **Named in §2:** the shared logger drops the mark on disk; topic-intent capture and the coherence metric.
- **Confirmed:** other ingress routes and learners (standing authorization, skill learning, goal realignment) are already owner-id gated, and nothing else reads `teamPhone` from a row.

---

## Evidence pointers

- `tests/unit/team-words-not-learned.test.ts`: the rule over owner, team, `msp`, forwarded, other user, unverified and no-owner cases, plus the adapter keeping the mark and a wiring check.
- `tests/unit/jev-correction-shadow.test.ts`: team, forwarded, other user and unverified senders are never classified; the owner's messages are.
- The tests fail on the old code. Correction capture and Jev unit files: 77/77.
- The Jev integration and e2e tests (run as unit copies) now give their operator messages a verified sender id, as real owner rows have, and check the new wiring: 14/14. The other row-writer and correction-backlog lifecycle tests are unchanged and pass.

## Current-main guard repair (2026-11-17)

Local Verify rejected the unchanged head twice because team-guards.test.ts still pinned the previous exclusion expression. The production correction path now uses isOwnersOwnWords for both classification and the distill window; the test had not followed that stronger owner allowlist. Reproduced locally (45 passing, one failing). After merging current main, the guard now checks the shared rule is wired to both consumers and exercises team rejection plus owner acceptance. Targeted team guard, owner-word and Jev tests pass (101/101). Runtime policy is unchanged by this repair. Full three-lane verification remains with Local Verify.

Fast guard verification on the branch merged with main: all 29 required fast guard/ratchet files pass (756 tests), run sequentially in six batches of at most five files. Type check passes. The new full-suite result is still required from Local Verify before merge.
