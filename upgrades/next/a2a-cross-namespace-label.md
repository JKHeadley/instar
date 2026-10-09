# A2A inbound-id ledger: a late copy that arrives over a second route is labelled

## What Changed

A fix to the inbound message-id ledger (spec: `docs/specs/a2a-inbound-id-ledger.md` §1, amended; tracked as ACT-061). Seen in a live two-agent proof on 2026-10-08: a direct same-machine hand-over timed out, the sender fell back to the relay with the same message id, the relay copy arrived first and was labelled as a resent copy, and the original direct copy was processed afterwards as a plain new message. The two copies were recorded under two different sender keys (`unverified:<fp>` and `registry:<fp>`), which by design never read each other.

- After the ledger admits a message, it now checks whether the same message id already has a row under another key for the same fingerprint (`<fp>`, `unverified:<fp>`, `registry:<fp>`, `asserted:<fp>`). If so, the copy is delivered with the existing notice "resent copy — check this thread's history before replying". This runs on all three ingress paths: the relay socket, `/threadline/messages/receive` and `/messages/relay-agent`.
- It is a label only. No message is dropped, no answer to the sender changes, no row in the other namespace is modified, and a terminal row still suppresses only in its own namespace. A sender known only by name (`local:` key) has no fingerprint and is not labelled this way.
- New counter `crossNamespaceLabelled` under `threadline.inboundIdLedger` on the authed `/health`.
- CLAUDE.md template + migration: a short paragraph, "A2A cross-route copies are labelled", for new agents, existing agents and Codex/Gemini shadows.
- Still behind the ledger's development-agent gate (`threadline.inboundIdLedger.enabled`).

## What to Tell Your User

When another agent on this computer sends me a message and its direct hand-over is slow, it also sends a backup copy through the relay. Sometimes the backup arrived first and the original turned up later looking like a brand new message, so I could answer the same thing twice. Now the second copy comes with a note telling me it is a repeat, whichever one arrives second. No message is ever dropped because of this. It is switched on for development agents only while it proves itself.

## Summary of New Capabilities

- The resent-copy notice is added when the same message id is already recorded for the same fingerprint under another kind of identity.
- Authed `/health` → `threadline.inboundIdLedger.crossNamespaceLabelled`.

## Evidence

- `tests/unit/a2a-inbound-id-ledger.test.ts` — 12 new tests: both orders, every namespace pair, a different fingerprint never labels, answers unchanged, a forged fingerprint only adds the notice, a letter-case miss, a full unverified space, the relay in-flight wait, ledger unavailable, counter persistence.
- `tests/unit/PostUpdateMigrator-inboundIdLedger.test.ts` — 3 new tests: existing agents receive the paragraph once, template and migrator text match, a Codex/Gemini shadow receives it once.
- `tests/integration/threadline/inbound-id-ledger.test.ts` — 4 new tests reproducing the live sequence through the real routes (relay copy first, late local copy → labelled), the reverse order, an asserted fingerprint, a different fingerprint and a name-only sender.
- `tests/e2e/threadline/inbound-id-cross-namespace-alive.test.ts` — 1 test: production-built controller, real listening server, real HTTP.
