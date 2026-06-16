# Side-Effects Review — Live-test Slack sender + placement responder reader

**Slug:** live-test-slack-sender
**Spec:** docs/specs/live-user-channel-proof-standard.md §5.4 (Platform-Sanctioned Automation) + §5.6 (deterministic cross-machine proof)
**Files:** src/core/SlackLiveSender.ts, src/core/PlacementResponderReader.ts, tests/unit/SlackLiveSender.test.ts, tests/unit/PlacementResponderReader.test.ts
**Posture:** ships DARK — two pure/injectable building blocks, NOT wired into server.ts. No route, no runtime construction. Stacked on the driver core (PR #1195).

## What it is
- **SlackLiveSender** — a real Slack `SurfaceSender`: posts a message AS A NON-AGENT identity (a user/second-bot token, injected) via `chat.postMessage`, and `awaitReply` polls `conversations.history` for the AGENT's reply (a message strictly after the sent ts authored by the agent's bot user id). Deterministic match; null on timeout; throws (never fabricates an id) if a post returns no ts.
- **PlacementResponderReader** — the injectable `resolveResponderMachine` for RealChannelDriver: maps (surface, channelId)→topic, reads `GET /pool/placement` `owner`, returns the serving machine id. Tolerates read errors (returns null). Reads `owner` (who holds the seat), NOT `pinnedTo` (the intent) — the distinction IS the capstone.

## Phase 1 — Principle check (signal vs authority)
Neither module is a decision point. SlackLiveSender is transport (post + poll); PlacementResponderReader is a read that returns a machine id. Neither blocks, filters, or gates anything — they produce data the harness asserts on. No brittle blocking authority added. Compliant.

## Phase 4 — Side-effects answers
1. **Over-block** — n/a (no block surface). Worst case: SlackLiveSender's reply-match is too strict and misses a genuine agent reply → the scenario records a FAIL/no-reply. Mitigation: it matches on the agent's bot user id (the deterministic author), and polls the full window.
2. **Under-block** — n/a. A risk: matching a STALE agent message as the reply. Mitigated by the strictly-after-ts guard (both via `oldest`+`inclusive:false` AND an explicit `m.ts > after` belt-and-suspenders) and oldest-first scan returning the EARLIEST post-prompt agent message.
3. **Level-of-abstraction fit** — correct: both are the concrete adapters the harness's injected seams (`SurfaceSender`, `resolveResponderMachine`) were designed for. They wrap existing surfaces (`SlackApiClient`, `/pool/placement`) rather than reinventing them.
4. **Signal vs authority** — compliant (transport + read, no authority). See Phase 1.
5. **Interactions** — none yet (dark, unwired). SlackLiveSender uses a SEPARATE sender token from Echo's bot, so it can't be confused with Echo's own outbound; it reads history read-only. PlacementResponderReader only GETs placement. No shadowing/double-fire.
6. **External surfaces** — when wired, SlackLiveSender WILL post a real message into a Slack channel (the demo workspace) and PlacementResponderReader WILL GET the local placement route. In THIS increment: no wiring, so no external surface. The sender token/identity is the one piece that needs provisioning (a user/second-bot token in the demo workspace) — the code is parameterized on it.
7. **Multi-machine posture** — PlacementResponderReader IS the multi-machine attribution: it reads the authoritative `/pool/placement` (proxied to the lease-holder), so it answers "which machine served this" correctly regardless of which machine runs the harness. SlackLiveSender is machine-agnostic (talks to Slack's API). No single-machine assumption.
8. **Rollback cost** — trivial: dark, unwired. Revert the commit.

## No-deferrals
The Telegram live sender + the runner route are the NEXT tracked increment (CMT-1568, `.instar/plans/live-test-harness-drivers-BUILD.md`), not a deferral of this one. This increment is complete + fully unit-tested (14 tests). The Slack/Telegram SENDER-IDENTITY provisioning (a user token / demo bot) is an external-credential dependency tracked in the plan, explicitly NOT a code deferral — the code is parameterized so only the credential is missing.

## Phase 5 — Second-pass review
Not required: neither module adds a block/allow decision, a session-lifecycle action, a sentinel/guard/gate/watchdog, or a coherence/trust surface (the Phase-5 triggers). Both are transport/read adapters. The driver core that DOES touch the §5.3 block (DemoChannelRegistry) had its second-pass in PR #1195.
