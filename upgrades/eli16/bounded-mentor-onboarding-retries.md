# Bounded mentor-onboarding retries — Plain-English Overview

> The one-line version: an unanswered mentor prompt can now be sent at most three times, the limit survives a restart, and the system reports delivery trouble instead of posting the same question forever.

## The problem

The mentor loop already avoided sending a second prompt while the first one was waiting for a reply. That protection had a hole: after twenty minutes, the old correlation was declared expired and removed. The next tick then treated the same words as a brand-new prompt.

That is how one permission question appeared about every thirty minutes for roughly twelve hours. Each individual send looked legal because the previous correlation had expired. Across the whole episode, however, there was no content-level limit, so the system could repeat its own action indefinitely.

The visible Telegram post also did not prove that the mentee could receive it. Telegram can display a message from one bot while withholding that bot-authored message from another bot's update stream. The old loop interpreted the missing reply as an unanswered coaching question and retried. It needed to recognize the repeated lack of confirmation as a delivery problem.

## What changes

Before any live mentor send, the existing outstanding-prompt tracker now normalizes the message, combines it with the mentee identity, and hashes that pair into a content key. The tracker durably reserves the attempt before it calls the transport.

Each content key gets three attempts:

- Attempt one is allowed.
- Attempts two and three are allowed after the earlier correlation expires or the transport refuses it.
- A fourth attempt with the same unanswered content is refused.
- Different content gets a different key and remains eligible.

The state file is upgraded in place from version 1 to version 2. It keeps the existing outstanding correlations and adds a bounded retry ledger. Only hashes and timing/count metadata are stored; the prompt text is not copied into this state.

## Why the ordering matters

The reservation is written before the send. If the retry ledger cannot be persisted, the transport is not called. This prevents a disk or state failure from silently removing the very brake that makes the self-action bounded.

A transport refusal still consumes an attempt. Otherwise an unreachable destination could be retried forever while the counter remained at zero. A confirmed correlated reply clears that content episode, because repeating the same words after an actual reply is a new conversation rather than an unanswered retry.

## What the operator sees

The normal first attempts remain unchanged. When the content budget is exhausted, the mentor tick reports a distinct delivery reason instead of claiming success or folding the event into a generic unanswered-question state.

The first exhaustion also emits one degradation signal explaining that delivery could not be confirmed and that identical sends are now suppressed. A persisted `escalatedAt` latch prevents the escalation itself from becoming another flood, including across a restart.

## Boundaries

This change does not alter Threadline identity resolution, Telegram's bot-to-bot behavior, the process-wide LLM circuit breaker, the mentor agenda, the reply timeout, the tick cadence, or budget limits. It does not add a route or configuration switch.

The retry ledger is capped at 64 unresolved content keys. Reaching that cap refuses new mentor sends rather than growing state without limit. Version-1 files remain readable and are rewritten as version 2 on the next state change.

## Proof

The four requested refusal-first tests were added before implementation and failed against the original source because `reserveSend` did not exist. After implementation they prove:

- first content is allowed;
- identical unanswered content is refused after three attempts;
- a different agenda item remains allowed;
- the breaker and its one-shot escalation survive a reconstructed tracker using the same state file.

Additional coverage proves whitespace-normalized dedupe, raw prompt text exclusion, the 64-key state bound, asynchronous delivery outcome handling, HTTP status propagation, and the real production delivery closure over three transport failures plus a fourth-send refusal.
