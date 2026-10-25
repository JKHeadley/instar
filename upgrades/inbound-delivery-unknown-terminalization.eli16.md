# Inbound Delivery Capacity Recovery — Plain-English Overview

> The one-line version: delivery attempts whose observation window ended uncertain must stop occupying the finite live-message queue.

## The problem in one breath

Instar safely refused to guess whether hundreds of older injected messages were consumed, marking them “unknown.” However, it left their transport state as “dispatched,” and the admission counter treats every dispatched row as live. Once 500 such rows accumulated, every new Telegram message was rejected with “Message could not be delivered to the session.”

## What already exists

- **Durable inbound journal** — records each physical terminal injection before it happens so crashes cannot silently replay uncertain effects.
- **Codex delivery observer** — watches the composer and rollout transcript until it proves consumption/response or reaches a fixed observation deadline.
- **Admission ceilings** — prevent an unbounded number of live rows or bytes from exhausting the server.
- **Terminal evidence retention** — keeps consumed, failed, and effect-unknown evidence for audit, then garbage-collects it under bounded age/count rules.

## What this adds

When the observer reaches its deadline without proof, the existing `markObservationUnknown` transition now records `effect-unknown` as the transport state as well as unknown transcript/composer eligibility. This does not claim that the message succeeded or failed. It only makes the already non-replayable uncertainty terminal, allowing the admission counter to release its slot while retaining the evidence for audit.

The status projection now reports these records as `effect-unknown` before considering their eligibility label, so uncertain-effect metrics remain honest. A regression test fills a one-row admission capacity, terminalizes the uncertain observation, verifies capacity returns, and verifies that a subsequent message can be prepared.

## The safeguards

**No automatic replay.** Effect-unknown is explicitly non-replayable, preserving the core no-duplicate guarantee.

**No evidence deletion.** Rows are retained under the existing terminal evidence policy. This change is a state transition, not data erasure.

**Bounded authority.** Only dispatched rows that the observer already selected after its observation deadline can take this transition. Prepared or actively observed rows are untouched.

## What ships when

The transition and status correction ship together. Existing stale rows on this machine are migrated with the identical narrow predicate after a complete SQLite backup; future rows self-terminalize through the observer.

## What you actually need to decide

Should expired, already-uncertain delivery evidence become terminal so it cannot permanently block new Telegram messages?
