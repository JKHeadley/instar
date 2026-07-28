---
framework: codex-cli
stall-coverage:
  - class: clean-turn-end
    status: declared-gap
    reason: >-
      no instar-side continuation machinery for codex sessions — the mentee's
      hand-built keep-working loop is the only thing continuing work at a
      clean boundary (apprenticeship drive 5-6 evidence: that loop stalled
      repeatedly and instar never noticed)
    issueRef: stallclass::clean-turn-end::codex-cli::gap
    closePath: CMT-890
    liveness-surface: >-
      DEFECT: registry shows the tmux session alive; nothing distinguishes
      "cleanly idle with work remaining" from "done" for codex
  - class: mid-turn-interrupt
    status: declared-gap
    reason: >-
      no detector for a codex session parked at an interrupted/resume state
      after host or server death (the class that cost drive-5 defect #9 on
      claude has no codex analogue either)
    issueRef: stallclass::mid-turn-interrupt::codex-cli::gap
    closePath: CMT-890
    liveness-surface: 'DEFECT: registry may show running over an interrupted codex session'
  - class: input-not-draining
    status: declared-gap
    reason: >-
      StuckInputSentinel's prompt-presentation signatures are claude-tuned;
      no codex-prompt ghost/real classification exists
    issueRef: stallclass::input-not-draining::codex-cli::gap
    closePath: CMT-890
    liveness-surface: 'DEFECT: delivered messages can sit undrained at a codex prompt silently'
  - class: wedged-context
    status: declared-gap
    reason: >-
      no codex transcript-poisoning signature family is known or detected;
      whether the class manifests on codex is itself unverified
    issueRef: stallclass::wedged-context::codex-cli::gap
    closePath: CMT-890
    liveness-surface: 'DEFECT: a fast-failing codex session would read as running'
  - class: policy-rejection-loop
    status: declared-gap
    reason: >-
      no detector for a codex session whose every reply is provider-rejected;
      signature family unknown for the OpenAI side
    issueRef: stallclass::policy-rejection-loop::codex-cli::gap
    closePath: CMT-890
    liveness-surface: 'DEFECT: rejection loops surface nowhere; session reads alive'
  - class: quota-wall
    status: declared-gap
    reason: >-
      the solo-codex global quota brake gates NEW spawns fail-safe, but no
      in-session wall detector or wait-or-swap recovery exists for a RUNNING
      codex session that hits its limit — neither half of
      detection-before-recovery is proven in-session
    issueRef: stallclass::quota-wall::codex-cli::gap
    closePath: CMT-890
    liveness-surface: >-
      DEFECT: a walled codex session has no truthful standby state; the
      brake only prevents new spawns
  - class: approval-prompt-wedge
    status: declared-gap
    reason: >-
      PermissionPromptAutoResolver's approval signatures are claude-code
      TUI signatures; codex approval prompts (full-auto exceptions) have no
      registered signature and no auto-clear
    issueRef: stallclass::approval-prompt-wedge::codex-cli::gap
    closePath: CMT-890
    liveness-surface: 'DEFECT: a codex session parked on an approval menu reads as running'
  - class: context-window-wall
    status: declared-gap
    reason: >-
      no codex context-exhaustion signature or compact-equivalent recovery
      is wired; codex sessions at the wall die or thrash unobserved
    issueRef: stallclass::context-window-wall::codex-cli::gap
    closePath: CMT-890
    liveness-surface: 'DEFECT: context-walled codex sessions have no honest surface'
---

# codex-cli — stall-coverage matrix

**Honest zeros.** Instar's stall detection + recovery family was built
Claude-first; none of it is proven for codex sessions. Every class is a
declared gap, each filed to the framework-issues ledger
(`stallclass::<class>::codex-cli::gap`) and anchored to the open commitment
CMT-890 so the debt re-surfaces on a cadence instead of rotting (Close the
Loop).

This is the matrix whose absence the apprenticeship program paid for in
production: Codey (codex-cli) hand-built his own keep-working loop because he
inherited none of the recovery family, and that loop covered only the classes
he had personally hit (spec §1, drive-5 defect #9 analysis). The
framework-agnostic stall-recovery service — the fundamental fix — is the
tracked out-of-scope follow-up of the parent spec.
