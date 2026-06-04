# Side-Effects Review — Update-Relevance Gate

**Version / slug:** `update-relevance-gate`
**Date:** `2026-06-04`
**Author:** `echo`
**Second-pass reviewer:** `not required (single-author Tier-2 under standing pre-approval)`

## Summary of the change

Adds an LLM-backed **UpdateRelevanceGate** at the single chokepoint every discretionary update-class message shares on its way to the Agent Updates topic. After PR #698 made user-facing announcements opt-in + maturity-tagged, the owner still saw update messages referencing internal machinery they cannot notice/use/care about ("Sibling Agent Server Control", "apprenticeship cycle recording"). #698 fixed the *framing*; this enforces *relevance*. The gate classifies a candidate message as `internal` (withheld), `jargon` (rewritten into plain language and delivered), or `user-relevant` (delivered as-is). It is wired into both update paths — `POST /telegram/post-update` (self-narration) and `POST /telegram/reply/:topicId` (the upgrade-notify session) — via a shared helper `applyUpdateRelevanceGate`. Files touched: `src/core/UpdateRelevanceGate.ts` (new), `src/core/types.ts` (config type), `src/server/routes.ts` (RouteContext field + helper + both routes), `src/server/AgentServer.ts` (options + routeCtx wiring), `src/commands/server.ts` (instantiation), `src/scaffold/templates.ts` (Agent Awareness), `src/core/PostUpdateMigrator.ts` (migration parity). Three test tiers + a migration test.

## Decision-point inventory

- `applyUpdateRelevanceGate` (src/server/routes.ts) — **add** — new relevance decision (suppress/rewrite/deliver) for Updates-topic-bound messages.
- `POST /telegram/post-update` — **modify** — relevance gate runs BEFORE the tone gate; suppressed → 200 {suppressed:true}; otherwise the (possibly rewritten) final text continues to the tone gate + send.
- `POST /telegram/reply/:topicId` — **modify** — relevance gate runs only when `topicId === agent-updates-topic` (strict no-op otherwise), and is skipped for proxy/system-template/relay sends exactly as the tone gate is.
- `monitoring.updateRelevanceGate.enabled` (config) — **add** — master flag; `undefined` resolves via the developmentAgent gate.

## 1. Over-block

The only "block" surface is suppression of an `internal`-verdict update. A false positive means a genuinely owner-relevant update is withheld. Mitigations: (a) the gate is instructed to choose `internal` ONLY when there is no owner-visible surface, and to prefer `jargon` (deliver + rewrite) whenever a real benefit hides under technical wording; (b) suppression is recorded to `logs/update-relevance.jsonl`, so an over-block is auditable rather than invisible; (c) it governs ONLY the Agent Updates topic — never normal conversation replies — so the blast radius is the update feed, where the cost of withholding a borderline note is low and the owner can always ask. A withheld capability is still LEARNED internally (the upgrade-notify MEMORY step is independent of the user message).

## 2. Under-block

An `internal`-but-mislabeled update could still reach the owner if the model judges it `user-relevant`/`jargon`. This is the acceptable-failure direction — it degrades to today's behavior (the message is sent), which is strictly no worse than before this change. The gate is additive noise-reduction, not a safety control, so under-block is benign.

## 3. Level-of-abstraction fit

Correct layer. This is an **authority** (LLM-backed, reasons about owner-relevance with the full candidate text), not a brittle detector. It deliberately mirrors `MessagingToneGate` — the established outbound-message authority — rather than re-implementing a keyword blocklist. It does NOT duplicate the tone gate: the tone gate judges *technical leakage / tone*; this judges *relevance to a non-technical owner*. They are complementary and run in series on the Updates path (relevance first, then tone on the final text). It uses the existing shared `IntelligenceProvider` primitive rather than opening its own LLM path.

## 4. Signal vs authority compliance

**Required reference:** [docs/signal-vs-authority.md](../../docs/signal-vs-authority.md)

- [x] Yes — but the logic is a smart gate with full conversational context (LLM-backed with the full candidate text and a prompt-injection boundary).

The gate holds suppress authority, but the logic is a smart, context-rich LLM authority — not a brittle detector. It mirrors the sanctioned MessagingToneGate pattern (same provider, fail-open, model 'fast', temperature 0, attribution). It never owns block authority with brittle heuristics. Compliant.

## 5. Interactions

- **Shadowing:** On `/telegram/post-update` the relevance gate runs BEFORE `checkOutboundMessage` (the tone gate). A suppress short-circuits before the tone gate and the send — intended (a withheld message needs no tone check). On a deliver/rewrite, the tone gate then runs on the FINAL text, so tone enforcement is preserved on exactly what goes out. Confirmed the reply route's existing system-template bypass + relay-skip semantics are mirrored, so the gate never shadows those.
- **Double-fire:** No. A message reaches the Updates topic through exactly one of the two routes; the helper runs once per request.
- **Races:** None. The gate is request-scoped and stateless apart from the append-only audit log (best-effort, never load-bearing).
- **Feedback loops:** None. The gate reads a candidate and emits a verdict; it does not feed any system that feeds back into it.

## 6. External surfaces

- **Other agents on the machine:** none (per-request, per-agent).
- **Install base:** ships dark on the fleet (developmentAgent gate), live only on Echo. No fleet behavior change until deliberately promoted.
- **External systems (Telegram):** the Updates-topic message content may now be a plain-language rewrite instead of the original, or withheld. `POST /telegram/post-update` gains a new success shape `{ok:true, suppressed:true, reason}` — additive; existing callers that only check `ok` are unaffected, and suppression is a 200 (success), so no caller treats it as a retryable error.
- **Persistent state:** appends to a new `logs/update-relevance.jsonl` audit file. No schema, no DB, no migration of existing data.
- **Timing:** adds one fast LLM call on the Updates path only. The reply path for normal conversation is byte-identical (strict no-op). Fail-open bounds any LLM-outage cost to "the original update is sent."

**Framework generality:** the gate is framework-agnostic. It operates on Telegram update-class messages via the shared `IntelligenceProvider`, which already abstracts the underlying framework (Claude CLI / Codex / etc.). No framework-specific assumptions; size-of-model is preserved by the provider's `model: 'fast'` contract across frameworks.

## 7. Rollback cost

Pure code change behind a flag. Back-out options: (a) set `monitoring.updateRelevanceGate.enabled: false` (or it's already dark on the fleet); (b) revert the code and ship a patch. No persistent state needs cleanup beyond an inert append-only log file. No agent-state repair. No user-visible regression during the rollback window — disabling the gate restores byte-identical passthrough.

## Conclusion

The review surfaced no design changes needed. The gate is an additive, fail-open, audit-logged relevance authority scoped strictly to the Agent Updates topic, mirroring the established tone-gate pattern. Over-block (the only real risk) is bounded by audit visibility, the prefer-jargon-over-internal instruction, and the low cost of withholding a borderline update. Clear to ship: live on Echo (dogfood), dark on the fleet.

## Evidence pointers

- Unit: `tests/unit/UpdateRelevanceGate.test.ts` (11 tests — both sides of every verdict boundary + fail-open).
- Integration: `tests/integration/update-relevance-gate.routes.test.ts` (6 tests — suppress/deliver/rewrite on post-update, disabled passthrough, strict no-op off the Updates topic, suppress on the reply path; audit-trail assertion).
- E2E: `tests/e2e/update-relevance-gate-lifecycle.test.ts` (3 tests — real AgentServer boot proves the options→routeCtx wiring; suppress + deliver over real HTTP + Bearer-auth).
- Migration: `tests/unit/PostUpdateMigrator-updateRelevanceGate.test.ts` (5 tests — section added, idempotent, template-parity no-double-patch, content preserved).
- Regression: usher-precision E2E (reply route) re-run green after the fail-safe `ctx.state?.get` guard.
