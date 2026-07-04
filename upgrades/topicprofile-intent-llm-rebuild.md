<!-- audience: agent-only | maturity: experimental -->

## What Changed

The recognizer that decides whether a mid-conversation message means *"change this topic's
framework / model / thinking"* — e.g. "use codex here", "switch this topic to gemini", "set high
thinking on this topic" — was rebuilt from keyword regexes into an LLM classifier
(`src/core/ProfileIntentClassifier.ts`). The old code (`parseProfileTrigger`'s
`/^use (codex|claude|gemini|pi…) …$/`, `/^switch this topic to …$/`, `THINKING_WORDS`, and the
`pin this topic to <id>$/` forms) was offender #1 of the 2026-07-03 keyword-intent audit: a
keyword/regex list DECIDING what a human meant. Those regexes were tightly anchored (so few false
positives), but they are brittle in the MISS direction — a valid paraphrase ("let's run this topic
on claude") had no anchor — and, more fundamentally, they are the exact anti-pattern the
constitutional standard *"Intelligence Infers, Keywords Only Guard"* forbids. The new classifier
infers the change intent from the message **and** a bounded window of recent conversation, and
constrains the value to a closed enum (framework ∈ configured frameworks, model ∈ known ids/tiers,
thinking ∈ off/low/medium/high/max) via **code-side validation of the model's emitted field** —
never string-matching the model's prose. It is conversion #1 under that standard, mirroring the
merged move-intent exemplar (PR #1367).

It **fails open**: on any uncertainty — no provider, breaker open, timeout, unparseable/schema-
violating output, value-not-in-enum, value-not-grounded-in-the-latest-message, or low confidence —
the message passes straight through to the agent, never actuating a respawn. A **grounding guard**
(`valueGroundedInLatestMessage`) additionally requires the resolved value to appear in the LATEST
message, so a value inferred purely from stale prior context ("yeah go with that") never actuates —
closing a confirm-slot-bypass the context window would otherwise open. The LLM call is `gating:true`
(swap-provider-before-fail, no silent heuristic drop). It ships **dev-gated dark on the fleet +
dry-run first on a development agent** (it logs would-actuate vs would-pass to
`logs/profile-intent.jsonl` — no raw message content — and actuates nothing until a deliberate
`dryRun:false`). The framework/model/thinking regexes are removed from `parseProfileTrigger`; the
command kinds (readout / undo / clear / reapply / switch-now / confirm) and the explicit
`effort` + `escalationOverride` forms remain (structural / explicit-mandate, not framework/model/
thinking intent). The `TopicProfileWriteSurface` authority + confirm-slot ordering guards are
unchanged.

## What to Tell Your User

Nothing user-facing right now — this ships dark on the fleet and dry-run on a development agent, so
no behavior changes until it's deliberately graduated (and the whole topic-profile WRITE layer is
itself already dev-gated + dry-run). If asked why the agent might once have missed a phrasing like
"let's run this topic on claude", or why "should we use codex here?" should never flip the setting:
the old recognizer was a brittle regex list, now replaced by an LLM that judges intent from the
message and its conversation context and errs toward *not* changing your topic when unsure.

## Summary of New Capabilities

- `src/core/ProfileIntentClassifier.ts` — LLM-with-context framework/model/thinking intent
  recognizer (`classifyProfileIntent` + `toProfilePatch`); structured-output enum guardrail +
  latest-message grounding guard validated in code; fail-open on all uncertainty; `gating:true`.
- Config `topicProfiles.intentClassifier` (`enabled` dev-gated; `dryRun:true`, `minConfidence:0.85`,
  `timeoutMs:4000`, `contextWindowTurns:6`, `modelTier:'fast'`); registered in `DEV_GATED_FEATURES`;
  attributed `gate` in `componentCategories`; row in `docs/LLM-ROUTING-REGISTRY.md`; bench coverage
  queued (`llmBenchCoverage.ts`, wave-3).
- `logs/profile-intent.jsonl` — machine-local dry-run soak log (LLM-engaged decisions only; enum
  fields + message length, NO raw content).
- Committed discrimination corpus + opt-in real-model benchmark (`INSTAR_LIVE_PROFILE_INTENT=1`),
  the graduation gate before `dryRun:false` (≥200 decisions, <1% false-actuation, zero
  context-resolved actuations).
