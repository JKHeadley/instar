# Threadline Single-Negotiator — now dogfoods on dev agents

## What Changed

- **The single-negotiator lease (`threadline.singleNegotiator`) is now dev-gated instead of
  off-for-everyone.** Phase 1 shipped it with a hardcoded `enabled: false` classified
  `deliberate-fleet-default`, which force-darked even development agents — the PR #1001
  anti-pattern. That starved the FD-7 dry-run false-positive telemetry the spec requires
  before the lease can ever enforce, so the feature could never graduate. The `enabled` flag is
  now OMITTED from `ConfigDefaults` and resolves through `resolveDevAgentGate`: **LIVE on a
  development agent, DARK on the fleet.**
- **On a dev agent it runs in dry-run only.** `dryRun` stays default-`true`, so the lease
  engages the ownership logic and logs every would-hold verdict to the negotiator JSONL
  (gathering the FD-7 telemetry) but **withholds nothing** — a real send is blocked only by an
  explicit `dryRun: false`. No egress, no spend, no destructive action.
- The registry entry moved from `DARK_GATE_EXCLUSIONS` to `DEV_GATED_FEATURES`, so the
  dev-gate wiring test now proves it resolves live-on-dev / dark-on-fleet permanently.

## Evidence

- Implements the approved `THREADLINE-SINGLE-NEGOTIATOR-SPEC` FD-7 dogfooding intent (CMT-1362),
  a follow-up to Phase 1 (PR #1071).
- Unit (`NegotiatorLease`, `devGatedFeatures-wiring`, `lint-dev-agent-dark-gate`), integration
  (`negotiator-send-gate`, `inbound-ack-wiring`) and e2e (`threadline-negotiator-alive`,
  `threadline-g2-boundary`) tests green; typecheck clean.

## What to Tell Your User

Nothing changes for real users or for the fleet — the single-negotiator lock stays fully off
for everyone except development agents. On a dev agent it now runs quietly in practice
(dry-run) mode: it watches each conversation and logs what it *would* do, but never blocks a
message. That practice data is exactly what the feature needs before it can ever be switched on
for real. An explicit on/off switch in config overrides this in either direction.

## Summary of New Capabilities

- No new user-facing capability. This is a rollout-correctness fix: the single-negotiator lease
  now follows the standard dark-feature pattern — proven on the dev agent first (in dry-run),
  dark on the fleet — instead of being switched off everywhere.
