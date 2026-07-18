---
framework: claude-code
stall-coverage:
  - class: clean-turn-end
    status: not-applicable
    reason: >-
      clean turn end is the intended boundary state, not a stall: the
      conversational loop (message-driven respawn/resume) and the autonomous
      stop-hook own continuation at a normal boundary, so no stall detector
      is owed for this class on claude-code
    revalidateOn: autonomous keep-working redesign or session-mode change
    liveness-surface: >-
      session registry shows completed/idle honestly at a clean boundary;
      standby stays silent (nothing is stalled)
  - class: mid-turn-interrupt
    status: declared-gap
    reason: >-
      drive-5 defect #9 (2026-07-17): a session parked at an
      interrupted/resume prompt after its host or server died mid-turn is
      undetected — a 2h silent production stall proved the class
    issueRef: stallclass::mid-turn-interrupt::claude-code::gap
    closePath: CMT-892
    liveness-surface: >-
      DEFECT while the gap stands: the registry may show running while the
      session sits at an interrupted-resume prompt; the standby classifier
      has no signature for this class yet
  - class: input-not-draining
    status: covered
    detector: src/core/StuckInputSentinel.ts#classifyPromptTextPresentation
    recovery: src/core/StuckInputSentinel.ts#StuckInputSentinel
    guardKey: exempt:StuckInputSentinel
    posture: live
    evidence: tests/unit/stall-evidence-claude-code.test.ts
    liveness-surface: >-
      the sentinel-pause path reports the paused/injection-wedged state to
      the topic instead of leaving delivered messages silently undrained
  - class: wedged-context
    status: covered-dark
    detector: src/monitoring/ContextWedgeSentinel.ts#classifyWedgeTail
    recovery: src/core/SessionRefresh.ts#SessionRefresh
    guardKey: monitoring.contextWedgeSentinel.autoRecovery.enabled
    closePath: CMT-893
    evidence: tests/unit/stall-evidence-claude-code.test.ts
    liveness-surface: >-
      standby classifies the wedge signature (StuckSignatureClassifier kind
      context-wedge) and says so, never "actively working"; detection +
      audit are live, auto-recovery ships dark (the covered-dark debt)
  - class: policy-rejection-loop
    status: covered-dark
    detector: src/monitoring/ContextWedgeSentinel.ts#detectAupRejection
    recovery: src/core/SessionRefresh.ts#SessionRefresh
    guardKey: monitoring.contextWedgeSentinel.autoRecovery.enabled
    closePath: CMT-893
    evidence: tests/unit/stall-evidence-claude-code.test.ts
    liveness-surface: >-
      standby surfaces the content-policy-error state (StuckSignatureClassifier
      kind policy-wedge) with the resend guidance, never "actively working"
  - class: quota-wall
    status: covered
    detector: src/monitoring/StuckSignatureClassifier.ts#classifyStuckSignature
    recovery: src/monitoring/RateLimitSentinel.ts#RateLimitSentinel
    guardKey: monitoring.rateLimitSentinel.enabled
    posture: live
    evidence: tests/unit/stall-evidence-claude-code.test.ts
    liveness-surface: >-
      standby reports the real state from the live tail ("hit the usage
      limit, resets …" — StuckSignatureClassifier kind rate-limited), never
      "actively working"
  - class: approval-prompt-wedge
    status: covered
    detector: src/monitoring/PermissionPromptAutoResolver.ts#detectApprovalPrompt
    recovery: src/monitoring/PermissionPromptAutoResolver.ts#PermissionPromptAutoResolver
    guardKey: monitoring.permissionPromptAutoResolver.enabled
    posture: live
    evidence: tests/unit/stall-evidence-claude-code.test.ts
    liveness-surface: >-
      the resolver auto-clears the prompt; a prompt it cannot clear raises
      ONE attention item (never a silent "running" over a wedged approval
      menu)
  - class: context-window-wall
    status: covered
    detector: src/monitoring/QuotaExhaustionDetector.ts#detectContextExhaustion
    recovery: src/monitoring/SessionRecovery.ts#SessionRecovery
    guardKey: exempt:QuotaExhaustionDetector
    posture: live
    evidence: tests/unit/stall-evidence-claude-code.test.ts
    liveness-surface: >-
      the "conversation too long / context limit reached" state is
      tail-gated (live state only, no stale-scrollback false positives) and
      reported honestly; recovery compacts in place first, fresh-respawn is
      the fallback
---

# claude-code — stall-coverage matrix

The most-instrumented framework: instar's stall family was built Claude-first,
one production incident at a time (spec §1). This matrix writes that coverage
down for the first time — and names the two honest holes.

## Coverage story

- **Detection-rich classes** (`wedged-context`, `policy-rejection-loop`,
  `quota-wall`, `approval-prompt-wedge`, `context-window-wall`,
  `input-not-draining`): a real detector fires on the live tmux tail or
  transcript signature, and a recovery path is reachable. Positive-control
  evidence with the RAW signatures lives in
  `tests/unit/stall-evidence-claude-code.test.ts`.
- **`wedged-context` / `policy-rejection-loop` are covered-dark**: detection
  and the sentinel audit run by default, but the auto-recovery arm
  (`monitoring.contextWedgeSentinel.autoRecovery.enabled`) ships dark — the
  gate treats these as gaps until the flip (closePath CMT-893, dry-run soak
  first). "A Dark Feature Guards Nothing."
- **`mid-turn-interrupt` is the honest hole** — drive-5 defect #9's exact
  class (closePath CMT-892). It is the newest class and sits last in the
  §2.1 precedence order, so ambiguous tails under-attribute to it; the
  future recovery-service increment owns the fundamental fix.
- **`clean-turn-end` is not-applicable by structure**: a clean boundary is
  the intended state; continuation is owned by the conversation loop and the
  autonomous stop-hook, not a stall detector. Revalidate if the keep-working
  design changes.
