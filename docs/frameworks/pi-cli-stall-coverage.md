---
framework: pi-cli
stall-coverage:
  - class: clean-turn-end
    status: declared-gap
    reason: >-
      pi ships dark (additive-only; nothing runs unless explicitly enabled),
      but an ENABLED pi session inherits zero instar-side continuation
      machinery — the gap is real and conditional on enablement
    issueRef: stallclass::clean-turn-end::pi-cli::gap
    closePath: CMT-891
    liveness-surface: >-
      DEFECT if enabled: nothing distinguishes a cleanly-idle pi session
      with work remaining from a finished one
  - class: mid-turn-interrupt
    status: declared-gap
    reason: 'no detector for an enabled pi session interrupted mid-turn by host or server death'
    issueRef: stallclass::mid-turn-interrupt::pi-cli::gap
    closePath: CMT-891
    liveness-surface: 'DEFECT if enabled: registry may show running over an interrupted pi session'
  - class: input-not-draining
    status: declared-gap
    reason: 'no pi-prompt presentation signatures exist; injection-wedge detection is claude-tuned'
    issueRef: stallclass::input-not-draining::pi-cli::gap
    closePath: CMT-891
    liveness-surface: 'DEFECT if enabled: messages can sit undrained at a pi prompt silently'
  - class: wedged-context
    status: declared-gap
    reason: 'no pi transcript-poisoning signature family is known or detected'
    issueRef: stallclass::wedged-context::pi-cli::gap
    closePath: CMT-891
    liveness-surface: 'DEFECT if enabled: a fast-failing pi session would read as running'
  - class: policy-rejection-loop
    status: declared-gap
    reason: 'no detector for a pi session whose every reply is provider-rejected'
    issueRef: stallclass::policy-rejection-loop::pi-cli::gap
    closePath: CMT-891
    liveness-surface: 'DEFECT if enabled: rejection loops surface nowhere'
  - class: quota-wall
    status: declared-gap
    reason: 'no pi quota-window reader, wall detector, or wait-or-swap recovery exists'
    issueRef: stallclass::quota-wall::pi-cli::gap
    closePath: CMT-891
    liveness-surface: 'DEFECT if enabled: a walled pi session has no truthful standby state'
  - class: approval-prompt-wedge
    status: declared-gap
    reason: 'no pi approval-prompt signatures are registered; no auto-clear exists'
    issueRef: stallclass::approval-prompt-wedge::pi-cli::gap
    closePath: CMT-891
    liveness-surface: 'DEFECT if enabled: a pi session parked on an approval menu reads as running'
  - class: context-window-wall
    status: declared-gap
    reason: 'no pi context-exhaustion signature or compact-equivalent recovery is wired'
    issueRef: stallclass::context-window-wall::pi-cli::gap
    closePath: CMT-891
    liveness-surface: 'DEFECT if enabled: context-walled pi sessions have no honest surface'
---

# pi-cli — stall-coverage matrix

**Honest rows for a ships-dark framework.** pi-cli is a valid
`IntelligenceFramework` member that ships dark — nothing changes unless an
operator explicitly enables it. The moment one does, an enabled pi session
inherits ZERO instar-side stall detection or recovery, so every class is a
`declared-gap` (not `not-applicable`: the framework is installable and
runnable today, unlike the dead gemini-cli).

Each gap is filed to the framework-issues ledger
(`stallclass::<class>::pi-cli::gap`) and anchored to the open commitment
CMT-891, whose bar is explicit: **before any fleet enable of pi, build or
formally accept the stall coverage** — the same detection-before-recovery
standard every framework pays. Minutes of authoring now; the alternative is
re-learning spec §1's incident list one pi production stall at a time.
