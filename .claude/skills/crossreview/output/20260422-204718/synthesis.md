# CrossReview Synthesis: SELF-HEALING-REMEDIATOR-SPEC.md

**Review ID**: 20260422-204718
**Date**: 2026-04-22
**Models**: GPT 5.4, Gemini 3.1 Pro, Grok 4.1 Fast
**Document**: SELF-HEALING-REMEDIATOR-SPEC.md
**Focus**: full document

---

## Overall Assessment

**Consensus Status**: CONDITIONAL

| Model | Status | Score | Key Finding |
|-------|--------|-------|-------------|
| GPT 5.4 | CONDITIONAL | 8/10 | Alert policy inconsistency; machine-lock reclaim too strict; errorCode enum governance missing |
| Gemini 3.1 Pro | APPROVE | 9/10 | Build-toolchain precondition missing for npm rebuild; wall-clock TTLs break on sleep/wake |
| Grok 4.1 Fast | APPROVE | 9/10 | No critical issues; gaps around multi-machine sync, runbook lifecycle, queue-replay idempotency |

**Average Score**: 8.67 / 10
**Score Range**: 8 - 9

Two of three models approve outright; GPT holds CONDITIONAL on a handful of correctness and alert-policy issues. Net: strong spec, ready for implementation after a tight fix-list addresses the consensus issues below. Treating as **CONDITIONAL** overall because GPT's critical issues (alert matrix ambiguity, lock reclaim logic, state machine formalization) are real behavioral bugs the "approve" reviewers didn't contradict, they just didn't surface.

---

## Consensus Findings

*Issues 2+ models flagged independently — strongest signal for real problems:*

1. **Wall-clock time vs monotonic time for short-duration TTLs/heartbeats**: Flagged by Gemini and GPT
   - Gemini frames it as sleep/wake laptop scenario: lid-close causes wall-clock jumps that make locks instantly stale or reset window-caps incorrectly. GPT frames it as a generic clock-skew / NTP-correction gap across TTLs, deadlines, and rolling windows.
   - **Action**: Specify `process.hrtime.bigint()` / `performance.now()` for short-duration timers (heartbeats, expectedRuntimeMs, attempt deadlines). Keep wall-clock for 24h windows but document sleep-state semantics. This intersects with GPT's Issue 2 — elapsed-time reclaim logic must be monotonic-aware.

2. **Git-sync scale problem for per-machine audit/state files**: Flagged by Gemini and Grok
   - Gemini: `attempts-*.jsonl` git-synced across fleet → repo bloat, clone-time blowup at Phase 3.
   - Grok: `degradations-queue.jsonl` git-sync could replay old entries post-remediation; dedup key `{subsystem, errorCode}` too coarse to reject replays.
   - **Action**: Two-part fix. (a) Audit-log sync: restrict git-sync to the small `attempts-recent-<machineId>.json` sidecar; plan a remote sink (S3/centralized telemetry) for Phase 2/3. (b) Replay idempotency: add a `replayId = sha256(event.observedAt + agentId + nativeError.moduleName?)` to `NormalizedDegradationEvent`, reject duplicates in `onDegradation`. Note Grok's own self-flag: a `machine-locks-sync.jsonl` proposal would violate the spec's machine-scoped exclusion boundary — if adopted, it must be a coordination signal, not a lock.

3. **Runbook governance / lifecycle undefined**: Flagged by GPT and Grok
   - GPT: no ownership/review process for runbooks, no blastRadius=machine approval workflow, no per-runbook rollback expectations.
   - Grok: no deprecation policy (e.g., auto-disable if churn>5 in 30d or success<80%), no metrics-driven prioritization, registry grows unbounded.
   - **Action**: Add a Runbook Lifecycle section: authoring → review (checklist, dry-run evidence format) → activation → metrics-driven deprecation (churn/success thresholds) → retirement. Seed success-rate histogram in `/remediation/status`.

4. **npm rebuild command under-specified**: Flagged by GPT and Gemini
   - Gemini: missing precondition that the native toolchain (make/gcc/clang, Xcode CLI) exists; a Homebrew update that bumped Node may have broken the toolchain too, and a mid-mutation failure lands in `execution-failed-partial` dead-letter.
   - GPT: no sandboxing — missing cwd rules, env allowlist, timeout, stdout/stderr capture/truncation, exit-code handling, kill-on-timeout.
   - **Action**: Combined precondition + sandbox contract on the ABI runbook: verify build tools in PATH; define cwd, env allowlist, hard timeout, captured+truncated stdio, explicit exit-code handling, SIGKILL on timeout.

---

## Unique Catches (Per Model)

### GPT 5.4 Unique Findings
- **Alert policy internally inconsistent across Trust-model / Lifecycle / Upgrade-invariants**: Real product-behavior blindspot; spec both says "silent on success" and "preserve existing DegradationReporter alert path." Needs explicit matrix by {mode × outcome}. Highest-value catch in the review — nobody else surfaced it.
- **Machine-lock reclaim bootId-mismatch over-strictness**: Requiring bootId mismatch means a same-boot dead process's lock is never reclaimable; also "heartbeatAt > 3× expectedRuntimeMs" reads like absolute-timestamp comparison, not elapsed. Concrete correctness bug.
- **HMAC-based restart authorization weakness**: Single-user machine ⇒ HMAC is integrity-check, not privilege boundary. Separate keys per purpose (restart-intent vs pending-verify); consider authenticated local IPC for privileged restart. (Design-philosophy, but worth calling out.)
- **FeedbackManager dedup key too coarse**: `{subsystem, errorCode}` collapses distinct incidents across time. Add incident-window component.
- **panicStop state-corruption footgun**: Spec admits aborting at next await is state-corrupting. Replace with abort-requested transition + per-runbook cleanup handlers.
- **match() purity incomplete**: Static lint forbids fs/net/env but semantic "live observation" (e.g., `process.versions.modules`) is allowed. Move runtime facts into a dispatcher-prepared immutable ctx.
- **Explicit remediation state machine missing**: States are scattered across prose rather than formalized with legal transitions, persisted artifacts per state, retry eligibility, and escalation semantics.
- **ErrorCode enum registry not owned/versioned**: Safety model depends on structured matching, but no enum owner, versioning policy, or extraction test corpus.

### Gemini 3.1 Pro Unique Findings
- **`blastRadius: external` semantic contradiction**: Interface allows it, Guardrails forbid outbound network during execute(). Either rename to `cross-agent` or document as Phase-3-reserved and rejected by load-time validator. Valid documentation/safety-regression concern.
- **Symlink atomicity for shadow-node repoint**: `ln -sfn` is atomic but JS fs APIs for symlinks can be tricky cross-platform. Specify atomic write-rename.
- **Dead-letter / rollback directory inode-exhaustion**: TTL-only retention; a fast-looping alternating-errorCode failure could exhaust inodes. Add hard count cap (e.g., 50 files).
- **Telemetry spam on coalesced events**: 10k matching events → 10k `covered-by-attempt` telemetry rows? Specify rate-limiting/aggregation.

### Grok 4.1 Fast Unique Findings
- **Cost/CPU budget for slow hosts**: `npm rebuild` + `/health` polling up to 4–6 min could spike CPU/IO on low-spec machines. Add `costTelemetry` + enforce verify timeout at `expectedRuntimeMs * 2`. Valid, low-priority.
- **Observability gap: runbook match histograms**: `/remediation/status` lacks breakdown of events matched but precondition-failed. Useful for deprecation policy tie-in.
- **Container/platform accuracy**: `process.platform` inside containers; `flock`→`O_EXCL` fallback untested on Windows. Reasonable but out-of-scope for Phase 1 (spec explicitly scopes ABI runbook to darwin/linux).
- **Windows parity for ABI runbook**: Extend to win32 with `node-gyp rebuild` fallback. Grok's own subagent notes this is slightly out-of-phase with the spec's explicit darwin/linux scope — treat as Phase-2.

---

## Divergences

### Divergence 1: Overall readiness to ship
- **GPT**: CONDITIONAL (8/10) — "high-quality design, but a few correctness and operability issues should be resolved before build"
- **Gemini**: APPROVE (9/10) — "essentially ready for implementation, pending minor edge-case clarifications"
- **Grok**: APPROVE (9/10) — "no showstoppers block approval"
- **Analysis**: GPT is right to hold CONDITIONAL. The alert-policy matrix ambiguity (Issue 1) and machine-lock reclaim logic (Issue 2) are behavioral correctness bugs that will ship broken if not resolved in spec. Gemini and Grok didn't refute these — they simply didn't look at the alert/lifecycle cross-section or the bootId predicate closely. Treat GPT's critical-issue list as the fix-list before /instar-dev; Gemini and Grok's findings are additive (toolchain precondition, git-sync scale, lifecycle policy) and should be folded in.

### Divergence 2: Git-synced coordination signals
- **Grok**: Proposes `machine-locks-sync.jsonl` git-synced append-only pubsub for cross-host lock events.
- **Gemini**: Argues the opposite direction — git-sync of per-machine JSONL files is already a Phase 3 bottleneck; move audit logs OUT of git.
- **GPT**: Silent on multi-machine coordination; focused on single-user-machine assumption and suggests making it explicit.
- **Analysis**: Gemini's direction wins. Adding more git-synced state per machine compounds the Phase-3 bloat problem Gemini identified. If cross-host coordination is needed, it should be a distinct lightweight signal (not a lock) and ideally go through a centralized sink rather than git. Grok's own subagent flagged this inconsistency.

### Divergence 3: Clock-skew mitigation scope
- **GPT**: Broad — all TTLs/deadlines/rolling-windows are wall-clock; needs monotonic-timer usage across the board.
- **Gemini**: Scoped — short-duration only (heartbeats, expectedRuntimeMs); keep wall-clock for 24h windows, document sleep-state.
- **Grok**: Not raised.
- **Analysis**: Gemini's scoped guidance is the practical answer. Monotonic for sub-minute durations; wall-clock for long windows with documented sleep-state behavior. GPT's broader framing is correct in principle but overshoots the pragmatic fix.

---

## Model Strengths Observed

| Model | Strengths | Weaknesses |
|-------|-----------|------------|
| GPT 5.4 | Cross-section consistency analysis (alert matrix across 3 sections); precise predicate-logic bugs (lock reclaim bootId); formal gaps (state machine, enum registry, governance). Highest density of concrete correctness catches. | Response truncated mid-Section 7 at max_tokens. Light on industry-comparison specifics. |
| Gemini 3.1 Pro | Operational realism — build-toolchain precondition, sleep/wake cycle, inode exhaustion, symlink atomicity. Best external-lens catch on git-sync scale. Good industry comparisons (K8s operators, Ansible, PagerDuty). | Truncated at recommendation #3. Missed alert-policy inconsistency and state-machine formalization. No cryptographic-specifics scrutiny. |
| Grok 4.1 Fast | Completeness (full template, no truncation); pattern-name recall (Axon saga, Hystrix, eBPF dispatch); runbook lifecycle/deprecation framing. Strong on maintenance/evolution axis. | One self-contradicting recommendation (git-synced locks violating spec's own exclusion boundary). One out-of-phase recommendation (Windows parity). Declared "no critical issues" while GPT found 8 — recall weaker than GPT. |

---

## Prioritized Recommendations

*Combined from all models, ordered by frequency × impact:*

| Priority | Recommendation | Flagged By | Impact |
|----------|---------------|------------|--------|
| P0 | Define alert policy matrix by {mode × outcome} — dry-run / no-match / succeeded / failed / skipped. Resolve conflict between "silent on success" and "preserve existing DegradationReporter alert path." | GPT | High — biggest product-behavior ambiguity |
| P0 | Rewrite machine-lock reclaim predicate: elapsed-time (now − heartbeatAt > threshold) AND pid-dead AND (bootId-mismatch OR same-boot-stale-with-evidence). Remove bootId-mismatch-required. | GPT | High — lock leaks disable remediation until manual intervention |
| P0 | Formalize attempt state machine: states, legal transitions, persisted artifacts per state, retry eligibility, feedback behavior, escalation, per-transition metrics. | GPT | High — prevents crash/restart-boundary drift |
| P1 | Specify monotonic-time for short-duration timers (heartbeats, expectedRuntimeMs, per-attempt deadlines). Document sleep-state semantics for 24h wall-clock windows. | GPT + Gemini | High — laptop lid-close causes spurious reclaims / cap resets |
| P1 | Restrict git-sync of per-machine audit files to the small sidecar; plan remote sink (S3 / centralized telemetry) for Phase 2/3 growth. | Gemini + Grok | High — Phase-3 repo bloat + clone-time blowup |
| P1 | Add `replayId = sha256(event.observedAt + agentId + nativeError.moduleName?)` to NormalizedDegradationEvent; reject duplicates in `onDegradation`. | Grok (+ GPT dedup concern) | High — git-sync replay of queue entries re-triggers verified successes |
| P1 | Formalize ErrorCode registry: owner, versioning, unknown-classification behavior, extraction test corpus, deterministic normalization. | GPT | High — structured-matching safety model rests on this |
| P1 | Add build-tool precondition + sandbox contract to ABI runbook: verify make/gcc/clang in PATH; define cwd, env allowlist, hard timeout, stdio capture+truncation, exit-code handling, SIGKILL on timeout. | Gemini + GPT | High — current path risks mid-mutation dead-letter on broken toolchain, unbounded child-process behavior |
| P1 | Add Runbook Lifecycle section: authoring → review checklist → activation → metrics-driven deprecation (churn/success thresholds) → retirement. Seed success-rate histogram in `/remediation/status`. | Grok + GPT | Medium-High — bounded registry growth, governance for blastRadius=machine |
| P2 | Replace panicStop hard-abort with abort-requested transition + per-runbook cleanup handlers / abortSafePoints; force-kill only in audited emergencies. | GPT | Medium-High — avoid stranded partial mutations |
| P2 | Clarify `blastRadius: external`: rename to `cross-agent` or document as Phase-3-reserved and rejected by load-time validator. | Gemini | Medium — prevent future author confusion / security regression |
| P2 | Add FeedbackManager incident-window component to dedup key: `{subsystem, errorCode, incidentWindowStart}`. Define reopening behavior. | GPT | Medium — avoids collapsing distinct incidents |
| P2 | Separate HMAC keys per purpose (restart-intent vs pending-verify) via independent derivation contexts; be explicit that HMAC is integrity, not privilege boundary. | GPT | Medium — tightens docs; consider authenticated local IPC Phase 3 |
| P2 | Define allowed-input contract for match(): event + immutable dispatcher-prepared ctx only; no ad-hoc runtime observations inside runbooks. | GPT | Medium — preserves purity guarantees |
| P3 | Add hard file-count cap (e.g., 50) on dead-letter/rollback directories to backstop TTL-only retention against inode exhaustion. | Gemini | Low-Medium |
| P3 | Specify telemetry rate-limiting/aggregation for coalesced `covered-by-attempt` events. | Gemini | Low-Medium |
| P3 | Add `costTelemetry` per runbook; enforce verify timeout at `expectedRuntimeMs * 2` with `curl --connect-timeout`. | Grok | Low-Medium |
| P3 | Add runbook-match histograms to `/remediation/status` (matched-but-precondition-failed, etc.) — feeds the lifecycle deprecation policy. | Grok | Low-Medium |
| P3 | Specify atomic write-rename for shadow-node symlink swap cross-platform. | Gemini | Low |
| P3 | Make single-user-machine deployment assumption explicit in a Deployment Assumptions section. | GPT | Low |

---

## Gaps Across All Reviews

1. **Cryptographic specifics**: No model scrutinized the HKDF construction, what the HMAC is actually computed over, or the `source: remediator` HMAC verification transition. Worth a focused crypto pass.
2. **Verification false-positive/negative modeling**: Only GPT touched on `/health?fast=1` being green while subsystem intermittently fails. No model proposed subsystem-specific health semantics or probabilistic verification thresholds.
3. **Resource budgeting under simultaneous distinct-subsystem degradations**: Concurrency-of-one is universal; no model discussed queue-depth fairness, starvation, or prioritization when unrelated subsystems degrade in parallel. GPT nods at it as a Phase-2 bottleneck but doesn't propose a mechanism.
4. **AutonomyProfileLevel grain for collaborative-gated toggles**: Gemini explicitly called this out as un-scrutinized. How does autonomy-level map to blastRadius activation?
5. **Network taxonomy**: GPT notes "no outbound network during execute()" is too coarse (local IPC vs loopback vs LAN vs internet). No model proposed the taxonomy.
6. **Redaction coverage for remediation-generated artifacts**: Reporter redaction is covered; command output, config values, and paths surfaced by runbooks are not.

---

## Key Takeaway

Single-model review would almost certainly have approved this spec (2 of 3 external models did). The cross-model lens surfaces what one reviewer alone misses: **GPT's cross-section consistency pass caught an alert-policy ambiguity and a lock-reclaim predicate bug that both APPROVE reviewers missed entirely**. Meanwhile, Gemini's operational lens surfaced the build-toolchain precondition and git-sync-at-scale problems GPT didn't frame, and Grok contributed the runbook-lifecycle governance frame nobody else surfaced.

The most important action item before /instar-dev: **resolve the alert policy matrix (P0)**. Every other finding is additive refinement; that one determines whether production mode actually suppresses user spam — the entire product value proposition. Combined with the lock-reclaim predicate fix and the formal attempt state machine, these three GPT-critical items are the conditional-to-approve bar. The consensus P1s (monotonic time, git-sync scope, replay idempotency, errorCode registry, toolchain precondition + sandbox, runbook lifecycle) should land in the same spec revision.

---

*Generated by CrossReview cross-model analysis.*
