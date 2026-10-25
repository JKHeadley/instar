# Side-Effects Review — Subscription re-login completion witness

**Version / slug:** `subscription-relogin-completion-witness`
**Date:** 2026-09-14
**Author:** Echo
**Second-pass reviewer:** Archimedes (`review_relogin_side_effects`)

## Summary of the change

This change removes file-existence as automatic completion proof for Claude follow-me sign-in. `PendingLoginStore` records an opaque pre-login auth revision, `EnrollmentWizard` advances only after that revision changes and then retains the existing exact-email oracle gate, `server.ts` derives the revision from the machine-local keychain without persisting credential bytes, and `routes.ts` strips the internal revision from every HTTP surface. The Subscriptions dashboard also reopens its existing PIN overlay when a repair action lacks current operator proof.

## Decision-point inventory

- `EnrollmentWizard.sweepFollowMeCompletions` — **modified** — automatic completion now requires a changed auth revision instead of an already-existing settings file.
- `EnrollmentWizard.completeFollowMe` — **pass-through** — exact provider identity remains the authority that decides whether the account is selectable.
- Subscriptions dashboard repair/profile controls — **modified** — missing or expired proof invokes the existing unlock surface; the server remains the authorization authority.
- Pending-login API projection — **modified** — internal revision evidence is removed before serialization.

---

## 1. Over-block

A legitimate already-authorized browser short-circuit will remain pending if the provider completes without changing the keychain credential blob. That is the intended fail-closed posture: unchanged credential material cannot prove that this exact attempt succeeded. The operator can still use the explicit paste-back path or reissue the artifact, which captures a fresh baseline. Legacy pending rows without a baseline also cannot auto-complete, but remain recoverable through those existing paths.

---

## 2. Under-block

A credential blob changed by an unrelated process during the same pending window can satisfy the revision precondition. It cannot by itself activate the account: the existing identity oracle must still resolve the exact expected email. The broader assisted-repair orchestrator continues to require fresh authenticated use, active pool state, and closure of the exact incident before declaring repair success. This patch does not turn the revision into a success authority.

---

## 3. Level-of-abstraction fit

The revision comparison belongs in `EnrollmentWizard`, immediately before its existing follow-me completion authority. The server composition owns access to the machine-local keychain and supplies only an opaque witness function. `PendingLoginStore` durably binds the baseline to the exact artifact/reissue. HTTP routes own projection and strip the internal field at the boundary. The dashboard reuses the global PIN overlay instead of creating a second authorization mechanism.

---

## 4. Signal vs authority compliance

**Required reference:** [docs/signal-vs-authority.md](../../docs/signal-vs-authority.md)

- [x] No — this change produces a signal consumed by an existing smart gate.
- [ ] No — this change has no block/allow surface.
- [ ] Yes — but the logic is a smart gate with full conversational context (LLM-backed with recent history or equivalent).
- [ ] ⚠️ Yes, with brittle logic — STOP.

The HMAC revision comparison is a deterministic evidence signal and a hard fail-closed precondition, not the authority that declares the identity or repair successful. Exact identity remains with the provider-backed identity oracle; the approved assisted-relogin state machine retains its independent authenticated-use and incident-closure requirements. Missing evidence means “keep waiting,” not rejection of a user or destructive action.

---

## 4b. Judgment-point check

No new static heuristic is added at a competing-signals judgment point. Whether auth material changed is an enumerable invariant: absent, unreadable, or unchanged evidence cannot prove a new credential landed. No balancing of liveness, urgency, ownership, or conversational meaning is involved.

---

## 5. Interactions

- **Shadowing:** revision evidence runs before `completeFollowMe`; it can delay that identity probe but cannot bypass or replace it.
- **Double-fire:** a per-login single-flight guard and `PendingLoginStore.completeIfVersion()` version CAS ensure that concurrent sweeps run pool finalization and Claude readiness setup exactly once on the winning completion.
- **Races:** each reissue records the current revision as its new baseline. A change from an older attempt therefore cannot satisfy a later artifact, and stale sweep versions cannot finalize a newer row.
- **Feedback loops:** pool activation can trigger ordinary quota polling, but quota data does not feed the revision baseline and cannot retrigger completion.
- **Recovery:** old durable rows fail closed; restart recovery/reissue supplies a baseline without migrating credential material. A thrown pool finalizer leaves the row pending, so a later sweep can retry instead of preserving a false terminal result.

---

## 6. External surfaces

The visible dashboard text changes from the dead-end “unlock again” instruction to an in-place PIN prompt. Pending-login response shapes do not expose the new internal field. The store gains one optional HMAC string; it contains no credential bytes and is machine-local. Timing still depends on the existing periodic completion sweep. No new provider, browser, messaging, or external API action is introduced.

Every touched operator action remains phone-completable: tapping Repair sign-in opens the existing six-digit PIN overlay, after which the same button can be tapped again. No raw token, JSON, ID, or command is requested.

---

## 6b. Operator-surface quality

1. **Leads with the primary action:** Yes. The existing Repair sign-in action remains the visible cell action; an expired proof immediately opens the required PIN overlay.
2. **Zero raw internals as primary content:** Yes. The operator sees only plain-language PIN and retry guidance; revisions, account ids, and credential locations remain hidden.
3. **Destructive actions de-emphasized:** Yes. This change adds no destructive action and does not move cancel/revoke controls.
4. **Plain language + phone width:** Yes. It reuses the existing mobile dashboard overlay and short status copy, introduces no new layout, table column, or horizontal content.

---

## 7. Multi-machine posture

**Machine-local BY DESIGN**, with pool-wide visibility proxied on read. Each auth revision is derived from the credential slot physically held on that machine and must never replicate. `GET /subscription-pool?scope=pool` continues to merge redacted account state across peers; route projection strips the revision before local or peer responses. The dashboard action is routed to the machine holding the target cell. The change emits no user-facing notice, creates no transferable URL, and adds no topic-bound durable state that could strand on transfer.

---

## 8. Rollback cost

- **Hot-fix release:** revert the code change and ship the next patch.
- **Data migration:** none. The optional baseline may remain in pending rows and is ignored by old code.
- **Agent state repair:** none. Existing pending rows remain valid; reissue is the ordinary recovery path.
- **User visibility:** during rollback propagation, an old node could again show dead-end unlock copy or accept file existence as completion proof, so rollback should be fleet-wide and prompt.

---

## Conclusion

The review confirms that the fix adds a narrowly scoped evidence precondition at the correct machine-local boundary. It removes the stale-file false-positive without weakening identity, authorization, or authenticated-use authorities. The material residual is deliberate fail-closed waiting when auth bytes do not change; existing paste-back and reissue paths keep that recoverable. The change is ready for independent review and shipment.

---

## Second-pass review

**Reviewer:** Archimedes (`review_relogin_side_effects`)
**Independent read of the artifact:** Concur. The reviewer verified signal-versus-authority separation; fail-closed absent/unreadable baselines; redaction across the identified HTTP paths; per-login single-flight plus version-CAS completion; retry after pool-finalization failure; exactly-once readiness setup for the winning sweep; and the dashboard 401-to-PIN recovery path.

---

## Evidence pointers

- Focused unit/integration/AgentServer E2E suite: 276 tests passed across 7 files.
- `corepack pnpm build`: passed.
- Repository lint: passed after the operator-authorized countdown update.
- `git diff --check`: passed.
- A repository-wide test attempt reached an unrelated CPU-bound hang in `window-lifecycle-production-wiring.test.ts`; the affected subscription suites completed green independently.

---

## Class-Closure Declaration

`defectClass: unbounded-self-action`, `closure: guard`, `guardEvidence: { enforcementType: ratchet, citation: tests/unit/enrollment-wizard.test.ts, howCaught: repeated completion sweeps with absent, unreadable, or unchanged revision evidence emit no completion; exact version CAS runs finalization once, a thrown finalizer remains pending, and terminal state is the settling brake }`.
