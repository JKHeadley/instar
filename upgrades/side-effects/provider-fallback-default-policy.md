# Side-Effects Review — Provider-Fallback Default Policy

**Spec:** `docs/specs/provider-fallback-default-policy.md` (CONVERGED 4 rounds, approved:true) · CMT-1554/1555
**Change:** ship the existing `IntelligenceRouter` failure-swap engine turned ON by default for internal gating/sentinel/reflector components (active-filtered chain Codex→PI→Gemini→Claude), plus a bounded per-attempt swap timeout so the longer default chain cannot re-create the stall it prevents.

## Phase 1 — Principle check (signal vs authority)
This touches a decision point (which provider serves a gating/safety call), so the principle applies. The change adds **no new brittle blocking authority**: the router's `failureSwap` fail-closed authority already exists and is preserved (it re-throws when primary + every swap target is down → the gating caller fails closed, never a silent brittle heuristic). The new pieces are (a) a default *preference order* (a policy, not an authority) and (b) a **fail-open** per-attempt timeout (timed-out attempt → next target → Claude tail → fail-closed only if all exhausted). The timeout is signal-shaped (abandon-slow → try-next) and cannot turn a fail-closed outcome into a silent pass. Observability rides the existing `DegradationReporter` (`onDegrade` reason `swap-attempt-timeout:<target>`). **Compliant.**

## Phase 2 — Plan
Built in the existing worktree `.worktrees/provider-fallback-chain` (verified current with `JKHeadley/main @ce13f42a3`; `git remote -v` → JKHeadley; tags `review-convergence`+`approved:true` present). Decision points touched: the router's `failureSwap` (existing authority — preserved). Existing detectors interacted with: `DegradationReporter` (observability), the per-framework circuit breakers (unchanged). Rollback: the no-op guarantee + the `{}` config lever (below).

## 1. Over-block
The change does not *block* inputs; it routes them to a different provider. The closest "over-block" risk is the §4.5 per-attempt timeout abandoning a provider that *would* have answered correctly just slowly. Mitigated: (a) the cap (5s) only fires on a swap attempt that is already past the failed primary, i.e. in a degraded path; (b) a timed-out attempt is *fail-open* — it advances to the next target and ultimately the Claude tail, never to a denial; (c) the cap is operator-tunable (`intelligence.swapAttemptTimeoutMs`). No legitimate gating decision is rejected — at worst it is served by the next provider or Claude.

## 2. Under-block
A provider that is reachable but returns **well-formed-but-semantically-wrong** output is not caught (the circuit breaker only trips on errors). This is a **pre-existing property of any LLM gate**, provider-independent, NOT introduced here — and round-3 grounding confirmed the gating *callers* already validate their own output (`MessagingToneGate.parseResponse` fail-opens on malformed JSON + validates the `VALID_RULES` allowlist; `MessageSentinel` try/catch fail-opens). This change only changes *which* provider can serve a weak answer, not the property. Documented (§6.4) as a tracked, non-owed hardening item, not part of this feature's scope.

## 3. Level-of-abstraction fit
Correct layer. The fallback mechanism, breakers, and gating-scope already live in `IntelligenceRouter` (the right place — one router every internal LLM call already flows through). This change is a thin **policy** computed at the router-construction site (`server.ts`) + one minimal engine touch (the swap-loop timeout). It does not duplicate a smarter gate; it *feeds* the existing `DegradationReporter`/`/metrics/features` observability rather than building a parallel one. The `job` category was deliberately EXCLUDED so a cost-bearing background feature (CartographerSweep) is never auto-armed as a side effect of this policy.

## 4. Signal vs authority compliance
See Phase 1. No brittle check gains blocking authority. The timeout is fail-open; the only blocking authority (router re-throw → caller fail-closed) is the pre-existing one, unchanged. **Compliant** (`docs/signal-vs-authority.md`).

## 5. Interactions
- **CartographerSweep** mutates `config.sessions.componentFrameworks` in memory at runtime. The §4.6 resolver reads config **live every call** and layers the computed default UNDER any live override, so CartographerSweep's injection still wins for its slot. A frozen memoized default would have silently disabled the freshness sweep — this was caught in convergence (R3-1) and is the reason the resolver is live-read + layered, with only the active-SET memoized.
- **Operator-set detection** is snapshotted once at the construction site (which runs before CartographerSweep's auto-vivify — verified ~line 4755 vs ~11331), so a later in-memory auto-vivify cannot masquerade as an operator override and disable the default (M5; covered by a unit test).
- **Per-framework circuit breakers** (existing): a broadly rate-limited Codex trips its own breaker → gating calls skip it fast, damping any herd onto the Claude tail (§6.2). Non-gating calls are untouched (they propagate to their heuristic — no herd).
- No double-fire / shadowing: the swap loop is unchanged except for wrapping each attempt in `Promise.race`; the re-throw-if-all-down path is preserved.

## 6. External surfaces
- `GET /intelligence/routing` and `/metrics/features` now reflect sentinels/gates/reflectors resolving off Claude on agents that have an off-Claude CLI — visible, intended observability (the operator can SEE the routing). No new route added (config-driven).
- CLAUDE.md template gains the corrected default-behavior text (new agents via `generateClaudeMd`; existing agents via `migrateClaudeMd` appended on the new `run off Claude by default` marker).
- Depends on runtime condition: which provider CLIs are installed on the machine (active-set). Honestly machine-local (see §7). No timing/conversation-state coupling.

## 7. Multi-machine posture
**Machine-local BY DESIGN.** The active-set is computed from `buildProvider(fw)!==null` against THIS machine's installed CLIs, at THIS machine's router-construction site, and is **never persisted or replicated** (runtime-computed default, no config block written). So machine A's installed-providers can never pin onto machine B — each machine routes by what it has. `/intelligence/routing` reflects the local machine's resolution (the route reads the local `resolveConfig`). This is the correct posture (a different machine genuinely has different CLIs) and is stated explicitly, not a silent single-machine assumption. No user-facing notice surface (no one-voice concern); no durable state that strands on topic transfer; no generated URL.

## 8. Rollback cost
Cheap and layered. (a) **No-op guarantee:** an agent with no off-Claude provider resolves to byte-identical-today behavior (claude-only → empty swap). (b) **`{}` lever:** operator sets `sessions.componentFrameworks: {}` → every category resolves to the agent default, empty swap — exactly today's behavior (unit-tested, M7). (c) **Timeout knob:** `intelligence.swapAttemptTimeoutMs` tunes/effectively-disables the cap (set very large). (d) **Full back-out:** revert the PR — purely additive code, no data migration, no agent-state repair (the default is runtime-computed, nothing persisted to roll back).

## No-deferrals (Phase 4.5)
The one out-of-scope item (semantically-wrong swap-target output, §6.4) is a pre-existing provider-independent property, explicitly NOT this feature's in-scope work, and carries an in-spec `<!-- tracked: -->` marker for No-Deferrals hygiene. No partial fix is shipped.

## Phase 5 — Second-pass review
**Concur with the review.** An independent reviewer audited the change against the real code (not the artifact's claims) and confirmed each high-risk dimension at named file:line:
- Fail-open / Signal-vs-Authority: `IntelligenceRouter.ts:212-268` — the cap only races already-degraded swap attempts (`continue` → next → Claude tail); the pre-existing fail-closed re-throw (`throw err`, line 268) and non-gating passthrough (line 206) are unchanged. No new blocking authority.
- `Promise.race` orphan-safety: `IntelligenceRouter.ts:228-238` uses `await Promise.race([...])` (never a detached handle); the unit test registers a real `unhandledRejection` listener, rejects the abandoned attempt after the cap, and asserts zero unhandled + late-result-not-used.
- §4.6 live-read+layer + boot-snapshot ordering: `server.ts:4750-4751` snapshots operator-set at construction; `resolveConfig` (4766-4781) reads live + layers computed default UNDER live overrides; CartographerSweep's auto-vivify (`server.ts:11329-11331`) runs later and cannot masquerade as operator-set — its `overrides` survive the layering.
- M11 honest+sufficient: the reviewer verified the REAL `ExternalOperationGate.consultLLM` (`ExternalOperationGate.ts:509-540`) fails closed (`'show-plan'` on catch) exactly as the test's synthetic fail-closed caller models; `MessagingToneGate` fails OPEN by design (delivery-path), correctly asserted as such.
- No double-fire/shadow/multi-machine strand: `target===framework` guard prevents re-firing the primary; active-set is machine-local and never persisted; `job` excluded so CartographerSweep's slot is never contended.

Non-blocking observation (already documented in spec §4.6): a runtime `PATCH /config {sessions:{componentFrameworks}}` changes gating routing live (resolveConfig reads live) — operator-scoped + every path fail-opens, so safe.
