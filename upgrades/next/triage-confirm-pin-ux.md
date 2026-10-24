# The approval form: one confirm button, and it takes you to the PIN box

## What Changed

Two defects in the Feedback Drain tab's Triage section, both found while the operator was trying
to perform a single approval on 2026-10-19 and could not.

**The confirm button now takes you to the PIN field.** The PIN input belongs to the authority
card; the executor's "Confirm with PIN" button is built in a separate section that can sit far
below it. The only connection was a line of small text reading "enter your PIN in the box above",
which does not say which box or that it is in a different panel. The operator pressed Confirm
with an empty field and was rejected for a step he had no way to know he had skipped. Showing a
confirm now scrolls the PIN field into view and focuses it, and the note names it ("Dashboard
PIN") instead of gesturing upward.

**Pressing a prepare button twice no longer stacks confirm buttons.** Each press of
"Let it run anyway…" (or "Turn ignores live…") appended another "Confirm with PIN" button. The
operator pressed three times — reasonably, since nothing visible had happened — and ended with
three identical confirm paths down the page, which reads as "the system is confused" and
discourages pressing any of them. The prepare step is now idempotent: it replaces its confirm
rather than appending another.

## What to Tell Your User

If an approval asks for your PIN, the box is now brought to you and focused when you press the
first button. And pressing that first button more than once is harmless — you will only ever see
one Confirm button.

## Summary of New Capabilities

- None. Two user-facing defects in an existing form.

## Evidence

- `tests/unit/feedback-triage-ui.test.ts`: pressing the prepare button three times leaves exactly
  one `.spend-arm-btn-commit`; and showing the confirm leaves `document.activeElement.id === 'ftPin'`.
- Both tests were confirmed to FAIL against the unfixed module, for the right reasons —
  "expected <button …(2)>" and "expected '' to be 'ftPin'" — and to pass with the fix.
- Full file: 10 passed, exit 0.
- Background and the other five findings from the same episode: `docs/DASHBOARD-UX-EVIDENCE.md`.
