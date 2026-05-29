# In plain English: stop the token-counter from freezing the agent on startup

## What this is about

Every agent keeps a little database of how many tokens it has used, called the
"token ledger." Recently we shipped a feature that, on startup, goes back
through that database and re-labels old rows so we know which part of the agent
spent the tokens. That re-labeling step is called the "backfill."

## What went wrong

The backfill ran **while the agent was starting up**, before the agent was
allowed to say "I'm alive." On a small database that's fine — it finishes in a
blink. But the longer an agent runs, the bigger its token database gets. Echo's
had grown to 202 MB with about 380,000 rows.

On a database that big, the backfill took **more than ten minutes** of solid
work. The problem: a watchdog that supervises the agent only waits a short time
for the agent to say "I'm alive." When the backfill ran long, the watchdog gave
up and killed the agent mid-job. Because the job never finished, it never wrote
down "done" — so the **next** startup began the exact same ten-minute job from
scratch, got killed again, and so on. The agent could never finish starting.
Echo was stuck like this for about 90 minutes.

## What already exists

- The token ledger and the backfill feature (shipped as #530).
- A "done" marker the backfill writes when it finishes, so it only runs once.
- A supervisor that restarts the agent if it doesn't report healthy in time.

## What's new

Two changes, both in the token-ledger code:

1. **The backfill no longer runs during startup.** The agent now starts up
   instantly and reports "I'm alive" right away, then does the re-labeling
   quietly in the background a little at a time. A slow database can never again
   stop the agent from starting.

2. **The work is now done in small batches that save progress.** Instead of one
   giant ten-minute job that loses everything if interrupted, it processes a
   chunk, saves it, processes the next chunk, and so on. If the agent restarts
   partway through, it picks up where it left off instead of starting over.

There's also a switch (`async` / `sync` / `off`) so tests and special cases can
still ask for the old all-at-once behavior on purpose. Normal agents get the new
safe background behavior automatically — just by running the new version. No
settings to change, nothing for you to do.

## What the reader needs to decide

Nothing to configure. This is a safety fix for a bug that can completely freeze
an agent on startup. The only thing worth knowing: for a few seconds after a big
agent boots, a handful of token rows may still show the old "unknown" label
until the background re-labeling catches up. That's harmless — token counts are
just for showing usage, they never block any real work — and it's far better
than the agent being unable to start at all.
