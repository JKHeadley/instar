# Operator Binding awareness section — ELI16

## What this is

Instar agents read a file called CLAUDE.md at the start of every session. It's
their "manual" — it tells them what capabilities they have and how to use them.
There's a hard rule in this project (the "Agent Awareness Standard"): if you build
a feature but never write it into that manual, then as far as the agent is
concerned the feature doesn't exist. It will never think to use it.

Over the last several changes we built a real security feature — "Operator Binding
(Know Your Principal)". It makes the agent figure out *who its real boss is* for a
conversation from the authenticated identity of whoever sent an authorized message,
and never from a name it merely read inside a document or a chat message. (That
distinction is the whole point: an earlier incident — "Caroline" — happened because
an agent adopted a name it saw written down as if that person were in charge.)

The feature shipped and works. But until now it was missing from the manual. This
change writes it in.

## What changed, concretely

A new section, "Operator Binding (Know Your Principal)", was added to the agent's
manual. In Instar there are actually THREE copies of that manual that all have to
agree, or a test fails the build:

1. The template a brand-new agent gets when it's first set up.
2. The migrator that patches the manual of agents that already exist (so they get
   the new section on their next auto-update — not just new agents).
3. A shadow copy for agents running on other AI frameworks (Codex, Gemini), so they
   learn it too instead of improvising a weaker workaround.

The section tells the agent: your verified operator is set automatically from the
authenticated sender (never a content name); here's how to look it up; and there's
an observe-only watcher (off by default) that quietly logs it if you ever credit a
decision to someone who isn't your verified operator.

## Why it's safe

This is pure documentation — text added to the manual. It changes no logic, no
behavior, no data. The migrator only adds the section if it isn't already there
(so running it twice is harmless). A build test enforces that all three manual
copies stay in sync, so this kind of "feature exists but the manual forgot it"
gap can't silently happen.
