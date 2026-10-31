# Side-Effects Review — Feedback triage account selection

**Version / slug:** `feedback-triage-account-selection`  
**Date:** 2026-10-31  
**Author:** Echo  
**Second-pass reviewer:** GPT-6 Astra, read-only independent review; concurred after the evidence correction below

## Summary of the change

The feedback sorter can select a local Codex subscription whose live `codex` quota is below the existing 75% floor, then bind that account to its exact `codex-cli/gpt-6-astra` call. The setting defaults to `off`. New code in `FeedbackTriageAccountSelector`, `FeedbackTriageService`, `FeedbackDrainStore`, the Codex live reader and model provider, router, config migration and scaffold changes account admission, reservation, launch and audit. Unit, HTTP integration and production lifecycle tests cover those boundaries. The approved design is `docs/specs/feedback-triage-pool-quota.md`.

## Decision-point inventory

- `FeedbackTriageAccountSelector.select` — added — treats a local identity plus live quota as eligibility evidence, with no cached fallback.
- `FeedbackTriageService.beginPrimaryCall` — modified — requires current owner, authority, quota age and account identity before the model launch.
- `FeedbackDrainStore.reserveTriageCall` and `launchTriageCall` — added — transact owner/epoch/authority/cap fences and charge or refund one attempt.
- `IntelligenceRouter` and `CodexCliIntelligenceProvider` — modified — enforce the registered provider/model/account route for triage; no sibling, model or framework fallback after admission.
- `FeedbackTriageService.pauseForQuota` — modified — classifies refusal as a pause, preserving retry and healing counters.

## 1. Over-block

A legitimate ambient Codex login that is not enrolled in the local pool now pauses triage even with available quota; an unreadable `auth.json`, disabled live reader or keyring-only login also pauses. This is deliberate until the serving identity and its quota can be bound. A valid weekly-only window is accepted, exactly 75% is refused, and a later healthy account is tried after earlier unreadable accounts. The pause is visible in status and does not consume a model-call slot.

## 2. Under-block

Replacing a credential after child launch cannot be prevented atomically with the current CLI home interface. The admitted account's fingerprint and login are checked again at completion; a difference produces `execution-identity-unverified`, and the slot stays charged. A crash after reservation but before release may conservatively retain that day's debit. The current local subscription file is a trust boundary; this code does not prove who operates the subscription backend. No cached quota or alternative provider can silently override an unreadable live admission.

## 3. Level-of-abstraction fit

The selector's threshold, timestamp and identity tests are hard invariants of the approved spend envelope, not a judgment about report contents. The registered triage authority still chooses dispositions from the report packet. Account eligibility feeds that existing authority and is bound again at launch. The transactional store, rather than an in-memory precheck, owns the owner/epoch/cap reservation because competing processes can race there.

## 4. Signal vs authority compliance

The change adds deterministic safety bounds on spend and identity. These are the hard-invariant and irreversible-spend exceptions described in [signal vs authority](../../docs/signal-vs-authority.md). It does not give a regex or report-content heuristic authority to decide a feedback disposition. The LLM arbiter remains the single disposition authority; the account selector only proves that a model invocation is permitted under the operator-approved envelope.

## 4b. Judgment-point check

No static heuristic resolves competing feedback signals. The 75% floor was already approved and is applied to each verified account; the selector chooses the lowest measured usage among eligible completed reads, then account ID for a stable tie. It does not grade a report or change the severity rubric.

## 5. Interactions

- **Shadowing:** strict routing runs before the provider call, and provider-level `strictModelPin` prevents its older unsupported-model fallback. The arbiter's post-response model check remains defense in depth.
- **Double-fire:** one transactionally unique reservation token charges each primary call. A competing release and launch have one winner; repeated release is inert. The service's explicit retry selects and reserves again.
- **Races:** after asynchronous quota reads, owner, authority, credential version and deadline are rechecked. Launch and refund are fenced in the shared SQLite ledger. A child already launched remains charged through handoff.
- **Feedback loops:** a quota refusal records a pause, not a model failure, so it does not increment unusable/healing counters or trigger a mistaken retry escalation. The queue-pace tuner reads the same verified account quota that primary triage can spend. It passes its stricter 65% ceiling into an extra tick, which rechecks the selected account before any model-call reservation; a lost margin stops the tick and steps the tuner down. The shared queue diagnostic classifies that stop as quota evidence rather than a normal run. This prevents an ambient 93% login from suppressing a healthy spare account and an ambient 10% login from accelerating work on a selected account already above the pace margin.

## 6. External surfaces

The `off`/`observe`/`on` config field and migration are installed for existing agents. The user-visible effect is that feedback triage may pause on an unverifiable ambient account, or use a verified spare account when `on` is deliberately enabled. The replicated audit contains opaque account, attempt and reservation IDs, owner tenure, quota family, bounded usage, timestamps and outcome; it excludes credential bytes, home, email, login identity and report text. No new operator approval action or URL is introduced. The selector sends no new message directly; the existing quota-pause notice remains owner-gated.

## 6b. Operator-surface quality

No dashboard renderer, approval page or form is changed. No new operator action is introduced; this section is not applicable.

## 7. Multi-machine posture

**Machine-local by design:** credential homes and live Codex sessions belong to one machine. The canonical owner alone runs selection and launches the model; remote agents obtain the existing owner-proxied triage status. Reservations and allowlisted lifecycle events live in the shared feedback drain ledger and are replicated through its existing path. The event stream names the launching owner tenure and completion observer so a handoff remains reconstructible. The existing one-voice notice gate and dashboard URL behavior are unchanged.

## 8. Rollback cost

Set account selection back to `off` to stop spare-account choice. That mode still enforces live quota, exact provider/model and verified ambient identity, so an unenrolled or unreadable account will pause rather than spend. A code rollback needs a patch release; the additive SQLite reservation tables may remain harmlessly present, and already charged daily slots must not be deleted. Agents receive the config and awareness migration through the normal update path. Queue throughput may stay low during rollback until a verified ambient login is available.

## Conclusion

The main tradeoff is a visible pause when identity or quota cannot be proved. The change is Tier 2 because it touches credential identity, spend admission, persistent counters and multi-machine ownership. The approved spec had six convergence rounds; the first independent Astra implementation review raised four findings, all addressed in the current local candidate. This artifact precedes exact-head full-suite and live rollout evidence; those gates remain open.

## Second-pass review (required)

**Reviewer:** GPT-6 Astra (`/root/account_side_effect_review`), read-only.  
**Independent read of the artifact:** The reviewer concurred with the signal/authority boundary, deliberate pause behavior, post-launch identity risk, machine-local choice, and rollback limits. It found that the first class-closure wording overstated what the convergence fixture tests. I narrowed that declaration below: the ratchet covers the durable per-item 24-hour throttle, while separate reservation tests cover daily and per-kind caps. The reviewer re-read the correction and concurred, with no remaining mismatch. The reviewer did not run tests.

After the queue-pace integration was rebased in, the same reviewer identified two cross-system mismatches: the tuner read ambient quota while triage could spend from a selected account, and the shared bottleneck classifier treated a new margin refusal as a normal tick. The candidate now reads verified selected-account quota, carries the tuner's stricter ceiling into the accepted tick, and classifies `quota-margin-lost` as quota evidence. The reviewer re-read both fixes and reported no remaining findings. The reviewer did not run tests.

## Evidence pointers

- Focused reader/model tests: 45/45, including a SIGTERM-resistant child.
- Focused selector/arbiter/service tests: 80/80, including post-launch credential change and handoff reconstruction. Follow-up triage and queue-pace focused tests: 127/127, including selected-versus-ambient quota, an accepted tick whose account loses the pace margin before spend, and bottleneck classification that preserves quota refusal evidence.
- HTTP integration: 9/9, including an over-limit ambient login and eligible spare.
- TypeScript and full lint: exit 0; production lifecycle and aggregate suite are pending the shared test lane.

## Class-Closure Declaration (display-only mirror)

`defectClass: unbounded-self-action`; `closure: guard`; `guardEvidence: { enforcementType: ratchet, citation: tests/unit/self-action-convergence.test.ts, howCaught: the existing feedback-triage-tick fixture models the durable per-item 24-hour requeue throttle under sustained pressure and restart. The ratchet fails if that modeled controller starts repeated per-item calls inside the floor. The fixture does not exercise the production reservation store or daily and per-kind caps; tests/unit/feedback-factory/triage-arbiter.test.ts directly tests those reservation limits and their transactional accounting. This change retains those limits and never retries a quota refusal. }`. The account-selection defect also has direct semantic tests for live quota and identity boundaries. The machine-readable decision record must carry this narrowed declaration.
