# Side-Effects Review — the go-live of the Gemini pay-per-use lane (slice E)

**Version / slug:** `gemini-payg-go-live`
**Date:** `2026-11-20`
**Author:** `Echo (build lane echo-gemini-payg-build, slice E builder)`
**Spec:** `docs/specs/gemini-payg-metered-lane.md` §4 ("The production key is minted at go-live": handoff contract, validation, lifecycle, transcript check), §5 notices, §6 stop actions, §7 visibility, §8 (pre-gate action, render, commit + restart, apply, release gate), §9, §10, Maturation plan, Self-Heal watcher declaration. Amends `docs/specs/money-layer-operator-enable-surface.md` (action list + restart binding) in the same change.
**Tier:** 2 (money release path). Size: 6 new source files, ~16 changed source/data files, 4 new + 2 updated test files.
**Second-pass reviewer:** see the end of this file.

## Summary of the change

Slice E builds the ONE operator action that turns the lane on, the release gate that is the only path to `live`, and the reduce-only, visibility and notice surfaces around them. The fleet stays dark: nothing here enables money on any agent, and nothing can spend until an operator PIN-commits a `gemini-payg-setup` plan and the release checks pass.

1. **Setup struct, plan text, files** (`src/core/geminiPaygGoLive.ts`, new).
   - `GeminiPaygSetup`: every committed field (designated MESH machine id, epoch, $50 month / $10 day / America/Los_Angeles, $2.50 per call, $10 uncertain-charge limit, E2 40% + $4/day, E1 1 pass/round, callers E1+E2, E3 empty, E4 off, models, keyGeneration = handoff fingerprint, providerKeyId, Google limit kind+amount, reconcile job on, transfer null). Canonical sha256 hash. A validator pins the v1 scope.
   - Plan text generated from the struct, one line per field. Line 1 is the first-screen line verbatim. The $50 is quoted with its source (Justin, 2026-11-20, topic 145625, both messages, 15:12 PST, "a separate $50 for this lane in its own Google project"). The agent-proposed values are each marked "Proposed by the agent, changeable before you approve". The Google-side line follows `googleSpendLimit.kind` (hard cap vs "Google will warn but not stop at $50; Instar's own cap is what stops spending"). The restart disclosure is verbatim.
   - Machine-local files under `state/`: `money-proposed-setup.json`, `money-pending-setup.json` (the intent), `gemini-payg-key-handoff.json`, `gemini-payg-mint-start.json` (server-recorded), `gemini-payg-apply-failure.json`, `gemini-payg-archive/`. All writes are tmp + fsync + rename. A stored hash that does not match its struct is "no proposal / no intent".
   - Render preconditions, each a named blocker: wrong machine; failover threshold < 176 s (re-read each render, so a config change re-checks); handoff missing/malformed; read before the SERVER mint start; screenshot hash mismatch (both screenshots); `keyCount ≠ 1` (second key in project); `boundTo.designationEpoch ≠` proposal epoch; stored-key fingerprint ≠ attested (computed in the named reader); Google limit above the cap; transcript set missing / not attested complete / unreachable / a hit; conflicting designation (heard echo or own record naming another machine); `secret-names` on every registered peer (holds key ⇒ blocker; unreachable ⇒ cleared by mint-after-filter; error/old peer ⇒ blocker; registry unreadable ⇒ blocker).
   - `applyPendingGeminiPaygIntent`: checks the intent's own hash, the self mesh id, and the `gemini-payg-setup-committed` authority row for that hash; then ONE durable caps-store write; deletes the intent only after it; idempotent by `appliedIntents[door]`. Any failure freezes the key (defaults seeded), records the failure, raises ONE notice per intent hash, never throws.
2. **Caps store** (`RoutingSpendCapsStore.ts`): optional `appliedIntents` (validated); `mutate(..., {durable})` fsyncs file + dir; new `applyGoLiveSetup` writes caps + GoLiveRecord + door policy (`armed-pending-proof` only) + zone + the hash in one write, keeps an existing freeze, refuses the probe door.
3. **Ledger** (`MeteredSpendLedger.ts`): `monthBreakdown(keyRef, month?)` — settled vs outstanding and per-caller, folded from rows by their CHARGED month (exact for a past month).
4. **Enable surface** (`moneyLayerEnable.ts`, `MoneyLayerEnableSurface.ts`, `MoneyLayerAuditLog.ts`, `RenderedPlanStore.ts`).
   - `gemini-payg-setup` joins `MONEY_LAYER_PREGATE_ACTIONS` (five). Sync `renderPlan` refuses it; `renderPlanAsync` renders it through an injected `GeminiPaygSetupPort`, pins the proposal hash and the caps version.
   - Commit: proposal hash re-read (and the card's hash when sent) ⇒ "the proposal changed; a new card is needed"; caps version drift ⇒ 409; authority row first, then the intent, then the flag; handoff archived; money serving ⇒ apply hot, no restart; else `restartRequired`.
   - `admitCommitRestart()` shares the cooldown/settling safeguards with `acceptRestart` (refactored into one helper) plus the three-state eligibility; refusals carry `retryAt`.
   - Four audit row types: `gemini-payg-setup-committed` (authority, pre-gate visible: hash + machine only), `-intent-applied`, `-release`, `-stop-action` (withheld pre-gate).
5. **Release gate** (`src/core/geminiPaygReleaseRecorder.ts`, new). The only importer of `mintReleaseProofMarker` (pinned by a test). Durable proof record bound to the applied intent hash; deterministic callId per attempt (ledger dedupe across restart); serialized; no-charge releases the slot; uncertain keeps its charge, 3 attempts in all; checks (d) → (a)+(e) → (c) → (b); on a multi-machine agent a local proof is refused BEFORE spending (a local row could never satisfy (e)); (b) verifies a signed live-test artifact through the injected verifier (absent ⇒ named). Only path to `recordReleaseLive`.
6. **Proof marker threading** (`GeminiApiProvider.ts`, `geminiPaygWiring.ts`): `proofMarker` is now the `ReleaseProofMarker` object, passed to `preflightMeteredCall` and `admitMeteredCall(..., { proofMarker })`. No route reads it from a body.
7. **Runtime** (`meteredLaneRuntime.ts`, `MeshRpc.ts`, `server.ts`): `release-proof-forward` now runs the holder's recorder (only a live-test evidence pointer is read from the payload); `peerSecretNames()`; `heardDesignation()`; `forwardReleaseProof`; a sixth registered-peer read-class verb `gemini-payg-setup-render` (render the setup plan on the proposal's machine) with `forwardSetupRender`.
8. **Routes** (`src/server/geminiPaygGoLiveWiring.ts`, new; `routes.ts`): `POST /routing-spend/key-handoff/mint-start` and `POST /routing-spend/key-handoff` (Bearer + loopback, work with money off; 400 on malformed); `POST|GET /routing-spend/gemini-payg/proposal`; `GET /routing-spend/gemini-payg/release`; `POST /routing-spend/release-proof`; `POST /routing-spend/caps/lower` (≤ current pre-checked on the holder, reduce-only mutator everywhere, bumps `leaseEpoch`); `POST /routing-spend/callers/disable`; `POST /routing-spend/share/lower`; `POST /routing-spend/reconciliation`. The stop routes go through `MeteredLaneRuntime.stopAction`, are audited with the server-resolved session, answer 202 "stop requested; the spending machine has not confirmed yet" when unconfirmed. `plan-money-layer` is async and forwards a `gemini-payg-setup` render naming another machine; the money-layer commit route schedules the restart (≤ 3 automatic retries at `retryAt`); `GET /routing-spend/caps` gains `geminiPayg` (§7 fields) and is proxied to the holder from any other machine (≤ 30 s cache, `ageMs`, `holderUnreachable` with last-known values; `?local=1` is the holder read); `caps-adjust` plans may carry `door` + `provisionalCeilingUsd` (the provisional card's prefilled plan); `GET /routing-spend/reconciliation` adds `geminiPaygBrowserReads`.
9. **Notices** (`src/core/geminiPaygNotices.ts`, new; `AgentServer.ts`): 100% month once (held 23:00–07:30 Pacific), provisional-ceiling Work Board card with the prefilled plan (held through quiet hours, once per month), conflicting designation immediate (security class; also archives the handoff), invoice drift after one re-read ≥ 6 h, lowered-limit notices one per action coalesced per hour with the Spend-tab link. 50%/80% are shown (caps view, Spend tab), never pushed. Delivery is the existing spend-alert dispatcher (or the Increment-B resolver); none ⇒ logged, not latched.
10. **Reconciliation** (`src/core/geminiPaygReconciliation.ts`, new) + job template `gemini-payg-reconcile` (`enabled: false` fleet-wide; 09:00 and 15:00 on the 2nd; the apply flips this agent's per-slug manifest on).
11. **Visibility UI**: `dashboard/spend-arming.js` `monthlyRowWords` + `commitRoute('gemini-payg-setup')`; the Spend tab shows the monthly row; `/mobile/spend` routes gain `committedMonthUsd` / `monthlyCapUsd`.
12. **Awareness / migration**: `src/data/awareness/gemini-payg-lane.md` updated (stop routes, go-live, release); Registry First row "How much have we spent on Gemini / metered models? → GET /routing-spend/caps" in `generateClaudeMd()` + a guarded `migrateClaudeMd()` step; `routingSpend.geminiPaygLane` ladder entry (flag `routingSpend.money.enabled`; the schema has no `operator-armed-per-agent` final or `money` risk, so it is `default-off-by-preference` with the operator-armed-per-agent reason recorded, risk `sensitive`).

## Decision-point inventory

- Render preconditions (each refusal-only; a missing input refuses).
- Proposal binding + caps version pin at commit (refusal-only).
- Apply: commit-row / hash / machine checks (refusal-only; failure freezes).
- Release checks (d)(a)(e)(c)(b) (refusal-only until all pass; the only `live` write).
- Commit-restart safeguards (refusal-only; reuse of the existing restart safeguards).
- caps/lower ≤ current pre-check (refusal-only; the reduce-only mutator is the authority).
- Drift notice threshold (> 10% AND > $2 after one re-read) — signal only.

## 1. Over-block

- A transcript path the account lane lists but cannot be read blocks render until fixed — deliberate (§4: unreachable is never "no hit").
- On a multi-machine agent the proof must arrive forwarded; a local call is refused before spending (otherwise the one proof slot would be burnt on an unusable row).
- A peer on an older build answers `secret-names` with `peer-version` and blocks render (it cannot prove the key absent). Offline peers are cleared.

## 2. Under-block

- `keyCount` and `transcripts` are attestations by the account lane, bound to screenshot hashes and the server mint start; they are not independent witnesses (the spec's honest limit). They are extensions of the §4 contract (see "Spec deltas" below).
- The dashboard PIN is readable by agent sessions (§9 foundation item, unchanged).

## 3. Level-of-abstraction fit

The PIN/plan/restart machinery stays in the enable surface; the lane-specific facts live behind one port. The caps store keeps the single write. The recorder is a core module with injected provider/ledger, so the release logic is testable without the server.

## 4. Signal vs authority compliance

Authority writes: the PIN commit (flag + intent), the apply (caps), the recorder (`live`), the reduce-only stops. Everything else (notices, drift, caps view, render blockers) is signal or refusal. No LLM decides anything here.

## 4b. Judgment-point check

D10 (drift notice) stays signal-only; D12 (release) is deterministic over recorded artifacts.

## 5. Interactions

- The commit restart reuses the persisted restart cooldown, so a go-live commit inside 60 s of another accepted restart reports `restart-cooldown` with `retryAt` and retries itself.
- Freeze from a designation conflict archives the handoff (an old attestation can never vouch for a new key).
- An apply keeps an existing freeze: a re-go-live after a failed apply still needs a PIN unfreeze (stated in the failure notice path).

## 6. External surfaces

New Bearer routes listed above; one new mesh verb (registered-peer, read-class: renders a plan, which is not authority). No config field is added. Money state stays excluded from backups.

## 6b. Operator-surface quality (Operator-Surface Quality standard)

The surfaces touched: the Spend tab's new monthly block (`dashboard/spend-arming.js` `monthlyRowWords`, rendered in `dashboard/index.html` above the door picker), the `gemini-payg-setup` plan's commit route mapping in `commitRoute`, and the plan text itself (shown verbatim by the existing `renderPlanPreview`).

1. **Leads with the primary action? Yes.** The monthly block is read-only status and sits above the existing door controls, which stay the actionable part; the plan's FIRST line is the plain first-screen sentence the spec requires, and the Approve/PIN control is the existing plan-preview flow, unchanged.
2. **Zero raw internals as primary content? Yes, with one justified exception.** The monthly block is dollars and plain sentences only (no key names, ids or hashes). The plan text must list every committed field (spec §8, property-tested), so the key fingerprint and the proposal hash appear — on later lines, after the plain lines, as support metadata the PIN binds to; they are never the headline.
3. **Destructive actions de-emphasized? Yes / unchanged.** No new destructive control: Freeze and the reduce-only stops stay where they were; the monthly block has no buttons.
4. **Plain language + phone width? Yes.** Every line is a short sentence ("Gemini this month: $3.20 of $50.00 (6.4%)."), written with textContent into stacked `div`s (no table, no horizontal scroll). Not loaded at 390x844 in this slice — that is the Run 1 page check the spec assigns before the card is sent (§8 Delivery), stated here rather than claimed.

## 7. Multi-machine posture

Proposal, intent, handoff and mint start are machine-local to the designated machine (physical-credential-locality). Caps reads proxy to the holder. Stop actions and the proof forward to the holder. The render forwards to the proposal's machine.

## 8. Rollback cost

Freeze (Bearer), then disable the money layer, then revert. A reverted build ignores `appliedIntents` (an unknown optional field) — but an older `validateCapsFile` may reject the new monthly-only record and close money entirely, the safe direction (spec §8). The reconcile job ships disabled.

## Spec deltas (recorded for the spec owner)

- §4 handoff contract gains `oneKeyArtifact.keyCount` (required) and optional `transcripts {paths, complete}` (required at render). Without them "a second key exists" and "every transcript the run produced" have no carrier in the file render reads.
- §8 "a request from another machine is forwarded there" is carried by a sixth mesh verb, `gemini-payg-setup-render`, beside the §6 five.
- The ladder entry uses the schema's closest values (`default-off-by-preference`, `sensitive`); the schema has no `operator-armed-per-agent` / `money`.

## Tests

- Unit: `tests/unit/gemini-payg-go-live.test.ts` (31), `tests/unit/gemini-payg-release-gate.test.ts` (14); updated `money-layer-enable-surface.test.ts` (five actions) and `mobile-native-capacity-screens.test.ts` (monthly fields).
- Integration: `tests/integration/gemini-payg-go-live-plan.test.ts` (7, two machines; harness `geminiPaygGoLiveHarness.ts`).
- E2E: `tests/e2e/gemini-payg-go-live-alive.test.ts` (3: real AgentServer wiring; the whole operator path across a restart, 200 not 503, a row settles, a mid-month cap refuses, the next Pacific month reopens).

## Second-pass review

### Reviewer verdict (independent subagent)

**Verdict: CONCUR WITH CONCERNS.** Nothing here can spend money the operator did not approve. Verified in code, not taken from this artifact: the only `live` writer is `GeminiPaygReleaseRecorder.evaluate` → `recordReleaseLive`. `setDoorPolicy` refuses a non-live → live move, and `applyGoLiveSetup` refuses any state but `armed-pending-proof`. `mintReleaseProofMarker` has one importer, and the marker is a WeakSet object that no route can build from JSON. The commit binds to the proposal hash (checked before the nonce is consumed, and again in `writeIntent`). The commit writes only the flag and the intent while money is off (`readCaps`/`capsVersion` only read). The apply is idempotent by `appliedIntents`, never throws, and deletes the intent only after the fsync'd write. The commit restart goes through eligibility, the persisted cooldown, the settling check and the audit flush. The stop routes call reduce-only mutators (`lowerCaps`, `lowerShare`, `disableCaller`). The proof `forwardedFrom` is the authenticated mesh sender. The release-gate and go-live unit tests pass (45/45). None of the concerns below blocks now.

1. [major] `src/server/geminiPaygWiring.ts:212-218`: the peer-side `secretNames` catches a vault read error and returns `[]`. The holder reads that as an authoritative "names" answer with no key in it, so a peer with an unreadable or locked vault clears the `key-on-peer` precondition by absence. `src/server/meteredLaneRuntime.ts:286` makes this wider: every failure except `peer-version` (handler exception, RBAC denial, timeout from an online peer) is classed `unreachable` and cleared. So the artifact's claim "error ⇒ blocker" holds only for old builds. The real protection is still mint-after-filter, which is why this is not blocks-now. Fix: have `secretNames` throw (or return `{ error }`) so the holder maps it to `outcome: 'error'`. Clear a peer only on a transport-level unreachable result, and treat any answer-level failure from a reachable peer as `secret-names-unreadable`.
2. [minor] `src/core/geminiPaygReleaseRecorder.ts:176-180`: if the process dies after `save(in-flight)` but before the provider reserves, no ledger row will ever exist. After the restart, `resolveFromLedger` leaves the attempt `in-flight` forever, and every `runProof` answers "proof-in-flight", so the door can never be released. This is the safe direction but a permanent wedge. Fix: when an attempt left by an earlier process has no ledger row, re-issue it with the same `n`/`callId` (ledger dedupe makes that safe), or mark it `no-charge` once the reservation TTL has passed.
3. [minor] `src/core/MoneyLayerEnableSurface.ts:504` with `geminiPaygGoLiveWiring.ts:168-170`: a corrupt caps store reports version `-1` at both render and commit. `-1 === -1` passes the pin, so the comment "−1 never matches a pinned version" is false. At render, `conflictingDesignation` (`geminiPaygGoLiveWiring.ts:203-205`) reads the corrupt store as null and skips the own-record check by absence. The outcome is still fail-closed (the apply cannot read or freeze, and no policy means the door is denied). Fix: make `prepareRender` refuse with a named `caps-store-unreadable` blocker when the version is `-1`, and make commit refuse on `-1`.
4. [minor] `src/server/routes.ts:19355-19364` and `MoneyLayerEnableSurface.ts:561`: when the restart safeguard refuses, the response's `message` still says "restarts now" while `restart.scheduled` is false. After the third automatic retry fails, or on `not-restartable` (which has no `retryAt`), nothing tells the operator that the approval is waiting for a restart. Fix: build `message` from the restart outcome, and raise one lane notice when the retries are used up.
5. [minor] `src/server/routes.ts:19680-19693`: the caps-adjust commit with `door` + `provisionalCeilingUsd` makes two separate store writes (`adjustCaps`, then `setDoorPolicy`). If the second write fails, the operator's single approved plan is only half applied. Fix: add one store method that applies both under one `mutate` call.
6. [minor] `src/core/geminiPaygGoLive.ts:578-604`: a failed apply leaves the intent file in place. Every later boot fails again and re-freezes the key, with the notice suppressed after the first time. So a PIN unfreeze is silently undone at the next restart until a new go-live overwrites the intent. Fix: move a failed intent into `gemini-payg-archive/` after it is recorded, so it fails closed once and not on every boot.
7. [minor] `src/core/geminiPaygReleaseRecorder.ts:235`: when `pricePointId` has no `|`, `pricedDoor` falls back to the ledger door. Check (e) "door === ledger door === priced door" then compares the ledger door with itself. Fix: when the price point id cannot be parsed, leave `pricedDoor` undefined (unmet), or resolve the point id through the price authority.
8. [minor] `src/providers/metered/gemini-api/geminiApiKeyReader.ts` `scanForStoredKey`: synchronous `readFileSync` of files up to 512 MB each (up to 20,000 files) runs on the server's event loop during render. Directories are followed through symlinks with no visited set, so a loop recurses until ENAMETOOLONG, and directories do not count toward `maxFiles`. Fix: use a visited set of realpaths, count directories in the budget, and scan files in streamed chunks or off the hot path.
9. [minor] Spec mismatch, `src/server/routes.ts` plan-money-layer: §8 says "a request from another machine is forwarded there". Forwarding happens only when the client names `designatedMachineId`. Otherwise the local render refuses `wrong-machine`, with the target in `detail`. Fix: when the local proposal is absent or names another machine, forward to the machine named in `detail`, or record this client-driven forwarding as a spec delta.
10. [minor] `GET /routing-spend/gemini-payg/release` calls `recorder.evaluate()`, which can perform the `live` write. It is still the only writer and every check has passed, but a read verb that releases money is surprising and is audited only on the POST paths. Fix: give the GET a pure evaluation and make the `live` write only inside `runProof`, or audit the release whichever path triggers it.

### Folded after review

1. [major] **Folded.** A peer whose vault exists but cannot be read now throws in `secretNames` (`geminiPaygWiring.ts`), and its `secret-names` handler answers `{ error: 'vault-unreadable' }` (`meteredLaneRuntime.ts`), which the holder records as `outcome: 'error'` — a named render blocker. No vault file at all stays a real empty answer. Only a thrown transport failure is treated as offline (cleared by mint-after-filter); distinguishing a network-unreachable peer from a mid-request transport fault is not possible at this layer, and the spec's mint-after-filter is the protection there. Test: `gemini-payg-go-live-plan.test.ts` "a peer whose vault exists but cannot be read…".
2. [minor] **Folded.** An attempt left `in-flight` with no ledger row (the process ended before the reservation; the reserve precedes the Google call) is released as `no-charge`, so a new attempt can run. Test added.
3. [minor] **Folded.** An unreadable caps store is a named `caps-store-unreadable` render blocker, and the commit's version read returns NaN, so `-1 === -1` can never pin.
4. [minor] **Folded.** When the commit's restart is refused, the response message says the approval is saved and the restart has not happened (with `retryAt`, or "applies at the next restart"); when the automatic retries are used up, one lane notice says so.
5. [minor] **Folded (narrowed).** The provisional-ceiling plan's door-policy half is checked before the caps half lands, so its expected failure cannot half-apply a plan. A disk failure between the two writes is still possible; both writes are reduce/raise-to-approved values from the same PIN plan.
6. [minor] **Folded.** A failed intent is archived after its failure is recorded, so the next boot neither re-applies nor re-freezes it (a PIN unfreeze holds). Test updated.
7. [minor] **Folded.** A price point id that does not name its door leaves the priced door unknown and check (e) unmet. Test added.
8. [minor] **Folded (partly).** The transcript scan keeps a visited set of real paths (symlink loops), counts directories toward the budget, and lowers the per-file limit to 128 MB (larger ⇒ unreadable, a blocker). Reads stay synchronous: render is an operator-triggered, rate-limited action, not a hot path.
9. [minor] **Folded.** A local proposal naming another machine now forwards the render there automatically (the route catches the surface's `wrong-machine` refusal and forwards to the machine it names). Integration test updated.
10. [minor] **Folded.** `GET /routing-spend/gemini-payg/release` evaluates read-only (`evaluate(undefined, { write: false })`); only the audited POST paths record the release. Test added.
