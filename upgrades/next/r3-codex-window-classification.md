<!-- bump: patch -->

## What Changed

**Codex usage windows are now labelled by the length the window reports, not by the order codex
sends them in.** Codex reports two rate-limit windows — a short (5-hour) one and a long (weekly)
one — and instar used to assume the first one was always the 5-hour window, because that is
codex's usual ordering.

Observed live on a pro account (2026-08-19): codex reported the WEEKLY window first
(`window_minutes: 10080`) with the second window absent entirely. Instar duly filed a fraction of a
seven-day allowance as a five-hour figure.

That is not a display bug. Everything downstream reads those two fields as window LENGTHS —
proactive account swap, session placement, and the codex load-shed brake. A weekly wall filed as a
five-hour one tells all of them that a multi-day exhaustion clears in a couple of hours, so an
account that is actually out for days looks like it is about to come back.

`classifyCodexWindows` now routes each window by the `window_minutes` it declares. Position is a
convention of the producer; `window_minutes` is the producer stating what the window actually is.
Ties resolve deterministically (shortest represents the short bucket, longest the long), and a
window carrying no usable `window_minutes` keeps its old positional meaning — so the change can
only correct a mislabel, never introduce one.

## Evidence

- New focused classification suite: 8 tests covering weekly-under-primary, absent secondary,
  conventional ordering, same-class ties, and missing/invalid `window_minutes` fallback.
- Existing quota-poller suite extended and green: 23 tests.
- Both suites pass against the live tree (31 tests, 0 failures).
- Found on real hardware while enrolling a second codex account, which put two codex accounts in
  one pool for the first time and made the per-account readings comparable enough for the
  discrepancy to show.

## What to Tell Your User

- **If you run codex accounts, your remaining-usage numbers were capable of being wrong in a way
  that mattered — this corrects it, no action needed.** A weekly allowance could be reported as if
  it were the short window that resets in hours. Because the automatic account switching reads
  those same numbers, it could move work onto an account that was actually exhausted for days.
  Claude-only agents are unaffected.

## Summary of New Capabilities

| Capability | How to Use |
|-----------|-----------|
| Codex rate-limit windows classified by declared length | Automatic. `QuotaPoller` routes each window by its `window_minutes` instead of by `primary`/`secondary` key order. |
| Safe fallback for windows with no declared length | Automatic. A window with no usable `window_minutes` keeps its positional meaning, so the change can only correct a mislabel. |
