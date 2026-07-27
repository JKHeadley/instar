# Upgrade Guide — vNEXT

<!-- internal-only -->
<!-- bump: patch -->

## What Changed

Adds `docs/specs/decision-replayability-standard.md` (plus its ELI16 companion) — the written
standard for what must be recorded so a decision can be replayed and re-evaluated later, rather than
merely asserted to have happened.

It answers the question the operator asked directly: **is a screenshot an acceptable thing to store?**
For a TERMINAL prompt the answer is no, and not for privacy reasons — the scrubbed pane TEXT of the
prompt region carries identical information to an image of it, but only text is scrubbable,
greppable, and diffable. Text is therefore *more* auditable, not less. Images remain the right medium
only where no text form exists, such as a GUI or a browser.

The standard carries three bounds so the rule cannot quietly become unbounded surveillance: capture
the prompt REGION rather than full scrollback; scrub before write, never after; and mark a record
`replayability: degraded` when scrubbing has hollowed it out, so a log can never silently become
useless while still looking complete.

## Evidence

Docs-only: no runtime surface, no endpoint, no config key, no behaviour change. The standard's own
`## Decision points touched` and `## Multi-machine posture` sections are present as the spec format
requires.

Shipped as its own change deliberately. The document was written and staged inside an unrelated
worktree that is blocked awaiting operator approval — so a finished deliverable was sitting
uncommitted behind a blocker it has no dependency on, one worktree removal away from being lost.
Extracting it is the concrete application of the project's own rule that deferral is deletion.

## Known limits

This ships the standard, not its enforcement. Applying it to the first runtime consumer
(`PermissionPromptAutoResolver`, which today records matched-pattern names and a one-way fingerprint
but no replayable prompt region) is tracked separately as ACT-1312 and is deliberately NOT bundled
here. Until that lands, the standard is a written rule with no mechanical guard behind it — which by
this project's own measure means it is not yet enforced.

## What to Tell Your User

None — internal change (no user-facing surface).

## Summary of New Capabilities

None — internal change (no user-facing surface).
