# Visible hold for an offline conversation owner

Tier 1. This is a record-only observability change. It does not change delivery or ownership authority.

## Over-block

No admission change. Durable custody is required before writing the historical hold record.

## Under-block

An owner with no observed heartbeat leaves the report pending until a minute has elapsed since durable enqueue. Existing queue expiry and loss reporting still apply. This change covers Telegram queueing through SessionRouter.

## Level-of-abstraction fit

The router observes a custody result and the current owner. Server wiring confirms offline capacity and emits a dashboard record using existing Attention storage.

## Signal vs authority

Under docs/signal-vs-authority.md, the pool heartbeat deadline affects only the report. The existing guarded takeover, placement CAS, delivery order and queue settlement remain in force.

## Interactions

One stable record key per topic and ownership epoch carries retries. A temporary suspect verdict alone cannot create the record while the capacity pool still reports online. Failures to report cannot fail routing. The copy describes a past hold and makes no claim about a current message or eventual delivery.

## External surfaces

The server records an Agent Health item with needsUser false and recordOnly true. No text or sender data from the inbound message is included.

## Multi-machine posture

The serving holder emits the record from its current router capacity view. Use the existing Attention mechanism. No new state path or wire protocol is introduced.

## Rollback cost

Revert the code and release fragment. Existing records retain their historical wording and need no migration.

## Independent review

Concur with the revised change. The reviewer verified custody and heartbeat timing, retry deduplication, and unchanged routing authority. The review was read-only.

## Class-Closure Declaration

The unbounded-self-action class is inapplicable. This adds one durable, record-only observation per topic ownership epoch following a user message. The dashboard record neither schedules work nor sends a notification. Queue retries already existed and cannot repeat the record while the stable ID exists.
