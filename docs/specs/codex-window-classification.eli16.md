# Codex Window Classification — Plain-English Overview

> The one-line version: read what codex says a usage window IS, instead of assuming the first one it sends is always the short one.

## The problem in one breath

Codex tells us how much of a subscription has been used across two windows — a short one that refills every five hours, and a long one that refills weekly. Instar assumed the first window in the message was always the five-hour one. On a live pro account it wasn't: codex sent the WEEKLY window first and omitted the other. Instar filed a fraction of a seven-day allowance as if it were a five-hour figure.

## What already exists

- **The usage poller** — asks each enrolled account how much it has spent and records two numbers, one per window. Already working; the numbers themselves were correct.
- **The account switcher** — moves work off an account approaching its limit, and moves it back after the window refills. It reads those two numbers as window LENGTHS.
- **The load-shed brake** — stops starting new work when an account is walled, and decides how long to wait based on which window is exhausted.
- **Placement** — decides which machine and account a new session lands on.

None of those re-derive the window length. They trust the label. So a mislabel is not a display bug — it is a wrong input to three separate decisions.

## What this adds

Each window is now sorted by the length it declares, not by the order it arrived in. If codex says a window is 10,080 minutes long, it is filed as the weekly one no matter which slot it came in.

- Ties — both windows landing in the same class — resolve deterministically: the shortest represents the short bucket, the longest the long one. A bucket is never filled by an arbitrary pick.
- A window that declares no usable length keeps its old positional meaning. So the change can only ever correct a mislabel; it cannot introduce one.

## The new pieces

- **`classifyCodexWindows`** — a pure function that takes the two windows and returns which is short and which is long. It does not fetch, cache, or decide anything about usage; it only sorts. It is deliberately not allowed to invent a window that codex did not send.

## The safeguards

**Prevents a silent regression on accounts that were fine.** An account reporting windows in the conventional order classifies exactly as before — the same two numbers land in the same two places.

**Prevents a new failure on incomplete data.** Codex sometimes omits a window or sends one without a declared length. Rather than guessing, those keep the behaviour that shipped before this change.

**Prevents a false correction.** The boundary between "short" and "long" is a full day. Codex's real values are 300 and 10,080 minutes, so there is no realistic value that sits near the line and could flip class from noise.

## What ships when

One patch. There are no phases, no dark flag and no rollout stages — the function is either correct or it isn't, and it is covered by tests both ways.

## What you actually need to decide

Nothing operational: this is a straight correction with no configuration and no user action. The only question for a reviewer is whether sorting by declared length rather than arrival order is the right rule — and it is, because arrival order is a convention of the sender while the declared length is the sender stating a fact.
