# Side-Effects Review — Scheduled credential identity audit (B3c)

**Version / slug:** `credential-identity-audit`
**Date:** `2026-06-16`
**Author:** `Echo (instar-dev agent)`
**Second-pass reviewer:** `subagent (Phase 5 — credential subsystem is high-risk-adjacent)`

## Summary of the change

Implements the "always-on scheduled identity audit" the live-credential-repointing spec already
specified (§2.4 / §0.c / §6) but never built. `CredentialLocationLedger.auditIdentities()` is a
NON-DESTRUCTIVE periodic re-verification: it re-probes each EXISTING tracked slot via the identity
oracle and refreshes ONLY that slot's verification/quarantine state (it wipes nothing — distinct from
`seedFromOracle`, which rebuilds). It is wired in `server.ts` as a boot one-shot (~90 s after start,
after the seed) plus a periodic interval (`auditCadenceMs/2`, capped 30 min, floored 1 min), gated by
the pure `shouldRunIdentityAudit(enabled, seeded, unknownMode, inFlight)` predicate and the SAME
dev-gate as the rebalancer. The last pass is surfaced read-only on `GET /credentials/rebalancer` as
`identityAudit`. Files: `src/core/CredentialLocationLedger.ts`, `src/commands/server.ts`,
`src/server/routes.ts`, `docs/specs/live-credential-repointing-rebalancer.md` (§2.4.1), + 4 test files.

**Why it matters:** the credential rebalancer's every objective (wall-rescue AND the use-it-or-lose-it
drain) only acts on a DESTINATION slot that passed `targetVerifiedRecent` = verified within
`auditCadenceMs` (default 6h). Nothing re-stamped `lastVerifiedAt` after the boot seed (`markVerified`
had zero callers; the periodic `rebalancer.tick()` never re-verified), so ~6h after seed every slot
decayed to "not recently verified" and the optimizer went permanently inert (`decisions: []`,
`noActuationReason: "… missing eligible target"`) even with an idle soon-resetting account begging to
be drained. This is the robustness fix that makes the existing optimizer able to act.

## Decision-point inventory

- `CredentialLocationLedger.auditIdentities()` — **add** — per-slot: refresh verified-recent on a
  re-confirmed healthy slot; recover (un-quarantine) a now-resolvable slot; quarantine a confirmed
  divergence / unverifiable email; HOLD a healthy slot on a transient oracle failure.
- `shouldRunIdentityAudit(enabled, seeded, unknownMode, inFlight)` — **add** — pure gate deciding
  whether a scheduled pass runs.
- `GET /credentials/rebalancer` response — **modify (pass-through, additive)** — adds a read-only
  `identityAudit` field (last-pass counts; null until first pass). No behavior change to existing fields.

---

## 1. Over-block

No outbound/inbound message or dispatch block surface. The nearest "block-like" action is quarantining
a slot (excluding it from balancing). Over-quarantine risk: a healthy slot quarantined when it
shouldn't be. The safe direction explicitly prevents the dangerous over-block: a transient oracle
failure/throw → **HOLD** (the slot is left exactly as-is, never quarantined). A slot is only
quarantined on a CONFIRMED `email` (the oracle contract §2.11: `email` set === identity-confirmed, it
never guesses a mismatch) that belongs to a different account / no account / an ambiguous account — a
genuine login divergence, the same condition `seedFromOracle` already quarantines on.

## 2. Under-block

The audit will NOT catch a divergence during the window between two passes (≤ `auditCadenceMs/2`,
≤30 min) — a login that changes and changes back within one interval is missed, as is any divergence
in the seconds before a rebalancer pass reads the slot. This is acceptable: the §2.3.6 delayed
re-verify still covers in-flight-swap divergence, and the audit narrows (not closes) the long-tail
client-write-back window exactly as §6 already states. It also does not re-probe a pool `configHome`
that was never seeded into the ledger (a brand-new enrollment) — that is `seedFromOracle`'s job at boot;
the audit is scoped to existing tracked slots by design.

## 3. Level-of-abstraction fit

Right layer. The audit lives ON the ledger (`CredentialLocationLedger`) — the single write funnel that
already owns the oracle, the pool view, and every verification/quarantine mutator (`markVerified`,
`quarantineSlot`, `unquarantineSlot`, `recordAssignment`). It REUSES those primitives rather than
re-implementing identity resolution, and mirrors `seedFromOracle`'s probe/classify logic on a
per-slot, non-destructive basis. The scheduling is a thin `setInterval` in `server.ts` (the same
pattern as the existing rebalancer tick), and the run/skip decision is extracted to a pure predicate
(`shouldRunIdentityAudit`) exactly like the existing `shouldBootSeedCredentialLedger`.

## 4. Signal vs authority compliance

**Required reference:** [docs/signal-vs-authority.md](../../docs/signal-vs-authority.md)

- [x] No — this change produces a SIGNAL (refreshed ledger verification state) consumed by the
  existing rebalancer; it has no outbound/dispatch block authority.

The audit moves ZERO credentials and NEVER triggers a swap — the executor (gated by dry-run) remains
the only write path for credential material. The one authority-shaped action, quarantining a slot, is
a DETECTIVE, reversible exclusion that follows the spec's already-converged quarantine-never-repair
rule, fires only on the oracle's non-brittle CONFIRMED-email contract, and is biased to the safe
direction (transient failure → HOLD, never quarantine). It adds no brittle blocking logic.

## 5. Interactions

- **Shadowing:** none. The audit refreshes state the rebalancer reads on its NEXT tick; it runs on its
  own timer (different cadence) and does not pre-empt or wrap the rebalancer tick.
- **Double-fire:** the periodic timer + the boot one-shot can never overlap — both go through the
  single `credAuditInFlight` reentrancy guard (and the pure predicate gates on it). A slow oracle pass
  cannot stack a successor.
- **Seed↔audit interleave (hardened after second-pass):** on a FRESH never-seeded agent the boot
  `seedFromOracle()` is fire-and-forget at t=0 and the boot audit fires at t≈90 s; `isSeeded()` does
  NOT protect this (seed bumps version at 'begin', flipping `isSeeded()` true mid-seed). Closed
  structurally with a `credSeedInFlight` flag (set around the boot seed, cleared in its `.finally`)
  that `runCredentialIdentityAudit` checks before running — so the audit cannot interleave with an
  in-flight boot seed, rather than relying on the 90 s timing assumption.
- **Races:** the audit and the rebalancer both touch the ledger, but the ledger is a single-writer
  in-process store (version-bumped, `save()` after each mutation); they run on the same Node event
  loop (no true concurrency), and the audit only writes verification/quarantine fields the rebalancer
  reads, never the cooldown/hysteresis state the rebalancer owns. The `seedFromOracle` boot path and
  the audit are sequenced (the boot audit is delayed 90 s and the predicate skips while unseeded).
- **Feedback loops:** none. The audit's output (fresh verification) feeds the rebalancer, but the
  rebalancer does not feed back into the oracle's identity answers.

## 6. External surfaces

- **Identity oracle (Anthropic OAuth profile endpoint):** the audit issues per-slot oracle probes on
  its cadence — the same probe `seedFromOracle` already makes, now also on a ≤30 min schedule. Bounded
  (≤ slot count per pass; reentrancy-guarded; dark-fleet no-op so single-account/plain installs never
  probe). No new external system, no new credential surface — the oracle dependency already exists.
- **`GET /credentials/rebalancer`:** adds a read-only `identityAudit` field (counts only — never any
  token material; the route's existing scrub chokepoint is unchanged). Additive; existing fields
  untouched.
- **Persistent state:** writes the SAME ledger file (`credential-locations.json`) the seed/swap paths
  already write (verification timestamps + quarantine flags + journal entries). No new file, no schema
  change to the assignment shape.
- **No operator-facing actions** added — the audit is autonomous background housekeeping; the only
  surface is the read-only status field. Not applicable to Mobile-Complete.

## 6b. Operator-surface quality

No operator surface — not applicable. This change touches no `dashboard/*` renderer, approval page, or
grant/revoke/secret form; the only surface is a read-only JSON field on an existing API route.

## 7. Multi-machine posture (Cross-Machine Coherence)

**machine-local BY DESIGN.** A credential's login physically lives in a config-home on ONE machine's
disk/keychain; the `CredentialLocationLedger` is inherently per-machine (it maps THIS machine's slots
to accounts), as is the rebalancer it feeds. The identity audit re-verifies THIS machine's slots — it
must differ per machine because the credential blobs differ per machine. It emits NO user-facing
notices (one-voice gating not needed — background housekeeping, counts only in a status field), holds
no topic-bound durable state (so nothing strands on topic transfer), and generates no URLs. The
cross-machine credential story (sharing logins across machines) is the separate, in-flight
`cross-machine-account-sharing` workstream (instar-exo) and is explicitly out of this change's scope;
confirmed zero source-file overlap with that branch.

## 8. Rollback cost

Pure code change — revert the commit, ship as the next patch. No data migration: the audit writes only
the existing ledger fields (`lastVerifiedAt`, `quarantined`, journal) that seed/swap already write, so
a rollback leaves the ledger in a valid state (just no longer auto-refreshed). No agent-state repair,
no user-visible regression during the rollback window (the feature is dev-gated and dark on the fleet;
on a dev agent a rollback simply returns to the prior inert-after-6h behavior). The new `identityAudit`
status field disappearing is inert (read-only, additive).

## Conclusion

The review produced no design changes — the implementation already follows the safe-direction and
single-write-funnel patterns the converged spec established. The change closes a specified-but-unbuilt
gap (the scheduled identity audit) that was the root cause of the optimizer never acting; it adds a
signal-refresher with no brittle blocking authority, reuses existing ledger primitives, is
reentrancy-guarded and dark-gated, and is covered across all three test tiers plus a pure wiring
predicate. Clear to ship pending Phase 5 second-pass concurrence.

## Second-pass review (if required)

**Reviewer:** subagent (credential-subsystem reviewer)
**Independent read of the artifact: CONCUR**

The reviewer independently traced the code and confirmed: the safe direction is correct (an
`unavailable`/throwing oracle lands `unavailable-held` via `continue`, never reaching `quarantineSlot`;
a confirmed-different email correctly `diverged-quarantined`; a recovered slot correctly
un-quarantines); signal-vs-authority compliant (zero credential moves; quarantine fires only on the
oracle's non-brittle CONFIRMED-`email` contract); iteration safety correct (slot names snapshotted
up-front, `existing` re-fetched per iteration, `continue` on mid-pass disappearance — no
mutate-while-iterating bug); no token leak (status routes through the scrub chokepoint; carries
non-secret email/accountId identifiers only); all three test tiers genuinely cover both sides of every
boundary (no hollow assertions). One LOW finding raised and RESOLVED in this artifact: the fresh-agent
seed↔audit interleave now has an explicit `credSeedInFlight` guard (see §5) rather than relying on the
90 s timing assumption. Concur to ship.

## Evidence pointers

- `tests/unit/credential-identity-audit.test.ts` — 10 tests, both sides of every branch (refresh,
  recover, divergence-quarantine, transient-held, ambiguous/unknown quarantine, still-quarantined,
  UNKNOWN-mode no-op, aggregate report).
- `tests/unit/credential-ledger-boot-seed-guard.test.ts` — `shouldRunIdentityAudit` predicate, all 5
  boundary combinations.
- `tests/integration/credential-routes.test.ts` — route surfaces a real audit pass live (wiring
  integrity + safe-direction end-to-end).
- `tests/e2e/credential-repointing-routes-alive.test.ts` — `identityAudit` alive on the
  production-shaped bundle.
- Broader sweep: 88 green across the credential subsystem; `tsc --noEmit` clean.
