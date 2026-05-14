# Side-effects review — A47 PrimaryAggregatorLease + failover (Tier-3)

**Spec**: `docs/specs/SELF-HEALING-REMEDIATOR-V2-SPEC.md` (§A47, §A60, §A56, §A57 Tier-3, §A20, §A14)

**Scope**: Introduces `src/remediation/PrimaryAggregatorLease.ts` — the coordination scaffold that owns "which machine is the primary aggregator" for the Tier-3 cross-machine clustering work. Replaces the deferred "whoever owns lifeline" heuristic. Adds the lease file + HMAC + fencing token + tiebreak + failover-event surface that the follow-up `NovelFailureReviewer` PR will consume.

---

## 1. What changes about the running system

Nothing observable today. The class is a self-contained module that no production code instantiates yet. The lease file `.instar/remediation/primary-lease.json` is not created unless `tryAcquire()` is called. No event is emitted on a process where no caller subscribes. No background timer is started — the renew cadence is driven by the caller (the future NovelFailureReviewer integration), not by the lease itself.

The one structural addition on disk is the optional `audit-anomaly.jsonl` append-line — but only when the split-brain path actually trips, which requires two live primary-aggregator instances racing on the same `.instar/`. With zero consumers wired, this also never executes.

## 2. Over-block / under-block

**Over-block risk** — The split-brain fail-closed mode refuses both `tryAcquire` and `renew` after a single token mismatch. False positives could starve the primary role. Mitigations: (a) the mismatch check only fires when `lastIssuedFencingToken !== null` (so a fresh process restart that adopts an existing lease cannot trip itself), (b) the fail-closed state is local to the instance — another machine is free to claim — and (c) `resetSplitBrainTrip()` exists for operator-initiated recovery. No production caller exists yet, so today: zero over-block in the running system.

**Under-block risk** — The fencing token is per-lease random (not monotonic). A network partition where machine B writes a token, partition heals, machine A renews without observing B's write — A would see a token mismatch and trip correctly. The window where multi-write goes undetected is bounded by the read-write race on a single file; atomic write via `tmp + rename` minimizes it. A truly concurrent two-writer scenario (same machineId from two processes) on the same filesystem is the residual case; this is the exact case A47 is designed to detect via the fencing-token mismatch — and the test (`5. renew with stolen lease`) covers it.

**Forged-lease under-block** — HMAC verification uses the audit-v1 leaf key from `RemediationKeyVault`. An attacker with filesystem write but not keychain access cannot forge a valid lease. The reader treats forged files as absent (returns null), so a downgrade attack cannot trick a machine into believing a stale or hostile leader exists.

## 3. Level-of-abstraction fit

- Module lives in `src/remediation/` alongside its peers (`RemediationKeyVault`, `AuditWriter`, etc.). No cross-tree dep.
- Uses `crypto.randomBytes(16)` for the 128-bit fencing token (A60). No external entropy dependency.
- HMAC body construction (`canonicalBody`) is fixed-key-order JSON — explicit ordering as the contract, not engine-defined object-insertion order. This matches the canonical-envelope discipline in `RemediationContext` and `AuditWriter`.
- File write is `tmp + rename` (atomic), `0o600` mode. Matches the convention in `RemediationKeyVault.flatFileWrite` and `AuditWriter.persistAccepted`.
- Destructive operations in tests route through `SafeFsExecutor` per the destructive-tool-containment contract.
- Lease shape extends the `LeadershipState` shape from `src/core/CoordinationProtocol.ts` per §A56's "reuse over parallel coordination system" default. The `fencingToken` type changes from `number` (monotonic counter in `CoordinationProtocol`) to `string` (128-bit hex per A60) — this is deliberate per A60's "stale fencing tokens emit split-brain-detected" hardening. The two coordination paths are independent: `CoordinationProtocol` is for general work coordination, `PrimaryAggregatorLease` is for the specific aggregator role.

## 4. Signal-vs-authority compliance

- **The lease IS the authority** on "who is the primary aggregator" — it issues the verifiable fencing token. Followers consult it via `readCurrent()` / `verifyFencingToken()` and treat the answer as ground truth.
- The split-brain detection is a signal that the LOCAL instance emits to itself (via the trip flag) AND to the forensic surface (`audit-anomaly.jsonl`). The local instance does NOT attempt to remediate the split-brain by writing the lease — it fails-closed. The operator (with full context) decides whether to reset state or investigate.
- The `remediation.primary-aggregator.changed` event is a signal. Consumers (the future NovelFailureReviewer) decide what to do with the role-switch — the lease module does not call into clustering logic itself. This is signal-vs-authority compliant: lease emits, role-owner decides.

No new authority is migrated to a low-context filter.

## 5. Interactions with existing behavior

- **`CoordinationProtocol`** — Unchanged. Same `LeadershipState` field names, different type for `fencingToken`. The two systems serve different purposes (general work coordination vs aggregator-role lease) and do not share state. §A56's "decision deferred to F-4 PR-time with a default of reuse" — this PR opts for a parallel lease file because (a) A60's 128-bit fencing token type-incompatibility with the existing `number` shape would force a breaking change to `CoordinationProtocol`, (b) the lease semantics (HMAC + audit-anomaly) are remediation-scoped and don't fit the general-purpose coordination protocol, and (c) keeping them separate means a bug in one doesn't take down the other. The decision is documented in the module header.
- **`RemediationKeyVault`** — Used only through its public `deriveLeafKey('audit', null)`. No changes to the vault. The audit context's machine-wide shared leaf (A20) is the intended consumer; we don't introduce a new context.
- **`SafeFsExecutor`** — Test destructive ops route through it. Module's own writes use `fs.writeFileSync` + `fs.renameSync` which are non-destructive (file create, not rm).
- **`audit-anomaly.jsonl`** — This file is the documented forensic surface (§A14, §A27, §A12). We append-only to it. The 10MB / 90-day rotation rule from §A27 is owned by the rotation infrastructure (not built here) and applies to this writer the same way it applies to other anomaly emitters.
- **`NovelFailureReviewer`** — NOT modified. Wiring is the follow-up Tier-3 PR per the build directive.

## 6. Rollback cost

Pure additive. Reverting the PR:
- Drops `src/remediation/PrimaryAggregatorLease.ts` (~400 lines).
- Drops `tests/unit/PrimaryAggregatorLease.test.ts` (~340 lines, 14 tests).
- Drops the `upgrades/NEXT.md` entry.
- No data-format migration: no on-disk schema this PR ships is consumed by any other component yet.
- No live consumer wired anywhere in production — `.instar/remediation/primary-lease.json` would only exist if a test or operator manually ran `tryAcquire()`.

Rollback cost: low. The only forensic artifact is the lease file itself, which is `.gitignore`-clean (under `.instar/remediation/`).

## 7. Test plan

14 unit tests in `tests/unit/PrimaryAggregatorLease.test.ts`:

1. `tryAcquire` on empty state → first machine wins, lease persisted with fencingToken + 32-byte HMAC.
2. `tryAcquire` with valid existing lease from another machine → declined with `reason: 'held-by-other'`.
3. `tryAcquire` with expired lease → new claim succeeds (subject to tiebreak).
4. `renew` extends `leaseExpiresAt` without changing `fencingToken` or `acquiredAt`.
5. `renew` with stolen lease (different fencingToken under our machineId) → split-brain detected; appends to `audit-anomaly.jsonl`; subsequent `tryAcquire` refuses with `reason: 'split-brain'`.
6. `verifyFencingToken` passes for the current lease token.
7. `verifyFencingToken` fails for a stale / wrong-length token.
8. Lower `sha256(machineId)` wins tiebreak with two simultaneous claims (A47 deterministic tiebreak).
9. HMAC verification rejects forged lease files (treated as absent — recovery `tryAcquire` succeeds).
10. Deterministic failover on TTL expiration emits `remediation.primary-aggregator.changed`.
11. `readCurrent` returns null when the file is missing.
12. `readCurrent` returns null when the file is malformed JSON.
13. `getRenewIntervalMs` returns the configured cadence.
14. `resetSplitBrainTrip` clears the local trip flag.

All 14 pass. `npm run lint` (tsc --noEmit + lint-no-direct-destructive) passes.

## Second-pass review

Not required (this PR introduces no live dispatch logic; every change is opt-in and no production code path constructs `PrimaryAggregatorLease`).
