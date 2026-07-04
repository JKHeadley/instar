# Side-Effects Review — Reviewer-Door Rewiring inc1 (Anthropic clean-door reviewer family)

**Version / slug:** `reviewer-door-rewiring-inc1`
**Date:** `2026-07-04`
**Author:** `echo (build hand)`
**Second-pass reviewer:** `not required (Tier-1: dark-on-fleet, config-reversible, no durable state / external side-effects; PR is the review surface)`

## Summary of the change

inc1 of REVIEWER-DOOR-REWIRING adds a third spec-converge external reviewer family — the strongest
Anthropic model (`claude-fable-5`) read through the clean `claude -p` door, off the measured-penalized
`opus × coding-harness` pair. It ships **dark on the fleet / live on a development agent** via the
`specConverge.reviewers.anthropic.enabled` developmentAgent gate; absent config keeps today's exact
`[codex, gemini]` behavior byte-for-byte. The family is a clean-door SECOND READ (`crossFamily: false`)
that books into its own `clean-door-anthropic-review` disclosure field and can never launder the
`cross-model-review` flag. Files touched: `src/core/crossModelReviewer.ts` (detection, model
resolution, registry entry, config gate, crossFamily plumbing, baseline-predicate swap, aggregate
filter, hardening preflight), `src/core/ClaudeCliIntelligenceProvider.ts` (reviewer-hardening
invocation + exported arg/env builders), `src/core/types.ts` (`IntelligenceOptions.reviewerHardening`),
`scripts/model-registry-freshness.manifest.json` (reviewer pin), `skills/spec-converge/scripts/cross-model-review.mjs`
(config gate), `skills/spec-converge/SKILL.md` (family + D7 disclosure), `src/core/PostUpdateMigrator.ts`
(SKILL.md content migration), `docs/LLM-ROUTING-REGISTRY.md` (stale `report`→`strict` line), plus five
test files + the converged spec docs.

## Decision-point inventory

- `SUPPORTED_REVIEWER_FRAMEWORKS` — **modify** — one new `claude-code` entry with REQUIRED `crossFamily: false`; codex remains the preference leader; existing ordering unchanged.
- `TRUSTED_REVIEWER_FRAMEWORKS` — **modify** — gains `claude-code`, COUPLED ATOMICALLY with the §5.4 baseline-predicate swap (`isTrustedReviewerFramework` → `isCrossFamilyReviewerFramework`).
- `ReviewerResult` / `CrossModelDetectionResult` — **modify** — gain a `crossFamily` field (populated from the registry; existing families byte-identical).
- `aggregateRoundOutcomes` / `detectCrossModelReviewer` / `detectAllCrossModelReviewers` / `wasNonClaudeFrameworkActiveWithin` — **modify** — gain `crossFamily` filtering (behavior for existing families byte-identical).
- `IntelligenceOptions.reviewerHardening` — **add** — the claude-provider inbound-safety lockdown option (other providers ignore it).
- `specConverge.reviewers.anthropic.{enabled,model}` config block — **add** — the developmentAgent gate + optional frontier-validated model override.
- No block/allow gate, no HTTP route, no scheduler job, no watcher is introduced or modified.

---

## 1. Over-block

**What legitimate inputs does this change reject that it shouldn't?**

No user-message block/allow surface — over-block not applicable. The one rejection path is the config
model-override validator: a concrete-but-non-frontier id (e.g. `claude-opus-4-8`) is rejected with
`override-not-frontier`. This is *intended* (it prevents re-pinning the reviewer to the penalized opus
door); a legitimate frontier id (`claude-fable-5`) is accepted, and the default pin needs no override.
The `--family claude-code` refusal on the fleet (`no-supported-framework`) is intended dark-gating,
not over-block.

---

## 2. Under-block

**What illegitimate inputs does this change let through that it shouldn't?**

The load-bearing under-block risk is the untrusted spec text reaching a tool/MCP execution path via the
`claude -p --setting-sources user` door (which loads user hooks + MCP servers and inherits full env).
§1.4 hardening closes this: empty allowed-tools + `--strict-mcp-config` + neutral scratch cwd + stdin
prompt + env allowlist, plus a fail-closed runtime preflight (`hardening-unsupported` → degrade, never
run unhardened). Verified by a STATE-level zero-tool-execution test against the real Claude CLI (a
benign tool-invoking payload creates NO file). The cross-model-honesty under-block (a claude-only run
masquerading as cross-model) is closed structurally by `crossFamily`-keyed filtering, fail-closed on an
unknown id, unit-locked.

---

## 3. Level-of-abstraction fit

**Is the change at the right layer?**

Yes. The reviewer family is a registry entry in the existing `SUPPORTED_REVIEWER_FRAMEWORKS` seam (the
established extension point); the hardening is invocation options on the existing
`ClaudeCliIntelligenceProvider` (no new adapter class, no `IntelligenceFramework` union change); the gate
rides the standard `resolveDevAgentGate` funnel; the anti-rot pin rides the existing freshness-lint
manifest. No new subsystem, no new abstraction — the change reuses every existing seam.

---

## 4. Signal vs authority compliance

**Does anything here gain blocking authority it shouldn't?**

No. Every reviewer (internal, external, clean-door) remains a SIGNAL into convergence synthesis; no
pass gains blocking authority; a degraded/unavailable family degrades loudly and convergence proceeds.
The config gate governs *availability of a signal source*, not any authority. The `crossFamily` guard
is a classification of what a signal COUNTS AS, not a block. The hardening preflight degrades (a signal
outcome), never blocks.

---

## 5. Interactions

**What existing features does this change interact with, and how?**

- **Freshness lint** (`scripts/lint-model-registry-freshness.mjs`) — the new `claude-clean-door-reviewer-default`
  pin is checked under strict enforcement; verified green + non-vacuity-tested.
- **subscription pool / circuit breaker / spawn cap** — the claude reviewer rides `buildIntelligenceProvider`,
  so it inherits the spawn-cap funnel + per-framework breaker; quota pressure surfaces as `degraded:
  rate-limited`. Quota-correlation honesty: the claude family draws on the SAME Anthropic pool as the
  authoring session (called out in the spec, degrades loudly).
- **7-day externals-mandatory baseline** — the predicate swap keeps the mandatory check keyed on
  cross-model families only; a claude-only activation never satisfies it (unit-locked).
- **PostUpdateMigrator** — the SKILL.md content migration reaches already-installed agents.

---

## 6. External surfaces

**Does this change touch any external service, network call, filesystem path outside the project, or spawn?**

- **Egress:** the claude reviewer sends the spec text to Anthropic (or the operator's OWN configured
  `ANTHROPIC_BASE_URL` proxy) — the SAME destination the authoring session already uses. ZERO new
  egress destinations. No third-party aggregator (OpenRouter declined, §2).
- **Spawn:** one `claude -p` one-shot per round per available family (≤10 rounds), run in a neutral
  mkdtemp scratch cwd with an allowlist env. The `--help` preflight is a cheap one-shot, cached
  per-process.
- **Filesystem:** the reviewer pin adds a row to the in-repo freshness manifest. No paths outside the
  project are written; the scratch cwd is under `os.tmpdir()`.

---

## 6b. Operator-surface quality (Operator-Surface Quality standard)

No new operator-facing surface (no HTTP route, no dashboard tab, no user-facing config the operator
edits conversationally). The `specConverge.reviewers.*` config is instar-developing-agent tooling set
per-machine by a maintainer, documented in the spec + SKILL.md + the release fragment. Not applicable
beyond that.

---

## 7. Multi-machine posture (Cross-Machine Coherence)

- **Reviewer availability (which families detect on this machine)** — machine-local BY DESIGN.
  machine-local-justification: physical-credential-locality — each family's door is a per-disk CLI
  login (claude OAuth config-home, `~/.codex/auth.json`, `~/.gemini/oauth_creds.json`); reachability
  cannot replicate without replicating credentials, which is forbidden.
- **Config (`specConverge.reviewers.*`)** — machine-local.
  machine-local-justification: physical-credential-locality — `.instar/config.json` has no replication
  path in instar (not one of the stateSync stores), and the config selects which per-disk CLI door
  (a machine-local credentialed login) the reviewer uses. Enabling the family on more than one machine
  is a per-machine edit.
- **`state/framework-activation-history.jsonl`** — existing surface, unchanged; already machine-local
  for the same reason (it records THIS machine's detections).
  machine-local-justification: physical-credential-locality — a record of per-disk login availability.
- Convergence runs on one machine per run; no cross-machine notice, URL, or durable-topic surface is
  added. No `unified` surface is infeasible-and-claimed (bidirectional check clear).

---

## 8. Rollback cost

**How hard is it to undo this change if it goes wrong?**

Trivial. The family ships dark on the fleet (absent config = byte-identical `[codex, gemini]`). Rollback
is a config flip (`specConverge.reviewers.anthropic.enabled: false`) or a revert of a docs/constants-only
change. No data migration, no durable state, no external side-effects. The freshness manifest `enforcement`
has its own documented `strict`→`report` rollback. The SKILL.md migration is idempotent + fingerprint-guarded
(a customized skill is never touched).

---

## Conclusion

**Ship / hold / needs second pass:** Ship (Tier-1). The change is dark-on-fleet, fully config-reversible,
adds no durable state or new external destination, and the two load-bearing risks (untrusted-text tool
execution; cross-model-flag laundering) are closed structurally and verified by tests — including a live
STATE-level zero-tool-execution proof against the real Claude CLI. Operator approval of the converged
spec (`approved: true`) is deliberately left to the operator per the run mandate.

---

## Second-pass review (if required)

Not required — Tier-1 (dark-on-fleet, config-reversible, no durable/external side-effects). The PR is the
review surface. Note for the operator: this increment implements a CONVERGED-but-not-yet-approved spec;
if a Tier-2 re-land is desired post-approval, the trace can be re-cut with `--spec` + the approved tag.

---

## Evidence pointers

- `tests/unit/crossModelReviewer-clean-door.test.ts` (28 tests) — detection, model resolution, §5
  lockdown battery (a–e), required-crossFamily-field guard, per-family concrete-pin model-arg, config gate.
- `tests/unit/claude-reviewer-inbound-safety.test.ts` (7 tests, incl. live STATE) — hardened argv/env +
  zero-tool-execution against the real Claude CLI.
- `tests/unit/model-registry-freshness-reviewer-pin.test.ts` (3 tests) — non-vacuity of the reviewer pin.
- `tests/integration/clean-door-reviewer-driver.test.ts` (7 tests) — driver `--family`/`--detect-only` paths.
- `tests/unit/PostUpdateMigrator-anthropicReviewerDisclosure.test.ts` (4 tests) — SKILL.md content migration.
- `node scripts/lint-model-registry-freshness.mjs` → PASS (strict). `node cross-model-review.mjs --detect-only`
  → `[codex, gemini]` (fleet-absent config, dark).

---

## Class-Closure Declaration (display-only mirror)

This change closes ONE instance of a class (a per-provider clean-door reviewer). The generalization —
a structured `{ provider, door, signalKind }` reviewer descriptor replacing the `crossFamily` boolean —
is tracked as a deferral (spec §8.5) for when a future reviewer breaks the binary Claude/non-Claude
taxonomy or the one-door-per-framework assumption. The paid-Gemini-key door + the direct `claude -p`
bench are tracked deferrals (spec §8.1/§8.3), registered as an evolution action at merge.
