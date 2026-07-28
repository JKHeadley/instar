# Side-Effects Review — Content-hash dedup for the relay-agent ingress

**Version / slug:** `threadline-relay-content-dedup`
**Date:** `2026-05-30`
**Author:** `instar-echo`
**Second-pass reviewer:** `instar-echo second-pass checklist`

## Summary of the change

This change stops duplicate agent-to-agent replies. The handler at
`POST /messages/relay-agent` accepts an inbound message, then spawns or resumes
the receiving agent's session before responding. When that spawn is slow (a
loaded box), the sender times out and retries the same message with a fresh
`message.id`. The existing dedup in `MessageRouter.relay` keys on `message.id`,
so the retry slips through and the receiver spawns/replies twice (observed six
times in one evening, 2026-05-30).

A new module `src/messaging/relayContentDedup.ts` (`RelayContentDedup`) provides
a bounded, in-memory, fixed-window dedup keyed on the stable triple
`(senderAgent, threadId, normalized content)`. `src/server/routes.ts` creates
one instance per server inside `createRoutes` and checks it in the relay-agent
handler, after envelope validation and before the relay accept. A duplicate
within the window short-circuits with an idempotent `200`
(`{ ok: true, deduped: true }`) and no spawn. Tests cover the unit logic (both
sides of every boundary) and the real HTTP route on a booted `AgentServer`.

This ships the dedup alone. The accept-boundary change (respond on inbox-accept
rather than after the spawn) is the root fix but touches response semantics and
the warrants-reply gate in the same handler, so it is a separately-reviewed
follow-up.

## Decision-point inventory

- `RelayContentDedup` — add — the dedup engine; chooses whether an inbound relay
  message is a fresh send or a duplicate retry.
- `relayContentDedup` instance in `createRoutes` — add — per-server-process
  dedup state, scoped to one server instance for test isolation.
- relay-agent handler guard — add — runs the dedup check on the ingress path and
  short-circuits duplicates before the relay accept and the session spawn.

---

## 1. Over-block

The guard drops an inbound only when the exact same sender, thread, and content
recur within the window (default 60 s). The realistic over-block is a legitimate
rapid identical resend — an agent sending the same short text (for example a bare
acknowledgement) twice in the same thread within a minute would have the second
collapsed. The window is intentionally short and the match is exact, so this is
narrow; identical back-to-back content on one thread is far more likely a retry
than two distinct intents.

A subtler case: the guard records a key when it passes the check, before the
downstream spawn outcome is known. If the first attempt's spawn genuinely failed
and the sender resent identical content to retry it, that resend would be
dropped. In practice the retry trigger is a sender timeout while the original
spawn is still in flight (so the retry is genuinely redundant), not a spawn
failure — a failed spawn already returns `200` today, so it does not provoke a
retry. The limitation is documented rather than papered over.

## 2. Under-block

A retry whose content was modified (for example the sender appends text) hashes
differently and is not collapsed — correct, it is a different message. Messages
missing a `threadId` or body content are passed through unchanged, because there
is no stable key for them and they are not part of the observed failure.

The dedup is per-server-process in-memory state. Across a multi-machine failover
the new holder starts with an empty window, so a duplicate that straddles the
handoff could slip through. This is acceptable: the durable per-message ledger
and the `message.id` relay dedup still apply, and the straddle window is seconds
wide.

## 3. Level-of-abstraction fit

The dedup lives at the relay-agent ingress as a small local module, not inside
`MessageRouter.relay`. The relay funnel's dedup is the `message.id` identity
layer with redelivery semantics; the content-hash layer is a distinct identity
(what the message *is*, not its id) for the specific retry-with-fresh-id failure.
Keeping it a separate module checked at the route keeps the change local to where
the failure manifests and leaves the relay funnel's contract unchanged.

## 4. Signal vs authority compliance

**Required reference:** [docs/signal-vs-authority.md](../../docs/signal-vs-authority.md)

- [x] No LLM judgment is involved. This is a deterministic mechanical guard — an
  exact content-hash match within a fixed time window — exercising the same kind
  of narrow, idempotent authority the existing `message.id` relay dedup already
  holds. It never interprets meaning; it only recognizes an exact repeat. A
  false match requires identical sender, thread, and bytes within seconds, and
  its only effect is to withhold a second spawn (no data is lost; the message is
  still acknowledged with `200`).
