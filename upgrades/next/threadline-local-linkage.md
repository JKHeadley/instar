## What Changed

Fixed same-machine Threadline replies so they route back to the topic that
started the conversation. When two of your agents run on the same computer, a
reply from one to the other now lands in the originating Telegram topic and
re-injects into that session, instead of being false-isolated into the separate
"Threadline" hub topic.

Root cause: the same-machine inbound path (`/messages/relay-agent`) called the
inbound handler with no sender identity context, so the anti-hijack guard saw
the sender's name while the thread stores the peer's fingerprint as owner. The
mismatch made the guard isolate every co-located reply to a fresh thread (which
has no topic linkage). The fix resolves the local sender's name to its
fingerprint from the known-agents registry and passes a `plaintext-tofu` relay
context so the guard's identity check matches.

## What to Tell Your User

If your agents collaborate on the same machine, their replies now show up in the
topic you started in and the waiting agent picks them up right away — no more
replies disappearing into the separate Threadline area. Cross-machine behavior
is unchanged.

## Summary of New Capabilities

No new capabilities. This is a bug fix completing the existing Thread→Topic
Linkage feature on the same-machine delivery path.

## Evidence

- `src/server/routes.ts` — `/messages/relay-agent` resolves the local sender's
  name → fingerprint and passes a `plaintext-tofu` `RelayMessageContext` into
  `handleInboundMessage` (previously undefined).
- `tests/unit/ThreadlineRouter-anti-hijack.test.ts` — two regression tests:
  resolved-fingerprint co-located reply resumes (topic linkage holds);
  unresolved still isolates (hijack guard preserved). Full anti-hijack +
  Threadline suite green; `tsc --noEmit` clean.
- Side-effects review: `upgrades/side-effects/threadline-local-linkage.md`.
