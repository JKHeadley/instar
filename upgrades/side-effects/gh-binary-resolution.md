# Side-Effects Review — resolve the GitHub CLI by path, so a project item can be recorded as merged

## Summary of the change

The server is launched by launchd with a minimal PATH that does not include
`/opt/homebrew/bin`. Every in-process `execFileSync('gh', …)` therefore died with a raw
`spawnSync gh ENOENT`. The visible consequence: `building → merged` on a project item could
never succeed on this install, because the stage gate correctly refuses to take the caller's word
and verifies the PR with `gh` — a missing binary read as "cannot verify", so the item stayed open.

Adds `src/core/resolveGhBinary.ts` (override → cached → common absolute locations → `which`),
mirroring the established in-repo `BitwardenProvider.findBw` pattern, and uses it at the
`ghPrView` callsite. A missing binary now raises a NAMED diagnostic naming the override env var,
instead of an opaque spawn error.

## Decision-point inventory

None added. `resolveGhBinary()` returns a path or null and makes no decision about whether an
operation may proceed. The existing authority (`StageTransitionValidator`) keeps its judgement
unchanged — it still refuses the transition when the PR cannot be verified.

## 1. Over-block

Nothing newly blocked. The transition already failed in this situation; it now fails with a
useful reason, or succeeds where it previously could not. The resolver cannot cause a refusal that
was not already happening.

## 2. Under-block

The gate still trusts whatever `gh` it resolves. A hostile `gh` earlier on the candidate list, or
a malicious `INSTAR_GH_PATH`, would be trusted — unchanged from the previous behaviour, which
trusted whatever `gh` PATH produced. Named rather than silently accepted; not addressed here
because it is the pre-existing trust model for every CLI this repo shells out to.

## 3. Level-of-abstraction fit

Correct layer. Binary resolution belongs beside the callsite that shells out, not inside the
validator (which should stay a pure decision function) and not in process startup (which cannot
know which binaries a given route will need). The repo already solves this exact problem this
exact way for `bw`.

## 4. Signal vs authority compliance

Compliant. The resolver is a pure signal — a path or null. It holds no blocking authority and
cannot pass anything. The one behavioural change at the authority is that "cannot verify" now
carries a named reason; the refusal itself is unchanged, and it still fails toward refusing rather
than assuming a merge happened.

## 4b. Judgment-point check

No LLM judgement. Deterministic filesystem existence checks.

## 5. Interactions

Scoped to the `ghPrView` callsite. Thirteen other `gh` invocations exist across the tree; most run
in CLI/script contexts that inherit a normal user PATH and are not known to be broken. They are
NOT swept here — a blind sweep would widen blast radius past what is verified. Tracked for
assessment under ACT-1269 <!-- tracked: ACT-1269 -->.

## 6. External surfaces

No API shape change. The failure message on an unverifiable merge becomes human-readable and names
the override variable. No new external calls: `gh pr view` was already being invoked.

## 6b. Operator-surface quality

The new message says what could not be done, why, and the one lever that fixes it, in plain
English — and states that the transition is refused rather than assumed, so the reader knows the
system did not guess.

## 7. Multi-machine posture (Cross-Machine Coherence)

**Machine-local by design.** Binary location is a property of one machine's filesystem; there is
nothing to replicate and a peer's answer would be actively wrong. `INSTAR_GH_PATH` is per-machine
by nature. No durable state, no generated URL, no user-facing notice, so no one-voice gating and
nothing to strand on a topic transfer.

## 8. Rollback cost

Revert the commit. The resolver is additive and its only consumer is the one callsite; reverting
restores the previous `execFileSync('gh', …)` exactly. No data, no migration, no stored state.

## Conclusion

Restores a transition that has been unreachable on this install. Worth recording that this is the
SECOND time `building → merged` has been impossible for an environmental reason — the #866 note at
the same callsite records the 2026-06-06 instance, where the helper simply was not injected. Same
symptom, different cause, which is why this fix targets resolution rather than that one callsite.

Proof, under the exact minimal PATH that caused the failure (`PATH=/usr/bin:/bin`):
bare `gh` → `ENOENT (the old failure)`; `resolveGhBinary()` → `/opt/homebrew/bin/gh`.

**Second-pass review: not required.** No runtime agent-behaviour gate is touched — no message
block/allow, no session lifecycle, no compaction, no coherence gate or trust level. The PR is the
review surface per Tier 1.
