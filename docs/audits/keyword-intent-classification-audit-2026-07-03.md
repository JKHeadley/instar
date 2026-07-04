# Audit — Keyword/Regex Intent-Classification of Natural Language (2026-07-03)

**Trigger:** Operator directive (Justin, topic 29836, 2026-07-03 ~18:45 PDT) after the move-intent
sentinel hijacked a discussion message. Core principle he named: *we live in a world of LLMs with
contextual intelligence; a decision about what a human MEANT must be inferred by an LLM over the
message AND its conversation context — keyword lists are brittle and violate our standards when they
make that decision.* Sibling to the existing "an LLM gate must not string-match" standard.

**Proposed standard (draft, being shaped with operator):** *"Intelligence Infers, Keywords Only Guard."*
A decision about what a human MEANT must be made by an LLM reasoning over the message + conversation
context. Keyword/phrase/regex lists are permitted ONLY to (1) validate against a fixed closed enum, or
(2) constrain an LLM's already-inferred choice to a known set. A list that DECIDES natural-language
intent is a bug.

## Genuine bug-class instances (6) — ranked by user-facing impact

| # | Location | Decides | Wired live? | Impact |
|---|----------|---------|-------------|--------|
| 1 | `src/core/topicProfileIngress.ts:73` `parseProfileTrigger()` (FRAMEWORK/THINKING regexes) | "change this topic's framework/model/thinking?" | YES — `server.ts:1663` Telegram inbound; actuates a session respawn | HIGH |
| 2 | `src/core/NicknameCommand.ts:24` `recognizeNicknameCommand()` (TRANSFER_VERBS/PIN_VERBS) | "move/run this on <machine>?" | YES — `server.ts:17705` `_tryNicknameRelocation`; moves the session | HIGH (the hijack) |
| 3 | `src/threadline/hubCommands.ts:27-34` `parseHubCommand()` (open/tie regexes) | "bind this conversation?" | YES — `server.ts:1817` intercept; **SWALLOWS the message before the agent sees it** | HIGH |
| 4 | `src/core/TopicClassifier.ts:119` `scoreKeywords()` | topic category + intent + problem type by keyword-hit density | NO (only self-refs) | MED (latent) |
| 5 | `src/core/AutonomySkill.ts:81` `INTENT_PATTERNS` | "go autonomous/collaborative/…?" from phrases ("I trust you completely") | NO (exported, unwired) | MED (latent; HIGH if wired) |
| 6 | `src/core/AgentReadinessScorer.ts:54,63` `scoreText()` | task = agent-ready vs human-led by lexicon density | advisory endpoint only | LOW-MED |

**Priority = the three LIVE-WIRED ones (1,2,3)** — each can eat or reroute a real user message.

## Related (same anti-pattern, on AGENT output not user intent — review under standard)
- `src/core/action-claim.ts` `classifyActionClaim()` (VERB_LEMMAS + FUTURE_LEAD regexes), wired
  `routes.ts:20305` — classifies the agent's OWN outbound ("did I promise a future action"),
  signal-only/high-precision. Not user-intent gating. (`time-claim.ts` is NOT this class — it extracts
  quantified time claims to fact-check vs a clock.)

## Deliberate safety floor — KEEP (the legitimate exception)
- `src/core/MessageSentinel.ts:193,213` FAST_STOP_PATTERNS / FAST_PAUSE_PATTERNS — emergency-stop
  fast-path, "tested before LLM classification" with an LLM stage BACKING it. The operator's described
  deterministic safety floor. (Note co-located `CONTINUE_PING_TOKENS:260` resume-intent pre-filter.)

## Correct pattern already in use (the conversion template — proven, not invented)
- `src/core/CoherenceGate.ts` — LLM reviewers via IntelligenceProvider (the reference).
- `src/core/TopicIntentCapture.ts` / `TopicIntentArcCheck.ts` — cheap pre-filter DROPS obvious noise,
  passes everything ambiguous to an injected LLM `classifyFn`.
- `src/monitoring/CommitmentSentinel.ts:68` `isBareContinuation` — exact-match ack drop → LLM.
- `src/core/crossModelReviewer.ts:399` TIER_WORDS — constrains an LLM's chosen tier to a known set (guardrail, correct).

## Cleared as NOT the bug class (verified)
Process/tmux-output signature matchers (StuckSignatureClassifier, QuotaExhaustionDetector,
ContextWedgeSentinel, SessionWatchdog, PresenceProxy, SessionManager terminal/idle patterns, …);
security scrubbers (PolicyEnforcementLayer, InputGuard, SecretRedactor, JargonDetector, …);
structured/command/enum validators (SafeGitExecutor verbs, DispatchExecutor BLOCKED_COMMANDS,
topicProfileValidation enums, TransferByNickname/RelocationNicknameSet planner-guardrails, …);
`.instar/hooks/instar/*` NL hooks operate on the agent's OWN Stop-hook output / tool calls, not
user-message intent.

## Next steps (gated on operator finalizing the standard wording)
1. Operator shapes the draft standard → codify it in `docs/STANDARDS-REGISTRY.md`.
2. Wire a lint that flags keyword/regex lists tested against message/conversation text in
   sentinel/gate/classifier code (sibling to the LLM-gate-no-string-match ratchet).
3. Convert the three live-wired offenders first (#1, #2, #3), rebuilt on the CoherenceGate /
   cheap-prefilter→LLM template, each through the instar-dev ceremony.

_Source: read-only audit agent sweep of src/core, src/monitoring, src/server, src/messaging, src/threadline, .instar/hooks — 2026-07-03. No files modified._
