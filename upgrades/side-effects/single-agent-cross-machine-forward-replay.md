# Side-Effects Review — Single-agent cross-machine forward replay

**Date:** 2026-07-16  
**Author:** instar-codey  
**Second-pass reviewer:** independent lifecycle review — two concerns resolved, then concurred

## Summary

The forwarding Telegram adapter fired the topic-routing promise without awaiting it, disconnecting durable poll progress from the owner's acknowledgment. The owner simultaneously persisted a remote receipt but discarded the insertion verdict, so an optional-ledger outage selected an in-memory dedup set that reset at boot. The correction couples cursor settlement to routing acknowledgment and makes the durable receipt verdict authoritative when the inbound queue is live.

## Interaction review

- The original Telegram message ID remains the `deliverMessage` identity end to end; no fresh delivery identity is minted on redrive.
- Local and cross-machine routing now share honest completion semantics: poll progress follows the asynchronous topic handler rather than merely scheduling it.
- A rejected topic handler propagates to the poll loop, which preserves the prior offset for platform redelivery. Settlement is deliberately serial: inventing an outer timeout cannot cancel local handling and would create a late-local-completion duplicate window. The cross-machine transport itself retains its existing bounded retries and timeouts.
- If the durable inbound queue is dark or its receipt write fails, behavior falls through to the optional SQLite message ledger and finally the existing in-memory compatibility set.
- Duplicate receipts short-circuit before owner injection. First-seen receipts preserve the existing receive/inject flow.
- Scope is one agent across its own machines, not cross-agent communication.

## Rollback

Code-only revert. Existing receipt and poll-offset stores remain schema-compatible.

## Independent second pass

The reviewer found that the first draft still swallowed handler rejection, allowing the offset to advance. That rejection now propagates without cursor advance. A proposed outer timeout was rejected on re-review because it cannot cancel local handling and would let a late local injection race a redelivery. The safe design keeps settlement serial while relying on the cross-machine transport's existing bounded retry/timeout contract.
