# Rate-limited subscription accounts recover after quota resets

## What changes

A subscription account can be marked `rate-limited` when a quota window is exhausted. The pool only places sessions on accounts marked `active`. Until now, the quota poller stored new usage numbers but did not return a rate-limited account to active. That left usable capacity stranded even after a limit reset and the account was working again.

The poller now returns that account to active when a new authenticated usage reading shows headroom in both its short and weekly windows, including any reported model-specific Fable window. If an earlier reading showed a window at 100%, its recorded reset time must have passed. This makes the fresh reading and the reset boundary agree before placement resumes.

## Safeguards

A rollout history file is not enough evidence: it may be stale, and it can report only the weekly window. A reading missing the short window is also insufficient because the real five-hour limit could still be in effect. A window with a reset time but no utilization value also cannot prove headroom. A window at 100%, an invalid percentage, or a still-pending recorded reset keeps the account rate-limited. Disabled and warming accounts stay as they are. The existing sign-in recovery path for `needs-reauth` remains separate.

## What to review

Check whether both windows plus any reported Fable window are the right proof for automatic recovery. This is a narrow, reversible status transition in the quota poller; reverting the code restores the previous hold behavior. No live account is changed by this PR itself.
