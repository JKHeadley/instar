# Side-Effects Review — the money model for the Gemini pay-per-use lane (slice B)

**Version / slug:** `gemini-payg-money-model`
**Date:** `2026-11-20`
**Author:** `Echo (build lane echo-gemini-payg-build, slice B builder)`
**Spec:** `docs/specs/gemini-payg-metered-lane.md` §2 (admission order, callers, E2 share, default-chain change), §3 (models, prices, tiers, `verified`), §5 (door policy, period model, limits, reserve steps, settle table, provisional, refusal reasons + status table), §8 (releaseState + PROBE_DOOR only), §10 (Migration Parity), §11 unit bullets; FD-G4.
**Tier:** 2 (money gate). Size: 10 source/data files + 1 new and 6 updated test files, ~1,900 LOC.
**Second-pass reviewer:** see the end of this file.

## Summary of the change

Slice B builds the money model only. No network call, no provider, no mesh, no go-live action. Nothing here can spend: no caller-facing code path calls `admitMeteredCall` yet, and the `gemini-api` door has no go-live record, no door policy and no verified price on any agent.

1. **Caps store** (`RoutingSpendCapsStore.ts`). `KeyCapsRecord` gains optional `monthlyCapUsd` and `periodTimeZone` (IANA; absent ⇒ UTC). `lifetimeCapUsd` is optional when monthly is set. `validateCapsFile` requires lifetime-or-monthly plus daily, and validates the zone. A new optional `doorPolicy: Record<door, MeteredDoorPolicy>` holds the spec §5 fields, with a store-level validator (`validateDoorPolicy`: only the four listable callers, sha256 `keyGeneration` or null, positive throughput floors, a closed `releaseState`). Mutators:
   - PIN path: `setDoorPolicy(actor, expectedVersion, door, policy)`; `adjustCaps` takes monthly/zone.
   - Bearer, reduce-only, no version: `lowerCaps` (each value ≤ current; bumps `leaseEpoch`, never `designationEpoch`), `disableCaller`, `lowerShare`.
   - The period zone is refused as a change while a door using the key is live.
   - The reserved probe door is refused by every new mutator and carries no policy.
2. **Ledger** (`MeteredSpendLedger.ts`).
   - Rows gain the CHARGED `dayEpoch`/`monthEpoch` (Intl, the key's zone), stamped at reserve and inherited by settle/expire/provisional rows. They also gain `callId`, `requestSha256`, `component`, `caller`, `run`, `tier`, `pricePointId`, `e1PassKey` and the booked rates.
   - Pre-change rows fold on their UTC day/month, exactly as before.
   - Totals gain `committedMonthUsd`, `monthEpoch`, `provisionalMonthUsd`, `outstandingReserveUsd`, `e2MonthUsd`, `e2DayUsd`.
   - The in-lock check order is: callId dedupe → policy re-read callback (`revalidateUnderLock`) → per-call ceiling → E2 shares (caller `second-opinion` only) → month → day → lifetime → provisional ceiling → E1 pass slot.
   - Each period check reports `reserves-outstanding` when settled + reserve would fit, with `retryAfterSec` bounded to 1–60 s from the soonest settle deadline. It also reports `resetsAt`, the next period boundary in the zone.
   - **Provisional, `gemini-api` only** (`PROVISIONAL_EXPIRY_DOORS`). Expiry books the reserve as provisional. A new `provisional` row kind (`settleProvisional`) books the full reserve. A later actual settle keeps max(provisional, actual) and records `bookedExcessUsd`. Every other door keeps the $0-on-expire fold and the absolute late settle (tested).
   - `callId` dedupe is folded from rows, so it survives a restart. A different `requestSha256` raises `CallIdConflictError`.
   - E1 slots are counted under the lock. A confirmed `noCharge` settle releases one; provisional keeps it.
3. **Gate + entry** (`MeteredSpendGate.ts`, `meteredCallEntry.ts`).
   - The refusal union gains the 13 reasons.
   - `refusalHttpStatus` and `refusalPlainMessage` follow the status table.
   - `MoneyGateRefusal` carries `facts`. `toWire()`/`fromWire()` survive forwarding; an unknown wire reason becomes `ledger-error`, never a pass.
   - `AdmitRequest` gains required `component` + `caller` (closed `MeteredCallerId`), plus optional `callId`, `requestSha256`, `run`, `inputTokensCounted`, `tierPointId` and `e1Pass`.
   - `gate.admit(req, proofMarker?)`: the proof marker is a separate argument. Its object is registered in a module WeakSet by `mintReleaseProofMarker`, so JSON can never produce one.
   - `callerAdmissionRefusal` is shared by the entry and the in-lock re-read. Order: caller in the closed set, then component present, then `probe` refused, then a door policy must exist (deny by default), then release-proof marker or membership, then the E3 component, then the spec-review pass key, then `armed-pending-proof`.
   - `admitMeteredCall(deps, req, internal?)`: dedupe → freeze → live → caller/release → gate.
   - `preflightMeteredCall` adds the §5 step-6 "committed already meets" refusal, so an exhausted caller never pays for a token count.
   - Gate step 3 accepts a monthly-only record.
   - `settleFromUsage` prices usage at the reservation's booked rates (the reserved point), not a re-resolved price.
4. **Prices** (`routingPriceAuthority.ts`, manifest).
   - Points gain `verified`, `maxInputTokens` and `id`. `resolve` folds `verified:false` into `priceStale`, and exposes `priceUnverified`/`priceAgeStale`.
   - New `selectTier(door, model, ts, input, {allowUnverified})` picks the smallest verified range containing the input, independent of manifest order. It refuses `outside-verified-tier` when none fits.
   - New door meta `requireVerifiedTier`.
   - For such a door the gate requires `inputTokensCounted` (else `token-count-unavailable`). Only the proof call may book an unverified point, at `conservativeMax`. An age-stale point refuses `stale-price-fail-closed`.
   - Manifest: `gemini-api` becomes `staleMode: fail-closed`, `requireVerifiedTier: true`, `conservativeMax {6, 30}`. It gains Neon 3/15 and Hydrogen 1.5/7.5 points (effective 2026-11-20, `verified: false`, no tier claim). The flash-lite point stays (append-only).
5. **Registry** (`llmBenchCoverage.ts`, `routingSpendView.ts`, `AgentServer.ts`).
   - FD-G4 removes every metered position from `NATURE_ROUTING_DEFAULT_CHAINS`: gemini-api, plus the openrouter and groq positions. FD-G4 says "remove metered positions" and §2 says "Default chains then contain only subscription doors", which needs both.
   - `DEFAULT_METERED_CAPS` gains `door` and the `gemini_api_key_payg` monthly shape ($50/month, $10/day, America/Los_Angeles). `metered_gemini_bench` moves to `RETIRED_METERED_KEY_REFS`: still known, shown retired, never defaulted.
   - The Spend view and the reconciliation sweep's door map use `meteredKeyDoors()` (defaults + caps store, never the probe key) instead of `meteredKeysFromChains()`.
   - The ledger takes the zone per key from the caps store.
   - The `caps-adjust` plan route and renderer gain `monthlyCapUsd` + `periodTimeZone`. They never `.toFixed` an absent cap and refuse a plan with neither cap.
6. **Slice A ratchet repair** (`SecretSync.ts`). Slice A's three inline `catch { x = null; }` guards had no exemption marker. They put the repo-wide no-silent-fallbacks ratchet at 497 > 494 on `feat/gemini-payg-run1` (origin/main is 494). All three fail closed (a null designation or self id drops every metered key), so each now carries an in-brace `@silent-fallback-ok` with that reason. The count is back to 494. No behaviour change.

## Decision-point inventory

- Caps validation: monthly-only accepted; zone validated.
- Gate step 3 (`invalid-cap`): monthly-only accepted; any present cap must be > 0.
- Entry/in-lock caller admission (new, refusal-only).
- Release state `armed-pending-proof` (new, refusal-only).
- Ledger in-lock checks: per-call, E2 share, month, provisional ceiling, E1 slot (new, refusal-only); `reserves-outstanding` vs `cap-exceeded` (reclassification of an existing refusal).
- Provisional expiry for gemini-api (books MORE committed, the safe direction).
- Price: `verified:false` ⇒ stale; tier selection; uncounted input refused.
- Default chains: metered positions removed (fewer routes, never more).

## 1. Over-block

- **`reserves-outstanding` replaces `cap-exceeded` while reservations are in flight.** A caller that branched on `cap-exceeded` to step down (E1 to Hydrogen) now sees `reserves-outstanding` during concurrency instead. No such caller exists yet. Two existing gate tests were updated to the new classification. The step-down rule in §5 names only `cap-exceeded`/`per-call-ceiling`, so a retry is the right reaction.
- **Doors without a policy refuse every caller at the entry.** That is all doors today. Nothing calls the entry, and openrouter/groq were never dispatchable.
- **A `gemini-api` call refuses until Run 2 verifies a price with a tier range.** That is intended (spec §3, "no assumed coverage").
- **Removing the openrouter/groq default positions** changes the nature-routing map, but those positions resolved unavailable everywhere (no money layer, no go-live), so no live route changes.

## 2. Under-block

- `preflightHeadroom` is advisory. The authority is the in-lock check, so a preflight that passes and a booking that refuses is the designed race outcome.
- The E2 month share with no monthly cap evaluates to $0 (admits nothing). That is deliberate: a share with no base cannot be a positive limit.
- `mintReleaseProofMarker` is exported, so any in-process code could mint one. No lint stops that yet. The spec's recorder (slice E) is the only intended caller, and minting still requires `armed-pending-proof` plus a door policy, with every cap applied. A lint or an import-ban test belongs with slice E.
- `keyGeneration` is stored and validated here but compared against the vault key only in slice C (`key-generation-mismatch` is in the union but not raised yet). The same goes for `prompt-contains-live-secret` and `request-too-large`, which the provider (slice C) raises.
- The "critical-gate refusal at plan render" and "add needs PIN at the route" bullets need a plan route for door policy, which this slice does not add. They are covered at the store level (version-checked PIN setter, reduce-only Bearer mutators). The render-time refusal is slice D/E work.

## 3. Level-of-abstraction fit

Arithmetic and slot accounting live in the ledger's per-key critical section, which is the only place concurrent reservations see each other. Policy interpretation (caller and release state) lives in one exported function used by both the entry and the in-lock re-read. Price/tier selection lives in the price authority. The gate composes them, and the entry stays an ordering wrapper.

## 4. Signal vs authority compliance

All new authority is deterministic arithmetic or exact set membership at the metered admission point, the same ruled exception the parent money gate uses: a missed refusal spends real money that cannot be recalled. Every new branch refuses or books more committed spend, never less. No LLM judgment is involved.

## 4b. Judgment-point check

There is one classification judgment: `reserves-outstanding` vs `cap-exceeded`. It is a deterministic comparison (settled + reserve ≤ cap), and both answers refuse.

## 5. Interactions

- **PROBE_DOOR.** `runCapGateProbe` calls `gate.admit` with the reserved `probe` caller and component. The probe door has no policy, so the in-lock caller check is skipped and its `cap-exceeded` path is unchanged. A test runs the probe beside a gemini policy.
- **Spend alert observer.** The admit event sends `lifetimeCapUsd: 0` for a monthly-only key, and the emitter already skips non-positive caps. Monthly-approach alerts are not added here; the spec's notices are later work.
- **`allCommitted()`/`committed()`** now return extra fields. The routes copy only the fields they name, so the response shapes for existing fields are unchanged.
- **Mobile capacity rows** read `lifetimeCapUsd` through `num()`, which already accepts null.
- **The `/routing-spend/freeze` default seed** now creates a monthly-shaped record for the gemini key.

## 6. External surfaces

- `GET /routing-spend/caps` rows gain `monthlyCapUsd`, `periodTimeZone`, `committedMonthUsd`, `pctMonthly` and `retired`. `lifetimeCapUsd` may be null.
- The key list is now `gemini_api_key_payg`, `metered_openrouter_bench` and `metered_groq_bench`, plus any key in the caps store.
- `POST /routing-spend/plan` `caps-adjust` accepts `monthlyCapUsd` and `periodTimeZone`, and makes `lifetimeCapUsd` optional.
- The nature-routing map shows no metered positions.
- No config field, route or job is added.

## 7. Multi-machine posture

Replicated code. The money state stays single-writer on the PIN-designated machine (the parent model). Rows carry their charged period, so a ledger read on any machine folds identically. The cross-machine forward, lease echo and designation come in slice D.

## 8. Rollback cost

A revert restores the old fold. A ledger written by this build may contain `provisional` rows, which an older binary skips as an unknown kind. That under-counts committed spend by the provisional amounts on a gemini-api key. No agent has a gemini go-live record, so no such row can exist yet. Caps files written with `monthlyCapUsd`/`doorPolicy` would fail the old validator (lifetime required), and the old gate fails closed on a store it cannot read. That is the safe direction, and it is repaired by re-adjusting caps. No data migration.

## Second-pass review

(appended below by the independent reviewer)

### Reviewer verdict (independent subagent)

**Verdict: concur-with-notes.** Nothing in this slice admits money that should be refused today, and nothing in the codebase calls the new entry yet. The notes below are things the next slices must not inherit unchanged. None of them blocks this slice.

**What I verified, in the code rather than the artifact:**
- **Ledger.** I read the ledger in full: reserve, settle, settleProvisional, sweepExpired, applyRow, checkCapsLocked, e1PassesUsed, periodEpochs and nextPeriodBoundaryMs. I also compared it with the HEAD version.
- **Gate and entry.** I read the gate (admit, policyUnderLock, admitCapsFor, gatePrice, mapReserveError, dedupeResult, preflightHeadroom), the entry module, the caps store diff, the price authority diff (resolve, selectTier), the manifest, the spend view, the default-chain change, AgentServer wiring and the caps-adjust route.
- **In-lock order.** Inside the lock the order is dedupe, then a fresh caps read (live, designation, lease, freeze, caps validity, and caller/E3/release state when a door policy exists), then the cap checks, then the E1 slot. The reserve row is appended only after all of these.
- **Release-proof marker.** The marker is a WeakSet-registered object and cannot come from JSON. It is honoured only while the door is `armed-pending-proof`.
- **Tier selection.** It ignores manifest order, needs `verified === true` plus a declared range, and refuses uncounted input.
- **Non-gemini doors.** They keep the $0 expiry and the absolute late settle, booked on the UTC day of the settle.
- **Pre-change caps files.** They pass the new validator, and the retired keyRef stays known.
- **Period epochs.** The DST cases in the test are correct for America/Los_Angeles: the 2026-11-01 fall-back, the 2026-03-08 spring-forward, and the month end at 08:00Z. The boundary binary search is monotone inside its 2-day and 33-day windows.
- **Tests.** I ran the 6 touched test files. Unit: 99/99 passed. Integration routing-spend-routes: 17/17 passed. E2E routing-spend-lifecycle: 12/12 passed.
- **Scratch probe.** I ran a probe built in TMPDIR against the real ledger. It confirmed concerns 1, 2 and 3 below.

**Concerns (all non-blocking for slice B; numbered by severity):**

1. **Callid dedupe has no binding, so it can bypass every check.** Locations: `src/core/MeteredSpendLedger.ts:466-470`, `src/core/MeteredSpendGate.ts:597` (dedupeResult), `src/core/meteredCallEntry.ts:157`.
   - A resubmission is matched on `callId` alone. The digest is compared only when both sides carry one, and the door, keyRef and model are never compared.
   - Probe result: a request for a different key and door, with no digest, came back `deduped: true` with the other call's reserveId. Through the entry this happens ahead of freeze, live and caller.
   - No money moves here, because nothing new is booked. But spec §5 step 6 speaks of an *authenticated* resubmission "with a matching resultToken and digest".
   - If slice C dispatches on any returned `AdmitResult`, that is an unbooked send.
   - Recommendation: require `requestSha256` whenever `callId` is set, refuse `callid-conflict` when the door, keyRef or digest differ, and make a deduped result impossible to mistake for a dispatch permit. Slice C must close this before any caller exists.
2. **Pre-change gemini-api expiry rows refold as provisional.** Location: `src/core/MeteredSpendLedger.ts:841`.
   - The fold decides provisional by the door's membership in `PROVISIONAL_EXPIRY_DOORS`. It does not read the row's own `provisional: true` flag, which line 621 writes.
   - Probe result: an old-binary reserve plus a $0 expire on `gemini-api` (key `metered_gemini_bench`) now folds to $1.50 committed, where it used to fold to $0.
   - This is the safe direction, and it is only possible on a hand-armed agent. It still contradicts §10 ("the fold handles their absence") and the artifact's claim that pre-change rows fold identically.
   - Fix: key the fold on `row.provisional === true`.
3. **A retry is suggested while a hard refusal still applies.** Location: `src/core/MeteredSpendLedger.ts:726` and the check order at 737-742.
   - Each period check classifies itself and throws first. A month check that has reserves outstanding reports `reserves-outstanding` (retry) even when the later day check is a hard `cap-exceeded`.
   - Probe result: day settled at its cap, month with $4 outstanding. The refusal came back as monthly with `reservesOutstanding: true`.
   - Both refuse, so no money moves. But the caller is told to retry when it should give up or step down.
   - Fix: evaluate every check, and return `reserves-outstanding` only when no check is a hard refusal.
4. **Price age-staleness is judged for the whole door, not per point.** Location: `src/core/MeteredSpendGate.ts:673`, via `routingPriceAuthority.ts:489` (`isDoorStale` uses the door's newest point).
   - §3 says a point past its 45-day window refuses. Today a fresh Hydrogen point keeps a 6-month-old verified Neon point usable.
   - Fix: compute freshness on the selected tier point.
5. **`setDoorPolicy` accepts `releaseState: 'live'` directly.** Location: `src/core/RoutingSpendCapsStore.ts:395`.
   - A PIN write can skip the release proof. No route reaches it yet. Slice E should make the move from `armed-pending-proof` to `live` reachable only by the recorder.
   - Related: `mintReleaseProofMarker` can be re-used for more than one proof call, as the artifact already says.
6. **The in-lock caller check is skipped when the door has no policy.** Location: `src/core/MeteredSpendGate.ts:590`.
   - This keeps the probe working. But a policy that vanishes between the entry and the lock (only possible by hand-editing the file) would skip the caller check under the lock instead of denying.
   - Narrower alternative: skip only for `PROBE_DOOR`, and deny otherwise.
7. **Minor items.**
   - `adjustCaps` reads an omitted lifetime or monthly field as "remove". The rendered plan does show "→ none", so the PIN holder sees it.
   - `applyRow` now books a settle that follows an unflagged expire on the settle's period (`:811-818`). That is a tiny divergence from the old fold, reachable only through cross-process interleaving.
   - The reserve zone is taken from the pre-lock caps read, not the in-lock re-read. That is safe while the zone is fixed for a live door.
   - Spec items not in this slice, for the slice plan to own: the critical-gate refusal at plan render, the PIN-versus-Bearer route tests, the 100%-of-month notice, the §10 awareness entry and Registry First row, and the `keyGeneration` comparison.

### Folded after review

Each item below landed with a unit test in `tests/unit/gemini-payg-money-model.test.ts` ("second-pass review folds").

- **Concern 1 (dedupe too loose).** A callId resubmission now counts as the same call only when the door matches, the key matches (ledger) and a request digest is present on both sides and equal. Anything else refuses `callid-conflict`. The shared check is `callIdConflict()`, used by the entry, the gate and the ledger lock.
- **Concern 2 (old rows folded differently).** The provisional expiry is now decided by the row's own `provisional: true` flag, never the door name. A pre-change $0 `gemini-api` expiry row folds to $0, as before.
- **Concern 3 (wrong refusal reason when two limits apply).** Every period limit is evaluated. A hard breach anywhere is reported before a `reserves-outstanding` one.
- **Concern 4 (door-level staleness).** For a `requireVerifiedTier` door, staleness is judged on the SELECTED point's own age against the SLA. A fresh Hydrogen point no longer keeps a stale Neon point usable.
- **Concern 5 (policy setter could mark a door live).** `setDoorPolicy` now refuses any move to `live`. The new `recordReleaseLive(actor, door, {proofReserveId, intentHash})` is the store carrier the slice-E recorder calls, and it works only from `armed-pending-proof`.
- **Concern 6 (in-lock caller check skipped for doors with no policy).** The in-lock caller check now runs for every door except the reserved probe door, so a door with no policy refuses there too. As a result the parent gate's fail-closed matrix (`tests/unit/metered-spend-gate.test.ts`) now gives its openrouter fixture a wide door policy and the `doorway-liveness` caller. A direct `gate.admit` on a non-probe door without a policy now refuses `not-allowlisted`.
- **Concern 7 (minor items).** The caps-adjust omitted-cap behaviour is shown in the rendered plan; left as is. The listed deferrals stay with slices C–E: the critical-gate render refusal, the route-level PIN/Bearer tests, the notices, the awareness entry and the key-generation comparison.
- **Correction.** The §1 summary line "pre-change rows fold on their UTC day/month, exactly as before" is now accurate, after concern 2.
