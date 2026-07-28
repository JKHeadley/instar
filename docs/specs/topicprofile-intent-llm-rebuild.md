---
title: "Topic-Profile Intent Recognizer: Keyword Regexes → LLM-With-Context"
slug: "topicprofile-intent-llm-rebuild"
author: "echo"
parent-principle: "Intelligence Infers, Keywords Only Guard"
eli16-overview: "topicprofile-intent-llm-rebuild.eli16.md"
review-convergence: "2026-07-04T06:07:45.585Z"
review-iterations: 3
review-completed-at: "2026-07-04T06:07:45.585Z"
review-report: "docs/specs/reports/topicprofile-intent-llm-rebuild-convergence.md"
cross-model-review: "codex-cli:gpt-5.5"
approved: true
single-run-completable: true
frontloaded-decisions: 4
cheap-to-change-tags: 0
contested-then-cleared: 0
---

# Spec — Topic-Profile Intent Recognizer: Keyword Regexes → LLM-With-Context

## Context

The keyword-intent audit (`docs/audits/keyword-intent-classification-audit-2026-07-03.md`)
found six places where a keyword/phrase/regex list DECIDES what a human meant. Three are wired
live into the inbound message path. This spec rebuilds **offender #1** —
`src/core/topicProfileIngress.ts` `parseProfileTrigger()`, the FRAMEWORK / MODEL / THINKING
write regexes — following the proven exemplar (the move-intent recognizer, PR #1367,
`MoveIntentClassifier` — the pattern: a cheap deterministic pre-filter drops obvious noise, an
LLM infers intent over the message + recent conversation, and the model's chosen value is
validated against a closed enum by code, never string-matched). It is conversion #1 of the plan
in `docs/specs/keyword-intent-conversions-1-and-3.md`.

**Currently.** `parseProfileTrigger` runs whole-message-anchored NL regexes over the operator's
message — `/^use (codex|claude|gemini|pi…) (here|for this topic)$/`, `/^switch this topic to
(…)$/`, the `THINKING_WORDS` forms, a `pin this topic to <id>$/` model form — to decide "does
this message mean *change this topic's framework / model / thinking*?" It is wired in `server.ts`'s
`handleTopicProfileIngress` (Telegram inbound); a positive match actuates a
`TopicProfileWriteSurface.applyWrite`, i.e. a session respawn.

**The bug class (honest framing).** These regexes are `^…$`-anchored, so they have FEW false
positives today — "should we use codex here?" never matched `^use …`. Their defect is twofold and
is the CLASS the standard bans regardless of current false-positive rate: (a) they are brittle in
the MISS direction — a valid paraphrase ("let's run this topic on claude", "make this a gemini
topic") has no matching anchor, so genuine intent is silently dropped; and (b) a keyword/regex
list DECIDING natural-language intent is the exact anti-pattern the constitutional standard
**"Intelligence Infers, Keywords Only Guard"** forbids — a judgment about what a human MEANT must
be inferred by an LLM over the message AND its conversation context, with keyword lists permitted
only to (1) validate a value against a closed enum or (2) constrain an LLM's already-inferred
choice to a known set. Offender #1 is the same CLASS as the live-wired sibling #2 (`NicknameCommand`,
which produced the 2026-07-03 hijack) — converted pre-emptively before it can misfire, not after.

## Alternatives considered

- **Explicit `/topic` slash commands only** (drop conversational recognition). Rejected: the
  conversational surface is the PRIMARY one by product design (CLAUDE.md's Topic Profile section:
  "NEVER instruct the user to type `/topic`"), and `/topic` already exists as the power-user path.
- **Confirmation round-trip on every conversational pin** (route every positive through
  `ProfileConfirmSlots.arm`). Rejected as the DEFAULT: it adds a confirm turn to the common,
  unambiguous "use codex here", a UX regression the deterministic regex path did not impose. The
  grounding guard (below) closes the ambiguous-context hole without taxing the common case.
- **Keeping the regex but widening it.** Rejected: it is the banned anti-pattern; widening trades
  the miss problem for the false-positive problem without escaping the class.

## What changes

A new `src/core/ProfileIntentClassifier.ts` — an LLM-with-context recognizer, structurally
identical to `MoveIntentClassifier`:

- **Input:** the operator's latest message + a bounded window of recent conversation turns
  (best-effort; the classifier works on the message alone if history is unavailable). The wiring
  fetches `contextWindowTurns + 1` turns and drops a trailing turn equal to the current message,
  so the model never sees the latest message twice.
- **Structured output:** the model emits strict JSON
  `{ isChange, intent: 'framework'|'model'|'thinking'|null, value, confidence }` where `value` is
  chosen from the closed enum for its intent:
  - `framework` ∈ `SUPPORTED_FRAMEWORKS` (claude-code / codex-cli / gemini-cli / pi-cli); the
    model maps a friendly word (codex→codex-cli) to the canonical id and emits the canonical.
  - `model` ∈ the known model ids/tiers — the union of `KNOWN_MODEL_IDS` across ALL frameworks
    plus the two tiers (`default` / `escalated`). Validation at the classifier is deliberately
    GLOBAL (framework-agnostic): the classifier's job is only to reject an invented id. The
    FRAMEWORK-SCOPED check (is this id valid for the topic's effective framework, and is its
    billing lane inside the subscription envelope) is `validateProfileFields`'s job at the write
    surface — a cross-framework id the classifier passes is then REFUSED there with a named reason,
    so no wrong respawn occurs, only a refusal reply.
  - `thinking` ∈ `THINKING_MODES` (off / low / medium / high / max).
- **Enum guardrail:** the emitted `value` is validated against the enum for its intent by CODE
  (`resolveEnumValue`, case-insensitive membership returning the canonical form) — the model's
  prose is NEVER string-matched. An out-of-enum value → no-op (pass-through). The model is
  structurally incapable of inventing a framework or model.
- **Grounding guard (`valueGroundedInLatestMessage`):** a profile change respawns the session, so
  the resolved value (or a framework's friendly alias) MUST appear in the LATEST message for a
  direct actuation. Context is used to judge command-vs-discussion, but a value resolved PURELY
  from a stale prior turn ("yeah go with that", answering a question five turns back) does NOT
  actuate — it fails toward pass-through. This closes a bypass the context window would otherwise
  open: a context-only affirmative would skip the `ProfileConfirmSlots` machinery (TTL / ordering /
  supersession / churn bound) and actuate directly. The old whole-message regexes could never
  match a context-only affirmative; this guard preserves that safety while gaining paraphrase
  recognition. It is a guardrail on an already-inferred value (standard survivor #2), not an intent
  decision.
- **Cheap pre-filter (drop-only):** if the message + context name NO framework / known-model /
  thinking-family signal token anywhere, skip the LLM and pass through. It never DECIDES a positive
  change — it only ever drops toward pass-through. It is deliberately INCLUSIVE (safe direction),
  so on a dev agent it spends one fast-tier LLM call on most operator turns that mention a
  profile-family word; its purpose is dropping obvious no-signal turns, not a large volume cut. The
  grounding guard, not the pre-filter, is what bounds actuation.
- **Fail-OPEN (load-bearing), and how it composes with *No Silent Degradation*:** the `evaluate`
  call is tagged `gating: true`, so on a provider failure the `IntelligenceRouter` first SWAPS to
  the configured failure-swap frameworks (each circuit-checked) before any error reaches the
  classifier — it does NOT drop to a heuristic on the first blip. Only when EVERY provider fails
  (or timeout / unparseable / schema-violation / out-of-enum / not-grounded / below-confidence)
  does the classifier return `isChange:false`. Critically, that pass-through is NOT a degradation to
  a brittle fake check — there is no heuristic fallback at all; the message simply reaches the
  AGENT (a strictly more-capable handler than any regex), and the outcome is REPORTED
  (`source:'fail-open'` + a logged row), never swallowed. For a message-gate that can SWALLOW user
  input, "fail toward pass-through" IS the safe, non-silent direction the "Intelligence Infers"
  standard prescribes; "No Silent Degradation" is satisfied by swap-first + report, with no weak
  check substituted. A missed "use codex here" is cheap (the operator restates, or the agent
  handles it); a wrongly-actuated respawn is the harm being removed.

`toProfilePatch(result)` adapts a positive result into the `ProfilePatchInput` the write surface
consumes (framework → `{framework}`; thinking → `{thinkingMode}`; a model tier → `{modelTier}`;
any other known model id → `{model}`). The write surface re-validates every field against the same
closed enums via `validateProfileFields`, so the classifier is a recognizer, not the authority.

`parseProfileTrigger` loses ONLY the framework/model/thinking write regexes (and the
`FRAMEWORK_WORDS` / `THINKING_WORDS` consts). It KEEPS the command kinds (readout / undo / clear /
reapply / switch-now / confirm) and the `effort` + `escalationOverride` forms. Those are NOT an
inference of framework/model/thinking intent (offender #1's declared scope): the command kinds are
structural, and `effort` + `escalationOverride` are fully `^…$`-anchored WHOLE-message forms over
CLOSED enums where command-vs-question is mitigated by whole-message anchoring, and
`escalationOverride: suppress` deliberately demands an unambiguous explicit form (any ambiguity
defaults to `inherit`, never weakening the escalation mandate). `EFFORT_WORDS` remains a
fixed-enum validator of an already-extracted token (the standard's survivor #1), not an intent
decider. (These siblings are named in the audit as part of the file but are out of THIS offender's
scope; the audit — a durable record — is where the broader keyword-intent program is tracked.)

## Wiring

`handleTopicProfileIngress` (server.ts): when `parseProfileTrigger` returns null, run the classifier
(forwarded content is never a command; the trust-floor `isAuthorizedSender` check already gates the
whole handler; the dev-gate + `_sharedIntelligence` + recent history feed it). A positive,
non-dry-run, grounded result → `applyWrite` + disclosure reply; everything else → pass-through. The
classified LATEST message is always the authorized operator's turn; conversation context in a
multi-participant topic may include other senders, but the grounding guard means a non-operator
cannot inject the value into the operator's latest message, so a planted-context assist cannot
actuate on its own.

**Observability.** The `evaluate` call carries `attribution.component: 'ProfileIntentClassifier'`
(registered `gate` in `componentCategories`), so provider / model / token cost / latency / fired
(isChange) vs noop (pass-through) land in `/metrics/features` automatically — no extra plumbing.
On top of that, every LLM-ENGAGED decision is appended to `logs/profile-intent.jsonl` for the soak:
`{ts, topicId, decision (actuate|would-actuate|pass), dryRun, source, intent, value, confidence,
reason, textLen}`. It records **no raw message content** — only enum-bounded fields and the message
LENGTH — mirroring the codebase's dev-soak convention (never persist a raw operator quote). A
prefilter-skip logs nothing (bulk traffic + privacy).

## Multi-machine posture

Machine-local BY DESIGN, and correctly so — no replication or proxied-read is needed:
- **The recognizer is per-machine inbound.** Telegram inbound is handled by the machine that OWNS
  the topic; the classifier runs there, on that machine's `_sharedIntelligence`.
- **What it gates is inherently machine-local.** A topic-profile write actuates a session respawn,
  which happens on the owning machine. There is no cross-machine state this feature owns.
- **The soak evidence is auto-aggregated, not hand-collated.** The primary graduation signal is
  `/metrics/features?feature=ProfileIntentClassifier` — which the `attribution.component` tag feeds
  automatically (calls / fired=would-actuate / noop=pass / provider / model / latency), so the
  operator reads ONE queryable surface, never greps logs by hand (satisfying *No Manual Work* —
  there is no per-machine log-union toil). The per-machine `logs/profile-intent.jsonl` is
  supplementary detail (the exact reason string per decision) for a spot-check, not the graduation
  input. The graduation flip itself (`dryRun:false`) is an irreducible operator RISK-ACCEPTANCE
  decision — enabling session-respawn actuation is a Rung-1 approval that cannot and should not be
  automated. The classifier makes an independent local decision per message regardless of where
  the topic is owned.

`machine-local-justification: physical-credential-locality` — the recognizer runs on the
topic-owning machine's Telegram inbound path, which is namespaced by that machine's bot token + the
forum/topic ids it owns (the standard's canonical example of this key), and it gates a tmux session
that physically lives on that machine's disk. There is no shared credential or durable state to
unify. A `unified` posture would be INFEASIBLE — the decision is a pure function of one machine's
inbound message + that machine's provider, with nothing to replicate.

## Rollout (dev-gated dark → dev-live dry-run → fleet)

- Config: `topicProfiles.intentClassifier` in ConfigDefaults, `enabled` DELIBERATELY OMITTED so
  `resolveDevAgentGate` decides — DARK on the fleet, LIVE on a development agent (registered in
  `DEV_GATED_FEATURES`, configPath `topicProfiles.intentClassifier.enabled`). Ships `dryRun:true`:
  on a dev agent the classifier RUNS and LOGS would-actuate vs would-pass, but the message ALWAYS
  passes through (never actuates a respawn) until a deliberate `dryRun:false`.
- **Calibration before graduation (concrete bound).** `minConfidence: 0.85` is inherited from
  `MoveIntentClassifier` and is NOT assumed calibrated. The graduation gate to `dryRun:false`
  requires, from `/metrics/features` + the soak rows: at least **200 LLM-engaged decisions** across
  the soak window, a **would-actuate false-positive rate < 1%** (a would-actuate on a message that
  was not actually a present profile command — counted separately from missed commands, which are
  the cheap direction), and **zero context-resolved would-actuates** (the grounding guard should
  make these structurally impossible; any occurrence is a bug, not a threshold). The opt-in LIVE
  discrimination-corpus accuracy run (≥90%, both canonical cases correct) is the pre-soak gate.
- **Context-only affirmatives are pass-through BY DESIGN.** A bare-ish confirmation whose value
  lives only in prior context ("yes, do that" after "switch this topic to gemini?") does NOT
  actuate — the grounding guard passes it through to the agent, which can re-propose via the
  existing §10.1 propose-confirm lane (`ProfileConfirmSlots`, still driven by `parseProfileTrigger`'s
  `confirm` kind). This is a deliberate safety choice, proven by the `guard-context-only-value`
  corpus case: the recognizer never turns a stale-context "yes" into a respawn.
- Because the topic-profile WRITE layer is itself dev-gated + dryRun (`topicProfiles.enabled` /
  `.dryRun`), this is doubly inert on the fleet. On the fleet, framework/model/thinking
  conversational pins pass through to the agent (which handles them conversationally / via
  `/topic`) — only the recognizer changed, not the write authority.
- Tunables (all frontloaded, no build-time decision left to the operator): `minConfidence` 0.85,
  `timeoutMs` 4000, `contextWindowTurns` 6, `modelTier` 'fast'. `'fast'` = a small, low-latency
  model — the standard deems it sufficient for this binary-ish, structured-output judgment; it is
  exposed so the operator can raise it to 'balanced' if the soak shows the fast model miscalibrated
  on the subtle command-vs-discussion cases.

## Signal vs authority

The classifier is a SIGNAL producer feeding the existing `TopicProfileWriteSurface` authority (which
owns validation + all side effects). It never holds brittle blocking authority: it can only ever
move a message from "actuate a write" toward "pass through to the agent" (fail-open), and the write
surface independently re-validates every field. This is the correct layer — the recognizer's
decision moves from regex to LLM; the actuator is unchanged.

## Tests (three tiers + the discrimination corpus)

- **Unit** (`tests/unit/ProfileIntentClassifier.test.ts`): pre-filter, JSON parse, enum guardrail,
  the grounding guard (both directions), confidence gate, intent→patch mapping, and the full
  fail-open matrix (no-provider / throw / timeout / unparseable / schema-violation) with a stub
  provider. This doubles as the wiring-integrity test for the injected `IntelligenceProvider`
  dependency — the no-provider and throwing-provider cases prove the DI dep is exercised and that a
  null/failing dep degrades to the safe pass-through, never a silent no-op that looks alive.
- **Discrimination corpus** (`tests/unit/profile-intent-discrimination.test.ts`, the first-class
  artifact): CHANGE vs DISCUSSION both directions with paraphrase, the context-only grounding
  guardrail, the out-of-enum guardrail, and fail-open cases. A DETERMINISTIC harness (CI) feeds each
  case a scripted "ideal model" verdict and asserts the pipeline maps it correctly; a LIVE harness
  (opt-in `INSTAR_LIVE_PROFILE_INTENT=1`) runs the SAME corpus against the real IntelligenceProvider
  for the model-accuracy benchmark. Plus a regression assertion that the keyword regexes are gone
  from `parseProfileTrigger`.
- **Integration** (`tests/integration/profile-intent-ingress-path.test.ts`): the ingress decision
  chain classifier → `toProfilePatch` → `validateProfileFields`, proving a genuine command yields an
  ACCEPTED patch and discussion / fail-open / dry-run yield no patch (pass-through). No new HTTP
  route is added — the change is a pure-logic classifier plus a dev-gated branch inside the existing
  inbound path — so there is no new server-route surface for a Phase-1 "feature is alive" E2E to
  probe; the integration test IS the end-to-end decision proof for the ingress path, and the
  dev-gate/dryRun wiring is covered by the dark-gate line-map + DEV_GATED_FEATURES wiring tests.

## Open questions

*(none)*
