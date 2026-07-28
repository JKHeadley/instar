---
framework: gemini-cli
stall-coverage:
  - class: clean-turn-end
    status: not-applicable
    reason: >-
      framework dead upstream (gemini-cli discontinued, 2026-07 model/door
      landscape): instar spawns no gemini sessions, so no session exists to
      reach this state
    revalidateOn: framework-revival
    liveness-surface: 'n/a — no gemini sessions can exist while the framework is dead upstream'
  - class: mid-turn-interrupt
    status: not-applicable
    reason: >-
      framework dead upstream: no gemini session can exist to be
      interrupted mid-turn
    revalidateOn: framework-revival
    liveness-surface: 'n/a — no gemini sessions can exist while the framework is dead upstream'
  - class: input-not-draining
    status: not-applicable
    reason: >-
      framework dead upstream: no gemini session prompt exists for input to
      wedge against
    revalidateOn: framework-revival
    liveness-surface: 'n/a — no gemini sessions can exist while the framework is dead upstream'
  - class: wedged-context
    status: not-applicable
    reason: >-
      framework dead upstream: no gemini transcript exists to poison
    revalidateOn: framework-revival
    liveness-surface: 'n/a — no gemini sessions can exist while the framework is dead upstream'
  - class: policy-rejection-loop
    status: not-applicable
    reason: >-
      framework dead upstream: no gemini session exists to enter a
      provider-rejection loop
    revalidateOn: framework-revival
    liveness-surface: 'n/a — no gemini sessions can exist while the framework is dead upstream'
  - class: quota-wall
    status: not-applicable
    reason: >-
      framework dead upstream: no gemini session exists to hit a quota wall
    revalidateOn: framework-revival
    liveness-surface: 'n/a — no gemini sessions can exist while the framework is dead upstream'
  - class: approval-prompt-wedge
    status: not-applicable
    reason: >-
      framework dead upstream: no gemini session exists to park on an
      approval prompt
    revalidateOn: framework-revival
    liveness-surface: 'n/a — no gemini sessions can exist while the framework is dead upstream'
  - class: context-window-wall
    status: not-applicable
    reason: >-
      framework dead upstream: no gemini session exists to exhaust a context
      window
    revalidateOn: framework-revival
    liveness-surface: 'n/a — no gemini sessions can exist while the framework is dead upstream'
---

# gemini-cli — stall-coverage matrix

**Dead framework, complete enumeration.** gemini-cli is discontinued upstream
(2026-07 model/door landscape: the CLI is dead; Antigravity CLI / OpenRouter
are the successor doors). Instar spawns no gemini sessions, so every stall
class is structurally unreachable — `not-applicable` with
`revalidateOn: framework-revival` on every row.

No detector work is owed to a dead framework — but the ENUMERATION is
complete, which is the parent spec's entire thesis: a partial matrix-file set
would re-create the invisible-zero-cell failure one level up. If the framework
revives (or its `IntelligenceFramework` member is replaced by a successor
CLI), the conformance sweep's `revalidateOn` trigger flags every row for
re-review, and a production incident matching any N/A cell reclassifies it to
`declared-gap` (an N/A proven wrong is worse than a declared gap).

Framework-issues ledger note: per-class `stallclass::<class>::gemini-cli::gap`
issues were pre-filed during matrix drafting; they remain open as revival
trackers but the N/A rows deliberately do not reference them (an N/A row
carries a structural reason + revalidation trigger, not a work anchor).
