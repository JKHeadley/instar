# Side-Effects Review — F-6 ServerSupervisor handshake

**Version / slug:** `f6-supervisor-handshake`
**Date:** 2026-05-13
**Author:** echo (instar-developing agent)
**Second-pass reviewer:** not required

## Summary of the change

Extends `src/lifeline/ServerSupervisor.ts` with the Remediator ↔ Supervisor
handshake described in `docs/specs/SELF-HEALING-REMEDIATOR-V2-SPEC.md`
(§A15 partial-upgrade rule, carried forward from v1 §Supervisor
coordination) and `docs/specs/SELF-HEALING-REMEDIATOR-V3-CONSOLIDATED-SPEC.md`
(§3 state-file taxonomy: `supervisor-handshake.json`, HMAC-extended
`restart-requested.json`; §9 Tier-2 sequencing). Adds:

- `ServerSupervisor.HANDSHAKE_PROTOCOL_VERSION = 1` (static).
- `RestartRequestedPayload`, `RestartRequestedReply`, `RegisteredRemediator`
  public types.
- `ServerSupervisor.registerRemediator(remediator)` — writes
  `<stateDir>/state/supervisor-handshake.json` (`{version,
  supervisorBuildId, writtenAt}`).
- `ServerSupervisor.handleRestartRequested(payload)` — verifies HMAC,
  handshake-version, staleness (5-minute window), and blastRadius
  (`process | machine` only — `fleet` is refused for Tier-2). On accept,
  tracks the request and initiates a `performGracefulRestart` cycle.
- `notifyPendingRemediatorRequestsOnHealthy()` — fires
  `remediator.onRestartComplete({requestId})` once the next healthy tick
  lands after a serverRestarting → healthy transition.
- `canonicalRestartRequestedBody(payload)` exported helper —
  deterministic byte serialization used as HMAC input on both sides.

The existing `private preflightSelfHeal()` is unchanged; W-2 will wrap
it. The existing `restart-requested.json` flag path is unchanged (the
in-process handshake is the canonical F-6 surface; the file-based flag
remains for AutoUpdater and is co-owned per v3 §3).

Files touched: `src/lifeline/ServerSupervisor.ts`,
`tests/unit/ServerSupervisor-handshake.test.ts` (new, 9 tests),
`upgrades/NEXT.md`, this artifact.

## Decision-point inventory

- `handleRestartRequested` — **add** — verifies signed restart requests.
  This holds blocking authority: a rejection refuses to restart the
  server. Each rejection branch is a deterministic check on
  cryptographic state (HMAC, monotonic clock, declared protocol
  version, declared blast radius), NOT a heuristic message classifier.
  See section 4 for signal-vs-authority analysis.
- `registerRemediator` — **add** — idempotent registration; no
  authority. Side-effects writes `supervisor-handshake.json`.
- `notifyPendingRemediatorRequestsOnHealthy` — **add** — fires
  callbacks. Idempotent (entries deleted after first call). No
  authority.

---

## 1. Over-block

**What legitimate inputs does this change reject that it shouldn't?**

- `blastRadius: 'fleet'` is rejected. Tier-2's ServerSupervisor only
  handles `process` and `machine` restarts. A fleet-wide restart is the
  coordination-protocol surface's responsibility, not the supervisor's.
  Refusal is by design and matches v3 §9 Tier-3 deferral; Remediator
  must not issue fleet-scope restart-requested in Tier-2 anyway.
- Clock skew > 5 minutes (in either direction) rejects valid requests.
  This is the documented staleness window per the F-6 spec; widening it
  would weaken replay defense. Operators with persistent clock skew
  receive `stale: ageMs=…` in the reject reason; the Remediator
  surfaces this in audit + alerts via the higher-level dispatch path.
- Handshake version mismatch is exact-equality only. A future v2
  protocol must be negotiated by bumping `HANDSHAKE_PROTOCOL_VERSION`
  on both sides; legacy Remediators speaking v1 will be rejected. This
  is the A15 contract — partial-upgrade DoS is prevented by refusing,
  not by best-effort interpolation.

## 2. Under-block

**What failure modes does this still miss?**

- The `monotonicTs` field is informational; the HMAC covers it but the
  supervisor does NOT enforce monotonic ordering across requests. A
  per-Remediator monotonic counter would close the residual replay
  window inside the 5-minute staleness budget. F-8 (rest) owns the
  per-surface monotonic counter (A42); F-6 deliberately punts.
- The supervisor accepts only the registered Remediator's leaf key. If
  the Remediator's RemediationKeyVault is rotated mid-flight, an
  in-flight request signed with the old leaf will fail HMAC
  verification. This is expected — the overlap window is owned at the
  vault rotation layer (per F-1's `rotateContext` contract).
- `RegisteredRemediator.getCapabilityLeafKey()` is called per
  verification — the supervisor does not cache. This is intentional
  (lets the Remediator rotate without re-registration) but pushes a
  small constant cost onto each call. Negligible at expected throughput
  (≤ 1 restart-requested per process per ~24h per A7 cross-process cap).
- File-based `restart-requested.json` path is unchanged in this PR.
  Adding HMAC to the file shape is described in v3 §9 ("HMAC required on
  ANY plannedRestart:true post-F-6"); the in-process handshake is the
  Tier-2 canonical surface and file-shape HMAC migration tracks under
  the AutoUpdater path, not F-6 proper. NEXT.md documents the gap.

## 3. Level-of-abstraction fit

**Is this at the right layer?**

Yes. F-6 lives in `src/lifeline/ServerSupervisor.ts` because the
supervisor is the only authority that can request a tmux-session
restart safely. The handshake protocol surface is a thin layer on top
of the supervisor's existing `performGracefulRestart()`; it does NOT
re-implement restart logic, doesn't reach into runbook internals, and
doesn't speak any domain vocabulary above
`{requestId, runbookId, attemptId, blastRadius}`.

The `canonicalRestartRequestedBody()` exported helper deliberately
lives at the bottom of the same file so the wire format has one
canonical owner — both the supervisor's verify path and the
Remediator's sign path (in F-8 rest) call the same function. Cross-file
divergence is the most common HMAC-protocol bug; co-locating prevents
it.

## 4. Signal vs authority compliance

**Required reference:** [docs/signal-vs-authority.md](../../docs/signal-vs-authority.md)

**Does this change hold blocking authority with brittle logic?**

- [ ] No — this change produces a signal consumed by an existing smart gate.
- [ ] No — this change has no block/allow surface.
- [x] Yes — but the logic is a smart gate with full conversational context.
- [ ] Yes, with brittle logic — STOP.

`handleRestartRequested` is a blocking gate. Each rejection condition
is a deterministic check on cryptographic + structural state, not a
heuristic message classifier:

1. HMAC verification via `crypto.timingSafeEqual` — pure crypto.
2. Handshake-version equality — integer compare.
3. `requestedAt` staleness — wall-clock arithmetic on a signed field.
4. `blastRadius` allowlist — string-set membership on a signed field.
5. Required-field shape check — typeof guards.

Every gated field is HMAC-covered by `canonicalRestartRequestedBody()`,
so an attacker who shifts any field invalidates the signature. The
gate has the FULL context needed to decide — the canonical body IS the
context — and the decision is reproducible. This matches the
"signal-vs-authority" contract: the gate that holds blocking authority
has the full structured payload, not a free-text excerpt.

## 5. Interactions

**Does this interact with existing checks, recovery paths, or infrastructure?**

- **`performGracefulRestart`:** `handleRestartRequested` calls the
  existing method on accept. Maintenance wait is pre-set so existing
  `handleUnhealthy`/serverDown suppression behaves as it does for
  AutoUpdater-driven restarts.
- **`restart-requested.json` file path:** Untouched. Both the file path
  (AutoUpdater) and the in-process path (Remediator) trigger the same
  `performGracefulRestart`. The two paths are independent and cannot
  race destructively — `performGracefulRestart` is idempotent at the
  tmux-session level.
- **Pending-request notification:** Wired into the existing healthy-
  tick branch of the health check loop. Idempotent (clears the map
  after firing). If `onRestartComplete` throws, the supervisor logs and
  continues — a faulty Remediator callback cannot wedge the supervisor.
- **`debug-restart-request.json`:** Unrelated path; doctor-session
  HMAC uses a different secret (`setDoctorSessionSecret`) and a
  different file. No interaction.
- **State-file: `supervisor-handshake.json`:** Newly written by
  `registerRemediator` + `setSupervisorBuildId`. Per v3 §3 it is NOT
  backed up and NOT git-synced. The path matches v3 §3 verbatim.
- **`RemediationKeyVault` (F-1):** F-6 takes the leaf key from the
  registered Remediator via callback, NOT directly from the vault.
  This keeps the supervisor decoupled from F-1's API surface; the
  Remediator (which owns the vault lifecycle) injects the key. If F-1
  rotates the context, the next registration / next call sees the new
  key.

## 6. External surfaces

**Does this change anything visible to other agents, other users, other systems?**

- **State file:** `<stateDir>/state/supervisor-handshake.json` (new).
  JSON `{version, supervisorBuildId, writtenAt}`. World-readable by
  default (same as sibling files in the same dir). No secrets in the
  body.
- **Public types:** `RestartRequestedPayload`,
  `RestartRequestedReply`, `RegisteredRemediator`,
  `canonicalRestartRequestedBody()` exported from
  `src/lifeline/ServerSupervisor.ts`. These are stable API surfaces
  that F-8-rest will consume; bump `HANDSHAKE_PROTOCOL_VERSION` on any
  wire-format change.
- **Events:** No new EventEmitter events. The existing
  `serverRestarting` event still fires from `performGracefulRestart`.
  `onRestartComplete` is delivered via callback, not event, because it
  is a per-request notification with a `requestId` correlator (events
  fan out; callbacks correlate).
- **No telegram, slack, or external API calls** added.

## 7. Rollback cost

**If this turns out wrong in production, what's the back-out?**

`git revert` on the F-6 PR removes the surface. No data migration:

- `supervisor-handshake.json` is regenerated on next registration; if
  no consumer registers (post-revert state), the file is stale but inert.
- No keychain or vault state is touched. F-1 vault is untouched.
- No restart-requested.json or other state-file shape changes (file
  shape additions are deferred to a follow-up per §2 above).
- The F-6 surface is currently uncalled in production code (no
  Remediator instance calls `registerRemediator` on main yet). Revert
  is safe at any point before the wrapper-PR series ships.

The A15 7-day age rule is what bounds the rollback risk for downstream
wrappers: a wrapper that depends on F-6 must wait until F-6 has been
on main + auto-updated for 7 days before merging, so a revert window
of < 7 days has zero downstream consumers to break.

---

## Spec anchor

This change implements:
- **v2 §A15** (partial-upgrade window — supervisor handshake lag rule),
- **v2 carried-forward §Supervisor coordination** (HMAC-signed
  restart-requested),
- **v2 §A20** (key segregation — the supervisor verifies HMACs against
  the capability-context leaf, not the legacy `~/.instar/agent.key`),
- **v3 §3** (state-file taxonomy — `supervisor-handshake.json`,
  `restart-requested.json` co-ownership),
- **v3 §9** (Tier-2 sequencing — F-6 unblocks W-2..W-4 after the 7-day
  age requirement).
