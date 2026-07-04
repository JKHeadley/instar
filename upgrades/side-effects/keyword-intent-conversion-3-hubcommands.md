# Side-Effects Review — Hub-intent recognizer: regex → LLM-with-context (Conversion #3)

**Version / slug:** `keyword-intent-conversion-3-hubcommands`
**Date:** `2026-07-03`
**Author:** `echo`
**Second-pass reviewer:** `subagent (fresh reviewer) — see appended verdict`

## Summary of the change

Replaces the keyword/regex DECISION in `src/threadline/hubCommands.ts` `parseHubCommand()` (anchored
whole-message regexes for "open this" / "tie this to <topic>") with an LLM-with-context classifier,
`src/threadline/HubIntentClassifier.ts`. The recognizer runs at the `telegram.onTopicMessage` hub
intercept in `src/commands/server.ts`, where a positive decision SWALLOWS the message before the agent
sees it and performs a bind — so a misread silently EATS a real message. The new classifier infers
open/tie intent from the message + a bounded recent-conversation window, constrains a `tie` target to a
structured enum of real existing topics (validated in code by numeric id membership, never prose-match),
and FAILS OPEN on every uncertainty (message passes through, never swallowed). The authoritative binder
`bindHubConversation` is unchanged. Ships dev-gated dark (config `threadline.hubIntent`, `enabled` omitted
→ `resolveDevAgentGate`) + dry-run first (`logs/hub-intent.jsonl`). Files: `HubIntentClassifier.ts` (new),
`hubCommands.ts` (regex removed), `server.ts` (wiring + `resolveHubClassifierDeps`), `ConfigDefaults.ts`,
`devGatedFeatures.ts`, `componentCategories.ts`, `LLM-ROUTING-REGISTRY.md`, three test tiers + updated
`hubCommands.test.ts` + recomputed dark-gate line-map. Follows the proven `MoveIntentClassifier` exemplar
(PR #1367).

## Decision-point inventory

- `hubCommands.parseHubCommand` (`src/threadline/hubCommands.ts`) — **remove** — the anchored-regex "is
  this a hub bind command?" decision is deleted.
- `HubIntentClassifier.classifyHubIntent` (`src/threadline/HubIntentClassifier.ts`) — **add** — the LLM
  decision that replaces it (open/tie/null + enum-validated target + confidence).
- `onTopicMessage` hub intercept (`src/commands/server.ts`) — **modify** — swaps regex call for classifier
  + dev-gate + dry-run gate + audit; still returns (swallows) only on a real, non-dry-run command.
- `bindHubConversation` (`src/threadline/hubCommands.ts`) — **pass-through** — unchanged binder.

---

## 1. Over-block

Over-block here = wrongly SWALLOWING a legitimate message the user did not mean as a bind command (the
exact harm the old regex caused, e.g. "should I open this?" / "open this in a new tab"). The new decision
is LLM-with-context, so these are correctly classified as discussion (covered by the discrimination
corpus). Structural protections against over-block: (a) FAIL-OPEN — any uncertainty passes through;
(b) a high confidence bar (0.85) to swallow; (c) a `tie` whose target isn't a real topic id passes
through; (d) the whole path is DARK on the fleet and DRY-RUN on dev, so nothing is swallowed until a
deliberate `dryRun:false` gated on a live accuracy benchmark. Net: over-block strictly decreases vs the
shipped regex.

## 2. Under-block

Under-block = failing to recognize a genuine bind command (message reaches the agent instead of
auto-binding). This is the SAFE direction here (a missed auto-bind costs a restate; the agent can still
bind via the API). Sources: (a) the cheap pre-filter skips messages with no bind-ish stem word, so a
paraphrase like "put this under the roadmap topic" is not auto-bound; (b) fail-open passes through on
provider failure; (c) while dark/dry-run nothing is bound. All acceptable — the design deliberately trades
missed auto-binds for never eating a message.

## 3. Level-of-abstraction fit

Correct layer: an AUTHORITY (context-rich LLM reasoning), not a brittle detector. It replaces a brittle
detector (regex) that wrongly held swallow authority. It routes through the shared `IntelligenceProvider`
(the same smart-gate substrate `CoherenceGate` uses) rather than re-implementing an LLM path, and reuses
the existing `bindHubConversation` binder rather than duplicating bind logic. The cheap pre-filter is a
low-level primitive used ONLY to drop toward pass-through (never to decide a positive), exactly as the
standard permits.

## 4. Signal vs authority compliance

**Required reference:** docs/signal-vs-authority.md

- [x] Yes — the logic is a smart gate with full conversational context (LLM-backed with recent history).

The classifier holds the swallow decision, but it is an LLM reasoning over the message + a bounded recent
conversation window (not brittle logic), and it fails open. The only string-matching in the module is the
pre-filter, which can never DECIDE a positive command — it only drops obvious non-commands toward
pass-through. Enum validation of the model's emitted `targetTopicId` is numeric-id membership, not
prose-matching.

## 5. Interactions

- **Shadowing:** the hub intercept runs inside `onTopicMessage` before normal session routing, exactly
  where the regex ran. When dark/dry-run OR fail-open OR not-a-command, it returns `handled:false`
  (falls through) so downstream routing (fix-commands, session dispatch) is unaffected — it can only
  shadow routing when it genuinely swallows a real command, which was the old behavior too.
- **Double-fire:** only one intercept owns hub-command recognition; there is no second recognizer to
  double-fire with. The `POST /threadline/hub/bind` API route is a separate, explicit caller (no text
  decision) and is unchanged.
- **Races:** none new — the classifier is stateless; the audit append is best-effort and wrapped so it
  never gates the message. `bindHubConversation`'s existing CAS mutate is unchanged.
- **Feedback loops:** none — the classifier reads recent history but does not write to it.

## 6. External surfaces

- **Other agents / users:** none while dark on the fleet. On a dev agent (dry-run) the only new surface is
  the machine-local `logs/hub-intent.jsonl` (80-char scrubbed preview, LLM-engaged decisions only).
- **External systems:** one bounded fast-tier LLM call per candidate hub message through the shared
  provider (spawn-cap + breaker), attributed `HubIntentClassifier`. No new network egress beyond that.
- **Persistent state:** none beyond the append-only dry-run log.
- **Operator surface (Mobile-Complete):** no operator-facing actions added — the only control is a config
  flag (`threadline.hubIntent.dryRun/enabled`), same as every dev-gated feature. Not applicable.

## 6b. Operator-surface quality

No operator surface — not applicable. This change touches no dashboard renderer, approval page, or
grant/revoke/secret form.

## 7. Multi-machine posture

**machine-local BY DESIGN.** The hub intercept and its dry-run log are per-machine inbound-message
processing on whichever machine owns the hub conversation; there is no cross-machine state to replicate
and no URL generated. It emits NO user-facing notices (it either swallows a command and lets the existing
binder post the hub confirmation, or passes through), so no one-voice gating is needed. It holds no durable
state that could strand on topic transfer (the audit log is local observability). The config flag resolves
per-machine via `resolveDevAgentGate`, consistent with every other dev-gated feature; on the fleet it is
uniformly dark.

## 8. Rollback cost

Pure code change — revert and ship a patch. No persistent state needing cleanup (the dry-run log is
append-only machine-local observability that can be ignored/deleted). No agent-state repair, no
user-visible regression during the rollback window (the feature is dark on the fleet, so a revert is a
no-op for fleet agents). The rollback lever short of a revert is `threadline.hubIntent` staying
dark/dry-run, or `enabled:false` to force-dark even a dev agent.

---

## Second-pass review (Phase 5)

**Reviewer:** fresh subagent (independent audit). **Verdict: Concur with the review.**

The reviewer independently traced every `return` in `classifyHubIntent` and confirmed only two paths
yield `isCommand:true` (a high-confidence `open`, or a high-confidence `tie` with an enum-resolved
target), both behind the confidence gate; every other path (empty text, no bind signal, no provider,
throw/timeout, unparseable/schema-violation, intent null, below confidence, tie-target-not-in-enum)
returns pass-through. The wiring's `willAct = isCommand && !dryRun` gate means the message is swallowed
ONLY on a real command with a resolved target and `dryRun:false`; the dark gate (`if clsDeps?.enabled`)
and dry-run default both skip swallowing; the audit write is wrapped so it can never break the path, and
the outer try/catch fails open to normal routing. Enum validation is numeric-id membership (never
prose-match); the pre-filter can only drop toward pass-through. The classifier never throws.

**One non-blocking observation:** while dark on the fleet, the "open this"/"tie this" structural
interception no longer fires (no regex fallback), so those messages reach the agent — whereas the fleet
CLAUDE.md still says the agent will NOT see "open this." This is the intentional dark-rollout tradeoff
already recorded in §2 (Under-block) / §5 (Shadowing); it is the SAFE direction (pass-through, never
swallow) and not a safety concern. It is a product-completeness item to close at graduation (flip the
gate, or update the fleet CLAUDE.md guidance for the dark window) — not a blocker for this change.

---

**CI follow-up (2026-07-04):** the new `HubIntentClassifier` gate is registered in
`COMPONENT_CATEGORY`, which the untrusted-input-classification ratchet requires to carry an explicit
`LLM_UNTRUSTED_INPUT` classification. It judges an inbound hub message's bind-intent (untrusted user
text), so it is classified `true` in `src/data/llmBenchCoverage.ts`. Mechanical consequence of the
component registration; no behavior change.

---

## Post-rebase addendum (main now carries #1367)

After the move-intent exemplar (PR #1367) merged, `main` gained the keyword-intent classification-ratchet family. Rebasing this branch onto it required registering `HubIntentClassifier` (a new `COMPONENT_CATEGORY` key) across every classification map, exactly mirroring how #1367 registered `MoveIntentClassifier`:

- `src/data/llmBenchCoverage.ts`:
  - `LLM_BENCH_COVERAGE`: `{ exempt }` — ships its own discrimination benchmark (`tests/unit/hub-intent-discrimination.test.ts` + opt-in `INSTAR_LIVE_HUB_INTENT=1`), the co-located benchmark IS the benchmark (same argument as MoveIntentClassifier / InteractivePoolCanaryJudge).
  - `LLM_JUDGES_CLAIMS`: bare `false` — classifies a USER's bind-intent, not an agent/session completion/health/credit claim.
  - `LLM_PARSER_CONTRACT`: `{ pending: 'contract-wave-2' }` — parses a closed intent(open/tie/null) + targetTopicId-enum + confidence verdict.
  - `LLM_UNTRUSTED_INPUT`: `true` — judges untrusted inbound hub text (landed in the prior fix commit).
- Pinned shrink-only baselines updated (each a visible, reviewed act): `EXEMPT_BASELINE` (`tests/unit/llm-bench-coverage-ratchet.test.ts`) and `PENDING_BASELINE` (`tests/unit/parser-contract-classification-ratchet.test.ts`) each gain `HubIntentClassifier`.
- `tests/unit/keyword-intent-decision-ratchet.test.ts`: `threadline/hubCommands.ts` removed from `EXPECTED_OFFENDERS` and `BASELINE` dropped 5→4 (the converted file no longer keyword-decides intent; the detector confirms exactly 4 remaining offenders). `topicProfileIngress` #1 remains for its own conversion.
- Merge conflicts in `componentCategories.ts`, `devGatedFeatures.ts`, `LLM-ROUTING-REGISTRY.md`, and `lint-dev-agent-dark-gate.test.ts` resolved keeping BOTH #1367's and this change's registrations; the dark-gate line-map recomputed against the merged `ConfigDefaults` (hubIntent +20 lines and moveIntent +18 lines both present, neither adds an attributed path).

No behavior change from this addendum — all registrations are ratchet metadata / test baselines. The classifier, wiring, config, and fail-open contract are unchanged from the reviewed version above.
