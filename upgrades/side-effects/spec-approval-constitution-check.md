# Side-Effects Review — A spec or design approval request must carry its constitution check result

**Version / slug:** `spec-approval-constitution-check`
**Date:** `2026-11-15`
**Author:** `echo`
**Second-pass reviewer:** `independent subagent (see below)`

## Summary of the change

Echo Bugs topic 10000002750: a design spec reached the operator for approval before the built-in constitution check had run, because the check only runs inside /spec-converge. This change (1) records every run of `POST /spec/conformance-check` in a small ledger (`src/core/specConstitutionCheckLedger.ts`, written from `src/server/specReviewRoutes.ts`, served locally by the new `GET /spec/constitution-checks`); (2) adds rule `B24_SPEC_APPROVAL_UNCHECKED` to the outbound gate (`src/core/MessagingToneGate.ts`), rendered on every non-health-alert review with the merged records (local + online peers, `SpecCheckPeerCache` in `src/server/routes.ts`); (3) judges agent-written Work Board cards and questions with the same rule (`src/server/workBoardRoutes.ts`, one LLM call, two tiers); (4) adds one awareness entry. Tier 1 declared (a revert fully undoes it; no migration, no config, the ledger is inert without the code). Size: about 10 files, ~650 lines with tests. Effort: 3 runs of the built-in constitution check on the spec (4 → 3 → 3 flags), no commit attempts yet at writing. The risk-floor signal is likely raised by "new authority to block": the gate already holds block authority; this adds one reason, and the way through is always the agent's own.

## Decision-point inventory

- `MessagingToneGate` rule set — modify — new blocking rule B24 (signal-driven class), exempt from the advisory migration.
- `checkOutboundMessage` (routes.ts) — modify — passes `specConstitutionChecks` to the gate on non-health-alert kinds.
- Work Board agent writes (`POST /work-board/cards`, records `edited` / `waiting-on`) — add — B24 judge; 422 on fire, retryable 503 when the judge cannot answer; person writes never judged.
- `POST /spec/conformance-check` — modify — side effect: writes the ledger (best-effort). Response unchanged.
- `GET /spec/constitution-checks` — add — read-only, local records.

---

## 1. Over-block

- A message that mentions approving a design in passing ("Justin approved the design yesterday, building now") could be judged an ask. The rule's PASS list names reports of an approval, and the under-fire bias applies to whether the text is an approval ask.
- A spec checked on a peer within the last minute (merge not refreshed) or on an offline peer: a request claiming that check is held once; the agent re-sends after the refresh or re-runs the check here. No operator cost.
- An approval ask for a non-spec plan ("approve the plan to rename the bot?") might be read as a design. PASS list excludes payments, merges of finished code, purchases, pairing, account steps; "a plan for something to be built" is in scope by intent.
- Work Board: during an LLM outage on both tiers, every agent card write is refused (503, retryable) even when unrelated to specs. Chosen deliberately (No Silent Degradation, flagged by the built-in check on the first draft); cards are not time-critical and nothing is lost. An agent with NO provider configured at all is a standing state, not an outage: writes go through, logged as `spec-approval-judge-no-provider` (second-pass concern, fixed).

## 2. Under-block

- When the outbound gate's LLM is unavailable, the existing availability behaviour applies (tiered delivery on the operator's own channel, or the degraded leak floor): B24 does not run. Same as every other rule.
- A request carrying the result of an earlier revision passes when that revision's record exists; the fingerprint is recorded but the request carries no spec text to compare.
- A request carrying a fabricated result for a spec older than the newest 25 records: the judge is told such claims are no ground to fire.
- Approval asks outside instar's send paths (the operator reading a file directly) are out of reach.

## 3. Level-of-abstraction fit

The outbound gate is already the single authority every agent message passes; B24 feeds it rather than adding a parallel gate. The Work Board has no LLM gate on writes, so a small dedicated judge sits on the route, sharing the rule text constant so the two cannot drift. The ledger is a signal store beside the existing conformance metrics, written by the one route that runs the check.

## 4. Signal vs authority compliance

The ledger and records are signals with no authority. The LLM (outbound gate / card judge) holds the authority, reading the full text and the records in context. No phrase pre-filter; the rule is classified `signal-driven` in `RULE_CLASSES`, which the judge-by-meaning ratchet checks.

## 4b. Judgment-point check

Not a static heuristic: the decision is an LLM judgment. Two size floors exist (500 stored slugs, 25 records per prompt), both resource floors with their cost stated; the prompt cut is disclosed in-band with its count and can never cause a hold.

## 5. Interactions

- B17 APPROVAL-NOT-ERRAND also reads approval asks; it judges who does the step, B24 judges whether the spec's check result is carried. A message can satisfy both; they do not contradict.
- B5_API_ENDPOINT etc. are about what reaches the user; B24's suggestion goes to the agent, and the required line is plain words ("Constitution check: ran 03:20, nothing at risk").
- Advisory migration: B24 is listed in `ADVISORY_MIGRATION_EXEMPT_RULES`; tested that `toneAdvisoryAck` cannot push it through.
- `recordConformanceInvocationAt` (scope-accretion evidence) is untouched; the new record is written next to it.
- Prompt size: the B24 section adds about 1.5KB of rule text plus up to ~5KB of records to every non-health-alert review.

## 6. External surfaces

- Agents: messages and cards asking approval of a spec/design without the result are held with a suggestion. New awareness entry explains it.
- Operator: sees approval requests that carry one line with the check result. No new operator action.
- Peers: each server now answers `GET /spec/constitution-checks` (bearer-authenticated like every route) and is polled by peers at most once a minute while messages are reviewed.

## 6b. Operator-surface quality

No dashboard or approval page file changed. Not applicable.

## 7. Multi-machine posture (Cross-Machine Coherence)

Proxied-on-read: each machine records its own checks; the reviewing server merges its own with each online peer's local answer via `SpecCheckPeerCache` (background refresh at most once a minute, never blocking a review; newest per slug wins; peer data cleaned and tagged with its machine). Holds go only to the sending agent: no operator-facing notice, so no one-voice gating needed. No durable state strands on topic transfer. No generated URLs.

**Status surfaces:** new `GET /spec/constitution-checks` returns this machine's records only and says so by design (it is the per-machine leg of the merged read, never a fleet answer).

**Stage-B certified set:** `src/core/specConstitutionCheckLedger.ts` enters the tone gate's import closure; it is listed under `excluded` in `src/data/stageBCertifiedSet.ts` with its reason (agent-reach precedent), and declares its own report type so the conformance reviewer and registry parser stay out of that closure.

## 8. Rollback cost

Revert the PR and release. The ledger file is left behind, inert. No migration, no config, no agent state repair.

## Conclusion

Ships. The residual (earlier-revision results) is stated in the spec and above.

## Second-pass review (if required)

**Reviewer:** independent second-pass subagent
**Independent read of the artifact: concur** (one concern, below)

- Checked: `npx tsc --noEmit -p .` clean; `tests/unit/spec-approval-constitution-check.test.ts` 24/24 pass. B24 is in `VALID_RULES`, `RULE_CLASSES` (signal-driven), `RULE_DISPOSITIONS` (blocking) and `ADVISORY_MIGRATION_EXEMPT_RULES`, so `resolveRuleDisposition` returns blocking and the `toneAdvisoryAck` path (routes.ts ~5269, gated on `result.advisory === true`) cannot pass it. Section is skipped only for `health-alert`, in both the gate prompt and the route context.
- Work Board: `specApprovalAllows` skips only `kind === 'person'`; `agent` and `session` principals are judged on create and on `edited` / `waiting-on` records (the `question` field is included). Person edits are never judged.
- Peer cache: first `get()` triggers a refresh (fetchedAt 0); in-flight dedupe; failures keep the last answers; peer fetch carries the bearer token, same pattern as the existing `/sessions?scope=pool` hop. Peer records are clamped by `cleanPeerRecord`; records and card text are rendered as JSON inside per-call random boundaries, so injection exposure is bounded.
- **Concern (over-block, not stated in section 1):** `judgeSpecApprovalAsk` returns `unavailable: true` when `intelligence` is null (`specConstitutionCheckLedger.ts`: `if (!intelligence ...) return { hold: false, unavailable: !intelligence }`), and `workBoardRoutes.ts` `specApprovalAllows` turns that into a 503. An agent running with no intelligence provider (`intelligenceSource = 'none'` in `src/commands/server.ts`) therefore has EVERY agent card write refused permanently, with a message saying "write the card again in a minute". Section 1 describes this only as a transient outage on both tiers. Suggest treating no-provider as the outbound gate does (degraded pass, logged) or stating it in the artifact.
- **Author response:** fixed. No provider now returns `noProvider`; the route lets the write through and logs `spec-approval-judge-no-provider`; a configured provider failing both tiers still holds with the retryable 503. Tests added (unit + work-board route). Section 1 updated.
- Minor: `recordSpecConstitutionCheck` is an unlocked read-modify-write, so two concurrent checks can drop one record (fails toward a held ask that a re-run clears). Evidence/claim records on cards are not judged (under-block, acceptable).

## Evidence pointers

- `tests/unit/spec-approval-constitution-check.test.ts`
- `tests/integration/telegram-reply-spec-approval-check.test.ts`
- `tests/integration/work-board-routes.test.ts` (B24 block)
- `tests/integration/standards-conformance-gate.test.ts` (ledger write)
- Built-in constitution check runs on the spec: 2026-11-15 09:16, 09:21, 09:23 UTC (4, 3, 3 at risk; fit).

## Class-Closure Declaration (display-only mirror)

- **defectClass:** `unbounded-self-action`
- **closure:** `n/a`
- **reason:** not a self-triggered loop: the peer-record refresh runs only when an outbound review or card write asks for records, at most once per 60s (`SpecCheckPeerCache.refreshMs`), with in-flight dedupe and no retry; a failed refresh waits for the next interval.
