# Side-Effects Review — evidence-bearing topic-operator bindings

**Version / slug:** `topic-operator-evidence`
**Date:** `2026-08-17`
**Author:** `instar-codey`
**Second-pass reviewer:** `Codex subagent /root/s4_second_pass`

## Summary of the change

`TopicOperatorStore` no longer treats a non-blank uid and a provenance label as proof of an authenticated operator. The real Telegram lifeline-forward and polling paths now call `setAuthenticatedOperator` after their existing sender-authorization check and attach evidence naming the ingress, authorization decision, sender uid, and message id. The manual `POST /topic-operator` compatibility route writes an inspectable `operator-api-assertion`; verified readers independently reject it. Legacy evidence-less rows and malformed/forged evidence are also rejected. The read routes expose verified operators separately from raw bindings, and only verified bindings enter the existing advisory replication seam. Consumer fixtures were moved onto the evidence-bearing writer so their intended authority is explicit.

This changes a hard identity invariant at `src/users/TopicOperatorStore.ts#isVerifiedTopicOperatorBinding` and the two authenticated writer call sites in `src/server/routes.ts` and `src/commands/server.ts`. The real route, store, ingress, replication, consumer, and lifecycle tests are updated accordingly.

Driving approved spec: `docs/specs/outbound-gate-tiered-fail-direction.md`, whose load-bearing wiring precondition requires `getOperator(topicId)` to read a LOCAL auth-bound record set from an AUTHENTICATED sender, never a replicated or ambiguous binding, and whose recipient-class decision must fail closed when that verified binding is absent. This fix makes that premise true at the store boundary instead of trusting a route-body assertion. It also composes with approved WS2.3 REQ-M8/M14, which keep self-reported/peer identity data non-authoritative and `TopicOperatorStore` identity resolution local-only. The original feature design is recorded in the historical `OPERATOR-IDENTITY-BINDING-SPEC`, whose establishment requirement says the operator comes from the platform-authenticated inbound sender, never a body/content assertion.

## Decision-point inventory

- `isVerifiedTopicOperatorBinding` — **add** — deterministic structural authority boundary: only a binding carrying complete, recognized, uid-matching establishment evidence is a verified operator.
- `TopicOperatorStore.setOperator` — **modify** — manual/API input is persisted as an assertion with no operator authority.
- `TopicOperatorStore.setAuthenticatedOperator` — **add** — authenticated ingress writer validates evidence before persistence and replication.
- `/internal/telegram-forward` operator auto-bind — **modify** — passes evidence only after `isAuthorizedSender` succeeds.
- Telegram polling operator auto-bind — **modify** — passes evidence only after `isAuthorizedSender` succeeds.
- verified reader methods (`getOperator`, `all`, `asVerifiedOperator`, `sessionContextBlock`) — **modify** — all funnel through the same independent evidence predicate.

## 1. Over-block

The intentional newly rejected inputs are:

- A manual `POST /topic-operator` body containing a legitimate Telegram uid. The route cannot prove that the human identified by that body sent or authorized the request, so treating it as verified would preserve the defect. The raw assertion remains durable and inspectable.
- A legacy row with `boundFrom: authenticated-inbound` but no establishment evidence. Some of those rows may have originated from genuine Telegram traffic; the old shape cannot distinguish them from rows minted by the loose API. They resolve to not verified until the next authorized Telegram message rewrites the topic through the evidence-bearing path.
- A real authorized message whose message id is missing or blank. The binding is not created because the requested property is evidence of a concrete inbound event, not merely a sender string. Message processing itself continues; only operator establishment is withheld.

No content/message judgment is made. These are enumerable structural requirements at an identity boundary.

## 2. Under-block

- `AuthenticatedTopicOperatorEvidence` is a runtime data structure, not a cryptographic capability. A future internal caller could construct it incorrectly. The present production caller census is closed to the two Telegram paths, each immediately downstream of `isAuthorizedSender`, and tests pin both. Any future writer must be reviewed against the same invariant.
- Authorization evidence records the name of the existing authorization decision, not its full policy inputs or a signed receipt. This change preserves enough provenance to distinguish the live authenticated paths from the manual assertion path; it does not build a general authentication-attestation system.
- Only Telegram has a verified establishment path today. A future WhatsApp or Slack writer must add a recognized evidence variant rather than reuse a Telegram label.
- A corrupted store still degrades to no verified operator. That is fail-closed for authority, but the existing store does not emit a dedicated corruption alert.

## 3. Level-of-abstraction fit

The evidence predicate belongs at the store's verified-reader boundary. Putting the rule only in the HTTP route would leave polling, lifecycle consumers, direct store callers, legacy disk rows, and future readers free to trust the old label. Putting it only in each consumer would duplicate and eventually diverge the identity policy. One store-level oracle gives every authority-bearing read the same answer while keeping `getBinding`/`allBindings` available for non-authoritative inspection.

The authorization decision itself remains in the messaging adapter, where platform sender identity is available. The store does not try to re-authenticate Telegram; it checks that the persisted evidence is complete and internally consistent.

## 4. Signal vs authority compliance

**Required reference:** [docs/signal-vs-authority.md](../../docs/signal-vs-authority.md)

- [ ] No — this change produces a signal consumed by an existing smart gate.
- [ ] No — this change has no block/allow surface.
- [ ] Yes — but the logic is a smart gate with full conversational context.
- [x] Yes, deterministic hard-invariant validation at an identity boundary — the documented exception to the judgment rule.

This predicate holds blocking authority, but not over message meaning or human intent. Its domain is closed and structural: recognized evidence kind, recognized ingress, exact authorization label, non-blank ids, and uid equality. “Does this row prove how it was established?” is an identity-record invariant. Allowing an LLM or conversational authority to override missing authentication evidence would be the unsafe design.

## 4b. Judgment-point check (Judgment Within Floors standard)

No new static heuristic at a competing-signals decision point. There are no competing signals to weigh: the persisted record either carries complete evidence from a recognized production ingress with the same uid, or it does not. Unknown and malformed inputs resolve to not proven. This is an enumerable hard invariant, not a judgment point.

## 5. Interactions

- **Shadowing:** the messaging adapters' existing `isAuthorizedSender` checks still decide whether an ingress may call the verified writer. The store predicate adds a persistence/read invariant; it does not bypass or replace sender authorization.
- **Double-fire:** both Telegram ingress paths may observe messages, as before. The store's existing identical-record/idempotency path preserves the first establishment evidence and avoids per-message rewrites. An assertion and a later authenticated bind for the same topic intentionally replace one another; the latest real authenticated message can heal an assertion or legacy row.
- **Races:** the file store retains its existing in-process cache/write behavior. This change adds no new concurrency model.
- **Replication:** asserted bindings never emit. Evidence-bearing local bindings use the existing best-effort advisory emitter. Replicated rows still have no apply path into the local authoritative store.
- **Consumers:** session context, principal-coherence, bias-to-action, topic profiles, and review context already call verified-reader methods. Their fixtures now use `setAuthenticatedOperator`, making the source of their authority explicit.

### Migration-window empty-read audit

The legacy-row window was traced through every production consumer rather than inferred from the store's authority posture:

| Consumer | Empty verified read | Behaviour relative to a verified row |
|---|---|---|
| Tone recipient classification | Classifies the recipient as `external`. | **Stricter**: takes the documented safe review/fail-direction side. |
| Standing-authorization resolution | Returns `present:false`; no prior grant reaches B17. | **Looser only for sending another approval ask**: a redundant ask is no longer rejected as a false blocker. It grants no action authority. Raw legacy uid cannot safely recover the historical grant, so this bounded self-healing regression remains documented until re-verification. |
| Principal-coherence observation | Treats attributions as unverifiable. | **Stricter signal / enforcement-neutral**: can produce more observe-only findings; it cannot block or rewrite. |
| Scope-accretion ratification | Sender can never equal a null operator uid. | **Stricter**: conversational ratification is refused. |
| Matrix acceptance | Sender can never equal a null operator uid. | **Stricter**: conversational acceptance is refused; PIN acceptance remains separate. |
| Remote attention acknowledgement principal | Falls back to the literal annotation `operator`. | **Enforcement-neutral, provenance weaker**: Bearer auth is the route authority and the header is explicitly annotation-only; precedence checks are unchanged. |
| Pool-transfer topic-pin provenance | Records the already Bearer-authorized mutation as agent provenance. | **Enforcement-neutral, provenance weaker**: mutation admission is unchanged; no operator claim is fabricated. |
| Topic-profile writes | `boundOperator` returns null. | **Stricter**: token and Telegram writes both return `no-bound-operator`. |
| Goal-realignment priority intake | Supplies an empty operator uid, which cannot equal the sender uid. | **Stricter**: the message is excluded as `unverified-sender`. |
| Replicated topic-operator union origin | Materializes no local origin record. | **Stricter / less disclosure**: no advisory record is exposed; it has no apply path into local authority. |
| Outbound-review conversation context | Before the follow-up fix, null fell through to `single-sender` for a one-sender history. It now checks `getBinding`: raw-present + verified-absent forces `weak-corroboration-only`, with no row tagged as operator. | **Was looser; fixed to stricter**. A real provider-path E2E test pins the distinction. |
| Mesh sender-validation arm | Has no operator bypass. Degenerate registry still delivers as before; populated registry still validates the actual sender; corrupt/unresolvable cases lose the operator exception. | **Same or stricter**: never admits a sender that the verified-row case would reject. |
| Nickname-relocation topic-pin provenance | Records the direct authenticated command as agent provenance. | **Enforcement-neutral, provenance weaker**: relocation admission is unchanged; no operator claim is fabricated. |
| Replicated PUT emission | No old row is emitted during the window; the next authenticated bind emits normally. | **Enforcement-neutral**: emission is a post-bind side effect, not an admission fallback. |

The two read-only HTTP/session surfaces are not authority consumers: session context reports `present:false`, and the inspection routes return `operator:null` alongside the retained raw `binding`. They expose the pending distinction without granting it authority.

## 6. External surfaces

- `POST /topic-operator` still returns 200 for a non-blank uid, but its returned row is labelled `operator-api-assertion` rather than `authenticated-inbound`.
- `GET /topic-operator` now returns `{ operators, bindings }`; `operators` is authority-bearing and filtered, while `bindings` is raw inspection data.
- `GET /topic-operator/:topicId` now returns `{ operator, binding }` for the same separation.
- Existing installs may temporarily see `operator: null` for legacy rows until an authorized Telegram message re-establishes them with evidence.
- The durable JSON shape gains `establishmentEvidence`; assertion rows can remain on disk.
- No new operator-facing action is added. The manual API is an agent/developer compatibility surface and explicitly cannot grant operator authority. Normal auto-binding remains automatic.

## 6b. Operator-surface quality (Operator-Surface Quality standard)

No dashboard, approval page, form, or other operator surface is changed — not applicable.

## 7. Multi-machine posture (Cross-Machine Coherence)

**machine-local BY DESIGN for authority; replicated as advisory context only.** This preserves the existing TopicOperatorStore/TopicOperatorReplicatedStore split: only a binding established from an authenticated sender on this machine can answer “who is my verified operator here?” Evidence-bearing bindings may emit the existing disclosure-minimized advisory projection to peers. Assertions do not emit, and peer records have no apply path back into the authoritative store.

- **User-facing notices:** none; no one-voice gate is needed.
- **Durable state / topic transfer:** the authoritative row remains local by design. A transferred/fronted topic must establish authority from authenticated local ingress; advisory replication cannot silently take over.
- **Generated URLs:** none.

## 8. Rollback cost

- **Hot-fix release:** the safest rollback retains `isVerifiedTopicOperatorBinding` and the asserted/manual distinction while reverting surrounding response-shape or documentation changes. Reverting the predicate itself reopens the security defect.
- **Data migration:** assertion rows may exist after shipment. A complete code revert to the old reader would interpret any such row according to the old loose semantics. Therefore a full rollback must first remove/quarantine `operator-api-assertion` rows or retain a compatibility reader that refuses them.
- **Agent state repair:** no reset is required for evidence-bearing rows. Legacy rows heal on the next authorized inbound message.
- **User visibility:** during rollout, legacy topics can temporarily lack verified operator context. Authority-bearing consumers refuse it. The one outbound-review path that could have reinterpreted absence as a single-sender license now uses raw-binding presence to force weak corroboration; standing authorization may temporarily allow a redundant approval ask because an unverifiable legacy uid cannot safely recover a prior grant.

## Conclusion

The change closes the exact provenance-laundering path: a body uid remains recordable, but it cannot become verified authority; only the two real authenticated ingress paths attach evidence, and every authority-bearing reader independently validates it. The main residual risk is that establishment evidence is a typed runtime record rather than a signed capability; keeping the writer census closed and mutation-measuring the live guard are therefore load-bearing. The implementation is ready for independent second-pass review and the separate Phase B acceptance instrument verdict.

## Second-pass review (required)

**Reviewer:** Codex subagent `/root/s4_second_pass`
**Independent read of the artifact:** concur

Concur with the review. The first pass found four blocking defects: a synthetic lifeline message id could be laundered through the polling writer; adapter P3b's C2 check was contradictory; valid JSON `null` could throw at the store boundary; and the artifact carried trailing whitespace. All four were corrected. The re-review drove the real route into `wireTelegramRouting`, confirmed present raw ids preserve lifeline evidence and missing raw ids leave both raw and verified bindings absent, checked P3b/P5's repaired mutations, and confirmed null/array/malformed/legacy inputs resolve to not-proven. Independent verification passed 4 targeted files / 37 tests, `npx tsc --noEmit`, and `git diff --check`.

This is `/instar-dev` Phase 5 concurrence only. It is not the separate Phase B instrument verdict or an `EFFECTIVE` certification.

Follow-up concurrence after the migration-window consumer audit: the reviewer confirmed that production and E2E now share `buildConversationContextForTopic`; raw-present/verified-absent forces weak corroboration while genuinely never-bound single-sender behaviour is preserved. The reviewer independently traced the standing-authorization redundant-ask limitation, annotation-only remote ack fallback, same-or-stricter mesh validation, and provenance-only pin fallbacks, and found the fourteen-row classification supported. Five focused unit files passed (73/73), with TypeScript and diff checks clean. The E2E was statically reviewed because the machine's capacity-one suite lane timed out before tests started; S4's own real E2E execution passed 7/7 and its type-preserving hollow control failed the substantive route assertion. This remains Phase 5 concurrence, not Phase B instrument certification.

## Evidence pointers

- `tests/unit/topic-operator-store.test.ts` — forged self-report, assertion refusal, malformed/legacy fail-closed, non-vacuous mixed enumeration, positive authenticated control.
- `tests/integration/topic-operator-routes.test.ts` — real manual HTTP route plus real on-disk assertion and verified-reader refusal.
- `tests/integration/topic-operator-autobind-route.test.ts` — real authorized lifeline path with exact evidence plus unauthorized negative control.
- `tests/integration/topic-operator-polling-bind.test.ts` — real polling seam evidence.
- `scratchpad/phaseB/REPORT-S4.md` — before/after reproduction and manual P3 deciding output.
- `scratchpad/phaseB/adapters/topic-operator-evidence.mjs` — lane-authored adapter awaiting independent instrument execution.

## Class-Closure Declaration (display-only mirror)

No agent-authored-artifact defect and no self-triggered controller — not applicable.
