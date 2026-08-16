# Side-Effects Review — cross-machine account follow-me keeps the account's kind

**Version / slug:** `followme-provider-framework-carry`
**Date:** `2026-08-16`
**Author:** `Echo (instar-dev agent)`
**Second-pass reviewer:** `not required — see Phase 5 note below`

## Summary of the change

When the operator approves an account "follow-me" from one machine to another, the target machine has to work out what kind of account it is before it can sign in. If the account is held only by a peer, that lookup threw the kind away and assumed `anthropic` / `claude-code` every time. A Codex account therefore ran the Claude sign-in flow, into a `.claude-followme-*` config home that `codex` never reads, so the login could not complete — and the delivered-mandate consumer re-drove it on a cadence forever. This change carries the holder's `provider`/`framework` through the three hops that dropped it, fails closed when holders disagree about an account's kind, and derives the config-home prefix from the framework instead of hardcoding `claude`.

Files touched: `src/core/fetchPeerSubscriptionViews.ts` (carry the two fields off the peer's plain pool response), `src/core/accountFollowMeDepth.ts` (`MachineAccountRow` gains optional `provider`/`framework`), `src/core/resolveFollowMeEnrollTarget.ts` (use the holder's kind; new `account-record-kind-conflict`; new `followMeConfigHomePrefix` helper), `src/coordination/FollowMeConsumerBackoffStore.ts` (route the new code into the existing identity/repair lane), `src/server/routes.ts` (framework-derived config home on the enroll-start path).

## Decision-point inventory

- `resolveFollowMeEnrollTarget` (kind resolution) — **modify** — the account's provider/framework now comes from the holder that actually has the account, rather than a default.
- `resolveFollowMeEnrollTarget` (kind-agreement refusal) — **add** — holders that state a kind must agree; disagreement refuses rather than picking one.
- `classifyFollowMeFailure` (retry lane) — **modify** — the new refusal code joins the existing `identity` lane, which is the operator-repair lane rather than the retry-forever lane.
- `POST /subscription-pool/follow-me/enroll/start` (config-home allocation) — **modify** — prefix follows the framework. The mandate authorization on this route is untouched.

---

## 1. Over-block

**What legitimate inputs does this change reject that it shouldn't?**

One new refusal exists: `account-record-kind-conflict`, raised when two holders both state a kind for the same account id and the providers disagree (e.g. the local pool says `anthropic` and the Mini says `openai` for account `a1`).

The realistic way to hit this without a genuine data problem is an account id reused across two different providers — an operator naming a Claude account and an OpenAI account with the same id on different machines. That configuration is already broken for the existing email-agreement check (the two accounts would have different emails and would already refuse with `account-record-email-conflict`), so the new refusal adds essentially no new rejection surface. Where it does fire first, the outcome is a 409 naming the problem and asking for a repair, which is the correct answer — the alternative is silently signing in to whichever machine answered first.

A holder that omits the kind entirely (an older peer build whose `/subscription-pool` response predates this change) abstains rather than voting, so a mixed-version mesh does not manufacture a conflict. That is covered by a unit test.

---

## 2. Under-block

**What failure modes does this still miss?**

- **A holder that reports the wrong kind.** The resolver trusts the holder's own pool record. If a machine's pool has an account mis-tagged (which is exactly what a pre-fix `.claude-followme-*` codex enrollment could leave behind), this change carries that wrong value faithfully. It fixes the discarding, not the mis-tagging.
- **A single holder, no cross-check.** With exactly one holder there is nothing to agree with, so a wrong kind passes unchallenged. Agreement only helps when two machines both know the account.
- **The framework is trusted, the credential is not verified.** Choosing `codex-cli` selects the right sign-in flow and the right home; it does not verify that what lands there is a working credential. The existing identity oracle and the `expectedEmail` gate still own that.
- **Existing wrong-home slots are not migrated.** A pending login already sitting on a `.claude-followme-<codex-account>` path keeps that path. See §8.

---

## 3. Level-of-abstraction fit

`resolveFollowMeEnrollTarget` is already the single place that answers "what is the operator-approved enrollment target for this account", and it already resolves email + provider + framework + label together. The provider/framework answer belongs in the same function as the email answer, under the same holder-agreement discipline — splitting them would create two places that can disagree about the same account.

`followMeConfigHomePrefix` sits next to the resolver rather than in the route because the prefix is a pure function of the resolved framework, and a route is the wrong place to keep a mapping that wants unit tests. The route keeps the `path.join` and the id sanitisation, which are its own concerns.

`fetchPeerSubscriptionViews` is the only seam where the peer's response is parsed, so it is the correct and only place to stop discarding the fields. No higher-level gate already answers this question; nothing here runs parallel to an existing check.

---

## 4. Signal vs authority compliance

**Required reference:** [docs/signal-vs-authority.md](../../docs/signal-vs-authority.md)

**Does this change hold blocking authority with brittle logic?**

- [ ] No — this change produces a signal consumed by an existing smart gate.
- [ ] No — this change has no block/allow surface.
- [x] Yes — but the logic is a smart gate with full conversational context (LLM-backed with recent history or equivalent).
- [ ] ⚠️ Yes, with brittle logic — STOP.

The "or equivalent" is what applies, and it is worth being precise rather than leaning on the checkbox. The new refusal is not a heuristic reading of ambiguous input: it compares two recorded, structured values (`provider` on two holder records) for equality. There is no inference, no pattern-matching, no guess about intent — the domain is a small enumerable set of provider strings, and disagreement is an objective fact about the data, not a judgment about it. It is the same shape as the `account-record-email-conflict` refusal already in this file, which is the established pattern for this exact class of question.

The refusal also carries no authority of its own beyond stopping: it emits a typed code that the existing `FollowMeConsumerBackoffStore` consumes to choose a lane. The decision about what to do next lives in the consumer, where it already lived.

---

## 4b. Judgment-point check (Judgment Within Floors standard)

No new static heuristic at a competing-signals decision point. The kind-agreement check is an invariant, not a judgment: an account has exactly one provider, so two holders naming different providers for one account id is a contradiction in the records rather than a genuine conflict of live signals to be weighed. The enumerable domain is the provider set carried on pool records. No floor/arbiter is needed because there is nothing to arbitrate — the correct response to contradictory records is to stop and say so.

---

## 5. Interactions

- **Shadowing:** the kind-agreement check runs *after* the existing email-agreement check in the same function, deliberately. Email conflict is the more informative diagnosis and the one operators already have a repair path for, so it keeps precedence; a record set that is wrong in both ways reports the email conflict. Nothing that previously ran is skipped — the new check only executes on inputs that already passed email agreement.
- **Double-fire:** none. The resolver is called once per enroll-start request, and the second call site (`routes.ts:30039`) reads the same result rather than re-deriving it.
- **Races:** none introduced. The function is pure over its inputs; the peer views it consumes are fetched per request and not shared mutable state.
- **Feedback loops:** this change *closes* one. The delivered-mandate consumer re-drives enroll-start on a cadence and skips accounts already pending or enrolled; because the wrong-provider login could never reach either terminal state, that loop never settled. Routing the new refusal into the `identity` lane (rather than the generic retry lane) means a contradictory record set parks for operator repair instead of re-driving indefinitely — the same treatment the email-conflict code already gets.

---

## 6. External surfaces

- **Other agents on the same machine:** none. No shared state or IPC surface changes.
- **Install base:** the enroll-start route gains one new `code` value (`account-record-kind-conflict`) on an existing 409 response shape. The response fields are unchanged (`error`, `code`, `accountId`, `repairRequired`), so a caller reading `error` or branching on the status code is unaffected. The consumer that branches on `code` is updated in the same change.
- **External systems:** the provider sign-in flow selected for a follow-me enrollment can now be OpenAI's device-code flow where it previously was always Claude's URL-code-paste flow. That is the intended fix; `EnrollmentWizard.remoteKind` already routed `openai` to device-code, so no new provider interaction is introduced — it is finally reachable.
- **Persistent state:** new codex follow-me enrollments write their config home to `~/.codex-followme-<id>` instead of `~/.claude-followme-<id>`. Existing claude-code slots keep their exact paths (verified by a test asserting the unchanged prefix).
- **Timing/runtime:** none.
- **Operator surface (Mobile-Complete):** no operator-facing action is added. The operator's surface for this flow — the Subscriptions tab's pending-login panel and the approve/submit-code path — is unchanged; this change only affects which sign-in a pending login represents. A `account-record-kind-conflict` refusal surfaces through the same pending/failure path as the existing conflict code, with a plain-English `reason` string written for a non-engineer ("recorded as a different kind of account on different machines").

---

## 6b. Operator-surface quality

No operator surface — not applicable. No dashboard renderer, markup file, approval page, or grant/revoke/secret-drop form is touched.

---

## 7. Multi-machine posture (Cross-Machine Coherence)

**Posture: proxied-on-read.** This code path exists only because of multi-machine operation — it is the resolution step for an account held by a *peer*. The read is the existing per-peer fan-out to each machine's plain `/subscription-pool` (`fetchPeerSubscriptionViews`), and this change widens the projection carried over that read by two fields.

- **User-facing notices:** none emitted. No one-voice gating needed.
- **Durable state:** the config home allocated on the target machine is machine-local by design — a credential lives on the disk of the machine that holds it, and follow-me exists precisely because a login does not travel. It does not strand on topic transfer because it is not topic-scoped.
- **Generated URLs:** none.
- **Mixed-version mesh:** explicitly handled. A peer running an older build omits the two fields; the resolver treats absence as "unknown" and abstains rather than defaulting, so an un-upgraded peer degrades to today's behavior for its own accounts and never manufactures a conflict for others. Covered by test.

---

## 8. Rollback cost

- **Hot-fix release:** revert the commit, ship as the next patch. Pure code change.
- **Data migration:** none required. New codex enrollments would go back to allocating `.claude-followme-*` homes (i.e. back to being broken), but nothing written by this change needs cleanup. A `~/.codex-followme-*` directory created while the fix was live is inert after a revert — it is a config home no longer referenced, not corrupt state.
- **Agent state repair:** none. Agents with no codex account in a peer pool are unaffected entirely.
- **User visibility during rollback:** the only visible regression is the original bug returning for cross-machine codex enrollments. No user-visible breakage of anything that works today.

---

## Conclusion

The review did not change the design, but it did tighten two things. First, the kind-agreement check was deliberately ordered *after* the email-agreement check rather than before, so the more actionable diagnosis keeps precedence. Second, the new refusal code was routed into `FollowMeConsumerBackoffStore`'s existing `identity` lane rather than left to fall through to the generic retry lane — without that, the fix for one infinite retry loop would have opened a narrower one, since a contradictory record set is no more fixable by retrying than a missing email is.

The change is clear to ship. Its residual risk is that it faithfully carries a *wrong* kind if a holder's pool record is mis-tagged, which is a separate defect with a separate repair path (re-register the account), and it is a strict improvement over discarding the value entirely.

---

## Second-pass review (if required)

**Reviewer:** not required.

The Phase 5 trigger list is block/allow decisions on outbound messaging, inbound messaging or dispatch; session lifecycle; context exhaustion/compaction/respawn; coherence gates, idempotency checks, trust levels; and anything named sentinel/guard/gate/watchdog. This change touches none of them: it does not alter the mandate gate that authorizes the enroll-start route, does not touch session lifecycle, and adds no messaging block/allow surface. The one added refusal is a data-agreement check on structured pool records, matching an existing pattern in the same file.

---

## Evidence pointers

- Live reproduction: laptop pending-login `codex-sagemindai` recorded as `provider: anthropic`, `framework: claude-code`, `configHome: ~/.claude-followme-codex-sagemindai`, while the same account on the Mini is `provider: openai`, `framework: codex-cli`, `configHome: ~/.codex-followme-sagemindai`. Server log shows the repeating `started url-code-paste login for codex-sagemindai (anthropic)` → `follow-me completion codex-sagemindai HELD (missing-completed-email)` cycle.
- `tests/unit/resolve-follow-me-enroll-target.test.ts` — holder kind carried for a peer-only account; local kind preferred; disagreement fails closed; a holder omitting the kind abstains; config-home prefix per framework and unchanged for claude-code.
- `tests/unit/fetch-peer-subscription-views.test.ts` — provider/framework carried through the peer projection; malformed/absent values stay absent rather than being invented.
- `tests/integration/account-follow-me-enroll-start-route.test.ts` — a peer-held Codex account drives the OpenAI login and lands in `.codex-followme-*`; a peer-held Claude account keeps `.claude-followme-*`.

---

## Class-Closure Declaration (display-only mirror)

- **`defectClass`** — `unbounded-self-action`
- **Why it applies:** this change modifies the failure classification consumed by the delivered-mandate follow-me consumer, a self-triggered controller that re-drives enroll-start on a cadence.
- **Convergence argument:**
  - *Control-loop edge:* the consumer re-drives enroll-start for any mandated account that is neither pending nor enrolled. A wrong-provider login could reach neither state, so the error edge fed straight back into the drive edge with no decreasing quantity — an unbounded loop by construction.
  - *Steady-state bound:* fixing the provider resolution makes the intended terminal state reachable, so the normal path now terminates. For the path that still cannot terminate — contradictory holder records — the new refusal is classified into the `identity` lane, which parks the account after its bounded attempt budget instead of re-driving.
  - *Settling brake:* the existing per-(account, machine) backoff budget in `FollowMeConsumerBackoffStore` (4 attempts, then parked) is the brake; this change ensures the new refusal reaches it rather than bypassing it via the generic lane.
- **`guardEvidence.howCaught`:** `tests/unit/follow-me-consumer-backoff-store.test.ts` covers the identity-lane classification; the integration test asserts the enrollment reaches its terminal 201 with the correct provider, which is the state that ends the loop.
