# Side-effects review — Parity Sentinel mirror-trust wiring + PostUpdateMigrator backfill

Per L6 (Side-effects review gate). Seven dimensions.

## 1. Over-block / under-block

**Before this change.** UNDER-blocked: the sentinel's documented "mirror-trust" policy was a no-op. Any rule with that policy was effectively gated only by the global `remediationEnabled` flag, so an agent in approve-always or blocked trust state would still see the sentinel auto-remediate. The label said one thing, the code did another.

**After this change.** OVER-block risk: if AdaptiveTrust's DEFAULT_TRUST['modify'] = 'approve-always' were left to handle parity-sentinel for existing agents, every deployed agent would silently lose remediation on update. The PostUpdateMigrator seed at level 'log' is the mitigation — explicitly preserves the v0.1 remediate-by-default behavior while routing through trust.

Net trade is correct: behavior is now consistent with the documented policy, and the seed preserves continuity for deployed agents. Operators have a single trust-system surface to manage all auto-mutation policies (gmail, calendar, parity-sentinel, etc.) instead of a sentinel-specific flag.

## 2. Level-of-abstraction fit

The wiring lives in `shouldRemediate()` (private method on FrameworkParitySentinel), exactly where the policy was already being consulted. The migration lives in PostUpdateMigrator as a sibling step to `migrateProviderPortability` and `migrateFleetWatchdog` — same pattern, same idempotency guards.

The `adaptiveTrust` field is optional on the sentinel config. Production wiring (when the sentinel is added to server.ts boot) will pass an AdaptiveTrust instance; tests can omit it. This keeps the sentinel testable without forcing every caller to construct an AdaptiveTrust.

NOT done at the wrong level: not changing AdaptiveTrust.DEFAULT_TRUST globally (would affect every other service); not adding a sentinel-specific "trustEnabled" flag (would be a per-rule docs request, not structural); not making mirror-trust the universal default (each rule's existing policy stays as-is).

## 3. Signal vs Authority compliance

Textbook signal-vs-authority restoration (per B11). Before: the `'mirror-trust'` enum was the authority — present or absent decided remediation, but it was a label without semantic content. After: the enum is the signal ("this rule wants to be trust-gated"), AdaptiveTrust is the authority ("here's the trust level, decide accordingly"). The brittle low-context detector (rule policy declaration) emits; the higher-context system (AdaptiveTrust with its history, floor, and audit channel) decides.

`alwaysOverwrite` rules (like hookParityRule per Migration Parity §4) correctly skip the trust gate — they're governed by a different higher-context policy (§4) that says "always overwrite regardless of trust." Each layer expresses its applicable policy.

## 4. Interactions with adjacent systems

**AdaptiveTrust** — sentinel calls `getTrustLevel('parity-sentinel', 'modify')` + `trustToAutonomy(level)`. No mutation, read-only. AdaptiveTrust's own elevation/recovery streak logic continues independently — successful remediations build the success counter, incidents drop the level. No new state contract.

**PostUpdateMigrator orchestration** — the new step is registered in the `migrate()` ordered call list after `migrateFleetWatchdog`. Sibling pattern. No ordering dependency on earlier migrations except `migrateConfig` which sets up `_instar_migrations` (already a precondition for all sibling steps).

**trust-profile.json file format** — additive only. Existing services in `services{}` are preserved verbatim. The new parity-sentinel entry slots in alongside (e.g., next to `gmail`, `calendar`). No schema change.

**Existing sentinel tests** — the 12 existing tests don't pass `adaptiveTrust` and continue to exercise the backward-compatible fall-through path. 5 new tests cover the four trust-level transitions (autonomous, log, approve-always, blocked) plus a explicit backward-compat test asserting that without AdaptiveTrust the sentinel still remediates per v0.1.

**Hook always-overwrite rule (#259 amendment)** — unaffected. `alwaysOverwrite=true` rules skip the trust gate before it's consulted. Hooks continue to remediate unconditionally for built-in canonical hooks; user-edit-conflict goes through the audit event path.

**`/instar-dev` pre-commit gate** — unchanged. The gate checks spec frontmatter tags, not sentinel internals.

## 5. Rollback cost

Low. Three files: one sentinel field + 4-line gate addition, one PostUpdateMigrator method, two test files. Revert is `git revert`. The seed trust entry in trust-profile.json on deployed agents would remain after a revert (orphaned but harmless — AdaptiveTrust ignores unknown service entries except via getTrustLevel which returns the entry verbatim). A subsequent migration could clean it up if desired; not required for correctness.

## 6. Backwards compatibility / drift surface

Backwards-compatible:

- Any caller constructing the sentinel without an AdaptiveTrust instance gets the v0.1 binary behavior (remediationEnabled gate only).
- Any rule with `alwaysOverwrite: true` skips the trust gate entirely (per Migration Parity §4 carve-out).
- Existing trust-profile.json files keep all their existing service entries; the parity-sentinel entry is purely additive.
- The migration is idempotent and preserves operator-set entries.

**Drift surface.** The migration uses a content-sniff to preserve operator-set entries, but if an operator manually downgraded parity-sentinel to `'approve-always'` then deleted the trust-profile.json by accident, the next migration would re-seed at `'log'` (since the marker says "already migrated" but the file no longer exists, the migration is a no-op — operator must manually re-add their entry). Documented behavior.

**No documentation drift.** The documented mirror-trust policy now matches the code; CLAUDE.md Standards reference is satisfied.

## 7. Authorization / Trust posture

No new authority claims. The sentinel was already authorized to write to `.claude/hooks/`, `.claude/skills/`, etc. The trust gate **adds a layer of consent** — operators can downgrade parity-sentinel to flag-only without flipping the global `remediationEnabled` switch.

Trust-floor mirroring is preserved: AdaptiveTrust's MAX_AUTO_LEVEL = 'log' means the sentinel can never auto-elevate to 'autonomous' on its own. Only user-explicit grants reach that level. The seed at 'log' is the operationally correct starting point — full remediation with audit trail, but auto-elevation only to other 'log' or below states.

## Outcome

Ship.

The seven-dimension walk surfaced no blockers. The amendment makes the documented policy honest, restores trust-system consistency, and preserves v0.1 behavior for existing agents via the PostUpdateMigrator seed. Trust auditing now records every parity remediation event for operator visibility.
