# Durable-Output Hygiene — Layer B credential scrub at persistence chokepoints (ships DARK)

## What Changed

Ships the deterministic security floor for defect class 4 (a session-digest writer
reproduced a live access token verbatim into stored memory — INSTAR-Bench v2):

- **Shared pattern floor** `src/core/durableSecretScrub.ts` — `scrubForStore` /
  `scrubStructured` return scrubbed text + kind/offset/length redaction metadata;
  fail-safe-toward-redaction (scrub-error / oversize withhold the field under a typed
  marker, never persist raw bytes), size-bounded, linear patterns only (pinned test).
- **Config-gated wrapper** `src/monitoring/DurableOutputScrubber.ts` — dev-gate
  `monitoring.durableOutputScrub` (enabled OMITTED ⇒ dark on the fleet, live on a dev
  agent), `dryRun` defaults TRUE (would-redact metrics only, original text persists);
  FeatureMetricsLedger counters under `durable-output-scrub`; per-store poisoning-burst
  alarm → one deduped attention item.
- **First wired chokepoint**: SessionSummarySentinel `saveSummary` (task/blockers/
  files/topics) with a mandatory `redactionNote` provenance marker on any altered
  summary.
- **Auditable chokepoint inventory** `src/data/durableOutputChokepoints.ts` + a
  shrink-only CI ratchet — every other known LLM-output store (and each replicated
  store's receive path) is classified `pending`/`exempt` with an owner.
- Registered in `DEV_GATED_FEATURES` and `guardManifest` (configPath +
  dryRunConfigPath) so `/guards` and the boot tripwire cover the posture.

The dryRun:false enforce flip is the operator's decision on the dev-soak packet
(spec Frontloaded Decision #4). Spec: docs/specs/durable-output-hygiene-standard.md.

## Evidence

- Spec (converged round-3 clean + approved): `docs/specs/durable-output-hygiene-standard.md`
  with ELI16 companion.
- Side-effects review: `upgrades/side-effects/durable-output-hygiene-standard.md`.
- Tests: `tests/unit/durableSecretScrub.test.ts` (12), `tests/unit/DurableOutputScrubber.test.ts`
  (10), `tests/unit/durable-output-chokepoint-ratchet.test.ts` (6),
  `tests/integration/session-summary-durable-scrub.test.ts` (4) — all pass; dark-gate,
  no-silent-fallbacks, guard-manifest, feature-delivery, capability-index ratchets green;
  tsc clean.

## What to Tell Your User

⚗️ **Experimental / dev-gated — nothing changes for you yet.** This ships **dark on the
fleet**: it runs live only on a development agent, and even there it is in observe-only
mode — it counts what it would redact but never alters anything stored. The problem it
closes: if a secret (a password or access key) ever appears in text the agent is
summarizing, the summary that gets saved to long-term memory could carry that secret
forever. This adds a safety net that scans such text at the moment of saving and, once
an operator turns real redaction on after reviewing the observe-mode numbers, replaces
anything secret-shaped with a visible redaction marker plus a note that something was
removed. Until an operator flips it on, there is no user-facing change.

## Summary of New Capabilities

None yet for end users — this change ships dev-gated dark in observe-only mode. (When
an operator enables real redaction: permanent stores like session digests are scrubbed
of credential-shaped text before saving, every altered record carries a visible note,
and a burst of secret-shaped plants raises one attention item instead of silently
polluting memory.)
