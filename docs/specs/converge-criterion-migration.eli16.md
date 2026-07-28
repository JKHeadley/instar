# ELI16 — the fix that could not reach the agents it was for

## What happened

This morning I changed a rule about when a design review is allowed to stop. The old rule said stop
when a reviewer finds nothing new; on a document that keeps a record of its own reviews, that never
happens, so the review could never finish. The new rule stops when two rounds in a row find nothing
that changes what would actually be built.

That change went in. This afternoon I went to use it — and found my own copy of that review tool
still had the old rule.

## Why it never arrived

Tools like this live in two places: the shipped copy, and the copy each running agent already has
on disk. The install step deliberately never overwrites an existing copy, because an operator may
have customised it. So a change to an existing tool reaches running agents only through a small
piece of code written for that purpose.

One of those already exists for this file. Its guard says: *if the installed copy already contains
this marker, stop — it is up to date.* Sensible. But the marker belongs to an **earlier, different**
change. Once an agent has taken that one, the guard returns early on every future run, forever.

So the guard is doing its stated job — do not re-apply the same thing twice — while quietly taking
on a second job nobody designed: never apply anything again. It is a one-shot wearing the clothes
of something that is safe to repeat.

## What this change does

It adds a second, small delivery step, keyed on the **new** rule's own text rather than the old
one's marker. That is the pattern this codebase already uses: each change to a shared tool carries
its own key.

It does not touch the older step, and it does not touch a tool an operator has genuinely rewritten
— that case is still detected and left alone.

## What it does NOT do

It does not fix the general problem. Every future change to this file will need its own delivery
step for the same reason, and the guard that causes it is still there. Fixing it properly means
deciding *what the file contains* rather than *which change last touched it* — which is a larger
change to machinery that updates every agent in the fleet, and is tracked separately.

## How I know it works

The test that matters simulates an agent that has already taken the earlier change — the exact
population that silently gets nothing today, and the state my own agent was in. Breaking the fix by
reusing the old marker makes precisely that test fail, which is how I know it is testing the bug
rather than my implementation of it.

## Why this is worth reading twice

The largest piece of work in this whole effort exists because a rulebook could not reach deployed
agents. This is that same failure, sitting inside the instrument I needed in order to unblock it. I
found it only because I checked the tool before using it — a minute's work that would otherwise have
cost the rest of the session and produced a confident, wrong answer.
