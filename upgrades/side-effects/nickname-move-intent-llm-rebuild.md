# Side-Effects Review — Move-Intent Recognizer: Keyword List → LLM-With-Context

**Version / slug:** `nickname-move-intent-llm-rebuild`
**Date:** `2026-07-04`
**Author:** `echo`
**Second-pass reviewer:** `spec-converge round (codex-cli:gpt-5.5 + gemini-cli:gemini-2.5-pro + 4 internal reviewers)`

## Summary of the change

Replaces the keyword verb-list decision in `NicknameCommand.recognizeNicknameCommand`
(`TRANSFER_VERBS = [move,…,run,continue,resume,keep]`) — which hijacked the operator's discussion message
"keep the work on the laptop" on 2026-07-03 — with an LLM classifier (`src/core/MoveIntentClassifier.ts`)
that infers "is this a move/pin command to <known machine>?" over the message + a bounded window of recent
conversation, guardrailed by code-side enum validation of the model-emitted `targetNickname`. Fail-OPEN on
any uncertainty (never hijack). Wired at `server.ts` `_tryNicknameRelocation` behind a dev-agent dark gate +
dry-run. The keyword decision is removed from `NicknameCommand.ts` (only the `NicknameCommand` type, consumed
by the unchanged `TransferByNickname` planner, remains). Files: `src/core/MoveIntentClassifier.ts` (new),
`src/core/NicknameCommand.ts`, `src/commands/server.ts`, `src/config/ConfigDefaults.ts`,
`src/core/devGatedFeatures.ts`, `src/core/componentCategories.ts`, `src/core/machineCoherenceManifest.ts`,
`docs/LLM-ROUTING-REGISTRY.md`, three test files + the wiring/line-map test updates.

## Decision-point inventory

- `_tryNicknameRelocation` (server.ts) — **modify** — the "is this a move command?" decision changes from
  keyword-match to LLM classifier; the downstream `planTransferByNickname` actuator is pass-through (unchanged).
- `NicknameCommand.recognizeNicknameCommand` — **remove** — the keyword verb-list decision is deleted.
- `MoveIntentClassifier.classifyRelocationIntent` — **add** — the new LLM decision + code-side enum guardrail.
- `multiMachine.sessionPool.moveIntent` config — **add** — dev-gated dark, dry-run-first knobs.

---

## 1. Over-block

The "block" surface here = hijacking a message (treating it as a move command, swallowing it). Over-block =
falsely hijacking discussion. This change's entire purpose is to REDUCE over-block: the classifier fails
open (only a high-confidence command with a resolved enum target hijacks), and ships dry-run so it hijacks
NOTHING during the soak. The residual over-block risk is a confidently-wrong model returning
`isCommand:true, confidence≥0.85` on discussion — bounded by the graduation-gate live benchmark (must pass
before `dryRun:false`) and the conservative threshold. Strictly less over-block than the keyword list, which
hijacked on any verb×preposition×nickname co-occurrence.

## 2. Under-block

Under-block = missing a genuine move command (it passes through to the agent). By design this is the SAFE
direction (fail-open). Known misses: (a) a purely deictic target with no nickname anywhere in the window
("send it to my desktop") — the prefilter skips → pass-through; (b) any fail-open path (provider down,
timeout, low confidence, malformed output). All are cheap (the user re-phrases); none cause harm. The old
keyword list ALSO under-blocked ("let's have the mini take this one" was missed) — this reduces it via
context-aware inference.

## 3. Level-of-abstraction fit

Correct layer. It is a smart AUTHORITY (LLM reasoning over message + conversation context), not a brittle
detector — exactly what the "Intelligence Infers, Keywords Only Guard" standard requires for a
what-did-they-mean judgment. The cheap deterministic prefilter is a genuine *pre-filter* (drops toward
pass-through only, never decides a command), matching `TopicIntentCapture`. It USES existing primitives
(shared `IntelligenceProvider`, `RelocationNicknameSet`, `TransferByNickname`) rather than re-implementing
them; it FEEDS the unchanged planner rather than running parallel to it.

## 4. Signal vs authority compliance

**Required reference:** docs/signal-vs-authority.md

- [x] Yes — but the logic is a smart gate with full conversational context (LLM-backed with recent history).

The decision is an LLM reasoning over the message + a bounded conversation window — a smart gate, not a
brittle detector holding block authority. It replaces exactly the brittle-detector-with-authority
anti-pattern the standard forbids. It fails open, so even under provider failure it never asserts authority
it can't back.

## 5. Interactions

- **Shadowing:** `_tryNicknameRelocation` runs BEFORE `_sessionRouter.route()` (unchanged ordering) and only
  when `_sessionPoolStage() !== 'dark'`. When it returns `handled:false` (the common case, and ALWAYS during
  dry-run), routing proceeds normally — it cannot shadow the router. Verified by `transfer-activation-wiring.test.ts`.
- **Double-fire:** no. A message is classified once per inbound; a positive hijack returns early (`return`),
  a pass-through continues to the router exactly once.
- **Races:** none new. The classifier is stateless; the only write is an append to `logs/move-intent.jsonl`
  (best-effort, wrapped, never throws into the message path).
- **Feedback loops:** none. The classifier reads recent history but never writes conversation turns.

## 6. External surfaces

- **Other agents on the machine:** none — internal message-path classifier.
- **Install base:** dark on the fleet (dev-agent gate + the whole relocation path is already gated behind
  `sessionPool != dark`, which ships dark). No fleet behavior change.
- **External systems:** one bounded fast-tier LLM call per nickname-mentioning candidate message, via the
  shared `IntelligenceProvider` (spawn-cap + circuit-breaker + attribution). No new network dependency.
- **Persistent state:** `logs/move-intent.jsonl` — a new machine-local append-only observability log
  (LLM-engaged decisions only; 80-char truncated preview; local, never synced). Consistent with all other
  `logs/*.jsonl`.
- **Timing:** `timeoutMs` default 4000 bounds the worst-case pass-through delay for a candidate message.
- **Operator surface (Mobile-Complete):** No operator-facing actions added. The only operator interaction is
  flipping `dryRun:false` / `modelTier` in config (already a standard config edit), plus reading the
  dashboard **LLM Activity** tab (`/metrics/features`, already phone-accessible). N/A.

## 6b. Operator-surface quality

No operator surface — not applicable. This change touches no dashboard renderer, approval page, or
grant/revoke/secret-drop form (no `dashboard/*` or form files staged).

## 7. Multi-machine posture (Cross-Machine Coherence)

**Posture: machine-local BY DESIGN** — the classifier is stateless request-locality COMPUTE. It runs on the
machine that holds the topic (the lifeline forwards inbound to the holder), is a pure function of the
message + the live nickname registry + the provider, and has no durable cross-machine state to replicate.
The only durable artifact is `logs/move-intent.jsonl`, a machine-local observability log identical in
posture to `logs/sentinel-events.jsonl` / `logs/reaper-audit.jsonl` (pure per-machine observability).

- **User-facing notices / one-voice gating?** No — during dry-run it emits nothing to the user; when live it
  produces the same single "Moving…" reply the existing keyword path did (unchanged), routed by the existing
  single-owner path.
- **Durable state / strands on topic transfer?** The soak log is per-machine; a topic that transfers mid-soak
  splits its would-hijack/would-pass evidence across machines. This is graduation-decision EVIDENCE, not user
  data — at `dryRun:false` graduation the operator aggregates the per-machine logs (or scopes the soak to a
  non-moving topic). No user data strands.
- **Generated URLs?** None.

Multi-dev note: the dev-agent gate resolves per-machine, so a multi-dev setup should activate
pool-consistently (documented in the spec Rollout §4) to avoid divergent behavior across topic-holding machines.

---

## Migration parity

Config default `multiMachine.sessionPool.moveIntent` is added under the existing `sessionPool` block in
`ConfigDefaults.ts`; `applyDefaults`/`getMigrationDefaults` deep-merges it add-missing onto existing agents
(the documented sessionPool migration-parity path — verified: the whole config/migration test family, 1191
tests, stays green). `enabled` is OMITTED so `resolveDevAgentGate` decides (dark fleet / live dev);
registered in `DEV_GATED_FEATURES` (both-sides wiring test green). No hook/CLAUDE.md-template/skill changes
(the move-by-nickname capability is dev-only experimental behind the dark session pool, so no
Agent-Awareness template surface is added).

## Rollback

Pure revert. No schema/data migration to unwind. To disable without reverting: set
`multiMachine.sessionPool.moveIntent.enabled: false` in config (force-dark even on a dev agent), or leave the
session pool at `stage: dark` (the default) — either fully inerts the path. `logs/move-intent.jsonl` is
append-only observability and safe to delete.

## Risk

Low. Ships dark on the fleet AND dry-run-first on dev (logs would-hijack/would-pass, actuates nothing). The
change strictly REDUCES risk versus the shipped keyword recognizer (fail-open replaces false-positive
hijack). The residual risk (a confidently-wrong model once `dryRun:false`) is gated by the graduation-gate
live benchmark + user-role Live-Channel proof + the soak, all required before actuation. tsc clean; lint
clean; all three test tiers green including the discrimination corpus.

## Post-rebase addendum (2026-07-04)

Rebased onto current `main` (clean). The new LLM component `MoveIntentClassifier` was registered across the
LLM-coverage ratchets that landed on main (#1366 and the bench family): `src/data/llmBenchCoverage.ts` —
`LLM_UNTRUSTED_INPUT: true` (it reads untrusted user message + context), `LLM_JUDGES_CLAIMS: false` (it
classifies a USER's move intent, not an agent/session completion/health/credit claim), `LLM_PARSER_CONTRACT:
{ pending: 'contract-wave-2' }` (it parses a closed verdict), and `LLM_BENCH_COVERAGE: { exempt }` (it ships
its own discrimination benchmark). The keyword-intent-decision ratchet's baseline was decremented 6→5 and
`NicknameCommand.ts` removed from its `EXPECTED_OFFENDERS` (offender #2 converted — exactly what that ratchet
tracks). The `parseMoveIntentResponse` fail-open catch carries an `@silent-fallback-ok` marker (the
documented fail-open, surfaced via `result.source`/`reason` + the audit log, never a silent swallow). No
behavior change from these — they are the coverage/observability registrations a new LLM component requires.
