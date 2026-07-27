# Bound identical mentor-onboarding retries

## What Changed

The live mentor-onboarding delivery path now places a durable content-keyed retry brake in front of every outbound prompt.

- Identical unanswered content is limited to three attempts.
- The attempt is persisted before transport actuation.
- A transport refusal consumes the same bounded budget as an unacknowledged send.
- The fourth identical attempt is suppressed.
- A different agenda item receives an independent budget.
- Exhaustion emits one distinct delivery-degradation signal, protected by a restart-surviving latch.
- The retry ledger stores hashes rather than prompt text and refuses growth beyond 64 unresolved keys.

The mentor tick now awaits the delivery callback and records a specific `deliveryReason` when the delivery layer refuses or fails. It no longer marks an asynchronous send as delivered before the transport has answered.

## What to Tell Your User

Mentor onboarding will no longer keep reposting the same unanswered question forever. It makes at most three attempts for identical content, remembers that limit across restarts, and reports one distinct delivery failure when the limit is reached. A genuinely new agenda item can still proceed.

The prior anti-ping-pong guard was correlation-scoped. Once an unanswered correlation aged past the reply timeout, the guard deleted it and the next tick could post the same generated question again. A bot-to-bot receive-path failure therefore produced about twenty-four visible copies over twelve hours.

## Summary of New Capabilities

- Durable, normalized-content deduplication bounds identical unanswered mentor prompts at three attempts.
- Retry exhaustion and transport failures are visible as structured delivery outcomes with one restart-surviving escalation.
- New agenda content remains independently eligible while an exhausted item stays suppressed.
- Existing version-1 outstanding-prompt files load normally and upgrade on their next write.

## Compatibility

Existing version-1 outstanding-prompt files continue to load. The next write upgrades the file to version 2. No config, route, migration job, tick cadence, agenda rule, or reply timeout changes.

## Validation

Refusal-first unit tests failed on unmodified source, then passed with the implementation. Unit, integration, and end-to-end coverage pins the bounded attempts, novel-content independence, restart durability, one-shot escalation, production transport-failure behavior, and status visibility.
