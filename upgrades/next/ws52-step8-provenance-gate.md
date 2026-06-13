# WS5.2 Step 8 — credential provenance flag + env-token gate (dark)

<!-- bump: patch -->

<!--
  NOTE: dark/additive + internal. One new exported class (CredentialEnvTokenGate) + a new
  additive optional Session.credentialSource field + one rebalancer route that now surfaces
  the gate verdict. ALL gated by the EXISTING subscriptionPool.credentialRepointing flag
  (enabled:false + dryRun:true, already a DARK_GATE_EXCLUSIONS destructive entry) — NO new
  config flag, so the dark-gate line-map is UNCHANGED (no recompute; lint clean, dark-gate
  test green as-is). No new unfunneled credential write path — the gate is a pure read-time
  evaluator and the provenance field is free session-record metadata. CLAUDE.md awareness +
  migrateConfig are Step 9 (Migration parity).
-->

## What Changed

Enforces the spec's applicability precondition: live credential re-pointing only works for sessions that read their credential from the per-config-home store. A session launched with an env token bypasses that store and is invisible to the mechanism — so this step records, at spawn, WHERE each session's Anthropic credential comes from, and refuses to run the feature whenever an env-token session is present.

- **Durable per-session provenance flag** — a new `credentialSource: 'store' | 'env'` field on the session record, set at every claude-code spawn lane. It is derived from the IDENTICAL expression that selects the session's Anthropic env block — `(config.anthropicApiKey ?? '') !== '' ? 'env' : 'store'`, computed at the spawn site — so the flag can never drift from what actually launched the session (single source of truth; an independent recomputation would re-create the staleness class this spec exists to kill).
- **The env-token gate** — a new `CredentialEnvTokenGate` (src/core/CredentialEnvTokenGate.ts), a pure evaluator. It REFUSES the feature, with a NAMED category reason, when either the config field `anthropicApiKey` is any non-empty value (an OAuth token OR a direct API key — both bypass the store) OR any running claude-code session's provenance flag is `env`. Checking the LIVE fleet — not just the config field — closes the mid-life-flip hole: an operator setting an env token mid-run would otherwise leave already-running store sessions steerable while new env spawns are silently un-steered.
- **Named reason on the status route** — `GET /credentials/rebalancer`, when the feature flag is ON, now surfaces the gate verdict (refused, the reason category, and the count of env sessions), scrubbed through the existing secret-scrub chokepoint. Dark (flag off) it stays a strict 503 no-op.
- **Attribution-suppression** — on a gate refusal the location gate behaves as dark, so the quota poller stops routing reads/attribution through moved slots: an env session's usage is never mis-attributed to a slot tenant.
- **Dark** — gated by the existing `subscriptionPool.credentialRepointing` flag. With the feature off (the fleet + dev default) the gate is never consulted and the only delta is the additive provenance field on new session records (free metadata, never read) — byte-for-byte today's behavior.

## What to Tell Your User

This is internal plumbing that ships turned off, so nothing changes for you day to day. What it builds toward, with a safety guarantee baked in: the under-the-hood feature that moves a credential between your subscription accounts only works for sessions that read their login from the on-disk store I manage. If a session was instead launched with a login token handed straight to it in its environment, that session ignores the store entirely and the moving trick would be a no-op for it. So this step teaches me to record, the moment each session starts, which of those two kinds it is — and to refuse to run the whole moving feature at all whenever any running session is the kind I cannot steer. That refusal is deliberate and visible, with a plain reason, rather than the feature quietly mis-handling a session it does not actually control. It is off by default and does nothing until the feature is turned on after a review window.

## Summary of New Capabilities

One new exported class — `CredentialEnvTokenGate` (the env-token applicability gate: refuses on the config field OR a live env-token session in the fleet, with a named reason) — plus a new additive optional `Session.credentialSource` provenance field set at every claude-code spawn lane, and the `GET /credentials/rebalancer` route surfacing the gate verdict. All gated by the existing `subscriptionPool.credentialRepointing` flag. No new gate flag, no new unfunneled credential write path.

## Evidence

- `tests/unit/credential-env-token-gate.test.ts` (18) — config predicate (permits empty/undefined; refuses on sk-ant-oat, on a direct sk-ant-api03 key, and on any non-empty value); live-fleet path (refuses on one running env session with config empty, counts multiple, ignores a non-running env session and a non-claude env session, treats undefined as store, config-field refusal short-circuits before the fleet scan); attribution-suppression (`shouldAttributeSlotTenant` false for env, true for store/undefined); and the single-source-of-truth blocker proven by a static grep-assert against the real SessionManager source (exactly 3 env-block predicates + 3 identical provenance derivations + 4 record writes).
- `tests/integration/credential-routes.test.ts` (+3) — the rebalancer route surfaces the config-field refusal (scrubbed, no token leak), the live-fleet refusal (mid-life flip, config empty), and permits when config empty + all-store fleet.
- `tests/e2e/credential-repointing-routes-alive.test.ts` (+3) — feature-alive on the real AgentServer factory: rebalancer DARK is a strict 503 no-op, ENABLED + clean config + all-store fleet permits, ENABLED + a live env-token session refuses with the named reason.
- tsc clean; full `npm run lint` clean (dark-gate 16/16 unchanged — no ConfigDefaults touched); no-silent-fallbacks + no-empty-catch-blocks + feature-delivery-completeness + docs-coverage green.
