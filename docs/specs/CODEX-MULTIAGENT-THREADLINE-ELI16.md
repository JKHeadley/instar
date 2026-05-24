# Codex Multi-Agent Threadline Robustness — Plain-English Overview

## What this is

Two small fixes that let a Codex-based instar agent (like Codey) actually
*reply* to messages other agents send it over Threadline. Right now it can
receive a message but can't answer — and we found exactly why.

## The two problems, in plain terms

**Problem 1 — the worker is gagged.** When Codey gets a message, instar spins up
a little one-shot "worker" to write the reply. That worker uses a tool
("threadline_send") to actually send the answer. But instar was launching the
worker in a locked-down mode where the agent silently refuses to use tools — so
every time the worker tried to send the reply, the send was cancelled. The
worker did everything right; it just wasn't allowed to press the send button.
Interactive sessions already run in the permissive mode; the one-shot workers
didn't. We make them match.

**Problem 2 — roommates sharing one mailbox label.** Codex keeps its list of
tools in ONE shared settings file for the whole machine. Every Codex agent
writes its own "threadline" entry into that same slot when it starts, and the
last one to start wins. So if Codey starts, then another agent starts, the slot
now points at the *other* agent — and Codey's replies would go out wearing the
wrong name tag. We fix this by handing each agent its OWN correct entry at the
moment we launch its worker, so it never depends on who touched the shared file
last.

## What already exists vs. what's new

The messaging system, the relay, and the tool itself all already work — we
proved the full round-trip by hand. What's new is: (1) launching the one-shot
workers in the permissive mode so tool calls go through, and (2) injecting each
agent's own tool entry per-launch so the shared-file collision can't misroute
replies.

## Safeguards

Neither change adds a new gatekeeper or blocking rule. The first removes an
over-restrictive setting that was silently blocking a legitimate action. The
second is just computing the right launch arguments — no decisions, no new
authority. It's code-only: no data migration, no rewriting your config files,
and reverting is a clean undo.

## What you need to decide

Whether to approve shipping these two fixes. They're already coded, unit-tested,
and the key one is verified live (Codey sent a message and got a reply back once
the worker was allowed to use the tool). The risk is low and the rollback is a
plain revert.
