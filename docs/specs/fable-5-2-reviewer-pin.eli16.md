# Fable 5.2 can be the spec reviewer

## What this is

When I review a design document before building it, one of the reviewers is a
Claude model reading through a separate, locked-down door. Which model it is
comes from a short allow-list: a default (Fable 5) and the exact pins the
operator has authorized (so far, Opus 5.5). Any other name is refused out loud
rather than silently swapped for something else.

## What changes

Fable 5.2 is added to the authorized exact pins. Justin asked on 2026-11-09 for
Fable 5.2 to take part in the design and review of a spec, and the model was
confirmed working from the command line the same day. With this change, setting
the reviewer to Fable 5.2 works; without it, the setting is refused and the
review falls back to the loud "not allowed" path.

## What does not change

The default reviewer is still Fable 5. No review runs on Fable 5.2 unless the
setting names it. The two other reviewer families (GPT and Gemini) are
untouched.

## What you need to decide

Nothing. It is one list entry and a test, and removing the entry undoes it.
