# Live-test Slack sender + placement responder reader

## What Changed
Two more pure building blocks for the live-test harness (spec live-user-channel-proof-standard §5.4/§5.6), ships DARK (not wired):
- `SlackLiveSender` — a real Slack `SurfaceSender`: posts as a non-agent identity via `chat.postMessage`, awaits the agent's reply by polling `conversations.history` (deterministic: a message strictly after the prompt, authored by the agent's bot user id). Parameterized on the sender token so only the credential needs provisioning.
- `PlacementResponderReader` — the injectable `resolveResponderMachine` for RealChannelDriver: maps (surface, channelId)→topic, reads `/pool/placement` `owner` (the machine that actually holds the seat — the cross-machine proof), tolerates read errors (returns null).

## Evidence
- `tests/unit/SlackLiveSender.test.ts` — 7 tests: post→ts, no-ts throw, agent-reply-after-prompt, ignores non-agent + stale messages, poll-until-appears, timeout→null, no-afterId.
- `tests/unit/PlacementResponderReader.test.ts` — 7 tests: telegram channel==topic, owner reflects seat move, slack channel→topic mapping, no-topic→null (no fetch), owner-null→null, fetch-error→null, arrow-bound detached reference.
- `tsc --noEmit` clean. instar-dev gate green.

## What to Tell Your User
Nothing yet — internal infrastructure for the gold-standard live-testing harness, ships dark (no runtime surface, no behavior change). The payoff is when the harness drives the real Slack channel and proves which machine served the reply.

## Summary of New Capabilities
None user-facing. Internally: the real Slack drive + the cross-machine "which machine answered" reader that the live-test harness needs. No new routes, no config, no flags.
