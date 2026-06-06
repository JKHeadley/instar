---
bump: minor
audience: agent-only
maturity: experimental
---

## What Changed

Wired the merged `TopicOperatorStore` (#904) into the live `AgentServer` and
exposed it over HTTP (Know Your Principal standard, security-build increment 2b).
The store is now composed into the server under the `stateDir` guard (fail-safe:
`null` → routes `503`, never a crash) and reachable via four Bearer-gated routes.
This is the runtime arm of the operator-binding spec (#897); the store had no
consumers before this.

## What to Tell Your User

Nothing user-facing changes yet. This is foundation wiring (experimental) for the
Caroline identity-bleed security fix — it adds routes the system can use but does
not alter any current conversational behavior. The automatic session-start
injection of the verified operator is a later increment.

## Summary of New Capabilities

- `GET /topic-operator` — all bound operators (names + uids).
- `GET /topic-operator/:topicId` — one topic's verified operator (or null).
- `GET /topic-operator/session-context?topicId=N` — the `<topic-operator>`
  session-start injection block (`{ present:false }` when unbound).
- `POST /topic-operator` — bind a topic operator from the AUTHENTICATED sender
  `{ topicId, platform?, uid (required), displayName? }`; a blank uid is refused
  `400` (a content name can never become the operator).
- `CapabilityIndex` entry `topicOperator` (prefix `/topic-operator`).

## Evidence

Verified by 10 Tier-2 integration tests (full HTTP pipeline over a real
file-backed store, incl. the blank-uid refusal and the store-not-wired `503`
degradation) and 6 Tier-3 E2E lifecycle tests (feature-alive on the real
`AgentServer` boot path — `200` not `503` — full bind→read→inject lifecycle,
durable-write proof, and the over-the-wire blank-uid refusal). Tier-1 unit
coverage shipped in #904. Clean `tsc --noEmit`.
