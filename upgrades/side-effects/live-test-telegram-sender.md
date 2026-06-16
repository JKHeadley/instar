# Side-Effects Review — Live-test Telegram sender

**Slug:** live-test-telegram-sender
**Spec:** docs/specs/live-user-channel-proof-standard.md §5.4 (Platform-Sanctioned Automation)
**Files:** src/core/TelegramLiveSender.ts, tests/unit/TelegramLiveSender.test.ts
**Posture:** ships DARK — one pure/injectable SurfaceSender, NOT wired into server.ts.

## What it is
TelegramLiveSender — the real Telegram `SurfaceSender`: posts into a forum topic AS A NON-AGENT identity (an injected demo-bot post fn), then `awaitReply` polls the topic history for the AGENT's reply (the earliest entry with `fromUser === false` strictly after the sent messageId). Same proven shape as SlackLiveSender; parameterized on the demo-bot post fn + the history reader, so only the demo-bot CREDENTIAL + a demo group/topic need provisioning.

## Phase 1 — Principle check (signal vs authority)
Not a decision point — transport (post + poll). No block/filter/gate. Compliant.

## Phase 4 — Side-effects answers
1. **Over-block** — n/a. Worst case: the reply match misses a genuine agent reply → scenario records no-reply FAIL. Mitigated by the deterministic `fromUser===false` + strictly-after-messageId match over the full poll window.
2. **Under-block** — n/a. Risk of matching a STALE agent message mitigated by the `messageId > afterId` strictly-after guard + oldest-first scan (earliest reply after the prompt).
3. **Level-of-abstraction fit** — correct: the concrete Telegram adapter for the harness's `SurfaceSender` seam. Wraps the demo-bot post + getTopicHistory rather than reinventing them.
4. **Signal vs authority** — compliant (transport, no authority).
5. **Interactions** — none yet (dark, unwired). The demo-bot identity is SEPARATE from Echo's own bot, so a demo post can't be confused with Echo's outbound; history read is read-only.
6. **External surfaces** — when wired, it WILL post a real message into a demo Telegram group via the demo-bot token. THIS increment: no wiring, no external surface. The demo-bot token + demo group is the provisioning dependency; the code is parameterized on it.
7. **Multi-machine posture** — machine-agnostic (talks to the Telegram Bot API + reads topic history). The cross-machine attribution is the RealChannelDriver's PlacementResponderReader, not this sender. No single-machine assumption.
8. **Rollback cost** — trivial: dark, unwired. Revert the commit.

## No-deferrals
The runner route (wires both senders + RealChannelDriver + harness + the multi-machine matrix) is the NEXT tracked increment (CMT-1568, `.instar/plans/live-test-harness-drivers-BUILD.md`), not a deferral. This sender is complete + fully unit-tested (8 tests). The demo-bot/group provisioning is an external-credential dependency tracked in the plan, not a code deferral — the code is parameterized so only the credential is missing.

## Phase 5 — Second-pass review
Not required: transport adapter, no block/allow/lifecycle/sentinel/gate surface (the Phase-5 triggers).
