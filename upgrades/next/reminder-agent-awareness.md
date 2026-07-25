## What Changed

The dated check-in reminder (shipped in #1630) is now in the agent CLAUDE.md
template — and reaches EXISTING agents, not just fresh installs.

#1630 shipped routes, a built-in job, and 55 tests, and nothing in the agent
template. Per the Agent Awareness Standard, "an agent that doesn't know about a
capability effectively doesn't have it." No agent would have set `checkInAt`, so
the reconciler would have scanned an empty set every five minutes, found nothing,
and reported success forever. Working code, passing tests, green health check,
zero reminders.

**The migration is the substantive half.** The existing Commitments arm is
guarded by `if (!content.includes('**Commitments & Follow-Through**'))` — every
running agent already has that section, so anything added inside that branch
reaches fresh installs ONLY. That is the exact Migration Parity failure the
standard names, and it looks correct in a diff. The new subsection therefore gets
its own arm keyed on "section present AND subsection absent", with a test
asserting that separation rather than trusting it.

A drifted CLAUDE.md gets an append rather than a skip: a misplaced paragraph
beats an agent permanently unaware of a capability because it customised its own
notes.

The text states honest scope — dark by default, at-least-once rather than
exactly-once, and that "structurally impossible to have a dated promise without a
reminder" is NOT true yet. A briefing that oversells produces an agent
confidently relying on something that isn't running.

## Evidence

- `tests/unit/claudemd-check-in-reminder-awareness.test.ts` (10): the template
  documents the endpoint, names the `checkInAt` field an agent must set, carries
  a proactive trigger rather than a bare endpoint, states the honest scope, and
  points at `undelivered`; the migrator arm exists, is SEPARATE from the
  Commitments arm, is idempotent, records what it did, and appends rather than
  skipping on drift.
- `feature-delivery-completeness`: 126 tests green.

## What to Tell Your User

Nothing changes in behaviour. This is the difference between the reminder
feature existing and it being usable — without it, no agent would ever know to
attach a date to a promise, and the feature would have run over an empty list
indefinitely while looking healthy.

## Summary of New Capabilities

- Agents now know dated commitments produce reminders, which field to set, and
  which field reveals promises that were never delivered.
- Existing agents receive it on update, not only new installs.
- The briefing states what the feature does NOT yet guarantee, so an agent
  cannot over-rely on a capability that ships switched off.
