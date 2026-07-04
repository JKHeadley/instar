---
title: "Move-Intent Recognizer: Keyword List → LLM-With-Context"
slug: "nickname-move-intent-llm-rebuild"
author: "echo"
parent-principle: "Intelligent Prompts — An LLM Gate Must Not String-Match"
eli16-overview: "nickname-move-intent-llm-rebuild.eli16.md"
review-convergence: "2026-07-04T05:10:47.058Z"
review-iterations: 2
review-completed-at: "2026-07-04T05:10:47.058Z"
review-report: "docs/specs/reports/nickname-move-intent-llm-rebuild-convergence.md"
cross-model-review: "codex-cli:gpt-5.5"
approved: true
single-run-completable: true
frontloaded-decisions: 4
cheap-to-change-tags: 4
contested-then-cleared: 4
---

# Spec — Move-Intent Recognizer: Keyword List → LLM-With-Context

**Status:** DRAFT for review — the exemplar conversion under the proposed standard
"Intelligence Infers, Keywords Only Guard" (see `docs/audits/keyword-intent-classification-audit-2026-07-03.md`).
Offender #2 (the one that hijacked the operator, 2026-07-03). Pattern to follow: `CoherenceGate` (LLM
via IntelligenceProvider) + the cheap-prefilter→LLM hybrid (`TopicIntentCapture`, `CommitmentSentinel`).

## Problem
`src/core/NicknameCommand.ts:recognizeNicknameCommand()` decides "is this message a move/pin command?"
with a keyword verb-list (`TRANSFER_VERBS = [move, transfer, switch, migrate, send, shift, run,
continue, resume, keep, …]`) × a preposition × a known nickname. Wired live at `server.ts:17705`
(`_tryNicknameRelocation`); a positive match SWALLOWS the message (handled=true) and moves the session.

Failure mode (verified): "keep the work on the laptop" / "continue on the mini" / "run this on the
mini" — ordinary discussion — match as commands and are hijacked, never reaching the agent. And the
inverse: "let's have the mini take this one" (a real command, no listed verb) is missed. A keyword list
cannot tell intent from discussion; that is a meaning judgment.

## Solution
Replace the *verb→intent decision* with an LLM classifier that infers intent from the message AND its
recent conversation context. Keep the known-nickname set purely as a **guardrail** on the target.

### Contract
`classifyRelocationIntent({ text, conversationContext, knownNicknames, intelligence, minConfidence, timeoutMs, maxContextTurns, modelTier }) → { isCommand, intent: 'transfer'|'pin'|null, targetNickname: string|null, confidence, source, reason }`
- The LLM is given the message, a bounded window of recent turns (so "do it" / "yes move it" resolve),
  and the list of real machine nicknames. It judges: is the user *commanding* a session move/pin right now?
- **Guardrail via structured output + CODE-SIDE enum validation, NOT provider-native constrained decoding,
  and NEVER prose-matching (operator refinement 2026-07-03; hardened per round-1 cross-model review):**
  the prompt instructs the model to emit JSON whose `targetNickname` is one of the real known nicknames
  or `null`. Crucially, the guardrail does **not depend on the provider supporting native
  schema/enum-constrained decoding** (off-Claude frameworks vary): the provider returns free text, we
  `JSON.parse` it, and we **validate the emitted `targetNickname` field against the known-nickname set by
  exact case-insensitive membership** (`resolveEnumTarget`), discarding anything out-of-set. We read a
  parsed FIELD and check set-membership — we never scan the model's prose for a machine name. So the
  guardrail holds on ANY framework, and a model that names a machine you don't have is dropped.
  `TransferByNickname` planner + `RelocationNicknameSet` are retained as the downstream actuator unchanged;
  only the *recognizer's decision* changes from keyword→LLM.

### Fail-OPEN direction (load-bearing — this is the safety inversion)
The current bug is a false-POSITIVE hijack. The rebuild biases the other way: on ANY uncertainty, **do
NOT hijack** — pass the message through to the agent (`isCommand:false`). A missed move command (the user
re-phrases) is cheap; an eaten discussion message is the exact harm being removed. The complete fail-open
trigger list (each verified by a test):
- no provider / provider throws (circuit-breaker open, error) → `fail-open`
- timeout → `fail-open`
- **unparseable OR schema-violating model output** (not JSON, or a required field missing/mistyped) →
  `fail-open` (round-1 cross-model finding G2: harden against model *misbehavior*, not just unavailability)
- model says not-a-command → pass-through
- **`targetNickname` not in the known-nickname enum** → pass-through (the guardrail)
- **confidence below `minConfidence`** → pass-through

`isCommand:true` is returned ONLY on a high-confidence command with a resolved enum target.

### Discrimination accuracy & the model-quality dependency (round-1 adversarial M1/M2 — stated honestly)
The load-bearing correctness here is the model's command-vs-discussion judgment, and **CI cannot test it**:
the committed corpus (below) run deterministically feeds the classifier a scripted "ideal model" verdict,
so it locks the *pipeline* contract + guardrails + fail-open — but it does **not** prove any real model
discriminates. That is inherent to LLM classification. The model's judgment is guarded by, in order:
1. **fail-open + a conservative `minConfidence` (0.85)** — a miscalibrated/uncertain model passes through,
   never hijacks. The safety floor does not depend on model quality.
2. **the graduation-gate live benchmark** — the same corpus run against the **routed model** (opt-in
   `INSTAR_LIVE_MOVE_INTENT=1`) must pass (≥90%, and BOTH canonical cases — "move this to the mini"→act,
   "keep the work on the laptop"→pass) **before `dryRun:false` is ever flipped**. A model swap re-runs it.
3. **the dry-run soak** — real-traffic would-hijack vs would-pass logging proves the false-positive rate
   collapsed before actuation is enabled.
4. **`/metrics/features` fireRate** — post-graduation drift monitoring on the live component.

`modelTier` (config, default `fast` per the standard) is exposed so the operator can raise it to
`balanced` if the graduation benchmark shows the fast model miscalibrated on the subtle cases — routing
the hardest judgment to the cheapest tier is the one risk to watch.

### Latency/cost — cheap prefilter → LLM (the hybrid, per `TopicIntentCapture`)
A cheap structural prefilter runs first and only DROPS obviously-non-command messages (no known nickname
token present in the message OR the context window at all → cannot be a move; skip the LLM). Everything
that COULD be a move (a machine is named somewhere in the window) goes to the LLM. The prefilter may only
ever *skip the LLM toward pass-through*, never decide a command. **Deliberate fail-open limit:** a command
whose target is purely deictic with no nickname anywhere ("send it to my desktop", "the other machine")
is skipped → passes through; the user re-phrases with the name. Cost is bounded by the prefilter (most
inbound never reaches the LLM), the host spawn-cap, and the LLM circuit-breaker; there is no per-message
cache (repeated identical inbound is already dup-suppressed upstream). `timeoutMs` default **4000** (a
fast-model p95 is well under this; the timeout only bounds the worst-case pass-through delay — round-1
latency finding C5/G1). A deterministic slash-command channel (e.g. `/move mini`) is a possible future
complement for zero-latency explicit commands (round-1 C2) but is out of scope: the standard's concern is
*natural-language* intent, which is what this fixes.

### Framework routing
Route via the shared `IntelligenceProvider` (like CoherenceGate), so it runs on the configured
off-Claude / fast tier and rides the host spawn-cap + LLM circuit-breaker + per-feature attribution
(`attribution.component: 'MoveIntentClassifier'`, registered in `componentCategories.ts` as a `gate` and
in `docs/LLM-ROUTING-REGISTRY.md` as nature-A fail-open). `fast` is the default tier; `modelTier` config
allows raising it (see above). The context block hands the model each turn with its ROLE (`User:` /
`Agent:`) in chronological (oldest→newest) order, so it can weigh conversational adjacency — the input for
resolving (or correctly rejecting) a bare "yes"/"do it".

### Alternatives considered (round-2 cross-model C1/C3)
- **Explicit command syntax (`/move mini`) / a UI affordance.** A deterministic slash-command or a dashboard
  button would be zero-latency and unambiguous for *explicit* commands. It does not replace this work: the
  bug being fixed is that users move sessions in *natural language* mid-conversation, and the standard's
  scope is exactly NL intent. A `/move` channel is a fine future *complement* (out of scope), not a
  substitute — it wouldn't have caught "let's have the mini take this one".
- **Categorical output (`clear_command | ambiguous | not_command`) instead of a numeric confidence.** A
  reasonable alternative given that model self-reported confidence is not guaranteed calibrated. This spec
  keeps `isCommand` + an *advisory* confidence but treats the number as advisory: the load-bearing guard is
  fail-open + the empirical graduation benchmark + the soak, NOT the numeric threshold in isolation. If the
  soak shows the threshold is pseudo-precision, mapping only a categorical `clear_command` → action is the
  drop-in alternative shape (the pipeline already discards anything that isn't a high-confidence resolved command).

## Tests (the discrimination benchmark the operator named — the deeper gap)
A committed corpus that pits discussion vs command, both directions, with paraphrase:
- COMMAND (act): "move this to the mini", "run this on the laptop", "let's have the mini take this one",
  "actually, switch this conversation to the laptop please", "pin this topic to the workstation",
  context-resolved "yes, move it".
- DISCUSSION (pass through): "keep the work on the laptop for now", "the mini keeps failing", "should
  we move this to the mini?", "continue — on the mini it was faster", "the workstation handled that job".
- STALE-CONTEXT false-positive vector: a bare "yes" answering an UNRELATED question while a stale move
  proposal still sits in the window → pass through (round-1 adversarial M3).
- Guardrail: unknown nickname → no-command (caught cheaply by the prefilter; a distinct enum test forces
  the post-LLM `target-not-in-enum` path with a message that DID name a known machine).
- Fail-open: provider throws / timeout / unparseable / **schema-violating (missing field)** /
  low-confidence → `isCommand:false` (pass through).

Three tiers per Testing Integrity, all committed + green:
- **unit** (`tests/unit/MoveIntentClassifier.test.ts`) — classifier logic, prefilter, parse, enum
  guardrail, prompt-contract (enum + both discrimination classes + untrusted framing), every fail-open path.
- **the discrimination corpus** (`tests/unit/move-intent-discrimination.test.ts`) — DETERMINISTIC pipeline
  contract over the whole corpus (CI) + the keyword-recognizer-is-gone regression + an **opt-in
  `INSTAR_LIVE_MOVE_INTENT=1` real-model benchmark** (the graduation gate: ≥90% + both canonical cases).
- **integration** (`tests/integration/move-intent-relocation-path.test.ts`) — classifier → `toNicknameCommand`
  → `planTransferByNickname` end-to-end (the exact chain `_tryNicknameRelocation` runs), including the
  literal 2026-07-03 "keep the work on the laptop" hijack regression, the dry-run "classified-but-not-acted"
  contract, and the guardrail.

## Multi-machine posture
- **The classifier is stateless machine-local COMPUTE (request-locality), not a cross-machine state
  surface.** It runs on the machine that holds the topic — the same machine that processes the inbound
  message (the lifeline forwards inbound to the holder). There is no durable classifier state to replicate;
  it needs no replication or proxied-read. Default posture is honored: `unified` is not applicable because
  there is nothing to unify (a pure function of the message + the live nickname registry + the provider).
- **The only durable artifact is `logs/move-intent.jsonl` — a machine-local observability log**, consistent
  with every other `logs/*.jsonl` (sentinel-events, reaper-audit). `machine-local-justification:
  operator-ratified-exception` — ratified by this exemplar's audit + spec (`docs/audits/keyword-intent-classification-audit-2026-07-03.md`),
  same posture the whole observability-log family already holds.
- **Soak-read caveat (round-1 D4):** because the log is per-machine, a topic that transfers mid-soak splits
  its would-hijack/would-pass evidence across machines. At graduation the operator aggregates the per-machine
  logs (or scopes the soak to a non-moving topic) before deciding `dryRun:false`. This is a read-time
  aggregation, not a stranding of user data.

## Observability
- `logs/move-intent.jsonl` — one line per **LLM-engaged** decision only (a prefilter-skip is a trivial
  would-pass and is NOT logged, to avoid over-collecting a preview for every inbound message — round-1
  privacy finding C4/S1). Fields: `ts, topicId, decision (would-hijack|would-pass|hijack), dryRun, source,
  intent, target, confidence, reason, textPreview` (whitespace-collapsed, **80-char-truncated**, local-only,
  never synced across machines).
- `/metrics/features` — the shared-provider attribution surfaces the component's calls, fireRate, cost, and
  latency (Observable Intelligence). This is how post-graduation drift is caught.

## Rollout
Graduation ladder (same discipline as the honesty gate):
1. **dark on the fleet** — the whole relocation path is *already* gated behind `_sessionPoolStage() !== 'dark'`
   (the session pool ships dark). So removing the keyword recognizer causes **NO fleet regression: the fleet
   never ran the keyword recognizer either** (round-1 D1). The move-by-nickname capability is a dev-only
   experimental part of the dark session pool.
2. **dev-live, `dryRun:true` (observe)** — the classifier runs on real dev traffic and LOGS would-hijack vs
   would-pass; it NEVER actuates. The unchanged `TransferByNickname` actuator + the integration test cover
   the actuation path during this window (round-1 D2).
3. **dev-live, `dryRun:false` (actuate)** — flipped only after (a) the graduation-gate live benchmark passes
   on the routed model, (b) the soak shows the false-positive rate collapsed, and (c) **a user-role
   Live-User-Channel proof** (per the constitutional standard): a user-role session drives real "move this
   to X" (act) AND "keep the work on X" / "should we move this to X?" (pass) through the REAL Telegram
   surface on a throwaway dev topic, confirming the actuation moves the session AND discussion is never
   hijacked — BEFORE the operator relies on it. (There is no HTTP route here, so the classic Tier-3
   "feature-alive returns 200 not 503" E2E is N/A; this live-channel proof is its equivalent.) **Pre-`dryRun:false`
   checklist item (pre-existing foundation gap, round-1 lessons):** the wiring passes `isMidReply: () => false`
   to the planner (a known best-effort simplification carried over from the keyword path, unchanged here) —
   revisit whether a mid-reply move should confirm before enabling live actuation.
4. **fleet** — only when the session pool itself graduates past dark. Multi-dev note (round-1 D5): the
   dev-agent gate resolves per-machine, so a multi-dev setup should activate pool-consistently to avoid
   divergent behavior across the machines that hold a topic.

## Frontloaded Decisions
Every decision is resolved here (design-fork authority; all are cheap-to-change-after because the whole
feature ships behind a named dark + dry-run phase and touches no durable external side-effect, money,
identity, or published interface — the actuation stays off until `dryRun:false`):
1. **Confidence threshold** for `isCommand:true` = **0.85** (config `minConfidence`, operator-tunable). Conservative
   start; the dev-agent soak measures the would-hijack rate and this is the dial to relax if it's too strict.
2. **Conversation-context window** = **last 6 turns** (config `contextWindowTurns`), each turn clamped to 400 chars,
   fetched via `TelegramAdapter.getTopicHistory`. Enough to resolve "yes, move it"; bounded against a huge paste.
3. **"pin" intent stays in-scope** in this pass — the model emits `intent: "transfer" | "pin"` and the existing
   `TransferByNickname` planner already treats both identically (both set a hard pin), so keeping pin costs nothing
   and avoids a second recognizer. No split.
4. **Model tier** = **`fast`** (config `modelTier`), per the standard's "fast is sufficient"; raisable to `balanced`
   if the graduation benchmark shows miscalibration (round-1 M2). **Timeout** = **4000ms** (round-1 C5/G1).

## As-built notes
- New module `src/core/MoveIntentClassifier.ts` (`classifyRelocationIntent` + `toNicknameCommand`); the keyword
  `recognizeNicknameCommand`/`TRANSFER_VERBS`/`PIN_VERBS` decision is REMOVED from `NicknameCommand.ts` (only the
  `NicknameCommand` type — consumed by the unchanged planner — remains).
- Wired at `server.ts` `_tryNicknameRelocation`: dark-gate (`resolveDevAgentGate`) → context fetch → classify →
  audit line (`logs/move-intent.jsonl`, decision = would-hijack | would-pass | hijack) → dry-run gate → planner.
- Config `multiMachine.sessionPool.moveIntent` (`enabled` OMITTED → dev-agent dark gate; `dryRun:true`,
  `minConfidence:0.85`, `timeoutMs:4000`, `contextWindowTurns:6`, `modelTier:'fast'`). Registered in `DEV_GATED_FEATURES`;
  component registered in `componentCategories.ts` (`gate`) + `docs/LLM-ROUTING-REGISTRY.md` (nature A, fail-open).
- Tests: `tests/unit/MoveIntentClassifier.test.ts` (logic + fail-open), `tests/unit/move-intent-discrimination.test.ts`
  (the committed corpus — deterministic pipeline contract + opt-in `INSTAR_LIVE_MOVE_INTENT=1` real-model benchmark +
  the keyword-recognizer-is-gone regression), `tests/integration/move-intent-relocation-path.test.ts`
  (classifier→planner end-to-end incl. the exact 2026-07-03 hijack regression).

_This spec is the exemplar; offenders #1 (topicProfileIngress) and #3 (hubCommands) follow the same
shape — cheap prefilter → LLM-with-context, guardrail on the resolved target, fail-open to pass-through._

## Open questions
*(none)*
