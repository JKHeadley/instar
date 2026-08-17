# Side-Effects Review — the money-layer operator ON switch (Phase 1)

**Version / slug:** `money-layer-operator-enable-surface`
**Date:** `2026-08-16`
**Author:** `echo`
**Second-pass reviewer:** `codex-cli:gpt-5.5` (independent cross-model) — **CONCERN, 8 findings, all fixed**

## Summary of the change

The Increment-B money layer (booking ledger + fail-closed cap gate + PIN cap controls) ships dark behind `routingSpend.money.enabled`, and nothing in instar could set that key: no route writes it, and `routingSpend` is deliberately absent from `PATCHABLE_CONFIG_KEYS`. The only way to turn the layer on was hand-editing the config file on the machine. This change adds the operator's way in: six PRE-GATE routes that answer 200 while the money layer is OFF, because they are the door to turning it on.

New modules: `src/core/moneyLayerEnable.ts` (pure vocabulary + state derivation), `MoneyLayerEnableStore.ts` (durable operator flag + failure record, fsync'd), `MoneyLayerAuditLog.ts` (two channels by interface over one JSONL), `MoneyLayerEnableSurface.ts` (the orchestrator: plans, PIN commits, restart nonce, probe, rate limits), `moneyLayerProbe.ts` (the reserved `__probe__` door + the cause-checking probe), `meteredCallEntry.ts` (the metered-call chokepoint: freeze first, live enable check second). Modified: `AgentServer.ts` (unconditional surface construction + the construction predicate), `routes.ts` (the six routes + the `caps/log` sensitivity split), `RoutingSpendCapsStore.ts` (the reserved door + refusal at the mutation funnel), `RoutingPriceAuthority.ts` (code-defined probe price), `MeteredSpendLedger.ts` (`outstandingReserveCount()`), `SingleInstanceLock.ts` (`revalidate()`), `RenderedPlanStore.ts` (four new plan actions), `PostUpdateMigrator.ts` (agent-awareness section + migration), `commands/server.ts` (passes the lock).

Spec: `docs/specs/money-layer-operator-enable-surface.md` (converged at 40 rounds, operator-approved 2026-08-16).

## Decision-point inventory

- `MoneyLayerEnableSurface.commit` — **add** — may this PIN-approved plan apply? (invariant: authorization on money — either the operator's PIN authorized this exact rendered plan on this machine in this source state, or it did not).
- `MoneyLayerEnableSurface.acceptRestart` — **add** — may this restart proceed? (invariant: PIN + unconsumed nonce + confirmation hash + restartable state + cooldown + not-settling-unless-forced).
- `MoneyLayerEnableSurface.renderPlan` — **add** — may a plan be minted, and which disable variant? (invariant: lock held + rate limit; the variant is a pure function of `enableSources`).
- `moneyLayerShouldConstruct` — **add** — should the money layer's components be built at boot? (invariant: `intentEnabled`, the MLE-1 OR).
- `resolveServingReady` / `admitMeteredCall` — **add** — may a paid call proceed? (invariant: not frozen ∧ intent ∧ probed ∧ lock held).
- `runCapGateProbe` cause-check — **add** — is cap enforcement genuinely up? (invariant: the refusal reason is exactly `cap-exceeded`; anything else, including an admit, is a failure).
- `filterRowsForPregate` — **add** — which audit rows may a pre-gate reader see? (invariant: an enumerated per-row-type table; an unknown row type is withheld).
- `MeteredSpendGate.admit` — **pass-through** — deliberately unmodified. The probe enters it directly; no conditional was added inside the gate.
- `PATCHABLE_CONFIG_KEYS` — **pass-through** — deliberately untouched. No route here writes the config file.

---

## 1. Over-block

**What legitimate inputs does this change reject that it shouldn't?**

Four cases, each deliberate, plus one genuine finding:

- **A plan rendered without the single-instance lock is refused (409).** On a machine whose lock was reclaimed by a successor, an operator's legitimate render fails. Deliberate: a rendered plan is authorization material spendable later with the PIN, and minting it from a non-owner would let a non-owner manufacture the artifact the commit path trusts. The refusal names `lock-not-held`.
- **A plan is refused (409) when `enableSources.state` moved between render and commit.** A legitimate operator who edits `config.json` in another window mid-flow has their plan rejected. Deliberate: they approved a decision made in a particular situation; they should see the new plan.
- **A restart is refused while money is settling** unless re-sent with `force: true`. A legitimate urgent restart is delayed. Deliberate and escapable in one field.
- **`freeze`/`unfreeze`/`adjustCaps`/`setGoLive` on `__probe__` throw.** No legitimate operator input is rejected — the keyRef is reserved and never user-supplied for a real door.
- **GENUINE FINDING (accepted, documented): with no `dashboardPin` configured, every commit and restart is refused as `bad-pin` and the operator cannot enable the layer at all.** This is correct fail-closed behaviour (a PIN-gated money action must not be reachable when the PIN is unset), but the error message says "PIN rejected", which misleads an operator whose real problem is that no PIN is configured. Verified live on the throwaway deploy, where this exact confusion cost a debugging cycle. The commit-route message is unchanged for this pass — the honest read is available on the dashboard, which does not render PIN forms without a PIN — but it is a real rough edge and is recorded here rather than smoothed over.

---

## 2. Under-block

**What failure modes does this still miss?**

- **A Bearer holder can render plans and mint restart nonces.** They cannot commit or restart without the PIN, but they can consume the 20/hour render budget and thereby deny the operator a plan for up to an hour. Bounded, audited, self-healing.
- **A Bearer+PIN holder can restart the server repeatedly**, bounded only by the 60s cooldown. Accepted deliberately and stated in the spec: a restart moves no money, books no spend and changes no cap, so its worst case is availability damage the cooldown bounds.
- **The confirmation-text hash does not prove a human read anything.** It proves the caller possessed the canonical text. A Bearer+PIN holder can mint, hash and restart with no human involved. Stated in the code and the spec; it is a client-integrity check, never an operator-consent proof.
- **The audit log is not tamper-evident.** Anyone with local admin access can edit the JSONL. Explicitly out of scope — this is a trust record against accident and against the agent, and the operator IS the local administrator.
- **`config-inspect` reads `config.json` from disk each call.** A concurrent partial write yields a `readError` rather than a diff; it never adopts, so the failure mode is an uninformative answer, not a wrong one. (Its PIN handling was a genuine hole — see second-pass finding 1 — and is now behind the shared lockout.)
- **The freeze check cannot protect a dispatch path that does not call `admitMeteredCall`.** This is the honest scope limit below, not a defence claim.

---

## 3. Level-of-abstraction fit

The change is deliberately split across three layers, and the split is the design:

- **Pure predicates** (`moneyLayerEnable.ts`) — no I/O, no authority. `moneyLayerShouldConstruct` lives here specifically so `AgentServer` and the E2E harness call the SAME function and cannot drift; that drift is what produced defect 3 below.
- **The surface** (`MoneyLayerEnableSurface`) — owns authorization on money. This is genuinely an authority, and correctly so: the decisions are deterministic authorization checks, not judgment.
- **The entry path** (`meteredCallEntry.ts`) — sits ABOVE the money layer rather than inside it, because a check inside the layer dies with the layer.

Two "should this reuse an existing primitive?" answers: it REUSES `RenderedPlanStore` (widening `PlanAction` rather than writing a parallel plan machinery, so the pre-gate allowlist check is the only thing separating the two paths); and it REUSES the existing supervised-restart flag file the auto-updater writes, adding no new restart machinery.

One "should this feed a higher gate?" answer: no higher gate exists for money authorization, and inventing one would be the second configuration system the spec spent two convergence rounds removing.

---

## 4. Signal vs authority compliance

**Required reference:** [docs/signal-vs-authority.md](../../docs/signal-vs-authority.md)

- [x] **No — this change has no BRITTLE block/allow surface.** It holds real blocking authority, and every predicate behind it is a deterministic invariant over objective state, not a heuristic over ambiguous input.

Narrative: the principle forbids brittle detectors holding blocking authority — string-matching, pattern-guessing, anything where the "right" answer requires context the detector does not have. Every decision here is the opposite shape. "Is this PIN correct?" is a timing-safe hash comparison. "Was this plan rendered on this machine, under this source state, under the lock, and not yet consumed?" is a lookup against recorded facts. "Is this key frozen?" is a boolean on disk. "Did the cap gate refuse for `cap-exceeded`?" is an enum equality against the gate's own reason field. None of these can be wrong-in-a-way-more-context-would-fix; they can only be wrong if the recorded state is wrong, which is a different failure with its own fail-closed handling.

The one place a heuristic could have crept in — "is the layer working?" — is deliberately NOT heuristic: it is answered by making a real call through the real gate and demanding one specific refusal reason. A weaker design would have inferred readiness from "the objects are non-null", which is exactly the brittle-detector-with-authority shape this principle forbids.

---

## 4b. Judgment-point check (Judgment Within Floors standard)

**No new static heuristic at a competing-signals decision point.** Every decision added is either an enumerable invariant (authorization on money — the operator's PIN authorized this exact plan or it did not; there is no third live signal to weigh) or a safety guard on an irreversible-class action (a restart, a spend admission), which the standard names as deterministic by design. The spec's own `## Decision points touched` section reaches the same conclusion and states it: "No judgment-candidate decision points are introduced: every decision added is a deterministic authorization or liveness check on money — the class where static rules are correct and weighing competing signals would be a defect."

---

## 5. Interactions

- **Shadowing — the six routes are declared ABOVE `const moneyOn = …` in `routes.ts`.** This is load-bearing placement, not style: the pre-gate routes must never fall behind the gate they exist to open, and physical position makes an accidental future fold visible in review. They do not shadow the existing `/routing-spend/plan`, which keeps its own path and its own 503 (verified live: the ordinary route still 503s in the same state the new routes answer 200).
- **`caps/log` behaviour CHANGED for existing callers.** Previously 503 while the layer was dark; now 200 with a restricted body. The `entries` key is preserved and empty pre-gate, so a caller reading `entries` sees an empty list rather than a crash; new information arrives under `moneyLayerEntries`. This is the one backward-compatibility surface in the change, and it required updating an existing E2E test that asserted the 503 — the contract change is documented in that test rather than silently loosened. The full/restricted line is keyed on `moneyOn()`; see the note at the end of the second-pass section for why that is not the spec's literal `servingReady`.
- **Double-fire — `ensureProbeDoor` is idempotent** (compares before writing), so a server restart does not append a caps-audit row per boot. Unit-pinned.
- **Races — the enable store is single-writer by the same single-instance lock the audit discipline depends on**, and every write is tmp+fsync+rename+dir-fsync. The plan store is in-process and dies with the process, which is correct: a plan is short-lived authorization material and must not survive a restart.
- **Feedback loops — none.** `enable-status` is a read that writes nothing (unit-pinned, T32), specifically so dashboard polling cannot drive audit-log volume or advance observed state.
- **`RenderedPlanStore.PlanAction` widened** — the existing money routes match on specific action strings, so the four new members are inert there; the pre-gate commit route rejects any action not on its own allowlist.

---

## 6. External surfaces

- **Other agents on the same machine:** none. The state files are per-agent under `<stateDir>/state/`.
- **The install base:** three new state files appear only once the surface is exercised (`money-layer-enable.json`, `money-layer-audit.jsonl`) or the money layer constructs (the `__probe__` rows inside the existing caps store). A fleet agent that never touches the surface sees no new files.
- **External systems:** none. The probe's provider makes no network call by construction.
- **Persistent state:** yes — the operator flag and the failure record. Both are additive; see rollback.
- **Timing:** the restart handoff depends on the supervisor acting on the existing flag file. If no supervisor is present the flag is written and nothing restarts; the surface reports honestly (`enable-pending-restart`) rather than claiming success, and the poll — not the response — is the source of truth.
- **Operator surface (Mobile-Complete):** this change EXISTS to satisfy Mobile-Complete for the money layer; it is the parent principle in the spec's frontmatter. Every action is a plain HTTP route the dashboard can render, every plan carries server-authored plain-English text for the operator to read, and the restart carries a server-authored confirmation string. **Honest limitation: the dashboard Spend-tab UI that renders these controls is NOT in this change.** The routes are phone-reachable and the agent can drive them conversationally on the operator's behalf, but a form the operator taps unaided does not exist yet. That is a real Mobile-Complete gap and it is tracked, not deferred silently. <!-- tracked: CMT-money-enable-dashboard-ui -->

---

## 6b. Operator-surface quality (Operator-Surface Quality standard)

**No operator surface touched — not applicable.** This change stages no `dashboard/*.js`, `dashboard/*.html`, approval page, or grant/revoke/secret-drop form. The dashboard rendering of these controls is the tracked follow-up named in §6.

---

## 7. Multi-machine posture (Cross-Machine Coherence)

**Machine-local BY DESIGN, and the reason is a security boundary rather than convenience.**

The spec is explicit that there is deliberately no fleet-wide enable: each machine is enabled on its own, by its own PIN. That follows from facts that are already per-machine and must stay so — the dashboard PIN is a per-machine credential and cannot cross the mesh; the single-instance lock is per-machine; the metered-lease designation names one machine; and the money layer's components are constructed by one process. A replicated enable flag would let a compromised or merely stale machine arm spending on another, which is a strictly larger authority than the one being added.

Concretely: plans carry `machineId` in their signed material and a plan committed on a different machine is refused (409); the rendered text names the target machine and nickname so a multi-machine operator always knows which one they are arming; the existing pool-link machinery already resolves a fronting server to the owning machine, so a remote operator drives the Spend tab OF the machine they are enabling.

- **User-facing notices:** none. This change emits no Telegram/attention output at all, so one-voice gating is not needed.
- **Durable state on topic transfer:** the state is machine-scoped, not topic-scoped, so it cannot strand on a topic move — a topic moving to another machine correctly finds that machine's own enable state.
- **Generated URLs:** none generated.

---

## 8. Rollback cost

- **Hot-fix release:** revert the code, ship as a patch. The six routes disappear and the money layer returns to config-key-only construction.
- **Data migration:** none required, but two residues need naming honestly. (a) `state/money-layer-enable.json` persists after a revert; harmless — nothing reads it, and re-applying the change picks the operator's intent back up, which is the desirable direction. (b) The `__probe__` rows inside `routing-spend-caps.json` persist. After a revert the reverted `validateCapsFile` no longer has `__probe__` in its known sets, so **on a machine where the money layer is enabled, a caps read would throw `unknown keyRef '__probe__'` and the money surfaces would fail closed.** That is the safe direction (money refuses rather than over-admits) but it is a real, loud consequence, and the fix is a two-line manual removal of the two `__probe__` entries. Recorded here rather than discovered during an incident.
- **Agent state repair:** none. No existing agent is affected until it exercises the surface.
- **User visibility during rollback:** none on the fleet — every route is additive and the money layer remains dark by default.

---

## Conclusion

The review produced three design changes and one accepted rough edge. The design changes all came from the same place: writing the code against the real gate contradicted the reviewed spec three times, and each contradiction would have shipped as a permanently-broken readiness check that read as a state rather than a bug — a $0 probe cap that the gate refuses as `invalid-cap` before the comparison; a manifest-resident synthetic price that is operator-editable, ages past its freshness SLA and is absent on no-source installs; and a construction predicate keyed on the config file alone, so an operator's PIN-committed enable promised "it comes up on the next restart" and then constructed nothing. The third was found only by driving the flow against a real server, and the same live run surfaced a fourth: an impossible construction (price authority dark) reporting `enable-pending-restart` and telling the operator to restart something a restart cannot fix.

The accepted rough edge is the "PIN rejected" message when no PIN is configured. The tracked gap is the dashboard form.

The change is clear to ship, with two items carried forward explicitly rather than quietly: the Mobile-Complete dashboard UI, and the honest scope limit that no live metered dispatch seam exists — `meteredCallEntry.ts` is the chokepoint that seam must come through, established now so the ordering is a precondition of that work rather than a retrofit onto it.

---

## Second-pass review (REQUIRED — this change adds gate/authority surfaces)

**Reviewer:** `codex-cli:gpt-5.5` — an independent CROSS-MODEL reviewer rather than a subagent of the author, given the artifact and the source and instructed to be adversarial. (This session is configured not to spawn subagents; a different model family is a stronger independent read than another copy of me, and is recorded here rather than quietly substituted.)
**Independent read of the artifact: CONCERN — eight findings, all accepted, all fixed.**

The verdict was "the artifact is not sound", and it was right. Every finding below existed in code that had already passed 67 tests across three tiers and a live end-to-end run on a real server. They are recorded in full — including the two the reviewer rated Critical — because the point of the second pass is the record, not the reassurance.

- **1. CRITICAL — `config-inspect` was an unlimited PIN oracle.** It compared the PIN inline and returned observably different fields on success, without touching any failure counter: a Bearer holder could brute-force the six-digit PIN there, then use it to commit money and restart the server. **Fixed:** every PIN-taking route now funnels through one `checkPin()` on the surface, which enforces the lockout and records the failure. A route can no longer opt out by comparing the PIN itself. Guard: `F1`.
- **2. CRITICAL — a plan could commit an action its rendered text did not authorize.** `money-layer-mirror-config` rendered in every source state, promising to copy the config setting and change nothing spendable — but its commit unconditionally wrote `operatorEnabled = true`. With the config key OFF, an ostensibly no-change "mirror" plan created durable enable intent. That is exactly the approved-text-vs-applied-action gap plan-binding exists to close. **Fixed:** the action is refused (409 `nothing-to-mirror`) where its own text would be false. Guard: `F2`.
- **3. HIGH — the operator's switch did not open the money controls.** Construction moved to the MLE-1 OR, but the route gate `moneyOn()` still read the config key alone. So an operator-only enable produced a machine reporting `enforcementReady: true` while `/routing-spend/plan`, caps adjustment, arming, unfreeze **and the advertised emergency freeze** all still answered 503 — the emergency stop unreachable in exactly the state the operator had just armed. This defeated the feature's whole claim and my Interactions section missed it. **Fixed:** `moneyOn()` is now the MLE-1 OR. Guard: `F3`, which asserts freeze specifically.
- **4. HIGH — the authority/audit coupling was backwards.** Enable and disable mutated the store first and appended the mandatory record second, so a failing append errored *after* the money-authority change had landed — contradicting this artifact's own claim. **Fixed:** record-before-mutate. A record without its change is the safe asymmetry; a change without its record is not. Guard: `F4`.
- **5. HIGH — the restricted audit view leaked spend activity, and the freeze-reason machinery was unwired.** `restart-requested` is pre-gate-visible in full and carried `settlingAtRequest`, a count of in-flight paid calls. Separately, the real freeze route never called `recordFreeze`, so the redaction path that lets an operator see WHY spending stopped had no writer at all. **Fixed:** the count is gone from the row; the freeze route now records through the surface (best-effort, reporting `recordProvisional` when the append fails). Guards: `F5a`, `F5b`.
- **6. HIGH — the surface was not constructed unconditionally.** Its block sat inside the large feature-metrics `try`, so an unrelated `FeatureMetricsLedger` failure jumped to that catch and left the money layer's only door null. **Fixed:** moved outside, with its own try/catch as the only thing that may disable it, and a comment naming the trap.
- **7. The 60-second restart cooldown was not real.** `lastAcceptedRestartAt` was process-local, and the action being rate-limited is the one that ends the process — so every restart reset it. **Fixed:** persisted in the durable store. Guard: `F7`.
- **8. The probe could book phantom money in its own failure case.** If the gate ever admitted the over-cap probe, the ledger booked the $2.00 reserve and the probe reported failure without settling it — permanent phantom committed spend against a door that can never bill. **Fixed:** the probe settles its own booking to $0 before reporting. Guard: `F8`. The reviewer also corrected an overclaim: `null-provider` is a NAME, not an implemented no-op object, since instar has no metered provider dispatch at all — the wording now says what is true, and the cap is named as the protection that is real today.

The reviewer explicitly found **no** signal-vs-authority violation, agreeing the `cap-exceeded` cause check is deterministic rather than heuristic.

**One divergence I made against the spec while fixing 5, recorded because it is mine and not the reviewer's:** the full/restricted line for `caps/log` is keyed on `moneyOn()` rather than the spec's literal `servingReady`. Keying it at `servingReady` would withhold caps rows from an operator whose layer is ON but not yet probed — the state where they most need the log — while withholding nothing from an attacker, because `GET /routing-spend/caps` already serves the same data under `moneyOn()`. A boundary is only as strong as its leakiest surface, so the stricter line bought no secrecy and cost real visibility.

---

## Evidence pointers

- **Tests:** `tests/unit/money-layer-enable-surface.test.ts` (45), `tests/integration/money-layer-enable-routes.test.ts` (15, real Express stack), `tests/e2e/money-layer-enable-lifecycle.test.ts` (7, incl. the 200-not-503-with-the-layer-OFF alive test and a full lifecycle across a simulated process restart with real ledger/caps/price/gate collaborators).
- **Live verification** — a throwaway deploy of the built dist (`instar test-as-self --keep`, `~/.instar/test-deploys/2026-08-17T03-11-50-980Z`, port 4041), driven end to end:
  - `GET /routing-spend/enable-status` → 200 `{lifecycleState:"disabled", enforcementReady:false}` while `POST /routing-spend/plan` → 503 in the same state.
  - `POST /routing-spend/plan-money-layer {action:"caps-adjust"}` → 400 `unknown-action` naming the enum.
  - Wrong PIN → 401 `bad-pin`; correct PIN → 200 `enable-pending-restart`.
  - `restart-nonce` → the confirmation text; restart WITHOUT the hash → 409 `confirmation-hash-mismatch`; WITH the hash → 200 and `state/restart-requested.json` written with `requestedBy: money-layer-enable`.
  - After a real process restart with the config key ABSENT: `{lifecycleState:"probed", enforcementReady:true, enableSources:{state:"operator-enabled", store:true, config:false}}`.
  - Audit trail on disk in order: `enable-source-transition`, `plan-rendered`, `pin-attempt-failed` ×3 (the real failed attempts), `enable-committed` (authority channel), `lifecycle-transition`, `restart-requested`, `restart-initiated`, `probe-result {passed:true, refusalReason:"cap-exceeded", evaluatedUsd:2}`, `restart-observed-ready`.
  - Ledger totals after the probe: `{}` — nothing booked.

---

## Class-Closure Declaration (display-only mirror)

**No agent-authored-artifact defect and no self-triggered controller — not applicable.**

The three build-time defects fixed here are defects in a HUMAN-reviewed spec document being corrected before any code shipped from it, not defects in a deployed agent-authored artifact. No loop, monitor, sentinel, reaper, scheduler or recovery path is added or modified: nothing in this change fires a restart, swap, respawn, spawn, notify, retry, re-drive or kill on its own. The restart is operator-initiated, PIN-gated and single-use-nonce-bound; the probe runs once at boot and once per enable commit, never on a timer.
