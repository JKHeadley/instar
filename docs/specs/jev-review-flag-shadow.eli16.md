# Jev review-flag shadow — plain-English overview

## What this is

Justin catches some of our mistakes only by reading a reply on Telegram and
correcting it. We want to know whether a small, cheap model (Jev, from
TypeSafe) can tell, on its own, which replies are worth a human look: a reply
that says something is done without showing it, asks Justin to decide or act,
reports a costly step, or does not answer what he asked.

This change does not show anyone anything. Once a minute the server looks at
the replies the agent recently sent on Telegram, asks Jev "does this need the
operator's review, is it fine, or can't you tell?", and writes one line to a
log file: which message it was (by its Telegram number), Jev's answer and how
sure it was. No message text is written to the log.

## What already exists

The same pattern already runs as the "going in circles" shadow: a dev-only,
log-only experiment that asks Jev a question and records the answer. This
change copies its safety rails: secrets are scrubbed before any text leaves the
machine, there is a daily limit on calls, a time limit per call, one
call at a time, and an off switch that takes effect within a minute.

## What is new

A background timer in the server, a summary page
(`GET /jev-review-flag/summary`), a config block, and a short note in the
agent's CLAUDE.md so the agent knows the experiment exists. Nothing is added
to any hook or to Claude Code's settings.

## Safeguards

It is on only for development agents; everyone else gets it switched off. It
needs the TypeSafe key, which only the development agent has. It cannot block,
send, change or delay anything. Cost is about five cents a day at most.

## What you need to decide

Nothing now. After about a week, a short note compares Jev's flags with the
replies Justin actually corrected and recommends whether a visible "worth a
look" marker is worth building.
