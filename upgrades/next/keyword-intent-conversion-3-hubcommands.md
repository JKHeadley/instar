<!-- audience: agent-only | maturity: experimental -->

## What Changed

The Threadline hub's "open this" / "tie this to `<topic>`" recognizer — the thing that decides whether a
message in the hub topic is a bind command — was rebuilt from anchored whole-message regexes into an LLM
classifier (`src/threadline/HubIntentClassifier.ts`). The old regexes
(`/^open(?:\s+this)?…/`, `/^(?:tie|bind)\s+this\s+to\s+(.+?)…/`) were wired at the `onTopicMessage` seam,
where a positive match **SWALLOWS the message before the agent ever sees it** and performs a bind — so a
misread silently EATS a real message (e.g. "should I open this?" or "open this in a new tab"). The new
classifier infers open/tie intent from the message **and** a bounded window of recent conversation, and
constrains a `tie` target to a structured enum of the real existing topics via **code-side validation of
the model's emitted topic-id** (never string-matching the model's prose). It is Conversion #3 under the
constitutional standard *"Intelligence Infers, Keywords Only Guard"*, following the proven move-intent
exemplar (PR #1367). It **fails open**: on any uncertainty — no provider, circuit-breaker open, timeout,
unparseable/schema-violating output, tie-target-not-in-enum, or low confidence — the message passes
straight through to the agent, never swallowed. It ships **dev-gated dark on the fleet + dry-run first on
a development agent** (it logs would-swallow vs would-pass to `logs/hub-intent.jsonl` and swallows nothing
until a deliberate `dryRun:false`). The keyword decision (`parseHubCommand`) is removed from
`hubCommands.ts`; the `HubCommand` type + the authoritative `bindHubConversation` binder are unchanged.
Ships with a committed discrimination corpus (command vs discussion both ways + guardrail + fail-open) —
deterministic in CI plus an opt-in `INSTAR_LIVE_HUB_INTENT=1` real-model benchmark used as the graduation
gate before actuation.

## What to Tell Your User

Nothing user-facing right now — this ships dark on the fleet and dry-run on a development agent, so no
behavior changes until it's deliberately graduated. If asked why the agent used to grab a hub message
like "should I open this?" as a bind command: that was a brittle regex that ate the message before the
agent saw it, now replaced by an LLM that judges intent from the message and its conversation context and
errs toward not grabbing your message when unsure. While dark on the fleet, the hub's automatic
"open this" grabbing simply does not fire, and everything else about the hub works exactly as before.

## Summary of New Capabilities

- `src/threadline/HubIntentClassifier.ts` — LLM-with-context hub-intent recognizer (`classifyHubIntent`
  + `toHubCommand`); structured-output topic-id enum guardrail validated in code; fail-open on all
  uncertainty.
- Config `threadline.hubIntent` (`enabled` dev-gated; `dryRun:true`, `minConfidence:0.85`,
  `timeoutMs:4000`, `contextWindowTurns:6`, `modelTier:'fast'`); registered in `DEV_GATED_FEATURES`.
- `logs/hub-intent.jsonl` — machine-local dry-run soak log (LLM-engaged decisions only; 80-char preview).
- Committed discrimination corpus + opt-in real-model benchmark (`INSTAR_LIVE_HUB_INTENT=1`), the
  graduation gate before `dryRun:false`.
