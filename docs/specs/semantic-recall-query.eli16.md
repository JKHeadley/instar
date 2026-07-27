# ELI16 — the memory worked, the question didn't

## The short version

Your agent has a memory. Before it answers you, it quietly searches that memory for anything
relevant and reads it back to itself. That system was switched on and working. It just never
found anything, because of how the question was phrased.

## How it failed

The search required **every single word** of the question to appear in a stored note.

Ask "why is the deploy failing" and the search looks for notes containing *why* **and** *is*
**and** *the* **and** *deploy* **and** *failing* — all five. No note anywhere contains the
word "why". So the search returns nothing. Not "nothing relevant" — nothing at all, always,
for any question starting with "why".

And questions are the only thing this system is ever given. It gets handed whatever you
typed, verbatim.

Measured against the real memory store, which holds 2,852 notes:

| what was asked | results |
|---|---|
| "can I reach Codey" | 0 |
| "is Codey responding to my messages" | 0 |
| "why is Codey not replying" | 0 |
| "reach Codey" | 7 |
| "Codey messages" | 17 |

Same memory, same store, same instant. The only difference is the ordinary connecting words.

## Why nobody noticed

Because an empty answer is indistinguishable from an empty memory.

When the search returned nothing, everything downstream behaved exactly as it would if the
agent had genuinely never learned anything on the subject. There was no error, no warning,
no slow query — just silence, which is precisely what "I have no relevant memories" is
supposed to look like. The system reported perfect health while returning nothing, forever.

This is the expensive kind of bug: it doesn't break, it just quietly does nothing.

## What it cost

A concrete example, which is what prompted this fix. On July 19 the agent recorded a note:
*"Telegram bots cannot see other bots' messages, which means a topic post can appear
successful while still failing to reach the intended bot pipeline."*

On July 27 it spent a chunk of a morning re-discovering that exact fact from scratch, having
first concluded — wrongly — that another agent had stopped working. The note was stored
correctly the whole time. It was indexed. It was findable by keyword. It simply never came
back, because the question was a sentence.

## What changed

Two things, both small.

Ordinary connecting words — *why, is, the, can, I, to, my* — are dropped before searching.
They carry no information about what you're looking for and they were the only reason most
searches failed.

And if requiring all the remaining words still finds nothing, the search retries accepting
**any** of them. Something loosely relevant beats the empty answer that made every stored
lesson unreachable.

## The part that needed care

Widening a search risks drowning good results in noise, so the widening is deliberately last
in line. The precise search runs first and, whenever it finds anything at all, its results
are used untouched — the loose retry never runs. It only fires against an otherwise-empty
result, where the alternative isn't a better answer but no answer.

It also can't invent relevance. Asking about something genuinely not in memory still returns
nothing, and that is pinned by a test so a future change can't quietly turn this into a
system that always finds something whether or not it's there.

## How I know it works

I wrote the tests, removed the fix, and ran them against the original code. Nine failed —
the nine describing the new behaviour. Four passed, which was the point: those four check
that ordinary keyword searches, precise matches, genuinely-absent topics and permission
filters all still behave exactly as before. A test that only passes after your change isn't
protecting anything.

Then I ran it against the real 2,852-note memory rather than a test fixture. The question
"why can a telegram bot not see messages" went from zero results to five — with the July 19
note as the top hit.
