# Parallel-work awareness: the "is anyone else working on this?" answer was always no

> The one-line version: the surface an agent is told to check before starting work, so it doesn't duplicate what another of its conversations is already doing, has reported "nothing is running anywhere" since it shipped — including while the agent asking was itself running.

## The problem in one breath

Each conversation topic gets a row in a cross-topic index: what it is focused on, and whether a session is live on it right now. The live flag is the point — it is what turns a list of past topics into "here is what is happening at this moment."

That flag was computed by looking for a topic number attached to each running session. Sessions do not carry one. They never have: the record has an identifier, a name, a terminal session name, a working directory — and nothing naming the conversation. So the search found nothing every time, for every topic, and the flag came back "not running" for all of them permanently.

The count of running topics on that surface has been zero for its entire life.

## What already exists

- **The index itself is correct.** It enumerates topics, works out each one's focus, extracts distinguishing keywords, and asks a supplied helper whether each topic is live. Its own tests pass and always did.
- **The correct link already exists elsewhere.** The web view that lists sessions resolves each one's conversation from the terminal session name, through the messaging registry. That resolution works and is used every day.
- **Guidance that points at this surface.** The agent handbook describes it as the antidote to self-blindness and says to glance at it before starting substantial new work in a topic.

## What this adds

**The live flag is now resolved the same way everything else resolves it** — from the terminal session name, through the messaging registry — instead of from a field that does not exist.

The resolution is lifted into a small, separately testable helper, and the tests feed it session records shaped like the real ones: a terminal session name and no conversation number. That shape is the whole point. The index's existing tests supply a stand-in for the live check, so they were never able to notice that the real one could not work.

A session the registry cannot place is still not counted, and one that fails to resolve does not prevent the others from being found.

## Why it went unnoticed

The faulty lookup was written behind a type assertion — a note to the compiler saying "trust me, these records have a conversation number." They do not, and because the assertion was there, the compiler had no reason to complain. A promise made to the compiler that nothing checks is the same shape as a guarantee written in a comment that nothing enforces.

The failure was also invisible from the outside: an empty result and "nothing is running" look identical. There was no error, no warning, and no way to tell the difference without knowing what the answer should have been.

## The safeguards

**A genuine zero still reads as zero.** If nothing is running, or no session can be placed, the answer is still an empty set. Tests pin both, and they pass with the old behaviour as well as the new — which is what makes them a check on the fix rather than an echo of it.

**Nothing is invented.** A session whose conversation cannot be identified is left out rather than guessed at. The flag only ever becomes true from a real, resolved link.
