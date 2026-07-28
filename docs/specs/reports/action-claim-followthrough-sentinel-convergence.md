# Convergence Report — Action-Claim Follow-Through Sentinel (P2)

## ⚠ Cross-model review: UNAVAILABLE

No external (non-Claude) reviewer ran. Reason: `codex` is not on PATH in this
execution context (codex runs on this machine via the server's own invocation path,
not a shell binary the cross-model script can spawn). Convergence ran on the internal
Claude reviewers (lessons-aware + foundation audit, decision-completeness across two
rounds) + the code-based Standards-Conformance Gate. The reduced external-assurance
state is an informed choice; remediation for a future round is to run convergence
from a context with `codex` on PATH.

## ELI10 Overview

When I tell you "relaunching now" or "I'll fix that," nothing today guarantees I
actually do it — and on 2026-06-15 I said exactly that and then didn't. This spec
adds a careful detector on my outgoing messages: when I claim a *concrete* future
action (restart, push, merge, deploy, fix X), it opens a tracked commitment so the
existing reminder + revival machinery makes sure I follow through. It's high-precision
(vague "I'll take a look" never triggers it), it de-duplicates (restating the same
promise updates one commitment, not many), mis-fires expire on their own, and it
never blocks a message — it just opens a background promise to track. It ships off on
the fleet, on for the dev agent first. Verifying *completed*-action claims against
evidence is deferred <!-- tracked: CMT-1554-sibling action-claim-A2-evidence-primitive --> because the evidence channel doesn't exist yet.

## Original vs Converged

The original draft had three load-bearing problems the review caught:

- **It assumed a dedupe primitive that doesn't exist.** `CommitmentTracker.record()`
  mints a fresh commitment on every call (`externalKey` is stored but never read for
  idempotency), so "register on every future-action phrase" would spawn a new nagging
  commitment every turn. Converged: FD3 defines the key
  (`sha256(topicId|normalizedClaimVerb)`) + an idempotent return-existing create path
  + auto-expiry + a per-topic cap — and a live precedent for that exact dedup pattern
  was found at `server.ts:7021`, so it's a real scoped addition.
- **A2 (completed-action verification) was unbuildable as written.** It claimed to
  mirror the TIME_CLAIM check, but TIME_CLAIM works only because the clock is
  caller-injected; OutboundAdvisory is a pure text function with no tool-call/git
  evidence, and the Stop-hook input carries only the message text. Converged: A2 is
  honestly DESCOPED from v1 with a tracked marker — it needs a real per-turn evidence
  primitive first. The founding incident was a future-action claim, which the v1
  feature (A1) catches.
- **It would have spammed durable commitments.** Converged: FD2 restricts the trigger
  to a closed concrete-action verb set, fails toward NOT registering on ambiguity, and
  the spec now extends the EXISTING `detectTimePromise` path rather than drifting a
  second classifier.

Also: Migration Parity wiring (sibling Stop hook + `migrateSettings`/`migrateConfig`)
was added (FD6), the present-progressive tense rule was made explicit (FD4 — "X-ing
now" → A1), the parent principle was re-anchored to "Close the Loop", and the
"outlive its session" standard was engaged (A1 commitments ride the revival path).

## Iteration Summary

| Iteration | Reviewers who flagged | Material findings | Spec changes |
|-----------|-----------------------|-------------------|--------------|
| 1 | lessons-aware (+foundation audit), decision-completeness | 5 blockers (no-dedupe, A2-unbuildable, A1-spam, present-progressive boundary, migration-parity) + overlap-with-detectTimePromise | Rewrote: A2 descoped; added FD2 (precision), FD3 (dedupe+expiry+cap), FD4 (tense), FD5 (signal-only flags), FD6 (migration); re-anchored parent; engaged outlive-session standard |
| 2 | decision-completeness (convergence) | 0 (all 5 blockers resolved; every primitive ground-checked real; A2 descope honest) | none |

Standards-Conformance Gate: ran both rounds (`degraded: error` → non-authoritative,
fail-open, continued). Convergence mode: abbreviated — the two non-skippable reviewers
(lessons-aware+foundation, decision-completeness) ran across two rounds; external
cross-model unavailable-in-context (see banner). The decision-completeness reviewer
covered the security/adversarial/durable-state surface directly (it found the
missing-dedupe and the unbuildable-A2 architectural gaps).

## Full Findings Catalog

**Round 1 — material (resolved):**
1. *(both)* `CommitmentTracker.record()` has no dedupe (externalKey unread) → register-per-turn spam. → FD3 (key + idempotent create + expiry + per-topic cap).
2. *(both)* A2 completed-action verification unplumbed (OutboundAdvisory is pure text; no tool-call/git evidence; TIME_CLAIM analogy false). → A2 descoped from v1, tracked.
3. *(lessons)* A1 would mass-produce unverifiable nagging commitments (known scarring class). → FD2 high-precision closed verb set, fail toward not-registering; FD3 expiry+cap.
4. *(lessons)* A1 overlaps the existing `detectTimePromise` auto-beacon. → spec now extends that path, not a second classifier.
5. *(decision-completeness)* present-progressive boundary ("relaunching now"). → FD4 explicit rule (→ A1).
6. *(decision-completeness)* Migration Parity wiring unaddressed. → FD6 (sibling hook + migrateSettings + migrateConfig).
7. *(lessons, minor)* parent-principle mis-anchored (Cross-Agent Discipline is a sibling). → re-anchored to "Close the Loop". *(minor)* engage the outlive-session standard. → added.

**Round 2:** zero material; every primitive ground-checked present (unread `externalKey`, the `getActive().some(externalKey===)` precedent, `/commitments` route, `time-claim.ts`, sibling instar/ hook deploy path, `migrateSettings`/`migrateConfig`). A2 descope confirmed honest. Two non-blocking notes (normalizedClaimVerb normalization is a build detail; the tracking-id annotation).

## Convergence verdict

Converged at iteration 2. No material findings remain; all five round-1 decision
blockers + the spam concern are resolved as frontloaded durable-state decisions, every
claimed-existing primitive verified, A2 honestly descoped. Open questions: none. The
spec is single-run-completable and ready for review/approval. External cross-model
assurance was UNAVAILABLE in this context (see banner) — an informed approval choice.
