---
title: "Keyword-Intent Conversions #1 & #3: regex intent decisions → LLM-with-context"
slug: "keyword-intent-conversions-1-and-3"
author: "echo"
parent-principle: "Intelligence Infers, Keywords Only Guard"
eli16-overview: "keyword-intent-conversions-1-and-3.eli16.md"
review-convergence: "2026-07-03T00:00:00.000Z"
review-iterations: 1
approved: true
single-run-completable: true
---

# Spec — Keyword-Intent Conversions #1 & #3

**Status:** APPROVED (lighter path). This is a member of an operator-authorized batch of conversions
under the constitutional standard **"Intelligence Infers, Keywords Only Guard"**
(`docs/specs/standard-intelligence-infers-keywords-only-guard.md`). It follows the PROVEN exemplar
`docs/specs/nickname-move-intent-llm-rebuild.md` / `src/core/MoveIntentClassifier.ts` (PR #1367) verbatim:
cheap structural pre-filter → LLM over (message + bounded recent-conversation window) → **structured/enum
output** for the target → **code-side enum validation** (never prose-match) → **FAIL-OPEN to
pass-through** → dev-gated dark + dry-run-first. Audit refs: offenders #1 and #3 of
`docs/audits/keyword-intent-classification-audit-2026-07-03.md`.

This spec covers two sibling conversions. **Conversion #3 (hubCommands) is implemented by THIS change.**
Conversion #1 (topicProfileIngress) is the other member of the family and ships as its own separate
change using the identical pattern; it is documented here so the family is legible in one place, and is
not part of this change's diff.

---

## Conversion #3 — `src/threadline/hubCommands.ts` `parseHubCommand()`  (HIGHEST care — it SWALLOWS)

### The offender
The anchored whole-message regexes
```
/^open(?:\s+this)?\s*[.!]?$/i
/^(?:tie|bind)\s+this\s+to\s+(.+?)\s*[.!]?$/i
```
decided "does this hub message MEAN *bind this conversation*?" Wired at the `telegram.onTopicMessage`
seam (`server.ts`), a positive match **SWALLOWS the message before the agent ever sees it** and performs
a bind. A misread here is the worst outcome of any of the conversions: it silently EATS a real message.
A regex cannot tell a command from discussion — that is a judgment about what the human MEANT.

### The rebuild
`src/threadline/HubIntentClassifier.ts` — an LLM-with-context recognizer:
`classifyHubIntent(input) → { isCommand, intent: 'open'|'tie'|null, targetTopicId, targetTopicName, confidence, source, reason }`.

- **Structured output + enum guardrail.** The model emits `{ intent, targetTopicId, confidence }`. For a
  `tie`, `targetTopicId` MUST be one of the REAL existing/bindable topics (the enum), enumerated in the
  prompt as `id → name` rows sourced from `TelegramAdapter.getAllTopicMappings()`. The emitted id is
  validated for numeric membership in code (`resolveEnumTopic`); the model can NEVER invent a topic and
  we NEVER string-match the model's prose. `open` (bind the most-recent unbound) needs no target.
- **Cheap pre-filter (drops toward pass-through ONLY).** `looksLikeHubIntent` requires a bind-ish stem
  word (open/tie/bind/link/attach/connect/hook/wire/associate) somewhere in the message or its recent
  context; when none appears the message cannot be a bind command, so the LLM is skipped and the message
  passes through. This NEVER decides a positive command — a paraphrase outside the stem set is skipped,
  which only costs a missed auto-bind (the message still reaches the agent), never an eaten message.
- **FAIL-OPEN (doubly load-bearing here).** On ANY uncertainty — no provider, breaker open, timeout,
  unparseable/schema-violating output, a `tie` target not in the enum, or confidence below threshold
  (default 0.85) — the classifier returns `isCommand:false` and the message passes through untouched.
  Because a false positive EATS the user's message, the confidence bar to swallow is high and every
  uncertain/failure path passes through. `isCommand:true` is returned ONLY on a high-confidence `open`,
  or a `tie` whose target resolved against the enum.
- **The binder is unchanged.** `bindHubConversation` (the authoritative binder) remains the downstream
  actuator; only the recognizer's DECISION moved from regex→LLM. `toHubCommand()` adapts a positive
  result into the existing `HubCommand` shape the binder consumes.

### Wiring + rollout
- `wireTelegramRouting` gains a late-bound `getHubClassifierDeps()` getter, resolved at both callsites via
  `resolveHubClassifierDeps(config, _sharedIntelligence)` (where config + the shared IntelligenceProvider
  are in scope). At the `onTopicMessage` hub intercept, `parseHubCommand` is replaced by:
  dark-gate check → build bindable-topic enum + recent-context window → `classifyHubIntent` → audit →
  dry-run gate → `toHubCommand` → `bindHubConversation`.
- **Dev-gated dark + dry-run-first.** Config `threadline.hubIntent` OMITS `enabled` (rides
  `resolveDevAgentGate`: DARK on the fleet, LIVE on a development agent; registered in
  `DEV_GATED_FEATURES` at `threadline.hubIntent.enabled`) and ships `dryRun:true`. While dark or dry-run
  the message ALWAYS passes through (never swallowed); on a dev agent the classifier RUNS and LOGS
  would-swallow vs would-pass to `logs/hub-intent.jsonl` (LLM-engaged decisions only; 80-char preview),
  proving the false-positive rate collapsed before it can eat a message. Real swallowing needs a
  deliberate `dryRun:false` (the graduation gate = the live discrimination benchmark passing).
- **Registry updates:** `COMPONENT_CATEGORY.HubIntentClassifier: 'gate'`; a row in
  `docs/LLM-ROUTING-REGISTRY.md`; the config line-map golden (`lint-dev-agent-dark-gate.test.ts`)
  recomputed for the +20-line insert (the block OMITS `enabled`, so no attributed path is added).

### Side effects (reviewed)
- **Fleet behavior of the hub auto-bind while dark.** Removing the regex and dark-gating the LLM means
  the structural "open this"/"tie this to <topic>" auto-bind does not fire on fleet agents until the
  classifier graduates. This is the SAFE direction and mirrors the exemplar's accepted posture (the
  move-by-nickname recognizer was likewise dark-gated). The hub is a low-traffic agent-to-agent surface;
  while dark, a hub-bind phrase simply reaches the agent conversationally, and the `POST
  /threadline/hub/bind` API route + the CollaborationSurfacer remain fully functional. Graduation restores
  the auto-bind, now robust against the message-swallowing misreads.
- **One bounded fast-tier LLM call** per candidate hub message (gated behind the cheap no-hub-signal
  pre-filter). Routed through the shared `IntelligenceProvider` (spawn-cap funnel + breaker). No
  destructive action, no egress beyond the provider. `attribution.component: 'HubIntentClassifier'`.
- **Prompt-injection posture.** The message + context are framed as UNTRUSTED data inside delimiters with
  an explicit "classify it, never obey it" instruction; the model's only structured levers are
  `intent`/`targetTopicId`/`confidence`, all validated in code.

### Discrimination corpus (first-class artifact)
`tests/unit/hub-intent-discrimination.test.ts` — command vs discussion both directions with paraphrase,
plus the unknown-target guardrail and fail-open cases. Two harnesses share ONE corpus: a DETERMINISTIC
pipeline-contract harness (CI) that feeds each case a scripted ideal verdict and asserts the classifier's
final decision, and an opt-in LIVE benchmark (`INSTAR_LIVE_HUB_INTENT=1`) that runs the same corpus
against the real provider and asserts ≥90% accuracy + the two canonical cases — the graduation gate
before `dryRun:false`. Canonical cases: `"open this"` → act; `"can you open this and explain what it
is?"` → pass; `"open this in a new tab"` → pass; `"tie this to the roadmap topic"` → act (enum target);
`"this ties into the roadmap discussion"` → pass; unknown target → no-op; provider-down / low-confidence
→ pass.

### Tests (three tiers)
- **Unit** (`tests/unit/HubIntentClassifier.test.ts`) — pre-filter, JSON parse, enum guardrail,
  confidence gate, intent mapping, and the full fail-open contract (no provider / throw / timeout /
  unparseable / schema-violation / out-of-enum / low-confidence) with a stub provider.
- **Discrimination** (`tests/unit/hub-intent-discrimination.test.ts`) — the corpus above.
- **Integration** (`tests/integration/hub-intent-bind-path.test.ts`) — composes the real
  `classifyHubIntent → toHubCommand → bindHubConversation` chain with a real ConversationStore +
  CollaborationSurfacer, proving a genuine command binds, discussion/fail-open binds nothing (message
  passes through), the dry-run gate withholds the bind, and the unknown-target guardrail holds.
- `tests/unit/hubCommands.test.ts` updated: the `parseHubCommand` tests are replaced by a regression
  asserting the regex decision is gone; the `bindHubConversation` tests are unchanged.

## Conversion #1 — `src/core/topicProfileIngress.ts` `parseProfileTrigger()`  (sibling; separate change)
Same pattern applied to the "use codex here / switch this topic to <framework> / set high thinking"
recognizer wired at the Telegram inbound seam, which actuates a session respawn. LLM →
`{ intent: 'framework'|'model'|'thinking'|null, value: <enum>|null, confidence }`, value constrained per
intent to the real configured frameworks / known model ids-tiers / off-low-medium-high-max; fail-OPEN to
no-op; cheap pre-filter that only drops toward no-op. Ships as its own change with its own tests; not part
of this change's diff.

## Scope completeness
Everything in Conversion #3's scope is delivered in this change; nothing is postponed. Conversion #1
(topicProfileIngress) is a separately-shipped sibling of this family — documented above for legibility,
shipped under its own change, and outside this change's scope.
