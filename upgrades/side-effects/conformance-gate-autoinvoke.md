# Side-Effects Review — Standards-Conformance Gate auto-invocation

**Trigger:** operator finding (2026-06-12 topic 13481): the gate shipped 2026-05-24
explicitly staged for spec-review wiring; the staging lived only in registry prose →
zero runs in 19 days. ("What's the point of building something and not using it?")
**Change:** spec-converge Phase 1 gains a MANDATORY auto-invocation step — call
`POST /spec/conformance-check`, feed the per-standard flags to the reviewers, record
`ran (N flags)` / `unavailable: <reason>` per round in the convergence report; a
skipped-without-reason gate fails report validation. Registry prose updated to the
honest current state (auto-invoked as of 2026-06-12, CMT-1426 tracks the wider
enforcement-ratio program). PostUpdateMigrator delivers the updated skill content to
deployed agents (established marker/fingerprint pattern).

## 1. Over-block
None: the gate's report is signal-only and an UNAVAILABLE gate (server down, 503)
never blocks convergence — only an unexplained skip fails validation, which costs one
honest sentence.

## 2. Under-block
The mandate lives in skill instructions + report validation, not a programmatic hook
— a determined skip mislabeled "unavailable" would pass until the conformance
metrics funnel (GET /spec/conformance-metrics, already shipped) shows zero runs
against nonzero convergences; CMT-1426's cadence reviews exactly that number. Named
honestly: this is the signal-first phase per Signal vs. Authority.

## 3. Level-of-abstraction fit
The wiring belongs in the round that consumes it (Phase 1) — not a cron, not a
separate job: the gate's value is per-spec flags reaching the reviewers of that spec.

## 4. Signal vs authority compliance
Fully signal-only by construction; blocking authority remains a later, earned phase
(unchanged from the gate's own converged spec).

## 5. Interactions
Composes with the existing 8-reviewer round (a ninth input, not a new reviewer
spawn); the conformance route's extended timeout budget (middleware) already exists;
migration ordering with the posture migration converges either way (both copy the
same bundled file; markers are distinct).

## 6. External surfaces
None beyond the install base (skill content + registry prose + migration).

## 7. Multi-machine posture (Cross-Machine Coherence)
**machine-local BY DESIGN, with reason** — per-machine installed skill content kept
current by each machine's own update cycle (same posture as PR #1088's files). The
conformance CHECK itself runs against the local server of whichever machine runs the
spec review — correct, since the spec being reviewed lives in that machine's
worktree. No user-facing notices, no durable runtime state, no generated URLs.

## 8. Rollback cost
Revert the skill/registry edits and ship; the migration is marker-gated (a reverted
bundle stops patching; already-patched agents keep a mandatory step that calls a
still-existing, signal-only route — benign).

## Second-pass review
Not required — no block/allow runtime decisions, no session lifecycle, no
gate/sentinel/watchdog RUNTIME surface (the "gate" here is review-process content;
the route it calls is unchanged).
