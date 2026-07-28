# Side-Effects Review — Standing-Authorization signal for B17_FALSE_BLOCKER (bias-to-action)

**Version / slug:** `bias-to-action`
**Date:** `2026-06-29`
**Author:** `echo`
**Second-pass reviewer:** `independent reviewer subagent (Phase 5 — REQUIRED: touches the outbound gate authority + a uid/forwarded security path)`

## Summary of the change

Feeds the existing `MessagingToneGate` B17_FALSE_BLOCKER rule a **standing-authorization signal** so that "re-asking the operator for an approval they ALREADY granted" is recognized as the false blocker it is — the structural answer to the 2026-06-27 incident where I stopped at "ready for your go-ahead to build" despite a live preapproval. Two cheap, deterministic, deps-injected producers (`detectAskWhenAuthorized` — does the outbound text seek permission?; `resolveStandingAuthorization` — is there a VERIFIED-operator, non-forwarded, in-window grant?) feed the LLM gate, which makes the semantic call (does this grant cover THIS specific, non-FLOOR action?). **Ships OBSERVE-ONLY + dev-gated DARK**: on a dev agent it records a would-fire to `logs/bias-to-action.jsonl` (uid HASH + ask-phrase token, never a raw quote) and changes NO message; the live B17 firing is a separate future `observeOnly:false` operator decision. Files: `src/core/standing-authorization.ts`, `src/core/ask-when-authorized.ts`, `src/core/bias-to-action-telemetry.ts` (new); `src/core/MessagingToneGate.ts` (signal/context fields, render, B17 sub-clause); `src/server/routes.ts` (resolver wiring + observe-only telemetry + lifeline forwarded persistence + context attach); `src/messaging/TelegramAdapter.ts` (LogEntry `forwarded` + both ingress writers); `src/core/types.ts` + `src/config/ConfigDefaults.ts` (config); `src/core/devGatedFeatures.ts` (dev-gate registry); tests + the dark-gate line-map.

## Decision-point inventory

- `MessagingToneGate` **B17_FALSE_BLOCKER** rule (LLM authority) — **modify** — gains a STANDING-AUTHORIZATION sub-clause: an "asking for approval" message the existing carve-out would exempt becomes a B17 false blocker WHEN a verified grant plausibly covers THIS exact, non-FLOOR action. Judged by meaning; under-fire bias on every uncertainty. Inert until graduated.
- `detectAskWhenAuthorized` (signal-producer) — **add** — cheap deterministic "is the agent asking permission?" signal. No authority.
- `resolveStandingAuthorization` (signal-producer) — **add** — deterministic "is there a verified-operator non-forwarded in-window grant?" resolver. Deps-injected; no authority.
- `bias-to-action-telemetry.buildBiasToActionWouldFire` (observe-only telemetry) — **add** — pure record builder; no authority, no delivery effect.
- Telegram message-log `forwarded` field (data) — **add** — explicit boolean on both ingress writers; pure data, no decision surface of its own.

---

## 1. Over-block

**Shipped state (observe-only): NONE — the gate verdict is never changed.** In observe-only mode (the default, and the only mode shipping) `standingAuthorization` is NOT attached to the gate context, so B17 behaves exactly as today; the feature only writes a telemetry line.

**When graduated (`observeOnly:false`, a future operator decision):** the live risk is suppressing a NEEDED ask — the gate misjudges that an in-scope grant covers an action it doesn't, and tells the agent to act instead of asking. Mitigations baked in: (a) the gate judges by MEANING with full conversational context (a smart authority, not a brittle matcher); (b) a hard FLOOR-action carve-out (irreversible / cost-bearing / out-of-scope / policy-sensitive ALWAYS legitimately needs the ask, even with a live in-scope grant); (c) a decisive UNDER-FIRE bias — any uncertainty about coverage, floor-ness, or grant presence does NOT fire B17 (a needless ask is harmless; suppressing a needed one is the harm); (d) observe-only-first with a named FP-rate exit criterion before graduation.

---

## 2. Under-block

A genuine false-blocker ask still PASSES (no B17 fire) whenever the grant cannot be PROVEN: a forwarded-unknown legacy message-log row (no `forwarded` field), a row with a missing/blank uid, a grant outside the recency window, or a topic with no bound verified operator. This is the deliberate fail-safe direction (an unprovable grant never suppresses an ask). Also: the resolver's grant-phrase list is finite, so an operator's idiosyncratic phrasing of a grant may not be recognized — again failing toward sending the ask, never toward suppressing it.

---

## 3. Level-of-abstraction fit

Correct by construction. The two new modules are **detectors** (cheap, deterministic, deps-injected, no context, no authority) that FEED the existing **smart authority** (the LLM-backed B17 rule, which already has recent-message context). This is exactly the signal→authority shape `docs/signal-vs-authority.md` prescribes — not a new parallel brittle gate. The resolver re-uses the existing `TopicOperatorStore.asVerifiedOperator` (the authoritative verified-operator binding) and the existing `TelegramAdapter.getTopicHistory` read path rather than re-implementing either.

---

## 4. Signal vs authority compliance

**Required reference:** [docs/signal-vs-authority.md](../../docs/signal-vs-authority.md)

- [x] **No — this change produces a signal consumed by an existing smart gate.**

`detectAskWhenAuthorized` and `resolveStandingAuthorization` produce signals/context only; they hold zero block authority. The B17 decision stays with the LLM gate, which already reasons over conversational context and carve-outs and judges the new sub-clause BY MEANING (the gate-prompts-judge-by-meaning ratchet still passes). The observe-only telemetry is a pure record producer. No brittle logic anywhere owns a block/allow decision.

---

## 5. Interactions

- **Shadowing / citation precedence:** B17's citation precedence (B15 > B16 > B17 > B18) is unchanged. The standing-authorization context can NEVER flip a B1–B7/B15 leak HOLD — D7 renders `evidenceQuote` as boundary-quoted, secret-scrubbed untrusted DATA, and the gate's existing leak rules take precedence. The MessagingToneGate suite (incl. the leak-HOLD regression) passes.
- **Double-fire:** none. The resolver/telemetry run once per outbound review inside `evaluateOutbound`, alongside the other signal producers, before the single `review()` call.
- **Races:** the observe-only log write is append-only fire-and-forget; the `forwarded` field is additive to `LogEntry` (both writers persist it; the tail-cache and JSONL scan read it). No shared mutable state with concurrent cleanup.
- **Feedback loops:** none — the telemetry log is write-only observability; nothing reads it back into the gate.
- **Forwarded-persistence interaction:** the explicit `forwarded: false` diverges from the adjacent "spread `{forwarded:true}`, omit when false" idiom (TOPIC-PROFILE round-5). Verified the TOPIC-PROFILE forwarded-rejection still reads `forwarded === true` (an explicit `false` is correctly treated as not-forwarded by that path), and the TelegramAdapter suite passes.

---

## 6. External surfaces

- **Other agents / users:** none — dev-gated dark on the fleet (`monitoring.biasToAction.enabled` omitted → resolves dark off-dev). No HTTP route added.
- **Persistent state:** appends to `logs/bias-to-action.jsonl` (machine-local, append-only, observe-only telemetry — uid HASH + ask-phrase token + source enum + grant timestamp; NEVER a raw uid or raw operator quote). Adds a `forwarded` boolean to Telegram message-log rows (additive; other log readers ignore unknown fields).
- **External systems:** none (no Telegram/Slack/GitHub send; observe-only writes a local log).
- **Operator surface (Mobile-Complete):** **No operator-facing actions** — no route, no form, no PIN-gated action. The graduation lever is a config flag set by the operator out-of-band, not an in-product action.

---

## 6b. Operator-surface quality

**No operator surface — not applicable.** This change stages no `dashboard/*` renderer, approval page, or grant/secret form.

---

## 7. Multi-machine posture (Cross-Machine Coherence)

**machine-local BY DESIGN**, with reason: the observe-only telemetry exists to measure THIS detector's false-positive rate on THIS machine's real outbound before any warn/block surface is built — a pure per-machine observability stream (`logs/bias-to-action.jsonl`), exactly like the principalCoherence and raw-text-request observe-only logs. The resolver reads the LOCAL topic's verified-operator binding (`TopicOperatorStore`, already machine-local / topic-holder-authoritative) and the LOCAL message-log history; a topic moved to another machine resolves against the holder's own operator-binding + history (consistent with the existing operator-binding read — the working-set carrier already follows a moved topic's message log). 

- **User-facing notices?** No — observe-only writes a log; it sends nothing, so no one-voice gating needed.
- **Durable state stranding on transfer?** The telemetry log is per-machine FP measurement (not behavior), so it intentionally does not follow a topic; the `forwarded` field rides the same message-log the working-set carrier already moves.
- **URLs across machine boundaries?** None generated.

---

## 8. Rollback cost

- **Hot-fix:** pure code + config + one new telemetry log. Revert the branch, ship the next patch. The fleet sees NO behavioral/verdict change (the resolver + grant context + telemetry are dev-gated dark, so no standing-authorization logic runs and no message is ever altered there). The one fleet-wide difference is static: the B17 prompt now carries the STANDING-AUTHORIZATION sub-clause text + the `renderStandingAuthorization` "no verified standing authorization" placeholder — rendered unconditionally like every other static B-rule, and self-neutralizing (present:false → the sub-clause does not apply and the existing approval carve-out stands; the 55-test gate suite incl. leak-HOLD passes against it). Even a dev agent never altered a message (observe-only). So there is NO user-visible regression to roll back.
- **Data migration:** none required. `logs/bias-to-action.jsonl` is append-only telemetry, safe to leave or delete. The new `forwarded` field on message-log rows is additive and backward-compatible (legacy rows read as forwarded-unknown, which the resolver treats fail-safe).
- **Agent state repair:** none — no agent needs notification or reset.
- **User visibility:** none during the rollback window (observe-only, dark on fleet).

---

## Conclusion

The change is the minimal, correctly-layered embodiment of the approved spec: two deterministic signal-producers feeding the existing smart B17 authority, shipped observe-only + dev-gated dark so it measures its own false-positive rate before it ever changes a message. The review surfaced and confirmed the three load-bearing safety properties — (1) the standing-authorization context can never flip a leak HOLD, (2) every uncertainty fails toward sending the ask, and (3) a forwarded/unattributable grant never counts — each covered by tests on the real read/write paths. The forwarded-persistence work (explicit `false` on both ingress paths) is the load-bearing security substrate and is wiring-tested through the real `getTopicHistory`. Clear to ship as observe-only; live B17 firing remains a deliberate future operator decision.

---

## Second-pass review (if required)

**Reviewer:** independent reviewer subagent (adversarial, security-focused)
**Independent read of the artifact: CONCUR**

The reviewer independently traced all six security-critical claims against the actual code + the wiring/gate tests and could not break any:

1. **Leak-HOLD flip** — Safe. `standingAuthorization` is attached to the gate context ONLY in the `observeOnly === false` branch; in the shipped observe-only/dark state it stays `undefined`. When attached, `renderStandingAuthorization` JSON-encodes the quote in a fresh `AUTH_BOUNDARY_…`, length-bounds to 280, and the route pre-scrubs via `scrubString`; labeled untrusted DATA; citation precedence (B15>B16>B17>B18) untouched. Leak-HOLD regressions pass.
2. **Attribution** — Safe. Matched on `String(telegramUserId) === String(verified uid)` (authenticated `msg.from.id`), never `fromUser`/content-name; blank uid is a non-match (no wildcard); the `fromUser` filter excludes the agent's own sends (no self-grant).
3. **Forwarded third-party content** — Safe. Resolver counts only strict `forwarded === false`; both ingress writers persist an explicit boolean; legacy rows (no field) fail-safe; the lone downstream `forwarded` consumer (topicProfileIngress) is a truthy check, so explicit `false` doesn't break it.
4. **Telemetry leak** — Safe. Emits only ISO time, kind, topicId, source enum, ask-phrase token (agent's own canned phrase, bounded), uid HASH (12 hex), grantedAt. No raw uid, no operator words.
5. **Fail-open / inert** — Confirmed. Whole block is try/catch fail-open; telemetry write independently try-caught; on the fleet `resolveDevAgentGate` returns false so nothing runs.
6. **Dev-gate** — Correct. ConfigDefaults omits `enabled`; `resolveDevAgentGate` funnel; registered in `DEV_GATED_FEATURES`. Observe-only path confirmed NOT to attach the grant.

One non-blocking observation (no fix to code required): the B17 sub-clause prompt text renders fleet-wide even where the resolver is dark — addressed by softening §8's wording above (the fleet sees no behavioral change; the static prompt section is self-neutralizing). Nothing security-critical is broken.

---

## Evidence pointers

- Unit: `tests/unit/standing-authorization.test.ts` (11), `tests/unit/ask-when-authorized.test.ts` (16), `tests/unit/bias-to-action-telemetry.test.ts` (6).
- Wiring-integrity (real read/write paths): `tests/unit/bias-to-action-wiring.test.ts` (8) — forwarded persistence on BOTH ingress paths incl. explicit `false`; resolver fed from the real `getTopicHistory` honoring verified-uid-only + forwarded + no-operator fail-safes.
- Gate: `tests/unit/MessagingToneGate.test.ts` (55) incl. the leak-HOLD regression + gate-prompts-judge-by-meaning ratchet.
- Ratchets: `npm run lint` clean (incl. `lint-dev-agent-dark-gate`); `tests/unit/lint-dev-agent-dark-gate.test.ts` line-map updated (+9 shift documented).
- Spec: `docs/specs/BIAS-TO-ACTION-SPEC.md` (review-convergence + approved:true), ELI16 `docs/specs/BIAS-TO-ACTION-SPEC.eli16.md`.
