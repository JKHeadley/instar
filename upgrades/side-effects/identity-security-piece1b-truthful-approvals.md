# Side-Effects Review — Truthful approval records: the trust tool and MoltBridge

**Version / slug:** `identity-security-piece1b-truthful-approvals`
**Date:** `2026-11-18`
**Author:** `Echo`
**Second-pass reviewer:** `independent reviewer subagent (see below)`

## Summary of the change

Tier 2 (identity provenance), small: `threadline_trust` grants and revokes record source `agent-proposal` instead of `user-granted`; the four readers that accept `user-granted` (`AgentTrustManager` known sources and upgrade rule, `TrustEvaluator`, `httpPeerTrust`, `peerPlaceAdmission`) also accept `agent-proposal`; MoltBridge `approve` records `approvedBy: 'agent-proposal'`. Spec `docs/specs/identity-security-piece1b-truthful-approvals.md` (2 rounds, scope cut twice). 7 source files, ~30 lines, plus one unit test file.

## Decision-point inventory

- Trust upgrade source rule (`AgentTrustManager.setTrustLevel`) — modify — `agent-proposal` added to the accepted sources; behaviour for every existing caller unchanged.
- Peer admission source sets (`httpPeerTrust`, `peerPlaceAdmission`, `TrustEvaluator`) — modify — same addition.

---

## 1. Over-block

None added. Every request accepted before is accepted now. A rollback to an older build on the same machine would refuse peers recorded with `agent-proposal` until re-granted (old readers treat it as an unknown source).

## 2. Under-block

Unchanged from today by design: an agent session can still grant trust and approve a profile at Basic (umbrella §11). Only the record changes. Removing that ability needs the approval card (piece 5).

## 3. Level-of-abstraction fit

The label is set at the single writer (the trust tool, the approve route); readers keep one source set each. No parallel mechanism.

## 4. Signal vs authority compliance

**Required reference:** [docs/signal-vs-authority.md](../../docs/signal-vs-authority.md)

- [ ] No — this change produces a signal consumed by an existing smart gate.
- [x] No — this change has no block/allow surface. (The source sets gain one value so behaviour is unchanged.)
- [ ] Yes — but the logic is a smart gate with full conversational context.
- [ ] ⚠️ Yes, with brittle logic — STOP.

The change makes a record truthful; it adds no authority.

## 4b. Judgment-point check (Judgment Within Floors standard)

No new static heuristic at a competing-signals decision point.

## 5. Interactions

`userInitiated` is false for `agent-proposal` in the audit and the trust-change callback (`UnifiedTrustWiring`), which only records it. `ProfileCompiler` resets its auto-publish count for any value but `'auto'`, so MoltBridge publishing is unchanged.

## 6. External surfaces

The trust tool's response shows `source: 'agent-proposal'`. The trust audit and stored profiles carry the new value. MoltBridge drafts carry the new `approvedBy`. Nothing is sent to other agents or users differently.

## 6b. Operator-surface quality (Operator-Surface Quality standard)

No operator surface — not applicable.

## 7. Multi-machine posture (Cross-Machine Coherence)

Machine-local by design: trust profiles and the audit are per machine and never synced or git-synced; only the value written changes. No new status surface.

## 8. Rollback cost

Revert and ship a patch. Records written with `agent-proposal` stay; an older build reads them as unknown and refuses those peers until re-granted.

## Conclusion

Clear to ship. The review cut the original six-fix spec to the two labels that converged; the other fixes are their own specs.

## Second-pass review (if required)

**Reviewer:** independent reviewer subagent (Claude Opus 5.5), 2026-11-18
**Independent read of the artifact: concur**

Concur with the review: the code does what the artifact says and every existing caller behaves the same; `user-granted` appears only in the four readers; no route lets a caller choose the source; MoltBridge publishing is unchanged. Two nits applied: the comments naming the upgrade sources now include `agent-proposal`, and the ratchet matches the bare word outside comments.

## Evidence pointers

- Unit: `tests/unit/identity-piece1b-truthful-approvals.test.ts`, plus `ThreadlineMCPServer-trust` and `peer-place-admission` (60 tests passing locally).
- Throwaway: a grant through the real `/mcp/threadline` transport returned and stored `source: agent-proposal`, `userInitiated: false` (agent home `.instar/state/identity-build-144636/p1b-throwaway-proof.md`).

## Class-Closure Declaration (display-only mirror)

No agent-authored-artifact defect — not applicable.
