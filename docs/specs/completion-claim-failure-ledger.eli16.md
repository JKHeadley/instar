# Completion-claim failure ledger: plain overview

**What this is.** Instar has a checker that reads each finished reply and asks whether anything the agent said it did was backed up by what it actually did. It only watches for now; it never blocks a message. A recent review found it failing on 41% of the replies it looked at, even though the AI model behind it almost never returned an error.

**What was actually wrong.** The checker wasn't getting bad answers. For much of each day it wasn't getting to ask at all. It shared a small daily spending allowance with other background features. Each check was charged a made-up estimate of a quarter of a cent, so the shared allowance ran out at around six in the morning UTC. After that every check was turned away at the door, and the checker wrote each refusal down as "the model gave invalid output". Nothing logged the refusal as an error, because no model had been called. The other background features sharing that allowance were turned away too.

**What already exists.** The checker already has its own daily limits, set much higher than the shared allowance. Another feature already runs on its own private queue for exactly this reason.

**What is new.** The checker gets its own queue, so its own limits are what apply and it can no longer use up anyone else's allowance. A refusal is now recorded as a refusal. A new log records every reply the checker could not handle, with a short fixed reason code, the step that failed and the model used. It never records what the reply said. One new read-only page shows those records with a day-by-day count.

**The safeguards.** The checker stays in watch-only mode until it has failed on fewer than 5% of replies on each of seven full days in a row, with at least 20 replies on each of those days. This holds even if someone switches watch-only off in the settings. A missing, quiet or unreadable day keeps it in watch-only, so not knowing never lets it through.

**What it costs.** The checker will now make more model calls, up to its own existing limits, because it was being cut off before. Those calls run on the internal model, not the main Claude quota, and the existing daily limits still cap them.

**What you need to decide.** Nothing. If the numbers stay under 5% the checker becomes eligible to act, and turning that on stays a deliberate choice.
