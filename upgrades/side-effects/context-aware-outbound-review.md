# Side-Effects Review — Context-Aware Outbound Review (S2 context-aware reviewers)

**Spec:** docs/specs/context-aware-outbound-review.md (converged r4, approved under standing Session-A preapproval, topic 29836; tag commit dfdb7b21a). **Parent:** S2 enforcement-readiness track — the enforcement flip of `responseReview.observeOnly` is gated on this spec's §D9 criteria and stays a manual operator action.
**Ships DARK on the fleet, LIVE on development agents** via `responseReview.conversationalContext` (`enabled` OMITTED from defaults → `resolveDevAgentGate` at the WIRING layer; explicit false force-darks, explicit true is the fleet flip).
**Files:** src/core/untrustedConversationContext.ts (new), src/core/conversationContextWiring.ts (new), src/core/ResponseReviewDecisionLog.ts (new), src/monitoring/ReviewCanaryBattery.ts (new), src/core/CoherenceGate.ts, src/core/CoherenceReviewer.ts, src/core/reviewers/conversational-tone.ts, src/core/types.ts, src/server/routes.ts, src/server/AgentServer.ts, src/server/CapabilityIndex.ts, src/commands/server.ts, src/scaffold/templates.ts, src/core/PostUpdateMigrator.ts, src/scaffold/templates/jobs/instar/review-canary-battery.md (new, ships OFF)

## What changed

1. **untrustedConversationContext.ts (new):** the ONE shared untrusted-data envelope (§D2) — `clampConversation` (§D6 budget clamps: 6 msgs / 500 chars / 4000 total, oldest dropped first) + `renderUntrustedConversation` (per-call random `CTX_BOUNDARY`, JSON-encoded bodies, credential scrub per body, role labels + `USER(verified-operator)` principal tag, the structural `ask-license mode` line, and the §D3 four-clause prompt contract rendered as ONE ATOMIC block). Never throws; per-message scrub failure drops that message; any render failure drops the whole section.
2. **conversationContextWiring.ts (new):** `buildConversationContext(rows, operator)` — the wiring-layer principal computation (§D4): role from `fromUser`, `verifiedOperator` tags from authenticated-uid-vs-binding match, and the window `askLicenseMode` (bound → `verified-operator`; unbound → `single-sender` ONLY when every user row carries the same single authenticated uid; ANY uid-less user row or 2+ uids → `weak-corroboration-only`, fail-closed per R3-M2/R4-L1).
3. **ResponseReviewDecisionLog.ts (new):** the durable §D8 flip-evidence JSONL (`logs/response-review-decisions.jsonl`) — append-only, size-rotated (10MB → single `.1` archive via SafeFsExecutor), every write failure swallowed (telemetry never gates delivery).
4. **CoherenceGate.ts:** optional `conversationContextProvider` + widened `liveConfig` getter (now carries the wiring-RESOLVED `conversationalContext` block; ABSENT getter ⇒ DARK even against an enabled snapshot — round-2 L4 precedence); acquisition once per `_evaluate` inside its own try/catch, only for primary-user recipients with a numeric topicId; augmented SHALLOW-COPY fan-out (base ctx never carries conversation — §D3 structural availability); `EvaluateRequest.telemetry` (test-route-only canary tags) + `EvaluateResponse._contextMeta`; §D8 rows written at the `logAudit` seam for EVERY outcome (textHead = 200 scrubbed chars; canary/fixtureId stamped by the writer); §D9.4 counterfactual re-review (observeOnly-only, fire-and-forget, one context-stripped re-review per opted-in violating reviewer, `counterfactual:true` + shared `pairId`); `appendDecisionRow` exposes the single writer to the battery; in-memory audit entries gain `contextMeta` (§6). `DynamicReviewer` honors the `'recent-conversation'` contextRequirements opt-in key.
5. **conversational-tone.ts:** renders the atomic block ONLY when the gate handed it the augmented ctx; absent fields ⇒ prompt BYTE-IDENTICAL to feature-dark (the pre-existing static exception stands).
6. **routes.ts:** `/review/test` accepts `canary` + `fixtureId` (forwarded as `telemetry`; response gains `contextMeta`); `POST /review/evaluate` does NOT read them (a real turn cannot self-tag — boundary 13B, pinned by test); new Bearer-gated `POST /review/canary-battery/run` (503 while dark).
7. **ReviewCanaryBattery.ts (new):** the §D9.4b(a) daily battery driver — refuse-or-(pre-clean → seed reserved NEGATIVE topic ids with per-run-unique messageIds + uid-carrying user rows → replay both arms via the Bearer `/review/test` route → reviewer-level PEL-unmaskable assertions → finally-cleanup) → a `batterySummary` row on EVERY outcome including refusals.
8. **server.ts wiring:** the `resolveConversationalContext` LIVE closure (LiveConfig + `resolveDevAgentGate` — the kill-switch applies at the NEXT evaluate, no restart), the provider over real TopicMemory + `_agentServerRef` TopicOperatorStore, and the battery construction (localhost Bearer self-call to `/review/test`).
9. **Job template `review-canary-battery.md` (new):** ships `enabled: false` everywhere; operator enables it only on the soaking dev agent (spec §4.5 — no fleet migration carries it on).
10. **templates.ts + PostUpdateMigrator.ts:** `CONTEXT_AWARE_REVIEW_CLAUDEMD_SECTION` in `generateClaudeMd` (new agents) + an idempotent content-sniffed `migrateClaudeMd` append (existing agents), carrying the house dark-feature honesty phrasing (round-1 m5: `/review/history` 501s on most installs).

## Blast radius

- **Fleet default: byte-identical.** `enabled` omitted + not a dev agent ⇒ the resolver returns false ⇒ no acquisition, no section, prompts byte-identical (pinned by unit boundary 3/4 and the e2e fleet boot). The battery route 503s; the job ships OFF.
- **Total containment (round-1 M6, load-bearing):** the HTTP seam above the pipeline fails OPEN on a crash, so EVERY new context path — fetch, tagging, clamp, render, meta, D8 write, counterfactual — is individually contained; any failure degrades to "no section" (the STRICTER current posture), never to a throw escaping `_evaluate`. Pinned by throw fixtures at fetch/tag/render time.
- **Structural exposure bound:** conversation fields ride ONLY the augmented copies handed to the resolved opt-in set (`conversational-tone` alone in v1) for primary-user recipients; `information-leakage` and every other reviewer receive a base ctx that cannot render them (round-1 M1 + round-2 m2). Widening requires a spec revision, never config alone.
- **One-way risk direction:** context can only move a would-block toward PASS (measured by the counterfactual pairs + the canary battery, both soak-only); PEL is untouched and runs before all reviewers.

## Risk + mitigation

- **Risk:** the context channel launders a credential/PII paste past the reviewer. **Mitigation:** the §D3.3 bounded-scope clause + the daily adversarial canary battery (PEL-missable fixtures, baseline + with-context arms, reviewer-level assertions) — a laundering event FAILS the soak and resets the §D9 clock.
- **Risk:** an attacker-influenceable context body carries instructions. **Mitigation:** the proven §Design-4 envelope (random boundary + JSON-encoded bodies + corroborating-only preamble), boundary-7 injection tests.
- **Risk:** uid-less legacy rows fake a single-sender license. **Mitigation:** R3-M2 fail-closed rule (any uid-less user row in an unbound window ⇒ weak-corroboration-only), pinned both sides in boundary 6.
- **Risk:** the D8 log grows unbounded or leaks conversation. **Mitigation:** size rotation; only `contextMeta` + 200 scrubbed chars persist — bodies never (at-rest honesty note carried in the spec + docs).
- **Risk:** the battery strands fixture rows in the production TopicMemory. **Mitigation:** reserved NEGATIVE topic ids (collision structurally impossible), pre-clean + finally-cleanup + per-run-unique messageIds + seed-count assertion (R4-m4), all pinned by unit tests.

## Migration parity

- **Config:** NO `migrateConfig` entry on purpose — every key is optional with in-code defaults and the dev-gate convention REQUIRES `enabled` absent (a migration writing `enabled:false` would recreate the PR #1001 bug). Documented on the `ConversationalContextConfig` type.
- **CLAUDE.md:** section ships in `generateClaudeMd` + content-sniffed idempotent `migrateClaudeMd` append.
- **Hook scripts:** none changed — `response-review.js` already sends topicId + transcriptPath and is always-overwritten anyway.
- **Job:** new template installs through the normal built-in job path (`installBuiltinJobs` refresh), `enabled:false` everywhere.

## Rollback

- `responseReview.conversationalContext.enabled: false` — context off, reviewers byte-identical to pre-spec behavior, applied at the NEXT evaluate through the liveConfig wiring (no restart; pinned by boundary 12 + the e2e on-disk flip test).
- The D8 JSONL is additive telemetry; deleting it loses history, breaks nothing. `observeOnly` remains the orthogonal enforcement lever.

## Tests

- **Tier 1 (unit, 71 tests):** `untrusted-conversation-context.test.ts` (12 — envelope/clamps/scrub/atomicity, boundaries 7-9), `conversation-context-wiring.test.ts` (8 — boundary 6 both sides incl. the uid-less fail-closed rule), `coherence-gate-conversation-context.test.ts` (12 — boundaries 1-5, 12, 14 + the §D9.2 veto-day regression fixtures pinned both directions), `response-review-decision-log.test.ts` (9 — boundary 10 + boundary 11 counterfactual both sides, incl. canary-tag exclusion), `review-canary-battery.test.ts` (16 — boundary 13: outcome table, refuse conditions, seed-then-cleanup contract, failed-outranks-inconclusive).
- **Tier 2 (integration, 8 tests):** full HTTP pipeline over the real AgentServer auth middleware + real TopicMemory SQLite — enveloped ask in the captured prompt, byte-identical no-context path, provider-throw → 200 never fail-open, `/review/history` carries contextMeta and never bodies, canary tag plumbing test-route-only, battery route Bearer-gated + live/dark.
- **Tier 3 (e2e, 6 tests):** production init path with the REAL LiveConfig + resolveDevAgentGate + TopicMemory + TopicOperatorStore — dev boot ALIVE (context section + verified-operator principal tag from a real binding + battery 200), on-disk kill-switch flip applies with no restart, fleet boot byte-identical + 503 (Maturation Path dark side), Bearer gating.
- Suite health: tsc clean; `npm run lint` clean; `check-repo-invariants` green; `no-silent-fallbacks` green (every new catch tagged with a real justification); docs-coverage class ratchet back at floor with the new architecture page.

## Post-rebase conformance addendum (2026-07-03, PR #1343)

Rebasing onto post-#1341/#1342 main put this build under two guards that did not exist at its commit ceremony; conforming produced two additional side effects:

1. **Write-domain classification (src/core/WriteDomainRegistry.ts):** `POST /review/canary-battery/run` is now classified `machine-local` with an `ephemeral-rebuildable` story (standby-write-reconciliation §3.5 ratchet). Runtime delta: under the (dev-gated, dry-run) WriteAdmission layer the route resolves to a domain instead of null — machine-local ⇒ admit everywhere, which matches reality (the battery exercises THIS machine's review pipeline; fixtures are finally-cleaned; the D8 log is per-machine soak evidence). NOT added to the TODO-classify baseline (the ratchet forbids growth).
2. **FileClassifier sync exclusions (src/core/FileClassifier.ts):** `.instar/topic-memory.db` and `logs/response-review-decisions.jsonl` are now `git-sync-excluded` — the I9 second-axis file-level arm, same pattern as the wave-1 evolution/attention entries. Behavior delta: if any writer ever queued these paths for git-sync auto-commit, they are now skipped with a DegradationReporter breadcrumb instead of swept into a commit. A live SQLite binary and a per-machine JSONL must never ride git-sync (the round-2 S1 lesson); no current code path queues either, so the practical fleet delta is zero.
3. **Job template header (src/scaffold/templates/jobs/instar/review-canary-battery.md):** the trigger curl now resolves `AGENT_ID` and sends `X-Instar-AgentId`, conforming to the template-agent-id-header standard (bearer-only localhost calls are deprecated). No behavior change beyond the header; the job still ships `enabled: false`.

Rollback for this addendum rides the parent levers: the registry entry and exclusions are inert data rows (removing them restores the prior null-classification / sync-eligible state); the template header is cosmetic to auth (the server accepts bearer-only with a deprecation log).
