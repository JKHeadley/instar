<!-- bump: patch -->

## What Changed

Agents can now **securely hand each other (and collect from users) a secret** —
an API key, token, or password — without it ever touching chat history or disk.
This is the **Sealed Handoff** capability, built on the existing Secret Drop.

A new `threadline_request_secret` MCP tool lets an agent mint its own one-time,
never-on-disk submit URL and send it to whoever holds the secret; they submit it
off-relay over HTTPS, and the value lives only in memory until the agent
retrieves it with the hardened helper. Three structural protections are in place:
the submitted payload can be **signed by the sender** and verified before accept
(closes a first-POST-wins race on an intercepted URL); the submit **host and TLS
cert fingerprint are pinned inside** the signed invitation (defeats a
relay-swapped collector); and an **at-rest invariant test** proves the secret
value is never written to disk nor routed to Telegram.

The keystone that made this possible: an agent's own auth token is
vault-externalized, so the Threadline tool (a separate process) couldn't
authenticate to mint a request. A localhost-only loopback mint route closes that
gap — with explicit loopback + no-forwarding enforcement, because minting a
credential-collection URL is more sensitive than sending a message.

## What to Tell Your User

If you ever need to give your agent a credential, or if two of your agents need
to pass one between themselves, there's now a secure path for it: the agent
generates a one-time link, the secret is submitted privately over HTTPS, and it
never appears in your chat or on disk. Nothing to configure.

## Summary of New Capabilities

- `threadline_request_secret` MCP tool — receiver self-mints a one-time,
  never-on-disk Secret Drop request and returns the submit URL (no auth token
  needed; localhost-only mint).
- Loopback mint route `POST /threadline/secrets/request` — localhost-only, no
  bearer, routes through the durable server-side store so the request survives
  session churn.
- Sender-signature verification on submit (R1a) and host/cert pinning inside the
  signed invitation (R1b).
- At-rest invariant is now a regression test: a submitted secret never reaches
  disk, Telegram, or the agent's session injection.

## Evidence

- Keystone route + 7 tests: `tests/unit/sealed-handoff-self-mint-route.test.ts`
  (no-bearer mint → 201 paired with gated `/secrets/request` → 401;
  X-Forwarded-For → 403; validation).
- MCP tool + 4 wiring tests: `tests/unit/threadline/ThreadlineMCPServer.test.ts`.
- At-rest invariant: `tests/integration/sealed-handoff-at-rest.test.ts`.
- Spec: `docs/specs/SEALED-HANDOFF-SECURE-SECRET-TRANSFER-SPEC.md`. `tsc --noEmit`
  clean; full secret + threadline suite green (1492 tests).
- Follow-up (separate): the operator-confirm gate (requester ≠ authorizer) for
  agent↔agent transfers is built + unit-tested but not yet wired — it awaits a
  decision on the operator-authorization mechanism.
