# Side-Effects Review — Slack ambient "should I speak?" gate

**Version / slug:** `slack-ambient-gate`
**Date:** 2026-06-09
**Author:** Instar Agent (echo)
**Second-pass reviewer:** REQUIRED (changes when an undirected message is PROCESSED; LLM reads untrusted content) — independent adversarial review, see Phase 5

## Summary of the change

Phase 2, piece 2. `AmbientContributionGate.shouldSpeak()` decides whether the agent PROACTIVELY engages with an UNDIRECTED Slack message in an explicitly opted-in channel. **FAIL-TO-SILENCE:** speak only when ALL of (channel opted-in) + (under a hard per-channel rate-limit) + (LLM judges meaningful contribution above a conservative confidence threshold); ANY failure/uncertainty → silent. Dark/opt-in (no config → no gate attached → byte-for-byte today's mention-only behavior). Files: `src/permissions/AmbientContributionGate.ts` (new), `src/permissions/index.ts`, `src/messaging/slack/types.ts` (dark config block), `src/messaging/slack/SlackAdapter.ts` (wiring at the mention-only-skip), `src/commands/server.ts` (attach only when ≥1 channel opted in).

Decision point: whether an undirected message is processed at all (it was always dropped before unless directed).

## Decision-point inventory

- `SlackAdapter._handleMessage` mention-only-skip — **modify** — for an undirected message in an ambient-opted-in channel, run the gate; speak=false → the original drop path (unchanged); speak=true → process as a directed message. Directed messages (DM/@mention) never enter this block.
- `AmbientContributionGate.shouldSpeak` — **add** — fail-to-silence speak/silent decision.

---

## 1. Over-block

Not applicable in the harmful sense — the gate's bias IS toward silence (over-block). The "cost" of over-silence is the agent staying quiet when it could have helpfully contributed — the safe, intended direction for a conservative ambient mode.

## 2. Under-block (the real risk = OVER-SPEAK)

The danger is the agent speaking when it shouldn't (noise, or engaging with content it wasn't addressed in). Mitigations, ALL required for speak=true: explicit per-channel opt-in; a hard rolling-window rate-limit (conservative default 1 / 30 min / channel); an LLM meaningful-contribution judgment above a conservative confidence floor (default 0.85). Crucially, even a fully prompt-injected LLM "speak:true, confidence:1.0" is still bounded by the opt-in + rate-limit, and a malformed/uncertain verdict fails to silence. A speak=true only routes the message into the SAME downstream handling a directed message gets (including the permission gate) — it does not bypass any permission.

## 3. Level-of-abstraction fit

Correct. It slots at the exact mention-only-skip point — the one place undirected messages are decided — as a drop-in gate, not a parallel path. The LLM call mirrors the established `IntelligenceProvider.evaluate` pattern.

## 4. Signal vs authority compliance

**Required reference:** docs/signal-vs-authority.md + "no silent degradation." The gate holds authority (it can cause the agent to engage), and it is NOT brittle in the dangerous direction:
- It is FAIL-TO-SILENCE — the deterministic bounds (opt-in, rate-limit) gate the LLM, and the LLM call is deliberately NOT `gating:true` (a provider-swap would keep the decision alive; here the safe failure is silence, so any error lands in the catch → silent). Every degraded path = silence, never over-speak.
- It grants NO permission — a proactive turn still passes through the permission gate for anything it then does. So even maximal over-speak cannot widen access.

## 5. Interactions

- **Directed handling untouched:** the block is inside `respondMode==='mention-only' && !isDM && !@mention`, so DMs and mentions never reach it (verified at SlackAdapter.ts:907).
- **Rate-limit budget:** consumed (`recordSpoke`) only AFTER committing to process a proactive turn — no double-spend, no spend-on-silence. Per-channel keyed (no cross-channel budget bleed). In-memory; a restart resets the window, which can only make the agent quieter (safe side).
- **Ring buffer:** an un-spoken undirected message is still buffered for context (as today) then dropped — no behavior change there.

## 6. External surfaces

- **Other agents / install base:** none — dark by default (gate attached only when `ambientContribution.enabledChannelIds` non-empty). Byte-for-byte today's mention-only behavior otherwise.
- **External systems (Slack):** **ZERO new Slack Web API calls** (verified — the gate only decides whether to PROCESS; it never sends). The LLM provider is the existing IntelligenceRouter.
- **Untrusted input:** the LLM reads the message text (prompt-injection surface) — bounded by the fail-to-silence + opt-in + rate-limit invariant (focus of the Phase-5 review).

## 7. Rollback cost

Trivial. Additive + dark. Revert + patch; default (mention-only) behavior is unchanged on every install. In-memory rate-limit state is disposable.

## Phase 5 — Second-pass review (independent, adversarial — over-speak / fail-open)

REQUIRED. An independent reviewer attempted to force over-speak via prompt injection, find a fail-OPEN path, and bypass the opt-in/rate-limit. Verdict appended below.

### Verdict: CONCUR — fail-to-silence holds; no over-speak / bypass / fail-open

The independent reviewer traced all six vectors against the live code:
- **Prompt injection (over-speak):** untrusted text is fenced into the user prompt only; even a message mimicking the exact desired verdict can at most satisfy the LLM condition — it cannot touch the structural bounds (opt-in `Set.has`, double-guarded; per-channel rate-limit). No JSON-injection hole (malformed → null → silence). Ceiling under attack = the chosen conservative bound (1 proactive msg/window in an already-opted-in channel).
- **Fail-open:** none — every degraded branch (throw/timeout/circuit, empty/non-JSON, missing/`1`/string `speak`, NaN/negative/>1/missing `confidence`, thrown `onDecision` hook) lands on `speak:false`; defaults are silence + confidence 0.
- **Opt-in/rate-limit bypass:** none — opt-in is first + text-independent; budget consumed only AFTER commit (`recordSpoke` inside `if (ambientSpeak)`); rate-limit checked before the LLM; per-channel keyed (no cross-channel bleed); Socket-Mode redelivery deduped before the gate (no double-spend/double-speak).
- **Directed regression:** none — the whole block is inside `respondMode==='mention-only' && !isDM && !@mention`; DMs/mentions never enter it (wiring tests confirm 0 LLM calls).
- **Leak:** none — the prompt carries only the one overheard message (channel name passed undefined); a speak=true only processes content already being buffered.
- **Dark default:** byte-for-byte today's mention-only drop when unconfigured; an opted-in channel with a null provider still stays silent (`no-intelligence`).

The deliberate choice to NOT mark the LLM call `gating:true` is correct + load-bearing (a gating swap would keep the decision alive; here the safe failure is silence, so the error reaches the catch). 32/32 tests pass. **The gate can only ever make the agent quieter.**
