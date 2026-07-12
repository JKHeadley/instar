# Side-Effects Review — LLM-Decision Provenance Wiring (ACT-562)

**Version / slug:** `llm-decision-provenance-wiring`
**Date:** `2026-07-12`
**Author:** `echo`
**Second-pass reviewer:** `independent reviewer subagent — CONCUR (no defects; see Second-pass review section)`

## Summary of the change

Wires the existing `JudgmentProvenanceLog` substrate (previously connected to exactly one deterministic callsite, `SpawnAdmission`) to the three highest-stakes *LLM* decision points named in the ACT-562 audit: the autonomous continue/stop + P13-hard-blocker judge (`CompletionEvaluator`), the process-kill classifier (`ExternalHogClassifier`), and the always-on outbound tone gate (`MessagingToneGate`). It also (a) hoists construction of the log to unconditional-at-boot so it exists on every agent (previously null on single-machine / pool-dark installs), (b) makes `recordDecision` fail-open-total so a provenance write can never throw into a decision path, (c) adds a monotonic coverage ratchet that turns "every LLM decision point must log" from prose into a red-build invariant, (d) wires one `annotateOutcome` seam to an independent ground-truth signal (Real-Check verification results), and (e) envelopes every served free-text field as untrusted data. Recording is **dark-gated behind `provenance.llmDecisionWiring` via `resolveDevAgentGate`** — ENABLED on the dev agent, DARK (constructed-but-idle) on the fleet. Files: `JudgmentProvenanceLog.ts`, `provenanceRequired.ts` (new), `provenanceEnvelope.ts` (new), `RealCheckOutcomeBinder.ts` (new), `CompletionEvaluator.ts`, `MessagingToneGate.ts`, `commands/server.ts`, `server/AgentServer.ts`, `server/routes.ts`, `devGatedFeatures.ts`, `config/ConfigDefaults.ts`, `core/types.ts`, plus 8 test files + a coverage-floor artifact.

## Decision-point inventory

Every point below is **pass-through** for its own decision — this change *observes* each existing authority's verdict and never alters it. It adds **no new authority** and **no new brittle blocker**.

- `MessagingToneGate:outbound-gate:v1` — pass-through (observe) — records the derived context (80-char textHead + acted-on signals) + verdict of the existing tone-gate authority. The gate's block/allow decision is untouched.
- `CompletionEvaluator:continue-stop:v1` — pass-through (observe) — records the autonomous continue/stop verdict + its fenced context. The run-lifecycle decision is untouched.
- `CompletionEvaluator:p13-blocker:v1` — pass-through (observe) — records the P13 hard-blocker verdict. Untouched.
- `ExternalHogClassifier:process-kill:v1` — pass-through (observe) — records the kill/leave classifier verdict at the `evaluate` primitive. The veto-only deterministic floor + PIN-arm still gate the actual kill; recording never influences it.
- `SpawnAdmission` (pre-existing) — pass-through — unchanged; remains the reference caller.

---

## 1. Over-block

**No block/allow surface — over-block not applicable.** This change is observability-only. It introduces no path that can reject, hold, delay, or filter any message, action, spawn, or run. Every `recordDecision` call is a fire-and-forget append that is gated ON only for the dev agent and swallows all failures. A logging hiccup cannot change any verdict — proven by the §3.4 fail-open-totality negative test (a circular-reference / throwing-getter context never throws, and the caller's verdict is byte-identical whether the write succeeds or fails).

## 2. Under-block

**No block/allow surface — under-block not applicable.** Nothing here is trying to catch a failure mode; it records decisions other authorities already made. The closest analog to "under-block" is *coverage*: today only 3 of ~60 LLM decision points log. That is intentional (high-stakes-first per §2/§7, privacy-bounded per §7) and is not a miss — the §3.2 monotonic ratchet makes the remaining ~55 an explicitly-tracked, red-build-enforced backlog (each must be classified `required` / `deferred:<ref>` / `exempt:<rationale>`) <!-- tracked: ACT-562 -->, so the surface cannot silently grow past coverage.

---

## 3. Level-of-abstraction fit

Correct layer. Provenance is captured **at each caller**, after it parses the raw LLM text into a structured verdict/reason/floor — which is the only place that structure exists (the `buildIntelligenceProvider` funnel sees raw text only). The substrate (`JudgmentProvenanceLog`) already existed and was well-designed; this change *wires* it, it does not rebuild it. The coverage invariant lives one layer up as a CI ratchet over a production allowlist (`provenanceRequired.ts`), riding the existing `COMPONENT_CATEGORY` / `llm-attribution` census rather than a parallel enumeration. No smarter gate already owns "record what this decision decided on" — this is the first mechanism for it, which is the whole point of the audit (instar had a cost meter, no quality meter).

## 4. Signal vs authority compliance

**Fully compliant — this change is pure signal-side and adds zero authority.** Per `docs/signal-vs-authority.md`: detectors produce signals, authorities hold blocking power. This change adds neither a detector-with-authority nor a new authority; it records what the *existing* authorities (tone gate, kill classifier, continue/stop judge) already decided, with their own context and reasoning. It cannot block anything. The one direction it could have violated the principle — a graded outcome feeding back into a decision input (model routing, door, prompt, floor) — is explicitly barred as a §3.5 invariant this increment (and ACT-563) must not cross; the `RealCheckOutcomeBinder` only *writes* outcome rows and the route never reads them into any verdict. The feedback edge is deferred to ACT-564 with its own required bias/gaming analysis `<!-- tracked: ACT-564 -->`.

## 5. Interactions

- **Shadowing / double-fire:** No verdict path is duplicated or shadowed — a single `recordDecision` append per verdict, gated once. The tone-gate write is on the real-LLM-verdict path only (`interp.kind==='ok'`); the deterministic availability-fallback paths (fail-closed / degraded / capacity) are NOT logged, so a degradation is never misattributed as an LLM decision.
- **Construction vs wiring race:** Construction is now unconditional (server.ts hoisted block + AgentServer default-construct belt-and-suspenders) and the `multiMachine.sessionPool` block reuses the same instance rather than constructing a second — verified single-instance.
- **Adjacent cleanup:** The log has its own retention (14d) + two-ring drop-oldest buffer; it does not race the reaper or any other cleanup. The `annotateOutcome` binder is idempotent (one terminal outcome per `decisionId`; a second annotate is rejected) so a re-driven Real-Check tick cannot smear or double-write.
- **`/metrics/features` agreement:** model/door/tokens are sourced from each call's existing `onUsage`/attribution path, so a provenance row and its cost row agree by construction rather than drifting.

## 6. External surfaces

- **`GET /judgment-provenance`** changes from `503 (not constructed)` to `200-empty` on an agent with no rows (the hoist), and now sets `Cache-Control: no-store`. Bearer-gated as before; redacted rows only. This is the only externally-visible route change. A client that previously treated 503 as "feature off" now gets 200-empty — a strictly more honest signal, no breaking consumer (the route was already dev-surfaced).
- **Served free-text is enveloped:** `context`, `contextRedacted`, `reason`, `decision`, `optionsPresented`, `outcome` are HTML-escaped at the HTTP surface and (for the future grader/bench) serialized as a JSON string literal inside a fenced `untrusted-provenance-json` block. This closes the injection risk that the logged context (attacker-influenceable transcript/message tails) could steer a downstream reader. Verified by the closing-delimiter/delimiter-injection test.
- **Timing/runtime dependence:** none that affects correctness — recording is async, buffered, and fire-and-forget; a slow disk trades bounded memory (two rings, caps 5000/20000, drop-oldest) for never-slowing-a-decision.

## 7. Multi-machine posture (Cross-Machine Coherence)

**machine-local write, proxied-on-read** — matches the authoritative parent classification in `ownership-gated-spawn-and-judgment-within-floors.md`. Full provenance rows are credential-shape-scrubbed but NOT PII-scrubbed and are machine-local (0700/0600, `NEVER_SERVED_PREFIXES`, gitignored, backup-excluded, 14d retention); they are **never replicated** (replicating PII-bearing rows would widen the at-rest surface with no accountability benefit — each machine is accountable for its own decisions). The unified read is `GET /judgment-provenance?scope=pool`, which redacts full rows on the serving machine *before* the wire, envelopes each free-text field as untrusted (§3.1a), rides the existing shared pool-poll cache (per-peer once-per-interval, coalesced — not a naked per-request fan-out), and bounds total merged bytes. No silent single-machine assumption: the posture is declared and defended, and the coverage ratchet is a CI test (machine-independent). User-facing surface: the only user-visible notice is the deduped operator Attention item when `highStakes.bufferDropped > 0` (a lost process-kill audit under a pathological disk stall) — routed through the existing one-voice Attention path, not a new topic.

## 8. Rollback cost

**Cheap and reversible.** The feature is dark-gated (`provenance.llmDecisionWiring`, `enabled` omitted in `ConfigDefaults` ⇒ off on the fleet); flipping it off (or it simply never being on for a given agent) leaves the log constructed-but-idle with zero rows and zero behavior change. There is no migration and no persisted state that outlives the 14d retention window. Back-out of the whole change is a plain revert: construction reverts to conditional, callsites stop appending, the route reverts to 503-on-not-constructed. No data migration, no agent-state repair, no fleet coordination. Because recording never touched any decision outcome, a revert cannot regress any gate/kill/run behavior — the decisions were byte-identical with the feature on or off.

## Second-pass review (independent)

**Concur with the review.** I verified the observability-only claim against the real diff and code, not the artifact's assertions.

- **§3.4 fail-open totality (A) — holds.** `recordDecision` and `annotateOutcome` wrap their entire bodies in `try/catch` returning `null`/`false` on any throw (`JudgmentProvenanceLog.ts:226-294, 306-332`); `clampRow` wraps every `JSON.stringify` and falls to a defensive skeleton (`:345-384`), closing the one previously-uncaught circular/throwing-getter path. Both in-process callsites (ToneGate, CompletionEvaluator) additionally wrap the sink in a local `emitProvenance` try/catch and place the emit AFTER the verdict is formed / before `return`. The ExternalHog callsite (`server.ts:~18076`) does NOT add a local wrapper, but it calls the provably-total `recordDecision` after `raw` is captured and before `return raw`, so it cannot introduce a throw into or alter the kill decision (which is computed downstream from `raw` by `parseClassifierVerdict` + the veto-only floor in `ExternalHogScanTick.ts:164-165`, unchanged). All emits are synchronous fire-and-forget — never awaited into a verdict. The unit test proves a throwing sink leaves the ToneGate/CompletionEvaluator verdict byte-identical.
- **(B) No new authority** — every logged point is pass-through; `recordDecision` returns an id only and no consumer reads it back into a gate. **(C) §3.5 loop stays open** — `RealCheckOutcomeBinder` only WRITES outcome rows (`annotateOutcome`); the route (`routes.ts:5204`) calls `bindNewOutcomes()` and the verdict below never reads a graded outcome. No read-back edge exists in this diff.
- **(D) §3.1a envelope** — `readRedacted` omits `contextFull` and runs `envelopeRedactedRowForHttp` over every free-text field (`contextRedacted/reason/decision/optionsPresented/outcome`); `context` is never a served field name. The pool merge (`routes.ts:15065-15070`) forwards peer rows that were already redacted+enveloped on the peer's own machine (standard trust model), byte-bounded at 8KB. The LLM-replay serializer JSON-string-escapes, making closing-delimiter injection inert by construction (verified by test). **(E)** construction is unconditional and single-instance (hoist + AgentServer fallback + sessionPool reuse — no double-write path). **(F)** full PII rows never cross the wire (no replication; peer serves only its redacted view). **(G)** `ConfigDefaults` omits `enabled`, the flag is registered once in `DEV_GATED_FEATURES`, and gate-OFF yields `recordProvenance: undefined` ⇒ zero rows.
- **Verification performed:** `tsc --noEmit` clean; all 46 ACT-562 unit tests pass; the coverage-floor `setHash` recomputes exactly (`85b903e9…`); integration tests confirm 200-empty (not 503) + `Cache-Control: no-store` + read/pool envelope. The design is genuinely observability-only.

## Class-Closure Declaration

**Class:** `unbounded-self-action` — **closure: `guard`.**

The only self-triggered emit this change adds is the high-stakes buffer-drop operator notice (server.ts, id `agent:provenance-highstakes-drop`). It is bounded by construction: it is emitted with a **fixed attention id**, and `createAttentionItem` coalesces by id, so repeated high-stakes row drops under sustained disk-stall pressure converge to **exactly ONE** operator item (steady-state bound = 1 per condition). The emit is a passive reaction inside `recordDecision`'s already-bounded flush path (two-ring drop-oldest buffer, caps 5000/20000) with **no self-scheduled tick/timer loop** of its own. Provenance recording itself is a per-decision-event append (one row per verdict, hard-capped by the ring buffer), not a self-triggered controller. The `RealCheckOutcomeBinder` is idempotent per `decisionId` (one terminal outcome per decision; a second annotate is rejected), so it cannot re-fire unboundedly either.

- **Enforcement:** gate — the fixed-id dedup in `createAttentionItem` is the settling brake.
- **Citation:** `src/commands/server.ts#provenance-highstakes-drop`
