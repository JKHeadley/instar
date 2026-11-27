# Exact App message links

## What Changed

The dashboard and signed app clients can resolve a link to a specific App message. The link opens that message and older context directly. A message that the reader cannot access has the same response as a message missing from the serving copy.

This pull request also carries a documentation-only scope decision for the future quoted-reply design: loss of quote metadata through older App codecs is a disclosed compatibility limit, and known unavailable quotes show "Quoted message unavailable". No quoted-reply behavior ships here. The decision and its independent review are recorded in `docs/specs/reports/quoted-replies-bounded-decision-20261123.md`.

## What to Tell Your User

When this is enabled, use Copy Message Link from a message’s options. Anyone opening the link needs their own access to that conversation and message.

## Summary of New Capabilities

| Capability | How to Use |
|---|---|
| Copy a link to one App message | Choose Copy Message Link from the message's options, once the feature is on. |
| Open a message link | The link opens that message with the older context around it; the reader needs their own access to the conversation. |

## Configuration

The feature starts off. The setting is `mobilePairing.native.messageLinks.enabled`. Copying requires a configured shareable HTTPS origin. Links can be disabled without changing ordinary conversation history or pin navigation.

## Evidence

Not reproducible in dev — this is a new default-off feature, not a fix of observed behavior, so there is no before/after run. Focused store, browser, signed HTTP and production wiring tests cover it (tests/unit/console-chats-page.test.ts passed 54 of 54 on 2026-11-27). Real Chrome compatibility, peak scan timing and full verification remain required before activation. The quoted-reply scope decision and its independent review are recorded in `docs/specs/reports/quoted-replies-bounded-decision-20261123.md`; it describes future behavior, not an executed feature.
