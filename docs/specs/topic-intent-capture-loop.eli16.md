# Topic-Intent Capture Loop — the plain-English version

## What this is

Instar has a "filing cabinet" for each conversation topic — it's supposed to quietly notice the
facts and decisions we establish ("we're testing over Telegram," "the real goal is X"), file
them, and hand me a summary at the start of every future session so I stay grounded.

The cabinet got built and installed a while ago. But the part that actually *files things* — the
clerk who reads the conversation and writes notes — was never switched on. So the cabinet sits
empty, which is exactly why, during the original drift incident, it "had no record for the
topic." This spec hires and switches on that clerk.

## The smart part (what you steered me toward)

A naive clerk would judge each message in isolation — but one sentence ripped out of context
usually isn't enough to tell if something matters, or whether it's a short-term detail or a
long-term fact. So this clerk reads each new message *together with* a rolling summary of the
whole conversation (which Instar already keeps) and the notes already on file. That way it judges
significance properly instead of guessing.

## What the review round changed (and why it mattered)

Running the spec through review caught several real problems before any code got written:

- **Security:** because the clerk feeds old notes back into its own reading, a cleverly-worded
  message could smuggle in fake "instructions." Fixed in the design: all user text is fenced off
  as data-to-analyze, never instructions-to-follow, and truncated so it can't take over.
- **Money:** this is the first feature that calls an AI on (almost) every message, so cost is a
  real risk. The design bounds it three ways — a cheap filter that skips trivial messages before
  any AI call, a per-topic ceiling, and a daily spend cap — and it must use our subscription, not
  the pay-per-call API, so a runaway can't drain real money.
- **Corruption:** two copies of me running at once could clobber the same cabinet file. The design
  now requires safe, atomic writes so no notes get lost.
- **Honesty:** I'd claimed a helper function was "already built." It wasn't (it lived in an
  abandoned draft). The review caught the overstatement; the spec now treats it as real work.

## The safety guarantees

- It only watches and files; it never blocks or slows a message reaching you.
- If the AI is unavailable, or anything errors, it quietly does nothing — never breaks the chat.
- It's measurable from day one: there's a read-only view of what it filed, and it ties into the
  human-as-detector heat map so we can see where it's still missing things.
- There's an off-switch, and turning the whole thing off leaves the cabinet exactly as it is today.

## What changes for you

Day-to-day, nothing visible — it works silently. The payoff: every future session starts more
grounded than the last, because the things that mattered actually got written down. This is the
foundational rung of the whole "working awareness" north star; the later rungs (catching method/
goal drift, one unified memory, a mid-task nudge) build on top of this one filling the cabinet.
