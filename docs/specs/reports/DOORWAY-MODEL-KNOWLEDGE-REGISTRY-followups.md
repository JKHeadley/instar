# Doorway/Model Knowledge Registry — tracked follow-ups (Close the Loop)

Owner topic: **29723** (LLM-pathway / doorway-registry project). Parent spec:
`docs/specs/DOORWAY-MODEL-KNOWLEDGE-REGISTRY-SPEC.md` (approved 2026-07-04).

This stub is the durable tracking record the spec's §"Deferred / declined items"
acceptance bar requires ("the declined items are filed as tracked follow-ups, not
merely named here"). It is the `docs/specs` stub the spec names as one valid
tracking mechanism. Each row is re-surfaced from topic 29723; the `<!-- tracked:
29723 -->` markers in the spec body point here.

## Rollout increments — what shipped vs. what remains

The spec's §Rollout sequences the feature into graduated, dark-first increments.
Landed and remaining:

| # | Increment | Status |
|---|-----------|--------|
| 1 | Enriched manifest (seeded `topModels`, D4) + derived-frontier lint (report mode) — backward-compatible | **SHIPPED** (this PR) |
| 2 | Deterministic prober (`scripts/doorway-scan.mjs`) + live scan-state schema (`.instar/state/doorway-scan.json`) + diff/debounce/breaker + the `perMachineIndependent` job template (`enabled:false`) + the §2.7 PreToolUse command-allowlist guard | pending |
| 3 | `GET /doorways` route (D5 status contract) + CLAUDE.md awareness block + config knob (`maintenance.doorwayScan`) migration | pending |
| 4 | Operator enables the job on the maintainer agent (free-probes) → soak → optional `+liveness`/`+web-verify` opt-in | operator step |
| 5 | Companion-gated: reconcile `flaggedStale` → flip the lint to `strict` → ratify the "Keep the Doorway/Model Map Current" standard in `docs/STANDARDS-REGISTRY.md` | operator-ratified |

## Deferred / declined items (out of v1 scope, NOT dropped)

1. **DF1 — full pool-scope read** of live scan-state (merge each machine's
   scan-state, tagged by machine) — spec §Multi-machine. Additive follow-up.
2. **DF2 — per-machine scan-liveness monitoring** (a `lastScanAt`-freshness check
   surfaced via the guard-posture inventory) — spec §2.9 / P18. Anti-rot backstop
   is the independent freshness lint; this is the additive liveness signal.
3. **DF3 — open-ended doorway discovery** (a provider-registry probe beyond the
   candidate list + vault-key heuristic) — spec §2.5.
4. **DF4 — auto-PR** of a surfaced maintainer-diff against the canonical registry
   (post-soak) — spec §2.7. v1 is decoupled attention-queue + maintainer-diff,
   signal-only with zero source-write authority.
5. **DF5 — dedicated non-shell runner entrypoint** for the scan (removing the Bash
   surface the §2.7 guard defends) — spec §Alternatives.
6. **DF6 — system-notification lane bypassing the prose tone gate** for infra-health
   alerts (like the cold-start lifeline's deterministic `telegram.sendToTopic`
   path) — spec §2.6. v1 uses a jargon-safe body + confirmed-delivery re-surface.
