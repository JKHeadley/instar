# Side effects: WhatsApp text gets typed path-tag escaping (SEC-149)

In plain words: a typed file-path tag in a WhatsApp message is shown to the session as ordinary text, as on the other channels.

Tier 1. Size: 1 source file (`src/commands/server.ts`, `wireWhatsAppRouting`), 1 new test file.

## What changes
- `const text = escapeTypedPathTags(msg.content)` at the start of the WhatsApp handler; every later use (injection, respawn bootstrap, spawn) reads the escaped text.
- WhatsApp backends never deliver real media as a path tag (Baileys builds `[Image]`, `[Video]`, `[Document: <name>]`, `[Sticker]`, `[Location]`; the Business API forwards only text and captions), so nothing real is lost. The document placeholder becomes `[typed Document: <name>]`, which is correct: its name is sender-chosen.
- The function is idempotent, so text already escaped elsewhere is unchanged.
- The sender's profile name is cleaned once at entry (square brackets removed), so the new-spawn bootstrap, which used it raw, matches live injection.
- Not changed: iMessage sender names, and `MessageBridge`'s copy of WhatsApp text into a Telegram topic (traced only partly by the reviewer); both belong with the injection-hygiene work.

## Signal vs authority
Escapes untrusted text; refuses nothing.

## Rollback
Revert the commit.

## Tests
- `whatsapp-typed-path-tags` (new, 2): pass.

## Second-pass review

**Reviewer:** independent Claude reviewer subagent. Round 1 was blocking on one gap in the same function: the new-spawn bootstrap put the sender's profile name in raw. Fixed by cleaning the name once at entry, with a test. The text escaping itself was confirmed to reach live inject, respawn and new spawn, and nothing legitimate breaks.


## Repair after Local Verify (2026-11-23)
The full run failed three cases in `tests/e2e/whatsapp-message-routing-e2e.test.ts`. Those cases read only the first 2000 characters of `wireWhatsAppRouting`, and this change's comment block pushed the calls they look for past that window. The cleanup now lives in a small helper, `whatsAppInboundText`, just above the function, and the function calls it in one line. Behaviour is unchanged, and the unit test checks the helper and the call order. The branch was also brought up to date with main.
