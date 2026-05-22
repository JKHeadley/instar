# Framework-spawn portability — the plain-English version

## What broke

You set up "codey" as a **Codex-only** agent. That means it's
supposed to think and work using Codex (OpenAI's coding model),
not Claude. But when you messaged it on Telegram to get a dashboard
link, it quietly started up a **Claude** session instead. Wrong
engine entirely.

## Why it happened

Think of it like a car that has two possible engines. When you
built codey, you flipped a switch that said "use the Codex engine."
That switch got saved in one drawer of the glovebox.

But when codey actually needed to start its engine to answer your
message, it looked in a *different* drawer — one that was empty.
Finding nothing, it shrugged and grabbed the default engine, which
was Claude.

Two separate problems stacked up:

1. **The "start the engine" code wasn't even told to check the
   glovebox.** For messages coming in from Telegram, it always just
   used the default (Claude), no questions asked.

2. **Even if it had checked, it was checking the wrong drawer.**
   The switch you flipped during setup got saved in one place, but
   the engine-starting code only knew to look in two *other* places,
   both empty.

So the two halves of the system disagreed about where "which engine
do I use" lives.

## What we changed

- We made the engine-starter actually read the drawer where your
  setup choice is stored.
- We taught the system that your install-time choice is the source
  of truth, with a clear order: a one-off override beats a saved
  setting, which beats an environment flag, which beats the
  glovebox switch, which beats the old default.
- Both ways codey can start a session (answering a message, or
  running a scheduled job) now use the exact same logic.

## What this means for you

- **codey and any other Codex-only agent will now correctly run on
  Codex.** No more surprise Claude sessions.
- **You don't have to reinstall or re-run setup.** The fix reads the
  choice already saved on disk. The moment codey updates and its
  server reloads, it'll do the right thing.
- Claude-only and mixed agents are unaffected — they keep working
  exactly as before.

## The one tradeoff

We're now treating your install-time framework choice as binding
for *every* session that agent starts. That's the correct behavior,
but it means if you ever want a Codex agent to spin up a Claude
session for one specific task, that has to be an explicit override
(which the system supports) rather than something that happens by
accident.
