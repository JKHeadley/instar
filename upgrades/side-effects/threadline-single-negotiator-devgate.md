# Side-Effects — Threadline Single-Negotiator dev-gate fix (CMT-1362)

**Change:** Correct the rollout gating of the Threadline single-negotiator lease so it
dogfoods on development agents, as the spec's FD-7 ("dry-run-first … enforce only after
dry-run telemetry shows an acceptable false-positive rate") actually requires.

**Spec:** `docs/specs/THREADLINE-SINGLE-NEGOTIATOR-SPEC.md` (converged + approved). This is a
follow-up fix to the merged Phase 1 (PR #1071), not a new feature.

## What was wrong

Phase 1 shipped the lease with `threadline.singleNegotiator.enabled` hardcoded `false` in
`ConfigDefaults.ts` and classified in `DARK_GATE_EXCLUSIONS` as `deliberate-fleet-default`
("off for everyone, incl. dev"). That is the PR #1001 anti-pattern: a written `enabled:
false` literal force-darks even a development agent, so the lease never runs anywhere — and
the FD-7 dry-run false-positive telemetry the spec needs before the lease can ever enforce
is never gathered. The feature could not graduate.

## What changed

- `src/config/ConfigDefaults.ts` — OMIT `enabled` from the `singleNegotiator` block so it
  resolves through the developmentAgent gate. `dryRun` stays default-`true`.
- `src/threadline/NegotiatorLease.ts` — `resolveSingleNegotiatorConfig(raw, devGateConfig?)`
  now resolves `enabled` via `resolveDevAgentGate(r.enabled, { developmentAgent })` instead of
  `r.enabled === true`. An explicit config `enabled` still wins (false force-darks; true is
  the fleet-flip).
- `src/threadline/NegotiatorGate.ts` — `SendGateDeps.developmentAgent` added and threaded
  into the resolver at the send chokepoint.
- `src/server/routes.ts` — both resolver call sites (`GET /threadline/negotiator` and the
  send-gate evaluation) pass `ctx.config` so the gate resolves.
- `src/core/devGatedFeatures.ts` — moved the entry from `DARK_GATE_EXCLUSIONS` to
  `DEV_GATED_FEATURES` (the wiring test now proves it resolves live-on-dev / dark-on-fleet).
- `src/scaffold/templates.ts` + `src/core/PostUpdateMigrator.ts` — awareness text corrected
  from "default false ⇒ pass-through" to "dev-gated: live on dev in dry-run, dark on fleet".
- `tests/unit/lint-dev-agent-dark-gate.test.ts` — hand-updated the `enabled:`-line map (the
  `singleNegotiator` literal is gone; later entries shift +3 for the expanded comment).

## Behavioral impact

- **Dev agents (developmentAgent: true):** the lease now ENGAGES in dry-run — it runs the
  ownership logic and logs every would-hold verdict to the negotiator JSONL for FD-7
  telemetry, but WITHHOLDS NOTHING (a real send is only ever blocked by an explicit
  `dryRun: false`). No egress, no spend, no destructive action.
- **Fleet (developmentAgent unset/false):** unchanged — fully dark, pure pass-through.
- **Reversibility:** set `threadline.singleNegotiator.enabled: false` explicitly in config to
  force-dark even a dev agent. Stale lease state is inert when the gate is off (no cleanup
  job), exactly as in Phase 1.

## Migration parity

`applyDefaults` is add-missing-only and deep-merges. Existing agents that already received the
Phase 1 block with a persisted `enabled: false` keep it (explicit value wins) — they are NOT
silently flipped; only agents without an explicit value inherit the dev-gate resolution. The
migrator awareness paragraph is content-sniffed (idempotent) and only its text changed.

## Tests

Unit (`NegotiatorLease`, `devGatedFeatures-wiring`, `lint-dev-agent-dark-gate`), integration
(`negotiator-send-gate`, `inbound-ack-wiring`), and e2e (`threadline-negotiator-alive`,
`threadline-g2-boundary`) all green locally; full unit suite green apart from build/env-
dependent tests unrelated to this change (unbuilt lockfile lib, tunnel network, serendipity
route). Typecheck clean.
