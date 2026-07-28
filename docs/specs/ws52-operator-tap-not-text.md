---
title: WS5.2 Operator-Facing Completion + "Operators Act in Taps, Not Text" Standard
slug: ws52-operator-tap-not-text
eli16-overview: ws52-operator-tap-not-text.eli16.md
status: converged
approved: true
approved-by: justin (telegram uid 7812716706, "approved, please continue", 2026-06-18)
parent-principle: "Operator-Surface Quality"
author: echo
created: 2026-06-17
review-convergence: "2026-06-17T23:15:39.658Z"
review-iterations: 3
review-completed-at: "2026-06-17T23:15:39.658Z"
review-report: "docs/specs/reports/ws52-operator-tap-not-text-convergence.md"
cross-model-review: "codex-cli:gpt-5.5"
single-run-completable: true
frontloaded-decisions: 10
cheap-to-change-tags: 0
contested-then-cleared: 0
---

# WS5.2 Operator-Facing Completion + "Operators Act in Taps, Not Text" Standard

## Why this exists

WS5.2 Account Follow-Me shipped its plumbing and was declared "deployed and ready." When the operator (Justin) tried the live proof from his single dashboard, two failures surfaced *in front of him*:

1. **No guided operator surface.** Issuing an account-follow-me mandate required the Mandates tab's "Advanced — author by hand" form: pasting a raw JSON authorities blob + agent fingerprints. Operator feedback (2026-06-17, verbatim): *"You should not be allowed to ask a user to go through some complex step-by-step process that includes copying and pasting confusing text like JSON. This should be absolutely unconstitutional and it should be enforced."*

2. **No cross-machine enroll trigger.** `acceptDeliveredMandateCommand` only **stores** the delivered mandate; `AccountFollowMeService.onMandateDelivered()` has **no callers**; nothing polls the store; the scheduler does not lazy-trigger. The proof stalls silently after delivery.

Root cause: the feature was verified at "routes exist," never driven through the **real operator surface** — a direct violation of **Live-User-Channel Proof Before Done**.

This spec was hardened by a 5-reviewer convergence pass (security, adversarial, integration/multi-machine, decision-completeness, lessons/foundation). The convergence found that the naive design was materially broken on three axes (cross-machine surfacing, single-flight, revocation/expiry at point-of-use); those fixes are folded in below.

## Frontloaded Decisions (resolved — no mid-build stops)

- **FD1 — Mandate expiry.** Server-computed default **1 hour** (the mandate only needs to authorize one re-mint enrollment, not standing access). Computed server-side in `/mandate/issue-for-machine` when the body omits `expiresAt`; never a UI constant. The card shows it in plain English ("authorizes this one setup; expires in 1 hour").
- **FD2 — The `agents` pair.** Resolved **server-side at scan time** and carried on the consent offer (`FollowMeConsentRequest` gains `agents: [selfFp, targetFp]`, resolved from the mesh identity registry — self fingerprint + the target machine's agent fingerprint). The card POSTs the offer's opaque pair through verbatim; the operator never sees or types a fingerprint. (Closes the convergence's top build-blocker.)
- **FD3 — Card placement + scope.** The **Subscriptions tab**, rendering **pool-scope** offers (offers for ANY machine in the pool, per the one-dashboard rule), live from the scan route's existing peer fan-out. An offline depth-zero machine is silently absent (re-scan on dashboard refresh / peer reconnect), never an error.
- **FD4 — Surfacing is owned by the FRONTING machine, not the target.** The machine where the operator tapped Approve (and where the verified operator binding lives) owns the operator-facing loop end-to-end. The target enrolls and returns its login artifact to the fronting machine over the authenticated mesh; the fronting machine surfaces the tappable link to the operator's verified-bound topic. The target never tries to reach the operator directly (it has no bot token under the lease model and no authoritative operator binding — Know Your Principal). The originating `topicId` + operator uid travel as **mesh-authenticated delivery metadata** (NOT inside the signed mandate bounds).
- **FD5 — Enrollment is driven by a DURABLE consumer, not inline in the mesh handler.** A boot-sweep + tick consumer of the delivered-mandate store drives enrollment, so it survives restart, handles an offline-at-issue target (enrolls when it returns), and tolerates version skew. Driving a long device-code login synchronously inside the mesh-deliver handler is forbidden.
- **FD6 — Runtime hook (Part C arm 2) is a SIGNAL, not a standalone blocker.** Per `signal-vs-authority.md`: the detector emits a signal (`rawTextRequestToOperator`) into the existing outbound `checkOutboundMessage()` authority, which decides with full conversation context. It does NOT hold independent block authority (asking-for-JSON is not irreversible, so the safety-guard exception does not apply). Fail-open on its own error. High-precision imperative patterns only ("paste this", "copy the following JSON", "run this curl/command", "fill in your fingerprint"), directed at the operator, never a quoted/explanatory block.
- **FD7 — Build-time gate (Part C arm 1) UPGRADES §6b from prose-attestation to a mechanical content check** (the foundation fix). Allowlist is an explicit **in-file marker** (`/* operator-surface-power-user: <reason> */` / `data-power-user-surface`), co-located + reviewable, never a path allowlist; an allowlisted surface must be provably not the default path. The 2026-06-13 raw-JSON mandate-form is a **regression fixture**. The constant/fixture dodge is documented as out-of-scope (paired with code review), not pretended airtight.
- **FD8 — The standard is a named CLAUSE of the existing "Operator-Surface Quality" standard**, not a third near-duplicate registry entry.
- **FD9 — Two human-required taps, everything else agent-driven.** (1) PIN-approve on the card; (2) the OAuth login on the phone (only the human can complete a real account login — not bypassable). Agent-driven: scan, issue, deliver, enroll-drive, login-artifact relay, link-send, post-login verify, routed-message test. "Operator-equivalent" in the proof = a throwaway/dev account the author's principal can legitimately log into, never an OAuth bypass.
- **FD10 — Live-proof independence.** The volatile/failure/idempotency/rollback proof rows are driven (or independently spot-checked) by a **separate role** (a throwaway/peer agent + demo channels), not the author, per Live-User-Channel Proof. The operator's single real action remains the final login tap.

## Open questions

*(none)*

## Scope

### Part A — One-tap operator surface (no typing)

- Render each consent offer (`scanAndOffer`, pool-scope per FD3) as a **one-tap Approve card** in the Subscriptions tab: "Let *<machine nickname>* use your *<account label>* subscription — [Approve]" + a single PIN field + the plain-English expiry (FD1).
- On Approve → `POST /mandate/issue-for-machine` with `accountId`, `targetMachineId`, `agents` (FD2, from the offer), server-defaulted `expiresAt` (FD1), and the PIN. No JSON, fingerprints, IDs, scope strings, or Advanced section in the operator's path. The raw-author form stays for power users behind the FD7 marker, never the default path.
- **Idempotency:** a second Approve for the same (account, target) does NOT mint a second enrollment — `/mandate/issue-for-machine` reuses an existing live mandate for that pair (or the durable single-flight, Part B, collapses the downstream). The scan suppresses offers for pairs with a live mandate or in-flight enrollment, and the aggregated consent attention item is resolved/decremented as offers are approved.
- Acceptance: depth-zero machine + eligible account ⇒ tap-only Approve card; tap + PIN ⇒ mandate issued + delivered; zero raw text entered; double-tap ⇒ one enrollment.

### Part B — Cross-machine enroll connector (delivery → durable enrollment → tappable login, fronting-anchored)

- **Durable single-flight ledger** keyed `${accountId}::${targetMachineId}` (backed by `PendingLoginStore`-style durable state), a state machine `delivered → enroll-in-flight → login-issued → completed | failed`, with TTL + dead-holder auto-heal (PR-hand-lease pattern). It gates issuance, enrollment, reissue, AND scan re-offer. Survives restart.
- **Durable consumer on the target** (boot-sweep + tick, FD5): for each delivered mandate not yet consumed, **re-verify at point-of-use** — R4a signature **AND** `expiresAt` not past **AND** not revoked (live revocation state) **AND** bounds derived from the verified mandate (`readFollowMeBounds`), asserting any caller-supplied request equals them, fail-closed on any miss. Freshness-bounded: a mandate older than a short window requires a fresh Part A tap to re-arm; boot sweeps never re-enroll an already-consumed (`login-issued`/`completed`) entry.
- On a passing entry, transition single-flight to `enroll-in-flight` and drive the local re-mint (`EnrollmentWizard.start`) → `LoginArtifact` (`verificationUrl` + `userCode` + `ttlMs`; **never a token**). Transition to `login-issued`.
- **Return the login artifact to the fronting machine** over the authenticated mesh (FD4); the **fronting machine** surfaces exactly one tappable link to the operator's **verified-bound** topic. **Fail-closed:** if no authenticated-binding operator topic resolves, do NOT send — raise a HIGH attention item to the PIN-authed dashboard instead. Never fall back to an unverified topic.
- **Prompt-injection hardening:** HTML-escape + length-clamp every interpolated nickname/account-label (reuse the AutonomousProgressHeartbeat scrub); render the login link only when its host matches an allowlist of provider verification domains, else show the raw code + generic instruction. A peer-supplied string can never become the link target.
- **Honest failure surfacing (first-class acceptance, symmetric with success):** every terminal outcome — enroll-drive-failed, decision-denied, identity-mismatch, relay-failed — produces exactly one plain-language operator message ("couldn't start the login for *<machine>* — *<reason>*; tap to retry"). A watchdog: an entry in `enroll-in-flight` with no `login-issued` within N seconds escalates ONE attention item. No silent stall may be reintroduced.
- **Login-link expiry:** on `ttlMs` expiry before the operator taps, send ONE "that link expired — tap to get a fresh one" message (operator-initiated re-arm, a tap); never silent auto-reissue-on-a-timer. Cap total reissues per (account, target) then surface a terminal "re-approve from the dashboard." Reissue runs under the same single-flight (no concurrent drive).
- **Revocation reaches the target:** `/mandate/:id/revoke` for an account-follow-me mandate calls `deliveredMandateStore.remove(id)` (tombstone) AND a new `mandate-revoke-deliver` mesh verb propagates the revocation to the target's delivered store, so a revoked cross-machine mandate stops auto-enrolling.
- **Version skew (FD5 consequence):** until both machines are new, the flow degrades to store-only (current behavior) — never a wrong action; a target updated *after* delivery self-enrolls via the boot-sweep.
- Acceptance: issuing from Part A results, with no further operator dashboard action, in exactly one tappable login link reaching the operator (from the fronting machine); a re-delivery / restart / double-tap produces no second login; a revoked or expired mandate produces no enrollment; every failure path produces one honest message.

### Part C — "Operators Act in Taps, Not Text" clause + two-arm enforcement

**Standard (a named clause of "Operator-Surface Quality", `docs/STANDARDS-REGISTRY.md`, per FD8):** *An operator-facing flow (dashboard or messaging) must never require the operator to paste raw or technical text — JSON, fingerprints, IDs, base64, CLI/curl commands — or follow a multi-step technical process. Operators act in taps and plain-language choices; the UI assembles any structured data from those taps. A flow that needs raw technical input is finished for an engineer, not its user — and is not done.*

**Arm 1 — build-time (FD7):** upgrade the §6b operator-surface gate from prose-attestation to a **mechanical content scan** of changed operator-surface files: fail the commit when a surface requires raw technical input (textarea whose placeholder/label is a JSON template; an input labeled for fingerprint/ID/token/curl; instructions telling the operator to paste/author such text) UNLESS it carries the FD7 power-user marker and is provably not the default path. The raw-JSON mandate-form is a regression fixture.

**Arm 2 — runtime (FD6):** a detector that emits `rawTextRequestToOperator` into the existing outbound `checkOutboundMessage()` authority (signal, not standalone block); high-precision imperative-to-operator patterns; fail-open; runs at message **authoring** time (so a target-authored "paste this" is caught before it relays), and the gate's file-trigger set includes messaging templates, not only dashboard files.

## Cross-Machine Posture (mandatory declaration)

- One-tap card / scan offers — **proxied-on-read** (fronting machine fans out to peers; no new replicated state).
- Issued/delivered mandate — **machine-local-by-design** on the target (`DeliveredMandateStore`; the target's authority to act; correctly NOT replicated).
- Single-flight ledger + pending login — **machine-local-by-design** (a login lives in one config-home on one disk; durable across restart).
- Operator binding used for surfacing — **machine-local-authoritative** (replication is advisory-only; surfacing happens on the fronting machine where the authoritative binding lives).
- Login URL — **machine-independent** (provider-public verification URL, not a localhost/tunnel link); only its *delivery* is machine-boundary-sensitive (handled by FD4).

## Live-User-Channel Proof (mandatory before "done")

Driven through real surfaces with a signed PASS/FAIL matrix covering the required risk categories: happy-path; re-delivery + restart + double-tap (idempotency/single-flight); revoked + expired mandate (fail-closed); wrong PIN (permission); enroll-drive-failure + relay-failure (honest surfacing); target offline at issue then returns (deferred enroll); rollback (flag off → store-only). Volatile/failure rows driven/spot-checked by a separate role (FD10). The operator is brought in only for the final real login tap.

## Cross-model refinements (convergence round 3 — codex gpt-5.5 + gemini-2.5-pro, both "minor issues")

The external cross-model pass endorsed the design and contributed four binding clarifications (folded in here, non-material but strengthening):

- **R3.1 — Single-flight key identity domain.** The ledger key is the canonical `${accountId}::${targetMachineId}` where `accountId` is the **pool's canonical account id** (stable across machines), keyed within the **fronting machine's** issuance context — so the same logical (account→target) collapses correctly but two *different* fronting contexts cannot suppress each other's offers. If `accountId` is ever only locally meaningful, the canonical pool id (provider + account identity) is used, never a per-config-home local label.
- **R3.2 — Target→fronting failure/status reporting is an explicit mesh path.** The target reports each terminal/observable transition (`login-issued` with the artifact, `enroll-failed`, `decision-denied`, watchdog `stalled`) back to the fronting machine over the authenticated mesh (a `follow-me-enroll-status` verb). The **fronting** machine — which holds the verified operator binding — is the sole surfacer of operator messages. The target never messages the operator (it can't, and shouldn't).
- **R3.3 — Operator-message idempotency (durable outbox).** "Exactly one tappable link / one failure message" is enforced by a durable operator-message **outbox keyed by `(ledgerKey, ledgerState, eventId)`**, so mesh redelivery, fronting-machine restart, or retry collapses to **at most one visible active operator message per ledger state** — not N. The success link and each failure are single-emission by construction, not by hope.
- **R3.4 — Revocation race + login-issued invalidation.** Revocation is re-checked **before every state transition** (not only at enroll-start). A revoke that arrives after `login-issued` **invalidates the pending login** (the device-code re-mint is abandoned and the operator gets one "that authorization was revoked" notice), not merely "future enrollment stopped." Tombstones are retained for a bounded window so a late/lost `mandate-revoke-deliver` still lands; the target treats an unreachable revocation channel as fail-closed for that pair (no enroll while revocation state is unknown-stale past a freshness bound).

## Rollback

Part A card: additive; removal restores the prior surface. Part B: the auto-enroll connector is behind its **own** sub-flag (separate from the read-only card) with a `dryRun` that LOGS the intended enroll without launching a login; disabling reverts to store-only. Part C arms: each behind its own flag; disabling reverts to prior behavior. No data migration.
