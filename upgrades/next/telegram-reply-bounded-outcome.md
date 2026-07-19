---
change_type: fix
---

## What Changed

- Telegram reply requests now have finite connection and total deadlines.
- Transport failures always return an explicit ambiguous outcome with a delivery id and safe retry guidance.
- Stock installed relay scripts upgrade in place; locally customized scripts remain protected.

## What to Tell Your User

If a Telegram reply loses its connection before Instar can return a result, the agent now sees a clear uncertain-delivery warning instead of an empty tool outcome. It will verify before retrying rather than risk sending the message twice.

## Summary of New Capabilities

- Bounded, observable Telegram reply outcomes even when the transport fails before an HTTP response.

## Evidence

- Feedback: `fb-9c139a25-11e`
- Behavioral test: `tests/unit/telegram-reply-bounded-outcome.test.ts`
- Existing recovery/status regression suite remains green.
