<!-- bump: minor -->

## What Changed

Implemented Phase 2 of the approved Approval-as-Data design: the **approval ledger**.
Every operator approval is now recorded as durable, signed data — classified as
approved-as-is, approved-with-change (with the reason for each change), or rejected — and
the system computes a per-class agreement ratio and streak from those records. The ledger
tracks approvals wherever they occur: an official spec sign-off, a decision approved in
chat, or any other surface. New endpoints record a decision, list the records, and return
the agreement summary with a breakdown by surface. The ledger is signed, append-only, and
read-only with respect to all other behavior — it never gates, blocks, or changes anything.
The authoritative source of whether an approval was as-is or changed is always the
operator; the agent never self-classifies intent, and any record is operator-correctable.

## What to Tell Your User

Your agent now remembers your approvals instead of forgetting them the moment they happen.
Each time you approve something — a full spec, or just a choice you make in chat — it can
record whether you took its recommendation as-is or changed it, and why. Over time this
builds a simple picture of where the agent already proposes what you would have picked, and
where it still needs to close the gap. You stay the source of truth: the agent only records
what you explicitly say, and you can correct any entry. This is an internal, read-only
record — it never changes what the agent does, it just helps it learn your preferences.

## Summary of New Capabilities

- Record an approval decision through the new approvals endpoint, tagged as approved-as-is,
  approved-with-change, or rejected, with the reason for any change.
- Read a per-class agreement summary (total, approved-as-is count, ratio, streak, and a
  breakdown by where the approval happened) plus a list of recorded decisions.
- Maturity: stable for the recording and summary surface; the later auto-approval pilot
  remains a separate, operator-gated phase that is not part of this change.
