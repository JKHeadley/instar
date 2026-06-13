# Green-PR Auto-Merge Enforcement — Phase 7 becomes machinery

## What Changed

- **A background watcher merges your own green PRs (`GreenPrAutoMerger`).** When a PR this
  agent authored is green, mergeable, and not held, a server-interval watcher merges it —
  surviving session death (the prose "Phase 7: merge it yourself" rule died with the session
  that read it; this is machinery, not memory). Lease-serialized (one watcher across a pool),
  single-flight with a restart-surviving liveness guarantee, a per-PR failure ladder + circuit
  breaker, and a Tier-0 supervision posture (the only discretionary call is hold/candidate,
  failing toward skip). Off fleet-wide (`monitoring.greenPrAutoMerge`, classified
  `deliberate-fleet-default`), armed per dev agent with `expectedGhLogin`, repo-gated to an
  instar checkout with `scripts/safe-merge.mjs` present.
- **`scripts/safe-merge.mjs` is the hardened act-time re-verifier.** Strict argv +
  `--capabilities` contract probe, repo parameter, head pinning (`--match-head-commit`), JSON
  checks parsing (the `pending`-matches-a-check-name bug is gone), a producer-bound
  required-contexts floor (a lookalike job with the right name but a tampered workflow path is
  refused), reviews-required refusal, and honest classified exit codes. A `merged` claim is
  never trusted without an independent `gh pr view` confirmation.
- **A pool-visible kill-switch (`GuardLatchStore`) on a new replicated `guard-latch`
  coherence-journal kind.** `POST /green-pr-automerge/rollback` disarms the watcher (Bearer —
  anyone can STOP; absorbing, survives a lease move); `POST /green-pr-automerge/enable` re-arms
  (dashboard-PIN-gated — the operator's authority). Holds always win: a `[HOLD: …]` title, a
  `hold`/`do-not-merge` label, or draft status excludes a PR, and `POST /green-pr-automerge/hold`
  applies the marker in one call.
- **A Layer-2 session-exit nudge.** A session ending with a green unmerged PR on its branch is
  blocked once — "hold it or let the watcher land it; do NOT merge manually." NO variant emits a
  runnable merge command (a green PR + an armed watcher is exactly when manual merging is
  recreated manual work); protected-paths PRs route to the operator instead.
- **A floor-drift canary, routes, boot wiring, config defaults, `/guards` posture, and CLAUDE.md
  awareness** ship with it (Agent Awareness + Migration Parity — existing agents get the config
  block via ConfigDefaults, the hook changes via always-overwrite, and the awareness section via
  `migrateClaudeMd`).

## Evidence

- 117 unit tests: safe-merge hardening (27), guard-latch store (13), pure decision logic (31),
  the orchestrator (14), the merge runner — process-group spawn + two-phase durable in-flight
  record + orphan reap + B10 confirm (12), floor-drift per-family references (9), Layer-2 helpers
  (11). The `CoherenceJournal`/`JournalSyncApplier` suites pass with the new kind (35).
- 6 integration tests: the routes over the real HTTP pipeline — 503 unconfigured → 200 wired
  (feature-alive), the rollback gate closing, PIN gating, and the warm-up→merge tick flow.
- `tsc --noEmit` clean; the dark-gate golden map updated by hand for the new `enabled: false`.
- Independent second-pass review (merge authority + gate + watcher) — verdict CONCUR, appended to
  `upgrades/side-effects/green-pr-automerge-enforcement.md`: no path to an unintended merge,
  fail-toward-skip everywhere.

## What to Tell Your User

When one of my own PRs goes green, I now merge it myself — you never get handed the merge click,
and the merge happens even if the session that built it has ended. This is off by default
everywhere and only turns on for a development agent that I've explicitly configured. You stay in
control: say "stop auto-merging" and I disarm instantly (pool-wide), and re-arming needs your
dashboard PIN. Anything I shouldn't land yet — just say "hold #N" and it's held. PRs that touch
the merge machinery itself never auto-merge; those come to you.

## Summary of New Capabilities

- `GET /green-pr-automerge` — watcher status, the dual-latch gate, episodes, the Layer-2 snapshot.
- `POST /green-pr-automerge/tick` — manual trigger (lease + single-flight + warm-up gated).
- `POST /green-pr-automerge/rollback` (Bearer) · `/enable` (PIN) · `/pool-disarm` (PIN) · `/hold`.
- `monitoring.greenPrAutoMerge` config block (off by default; `expectedGhLogin` arms it).
