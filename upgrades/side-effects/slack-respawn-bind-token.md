# Side-Effects Review — Slack session respawn re-mints the conversation bind token

**Version / slug:** `slack-respawn-bind-token`
**Date:** `2026-07-04`
**Author:** `Echo`
**Second-pass reviewer:** `not required (Tier-1)`

## Summary of the change

A FRESH Slack channel spawn passes `bootstrapConversationIds: [conversationId]` to
`spawnInteractiveSession`, so the session mints `INSTAR_BIND_TOKEN` + `INSTAR_CONVERSATION_ID`
(durable-conversation-identity §7) and can open durable state — a commitment bound to its minted
(negative) conversation id. The Slack session **respawn** closure (`slackRespawner` in
`src/commands/server.ts`, used by `/sessions/refresh`, quota-swap, restart, and restart-all — all
funnel through `SessionRefresh` → `slackRespawner`) **omitted** `bootstrapConversationIds`. So a
refreshed/quota-swapped Slack session came up **token-less** (and without `INSTAR_CONVERSATION_ID`),
its durable commitment binds were **refused fail-closed**, and the follow-through fell back to a
fragile session-local timer that dies on the next restart. This is the live-proven S7 gap (Round-1 of
the 2026-07-04 test-as-self proof: an already-running/refreshed Slack session couldn't register a
durable commitment; a fresh spawn — Round-2 — could, registering `CMT-1922` bound to `-1734007126`).
Telegram's respawn is unaffected because it passes `telegramTopicId`, which the bind-token env
resolver uses as a fallback; Slack has no such fallback. Fix: the respawn closure resolves the
conversation id from the routing key (`conversationRegistry.mintForInbound(routingKey).id`, idempotent
get-or-create → the SAME id the fresh dispatch resolves) via a new unit-tested helper
`slackRespawnBootstrapIds` and passes it as `bootstrapConversationIds` — restoring parity with the
fresh spawn. Files: `src/commands/server.ts` (closure + import), `src/core/slackRefreshBinding.ts`
(helper), + test.

## Decision-point inventory

- `slackRespawner` closure spawn options (`src/commands/server.ts`) — **modify** — now passes
  `bootstrapConversationIds` resolved from the routing key.
- `slackRespawnBootstrapIds` (`src/core/slackRefreshBinding.ts`) — **add** — the pure, tested resolver.

## 1. Over-block / 2. Under-block

No block/allow surface. This RESTORES a capability (durable bind on a respawned Slack session) that was
mistakenly dropped. Over/under-block not applicable.

## 3. Level-of-abstraction fit

Right layer — the fix is a one-option addition at the respawn spawn site, mirroring the fresh-spawn
site exactly; the resolution is a tiny pure helper in the existing `slackRefreshBinding` module. No new
machinery, no new authority.

## 4. Signal vs authority compliance

**Required reference:** [docs/signal-vs-authority.md](../../docs/signal-vs-authority.md)

- [x] No — no runtime block/allow surface. The bind token it restores is enforced by the EXISTING §7
  `conversationBindGate` (unchanged); this change only ensures the legitimately-authorized session
  actually receives its own token on respawn.

## 5. Interactions

- **Shadowing:** none — additive spawn option, mirroring the fresh path.
- **Double-fire:** none. `mintForInbound` is idempotent (get-or-create), so re-resolving on respawn
  returns the same id the fresh dispatch used; no duplicate conversation is minted.
- **Races:** none new — the respawn already spawned a session; this only adds one option to that call.
- **Feedback loops:** none.
- **Fail posture:** `slackRespawnBootstrapIds` FAILS TOWARD RESPAWN — any resolution error → `undefined`
  (the prior token-less behavior), never throws, so a refresh can never be blocked by id resolution.

## 6. External surfaces

- **Install base / agents:** ships with the server; a refreshed Slack session now carries its bind
  token. No config migration. No behavior change for a session that already had the token (fresh
  spawns) or for Telegram (unaffected — separate fallback).
- **External systems:** Slack unchanged (same channel session, same delivery). No new API.
- **Persistent state:** none — `INSTAR_BIND_TOKEN` lives only in the tmux `-e` env at spawn (stateless,
  self-authenticating). This change sets it correctly on respawn; nothing is persisted.

## 6b. Operator-surface quality

No operator surface — not applicable.

## 7. Multi-machine posture (Cross-Machine Coherence)

**machine-local BY DESIGN** — `machine-local-justification: physical-credential-locality`. A Slack
session is a tmux process on the machine that owns the Slack connection; its bind token is minted into
that process's env at spawn on that machine (the token is a per-session, per-machine credential — the
§7 secret is machine-local plaintext, same posture as authToken). The respawn happens on the owning
machine. There is no cross-machine state, notice, durable record, or URL introduced; the fix only
corrects a spawn-option omission on the local respawn path.

## 8. Rollback cost

Pure code change — revert the closure option, the helper, the import, and the test. No persistent
state; a rollback returns to the (buggy) token-less respawn. Zero-cost back-out.

## Conclusion

Closes the final live-proven S7 gap: a refreshed/quota-swapped Slack session now re-mints its
conversation bind token, so durable, restart-surviving follow-through works even after a session
churn — matching the fresh-spawn path that the 2026-07-04 test-as-self proof showed already works.
Minimal, parity-restoring, fail-open, unit-tested. Clear to ship.

## Second-pass review (if required)

**Reviewer:** not required (Tier-1)

## Evidence pointers

- `tests/unit/slack-respawn-bootstrap-ids.test.ts` — 4 cases: resolves id → `[id]`, passes the full
  `channel:thread` routing key, `null` id → `undefined`, throwing registry → `undefined` (fails toward
  respawn).
- Existing `tests/unit/sessionRefresh-slack.test.ts` (22) stay green; `tsc` clean.
- Live proof: `docs/investigations/s7-slack-delivery-repro-2026-07-04.md` §9 (Round-1 refused vs
  Round-2 durable `CMT-1922`).

## Class-Closure Declaration (display-only mirror)

- **`defectClass`** — `spawn-option-asymmetry` (`novel`; nearestExistingClass: `feature-un-enablable`;
  includes: a spawn/respawn path that omits an option the parallel fresh-spawn path passes, silently
  degrading a capability; excludes: an intentionally-different respawn option). Enters
  `status:"unconfirmed"`, so this fix carries `closure: gap`.
- **`closure`** — `gap` — a class-level guard (a lint/test asserting respawn spawn-option parity with
  the fresh-spawn site) is out of scope for this fix.
- **`guardEvidence`** — n/a for `closure: gap`.
- **`gap`** — tracked follow-up: "respawn/fresh-spawn option-parity guard — assert the Slack (and other
  platform) respawn paths pass the same identity/bind options as their fresh-spawn counterparts."
