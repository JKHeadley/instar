# Side-Effects Review — F-5: TrustElevationSource + AutonomyProfileLevel wiring

**Version / slug:** `f5-trust-elevation-source`
**Date:** `2026-05-13`
**Author:** `echo`
**Second-pass reviewer:** `not required`

## Summary of the change

Tier-2 foundation module from the Self-Healing Remediator v2 spec (per
`docs/specs/SELF-HEALING-REMEDIATOR-V2-SPEC.md` "Trust elevation policy"
section + amendments A11, A22, A25, A41, A53, A57, A59). Three new modules
under `src/remediation/`:

- `src/remediation/TrustElevationSource.ts` — authoritative gate for
  runbook lifecycle transitions. Implements the asymmetric trust-elevation
  table from the spec: pessimistic-quarantine always-allowed, collaborative
  trust minimum for upward transitions, 48h fresh-trace + 1-week history
  for registered→live, two-distinct-kind-channel rule for essential
  un-quarantine (A53), and source-only transitions for
  proposal→registered, live→deprecated, deprecated→removed.
- `src/remediation/channels/TelegramApprovalChannel.ts` — F-5 stub
  implementation of `TrustedApprovalChannel`. Exposes the shape the real
  Telegram-countersignature verification (A41) will plug into, with a
  deterministic seeded-map for test fixtures.
- `src/remediation/channels/CliApprovalChannel.ts` — F-5 stub
  implementation of `TrustedApprovalChannel` for the
  `instar doctor confirm-unquarantine` signed-CLI second-factor path
  (A53 option 1). Same seeded-map shape.

This PR ships the policy module ONLY. No surface (dispatcher F-8,
un-quarantine endpoint A25, dashboard toggle) wires into the source in
this PR. F-5 is consumed by F-8's runbook-lifecycle wiring and by the
Tier-2 `POST /remediation/unquarantine/:runbookId` endpoint in
subsequent PRs.

The change is foundational infrastructure: it adds capability surface, it
does not remove or replace any existing decision point.

## Decision-point inventory

- `TrustElevationSource.canTransition()` — **add** — gates whether a
  runbook lifecycle transition is permitted given (a) the current
  autonomy profile, (b) supplied dry-run context, (c) approvals collected
  via configured channels. Returns `{allowed, reason}`; never mutates
  registry state.
- `TrustElevationSource.requireSecondChannel()` — **add** — gates whether
  the configured channels are sufficient for an essential-runbook
  un-quarantine (A53's "real second factor" rule, distinct-kind).
- `TelegramApprovalChannel.verifyApproval()` — **add** — stub: returns
  approval for seeded entries only. Real Telegram countersignature
  verification (A41) is a Tier-2 follow-up.
- `CliApprovalChannel.verifyApproval()` — **add** — stub: returns
  confirmation for seeded entries only. Real `instar doctor
  confirm-unquarantine` signed-CLI integration is a Tier-2 follow-up.

All decision points operate on caller-supplied policy inputs
(autonomy profile, dry-run trace age + history span, essential bit,
channel approvals). They do not contain content classification,
heuristics, or "guess intent from text" logic.

---

## 1. Over-block

**What legitimate inputs does this change reject that it shouldn't?**

- `canTransition('proposal-to-registered', ...)` ALWAYS refuses. By
  design — the spec deliberately offers no programmatic path. A human
  must run a `/instar-dev` commit + spec-converge approval. The source
  cannot become a backdoor.
- `canTransition('live-to-deprecated' | 'deprecated-to-removed', ...)`
  ALWAYS refuses. Same reason: source change only.
- `registered-to-live` refuses without `dryRunTraceAge` /
  `dryRunHistoryDays`. The dispatcher is expected to supply both from
  the audit projection (F-4); a caller that omits them is a programmer
  error. Refusing with an explicit `missing-...` reason is preferable to
  silently approving.
- Below-`collaborative` profile refuses ALL upward transitions even
  when channels approve. Spec-mandated. The profile is the user-set
  policy on how much authority the agent gets; it sits ABOVE channel
  approvals. A user explicitly setting `cautious` SHOULD see the
  agent refuse to un-quarantine even if approval comes through.

---

## 2. Under-block

**What failure modes does this still miss?**

- **Stub channels are not real.** F-5 ships the abstraction with
  deterministic seeded-map verification. The real verification (A41
  Telegram-countersignature with proposalId-binding + user_id principal +
  message-id watermark; A53 CLI signing key) lives in the channel
  implementations that ship later. A misconfigured agent that wires a
  stub into production would silently approve nothing; the dispatcher
  surfaces this as `no-matching-...-countersignature` audit-logged refusal.
- **Channel-kind collision.** The A53 "different-kind" rule keys on the
  channel's `kind` string. Two implementations using the same `kind`
  (e.g., two different Telegram bots) would falsely satisfy the
  two-channel rule if the source counted instances. The implementation
  counts distinct `kind` strings, so this is closed at the source. But
  a channel-implementer that picks a clashing `kind` would create a
  silent collapse — channel-implementer review is the mitigation.
- **Replay across transitions.** F-5 forwards the channel's `messageId`
  unchanged. The channel implementation MUST enforce the A41 watermark
  `(proposalId, messageId)` tuple; F-5 does not duplicate that check.
  This is the right layer — the source decides "did enough channels
  approve" given verified results; the channel decides "is this
  approval real and non-replayed."
- **Race between concurrent un-quarantine attempts.** F-5 evaluates
  channel approvals in `Promise.all`. Two concurrent dispatcher calls
  for the same runbook would each issue a separate `verifyApproval`. The
  channel implementation's watermark catches replay; the dispatcher's
  per-runbook lock (F-4 `MachineLock`) prevents two un-quarantines from
  taking effect. F-5 trusts those upstream gates.
- **Trust-profile race.** If `AutonomyProfileManager.setProfile()` flips
  during a `canTransition` call, the source captured `profile` in the
  constructor. The dispatcher is expected to construct a fresh
  `TrustElevationSource` per dispatch (or re-read profile from the
  manager). F-5 does not subscribe to profile changes.

---

## 3. Level-of-abstraction fit

**Is this at the right layer?**

Yes. F-5 is a **policy** module:

- It decides "is this transition permitted right now given my
  inputs"; it does not mutate state, dispatch runbooks, write
  registry, or talk to the network.
- The dispatcher (F-8) and the un-quarantine endpoint (A25) are the
  enforcement points: they call `canTransition`, get a verdict, and
  either proceed or audit-log + refuse.
- The channels are **mechanism**: they verify cryptographic /
  protocol-specific approval proofs and return a boolean.

Three-layer split (mechanism → policy → enforcement) is the spec-
mandated layering. F-5 sits in the middle layer alone — channels and
enforcement live elsewhere.

The `AutonomyProfileLevel` type is re-exported from
`src/core/types.ts` (canonical owner). F-5 does not duplicate or
redefine the type; it imports the same enum the rest of the codebase
uses via `AutonomyProfileManager`.

---

## 4. Signal vs authority compliance

**Required reference:** [docs/signal-vs-authority.md](../../docs/signal-vs-authority.md)

**Does this change hold blocking authority with brittle logic?**

- [x] Yes — but the logic is a smart gate operating on cryptographic /
  policy primitives.
- [ ] ⚠️ Yes, with brittle logic — STOP.

The "blocks" in this change are:

1. Profile-level comparison against a numeric ordering (`cautious=0,
   supervised=1, collaborative=2, autonomous=3`). Deterministic.
2. Trace-age numeric comparison against `FRESH_TRACE_MAX_AGE_MS`.
   Deterministic.
3. History-span numeric comparison against `MIN_DRY_RUN_HISTORY_DAYS`.
   Deterministic.
4. Channel-approval boolean count + distinct-kind set size.
   Deterministic, sourced from channel verifications.
5. Transition enum exhaustive switch. Deterministic.

None of these are "string match on free-text"-class brittle filters.
The signal-vs-authority anti-pattern is heuristic detectors holding
blocking power; F-5's gates are policy primitives operating on
authoritative inputs. The smart gate (the dispatcher / un-quarantine
endpoint) is the consumer that decides *whether to attempt* a
transition; F-5 only encodes the trust-elevation table.

The CHANNEL implementations are where signal-vs-authority matters most.
F-5's stubs are deterministic seeded-map lookups; the real Telegram /
CLI channels MUST enforce cryptographic verification (HMAC, signature,
watermark) — not string match on user reply text. The
`TrustedApprovalChannel` interface returns a `principalUserId` so the
A41 user_id-principal binding is preserved end-to-end.

---

## 5. Interactions

**Does this interact with existing checks, recovery paths, or
infrastructure?**

- **Shadowing:** `src/core/TrustElevationTracker.ts` exists already.
  Despite the similar name, that module tracks dashboard-driven trust
  elevation events at the autonomy-profile layer. F-5 is the
  remediator-specific runbook-lifecycle policy module. They share the
  `AutonomyProfileLevel` type but no decision-point overlap; the
  tracker is the SOURCE of the profile that F-5 READS.
- **Race with adjacent cleanup:** None. F-5 has no on-disk state, no
  background timers, no event listeners. Its only mutable state is the
  channel list captured at construction.
- **Double-fire:** `canTransition` is pure with respect to F-5 state
  (no caching, no memo). Channels are responsible for their own
  idempotency / replay defence. The dispatcher's `MachineLock`
  serialises actual state mutations.
- **Interaction with AutonomyProfileManager.** F-5 captures the
  profile at construction. The dispatcher SHOULD construct a fresh
  `TrustElevationSource` per dispatch (or re-derive). This is
  documented in the module header.

---

## 6. External surfaces

**Does this change anything visible to other agents, other users,
other systems?**

- No on-disk state. F-5 is in-memory only.
- No HTTP routes. The A25 `POST /remediation/unquarantine/:runbookId`
  endpoint that consumes F-5 ships in a follow-up PR.
- No Telegram surfaces. The Telegram channel implementation is a stub;
  the real Telegram-countersignature wiring ships in a follow-up.
- No dashboard tabs.
- New public types: `RunbookTransition`, `TrustedApprovalChannel`,
  `TrustedApprovalVerifyInput`, `TrustedApprovalVerifyResult`,
  `CanTransitionContext`, `CanTransitionResult`,
  `TrustElevationSourceOpts`. All under `src/remediation/`.
- New configuration surface: `remediation.approvalChannel.primary`
  (per A59) is NOT yet read by F-5; the channel array is supplied
  explicitly by the constructing caller. Config wiring lives at the
  point of dispatcher construction, in a follow-up PR.

---

## 7. Rollback cost

**If this turns out wrong in production, what's the back-out?**

Trivially low. No consumers of these modules ship in this PR — the
exported symbols are new and not yet imported anywhere in `src/`. A
`git revert` removes them with zero state-migration cost. No on-disk
files are created.

If a future consumer-PR exposes a bug in the policy logic, the back-out
path is "revert the consumer PR" — F-5 in isolation has no runtime
effect.

---

## Reviewer concurrence (Phase 5)

Not required. This change touches no block/allow surface for messaging,
no session lifecycle, no coherence/sentinel/gate authority. It is
foundational policy infrastructure with no live consumers in this PR.
The dispatcher (F-8 Tier-2) and the un-quarantine endpoint (A25
follow-up) are the enforcement points; their PRs will require their own
side-effects reviews when wiring lands.
