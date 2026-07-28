# Side-Effects Review — WS5.2 Account Follow-Me, PR4 (R12 revocation data-plane)

**Version / slug:** `ws52-account-follow-me-revocation`
**Date:** `2026-06-17`
**Author:** Echo (autonomous)
**Second-pass reviewer:** pending (high-risk: credentials, revocation honesty, cross-machine offline state)
**Spec:** `docs/specs/ws52-account-follow-me-security.md` — R12 (revocation), R9/S7/S8 (mechanism gating, departed-holder), R4b (de-pair key-rotation context)
**Status:** logic built + unit-tested (15 tests; tsc clean). This PR ships the PURE data-plane executor + honest-state surface; the server-shell wiring (consume the control-plane revoke signal, run the cooperative wipe with real deps, schedule `sweepDeadlines`, dashboard `revocation-pending`/`revocation-failed` render) is a follow-up wiring increment.

## Summary of the change

PR4 builds the R12 revocation DATA plane for Mechanism B (the default). "Stop following to machine X" is two halves: a PIN-gated control-plane mandate revoke (MandateGate — out of scope, the agent cannot revoke) PLUS a real data-plane effect. This module CONSUMES the already-fired control-plane revoke and computes the HONEST data-plane outcome over three branches: (i) cooperative-online target → local & total wipe (logout + slot delete + `SubscriptionPool.remove`) → `removed`; (ii) de-paired/hostile/`MachineStatus==='revoked'` holder → no remote wipe is possible, surface a phone-first provider-side de-authorization instruction → `provider-rotation-required`, NEVER a false "removed"; (iii) offline still-paired target → durable pending wipe fired on reconnect, bounded by an operator-tunable reconnect-deadline that ESCALATES to a LOUD `revocation-FAILED — rotate at provider NOW` aggregated HIGH attention item after expiry → `revocation-pending` then `revocation-failed`. Mechanism A (dark/refused-for-Anthropic) is handled minimally per R9: any A revoke flags `providerRotationRequired: true` unconditionally (a delivered credential cannot be un-delivered).

Files added (logic only, no I/O, dark behind `multiMachine.accountFollowMe`):
- `src/core/AccountFollowMeRevocation.ts` — the executor + honest-state surface (pure, injectable, fail-closed).
- `tests/unit/account-followme-revocation.test.ts` — 15 unit tests, both sides of every boundary.

## Decision-point inventory

- `AccountFollowMeRevocation.revoke(req, posture)` — **add** — selects the R12 branch from the caller-computed target posture and returns the honest data-plane outcome; deny-by-default for the optimistic `removed` claim.
- `AccountFollowMeRevocation.onTargetReconnect(...)` — **add** — fires a durable pending wipe when an offline target returns (R12.iii).
- `AccountFollowMeRevocation.sweepDeadlines()` — **add** — give-up discipline: escalates past-deadline pending wipes to a LOUD aggregated attention item (R12.iii).
- `AccountFollowMeRevocation.pendingStateFor(...)` — **add** — read-only honest dashboard state (`revocation-pending` / `revocation-failed` / null).

---

## 1. Over-block

Not a block/allow gate — it is a revocation executor. The closest "over-block" surface is the cooperative-wipe fail-closed path: a PARTIAL or THROWING wipe is reported as `revocation-pending` (not `removed`), which keeps a pending record alive and could surface a `revocation-failed` escalation for a wipe that ACTUALLY succeeded partially (e.g. logout succeeded, pool-remove threw transiently). That is the SAFE direction — the worst outcome is the operator is told to rotate at the provider when they technically didn't have to. We never claim `removed` we can't fully confirm; an over-escalation toward "rotate at provider" is intentional honesty, not a defect.

---

## 2. Under-block

The module cannot reach a hostile/de-paired holder — by design (S8: instar genuinely cannot force the logout). The honest end-state there is provider-side rotation; the module never PRETENDS otherwise, so the under-block (a live credential still out there) is SURFACED, not silently missed. The remaining real-world gap is operator inaction: if the operator never rotates at the provider after a `provider-rotation-required` / `revocation-failed` instruction, the credential stays live — but that is outside any code's reach and is exactly why the attention item is HIGH priority and aggregated-but-persistent.

---

## 3. Level-of-abstraction fit

Correct layer. This is a pure data-plane EXECUTOR + honest-state surface, mirroring PR1's `AccountFollowMeGrants` / PR2's `AccountFollowMeOrchestrator` / `AccountFollowMeService` injectable-deps style. It owns NO authority — the control-plane revoke authority stays with the existing PIN-gated MandateGate; this module consumes that decision and runs the side effects (each injected: `cooperativeWipe`, `pendingStore`, `emitRevocationFailed`). It does NOT re-implement `SubscriptionPool.remove` or framework logout — those are injected effects the server-shell wires to the real implementations. The give-up cadence reuses the resume-queue's deadline-escalation discipline conceptually (it does not depend on ResumeQueue code).

---

## 4. Signal vs authority compliance

**Required reference:** [docs/signal-vs-authority.md](../../docs/signal-vs-authority.md)

- [x] No — this change has no NEW block/allow authority. It is the data-plane executor of a decision the existing PIN-gated MandateGate already made; the only "gate" it honors is its own `enabled()` dark-flag (no-op when off).

The module never blocks a message or an operation. It computes a revocation OUTCOME and emits an honest-state signal (`revocation-pending` / `revocation-failed` / `provider-rotation-required`). The blocking authority (whether a revoke happens at all) is upstream and PIN-gated. Every uncertain path FAILS CLOSED toward "rotate at provider" — the safe, honest direction — never toward a false "removed".

---

## 5. Interactions

- **Shadowing:** none — there is no existing revocation data-plane to shadow. It runs AFTER the control-plane mandate revoke (upstream), consuming its result.
- **Double-fire:** the pending store is keyed on `${accountId}::${targetMachineId}`, so a re-revoke or a reconnect+sweep race cannot double-escalate the same pair — `sweepDeadlines` removes the record on escalation, and a successful `revoke`/`onTargetReconnect` removes it on `removed`. An idempotent upsert means re-running `revoke` for the same offline pair refreshes (not duplicates) the record.
- **Races:** the in-memory store is single-threaded per Node event loop; the production durable store must preserve the same upsert/remove semantics. A reconnect firing concurrently with a deadline sweep: whichever runs first wins — if the wipe lands first the record is removed and the sweep no-ops; if the sweep escalates first the reconnect's `onTargetReconnect` finds no record and no-ops (the operator already got the rotate-now item). Both orderings are honest.
- **Feedback loops:** none — `sweepDeadlines` only ever removes records and emits attention items; it never re-enqueues.

---

## 6. External surfaces

- **Other agents / mesh:** none directly — this module is local. The server-shell that wires it will consume the control-plane revoke (already mesh-delivered) and run the framework logout on the LOCAL target; this logic has no mesh egress.
- **Persistent state:** introduces a durable pending-wipe ledger (the `PendingWipeStore` seam; production: JSON/SQLite). Records are small (no credentials, no tokens — only account id, machine id, mandate id, provider name, operator email, nickname, two timestamps). PII note: operator `email` + machine nickname land at-rest in this ledger, same posture as the §6.1a meta projection (email is "never a secret"); no credential field exists in the record shape.
- **Operator surface (Mobile-Complete):** the operator-facing outputs are (a) the phone-first `ProviderRotationInstruction` message and (b) the HIGH `RevocationFailedAttention` item — both plain-English, both surfaceable via the existing attention-queue → Telegram topic path (no new operator UI primitive). The control-plane revoke itself is the existing PIN-gated Mandates-tab revoke (already phone-complete). No API-only operator action is introduced.
- **External systems:** the honest end-state explicitly POINTS the operator at the provider (Anthropic) to de-authorize/rotate — it does not call any provider API itself (correct: instar cannot rotate a Claude login on the operator's behalf).

---

## 6b. Operator-surface quality

No operator-surface markup file (`dashboard/*.js`, `*.html`, approval/grant/secret-drop form) is touched by THIS PR — it ships pure logic + tests. The dashboard `revocation-pending` / `revocation-failed` render is a follow-up wiring increment and will carry its own 6b review (leads with the honest state + the rotate-at-provider action; revoke control stays the demoted, PIN-gated Mandates control). Not applicable to this commit.

---

## 7. Multi-machine posture

**machine-local executor of a cross-machine effect, with proxied-on-read honest state.** This IS a multi-machine feature: it revokes an account on a DIFFERENT machine. Posture per surface:
- The cooperative wipe runs ON the target machine (the server-shell drives the framework logout against that machine's `CLAUDE_CONFIG_DIR` + its local `SubscriptionPool.remove`) — machine-local effect, triggered by the mesh-delivered control-plane revoke.
- The durable pending-wipe ledger is held on the REVOKING (operator-authority) machine and fires on the target's reconnect — durable state that must not strand. It is bounded (the deadline give-up) precisely so an offline-forever / terminated VM never leaves a silently-aging pending record.
- The honest dashboard state (`revocation-pending` / `revocation-failed`) is a read surface; pool-wide visibility is served via the existing `?scope=pool` merged reads (proxied-on-read), so the operator sees the true state from any machine.
- User-facing notices: the `RevocationFailedAttention` item is aggregated per (account,target) with a stable id (P17 — one running item, never a flood). One-voice gating is the existing attention-queue's job.

Single-machine / flag-off ⇒ strict no-op (`enabled()` returns false → `revoke` returns `feature-disabled`, `sweep`/`reconnect` no-op).

---

## 8. Rollback cost

Low. Pure code change behind `multiMachine.accountFollowMe` (dark on fleet). Revert the PR and ship a patch — no live credential is written or destroyed by THIS logic layer (the destructive effects are injected and only wired in the follow-up server-shell increment). The only persistent state is the pending-wipe ledger; on rollback an orphaned ledger is inert (nothing reads it once the module is gone) and can be deleted with no migration. No user-visible regression during the rollback window — the feature is dark.

---

## Conclusion

This review produced a pure, fail-closed revocation data-plane that mirrors the PR1/PR2 injectable style and is honest by construction: it never reports `removed` it cannot confirm, surfaces provider-side rotation as the ONLY complete answer for a departed/hostile holder, and bounds the offline pending state with a loud give-up. No authority is added — the PIN-gated MandateGate remains the only revoke authority. The build is clear to proceed to the server-shell wiring increment; the dashboard render of the honest states will carry its own 6b operator-surface review. Flagged for second-pass review given the credential/revocation-honesty risk class.

---

## Second-pass review (if required)

**Reviewer:** Independent reviewer subagent (2026-06-17) — **CONCUR**. Verified against R12 + the actual code (read in full), ran the tests (15/15) + `tsc --noEmit` (exit 0).

- **(a) Fail-closed / honesty** — `removed` is reachable from exactly ONE place: after `fullyWiped = loggedOut && slotDeleted && poolRemoved` AND `mechanism !== 'credential-transport'`. Every other path returns `revocation-pending` / `revocation-failed` / `provider-rotation-required`. A throw → pending; partial wipe → pending; offline → pending; de-paired → provider-rotation. The cardinal R12 sin (a false "removed everywhere") is structurally impossible; a test directly asserts the message never contains "removed" on the non-removed paths.
- **(b) Branch coverage** — ordered, exhaustive posture switch (dark no-op → `revoked` → `offline` → cooperative-online wipe); closed 3-member `TargetPosture` union; the module trusts (does not re-derive) the caller-supplied authoritative posture.
- **(c) Offline→pending→give-up** — bounded operator-tunable deadline; `sweepDeadlines()` emits one P17-deduped HIGH attention item then removes the record (no silent aging); `onTargetReconnect()` re-runs the real wipe and clears on success; `pendingStateFor()` honestly reports `revocation-failed` past deadline.
- **(d) Mechanism A** — `credential-transport` forces `providerRotationRequired:true` on every branch; even a clean A-wipe returns `provider-rotation-required`, never `removed` (a delivered credential is never claimed un-delivered).
- **(e) Signal vs authority** — pure deterministic planner over injected seams; does NOT revoke the mandate (that stays the PIN-gated MandateGate's control-plane authority); it is the data-plane executor + honest-state read surface, not a new blocking authority.
- **(f) Injected seams** — zero imports; `cooperativeWipe` / `pendingStore` / `emitRevocationFailed` / `enabled` / `reconnectDeadlineMs` all injected. No direct touch of SubscriptionPool/types/server. (Server-shell wiring is a tracked follow-on increment, mirroring PR1's primitive-layer pattern.)
- **(g)** Tests cover both sides of every decision boundary with realistic inputs.

No changes required to merge.

---

## Evidence pointers

- `tests/unit/account-followme-revocation.test.ts` — 15 tests, both sides of every boundary (cooperative vs hostile, online vs offline, pending vs escalated-failed, clean vs partial/throwing wipe, Mechanism B vs A, dark no-op). `npx vitest run` → 15 passed.
- `npx tsc --noEmit` → exit 0.
