# Instar Decision-Surface Inventory

**Living document.** Updated as decision points are added, removed, or reclassified. All entries are subject to the `/instar-dev` side-effects review on any change.

**Principle reference:** [signal-vs-authority.md](./signal-vs-authority.md)

## Classification legend

- **Signal** — produces structured output for a downstream consumer; does not block on its own.
- **Authority** — holds direct block/allow/kill/route authority. Must be either (a) LLM-backed with full context + traceable reasoning, or (b) deterministic in a constrained domain where the principle explicitly does not apply (hard-invariant validation, idempotency at transport layer, irreversible-action guards).
- **Violator** — holds authority with brittle logic in a judgment-required domain. Requires rework.
- **Audit** — borderline case flagged for review but not confirmed as a violator yet.

---

## 1. Outbound messaging gates (agent → user)

| Location | Decides | Style | Classification | Notes |
|---|---|---|---|---|
| `server/routes.ts` — `checkMessagingTone()` calling `MessagingToneGate.review()` | Whether an outbound message contains seven enumerated leak patterns | LLM-backed | **Audit** | Authority in principle; observed drift on 2026-04-15 where the gate cited rules not in its own prompt. Needs structured reasoning enforcement + over-block audit tail. |
| `server/routes.ts` — `checkJunkPayload()` → `isJunkPayload()` | Whether an outbound message is a debug token | Deterministic (literal tokens) | **VIOLATOR** | Brittle detector holding direct 422-block authority in the agent-runtime domain. Must be reshaped as a signal feeding the tone gate. |
| `server/routes.ts` — `checkOutboundDedup()` → `OutboundDedupGate.check()` | Whether an outbound message is a near-duplicate of recent | Deterministic (Jaccard 3-gram similarity) | **VIOLATOR** | Same pattern. Must be reshaped as a signal feeding the tone gate. |

## 2. Inbound message filtering (user → agent)

| Location | Decides | Style | Classification |
|---|---|---|---|
| `core/InputGuard.ts` — provenance tag check (Layer 1) | Whether a claimed [channel:id] tag actually matches its bound topic | Deterministic (tag extraction + lookup) | **Authority — OK** (hard-invariant: provenance forgery check at trust boundary) |
| `core/InputGuard.ts` — injection-pattern detection (Layer 1.5) | Whether a user message contains prompt-injection patterns | Deterministic (regex) | **Signal — OK** (emits warning; does not block unilaterally) |
| `core/InputGuard.ts` — topic-coherence review (Layer 2) | Whether a message fits the topic | LLM-backed | **Authority — OK** |
| `core/MessageSentinel.ts` — fast-path classifier | Whether a short user message is an emergency stop/cancel signal | Deterministic (regex, word-count gate ≤ 4 words) | **Authority — OK** (constrained: only acts on short-word messages matching specific imperative patterns. Longer messages route to LLM. Good hybrid.) |
| `core/MessageSentinel.ts` — LLM classifier | Intent class for non-short messages | LLM-backed | **Authority — OK** |
| `threadline/InboundMessageGate.ts` — rate-limit and trust-level checks | Whether an inter-agent message passes transport-layer constraints | Deterministic (sliding window per fingerprint) | **Authority — OK** (transport-layer mechanics — idempotency / rate limiting, not judgment) |

## 3. Session lifecycle

| Location | Decides | Style | Classification |
|---|---|---|---|
| `core/SessionManager.ts` — idle-prompt killer | Kill a session idle at Claude prompt > 15min | Deterministic (terminal-output patterns + vetoes) | **Authority — OK** (mechanical mortality decision; vetoes are the context check) |
| `core/SessionManager.ts` — max-duration kill | Kill a session exceeding configured timeout | Deterministic (elapsed time) | **Authority — OK** (safety valve, explicit policy) |
| `core/SessionManager.ts` — spawn gate | Whether to spawn a new session | Deterministic (name validation, max-sessions config) | **Authority — OK** (resource-constraint mechanics) |
| `monitoring/SessionRecovery.ts` — `checkAndRecover()` branching | Which recovery strategy (context-exhaustion vs stall vs crash vs error-loop) | Deterministic (JSONL analysis + process liveness) | **Authority — OK** (mechanical classification of observable state, not judgment about content) |
| `monitoring/SessionRecovery.ts` — escalation ladder | Which truncation strategy to try next | Deterministic (stall type + attempt count) | **Authority — OK** (mechanical escalation) |

## 4. Dispatch & triage

| Location | Decides | Style | Classification |
|---|---|---|---|
| `monitoring/StallTriageNurse.ts` — `diagnose()` | Recommended action for a stalled session | LLM-backed | **Authority — OK** |
| `monitoring/StallTriageNurse.ts` — `executeAction()` | Apply triage recommendation | Deterministic dispatch | **Signal — OK** (executor, not judge — carries out a recommendation produced by an authority) |
| `core/DispatchManager.ts` — `shouldAutoApply()` | Apply dispatch autonomously or queue for approval | Deterministic (type/priority whitelist) | **Authority — OK** (constrained policy: only lesson+strategy types are whitelisted) |
| `messaging/MessageRouter.ts` — `route()` | Where an incoming message goes | Deterministic dispatch | **Authority — OK** (mechanical routing, not judgment) |

## 5. Coherence gate

| Location | Decides | Style | Classification |
|---|---|---|---|
| `core/CoherenceGate.ts` — PEL (Policy Enforcement Layer) | Hard-policy violations | Deterministic rules | **Authority — OK** (hard-invariant rules) |
| `core/CoherenceGate.ts` — GateReviewer | Does this need full review? | LLM-backed | **Signal → Authority — OK** (LLM-backed triage feeding downstream specialists) |
| `core/CoherenceGate.ts` — specialist reviewers | Final pass/fail per specialist (tone, claim, settling, value alignment) | LLM-backed (parallel) | **Authority — Audit** (each specialist is an authority with its own prompt; should undergo the same "reasoning-traceable" check the outbound tone gate will get in Track 2 T2.5). |

## 6. External-operation gating (MCP / service calls)

| Location | Decides | Style | Classification |
|---|---|---|---|
| `core/ExternalOperationGate.ts` — `computeRiskLevel()` | Classify op as low/medium/high/critical | Deterministic matrix | **Signal — OK** (pure classifier feeding the decision below) |
| `core/ExternalOperationGate.ts` — `evaluate()` | Allow / show-plan / suggest-alternative / block | Hybrid (matrix + config + LLM for medium+) | **Authority — OK** (correct hybrid pattern: constrained matrix for low-risk, LLM for judgment cases) |
| `core/ExternalOperationGate.ts` — `checkServicePermission()` | Service permission enforcement | Deterministic whitelist | **Authority — OK** (hard policy at trust boundary) |

## 7. Trust & access control

| Location | Decides | Style | Classification |
|---|---|---|---|
| `core/AdaptiveTrust.ts` — `getEffectiveLevel()` | Current trust level for an operation | Deterministic (profile + floor) | **Signal — OK** |
| `core/AdaptiveTrust.ts` — `shouldElevate()` | Suggest trust elevation | Deterministic (operation count + history) | **Signal — OK** (suggestion, not a block) |
| `threadline/AgentTrustManager.ts` — `evaluateTrustLevel()` | Sender trust tier | Deterministic (fingerprint lookup) | **Signal — OK** |

## 8. Session recovery & compaction

| Location | Decides | Style | Classification |
|---|---|---|---|
| `monitoring/CompactionSentinel.ts` — `onCompactionDetected()` | State machine: pending-inject → verifying → retry / recovered / failed | Deterministic (file stat + timing) | **Authority — OK** (lifecycle-owner class, not a judgment gate) |
| `monitoring/CompactionSentinel.ts` — `verifyRecovery()` | Did the session respond? | Deterministic (file stat + window) | **Signal — OK** (feeds the state machine above) |
| `monitoring/SessionRecovery.ts` — pre-respawn drain (in-flight reply capture) | Whether to embed an in-flight reply into the recovery prompt | Deterministic (topic-history poll window) | **Signal — OK** (produces context for downstream prompt-assembly; no block authority) |

## 9. Autonomy & inter-agent gates

| Location | Decides | Style | Classification |
|---|---|---|---|
| `threadline/AutonomyGate.ts` — `evaluate()` | Deliver / notify-and-deliver / queue-for-approval / block per autonomy level | Deterministic (profile → decision table) | **Authority — OK** (explicit policy mapping, not judgment) |
| `core/AutonomyProfileManager.ts` — `getProfile()` | Current autonomy level | Deterministic (config / MEMORY.md) | **Signal — OK** |

## 10. Idempotency & dedup

| Location | Decides | Style | Classification |
|---|---|---|---|
| `scheduler/SkipLedger.ts` — `shouldSkip()` | Already executed this idempotency key? | Deterministic (ledger + TTL) | **Authority — OK** (transport-layer idempotency, not judgment) |
| `core/OutboundDedupGate.ts` — `check()` as a pure module | Near-duplicate check | Deterministic (Jaccard) | **Signal when used as signal; Violator when wired as direct 422 authority** — the module itself is fine; it's the routing in `server/routes.ts` that's in violation. |

## 11. Monitoring & alerting

| Location | Decides | Style | Classification |
|---|---|---|---|
| `monitoring/SessionActivitySentinel.ts` | Idle/stall detection | Deterministic | **Signal — OK** |
| `monitoring/MemoryPressureMonitor.ts` | System memory pressure level | Deterministic | **Signal — OK** |
| `monitoring/HomeostasisMonitor.ts` | Work-velocity awareness | Deterministic | **Signal — OK** |
| `monitoring/CoherenceMonitor.ts` | Coherence state tracking | Deterministic | **Signal — OK** |
| `monitoring/crash-detector.ts` | Detect crashed session | Deterministic | **Signal — OK** |
| `monitoring/stall-detector.ts` | Detect tool-call stall | Deterministic | **Signal — OK** |

## 12. Privacy routing

| Location | Decides | Style | Classification |
|---|---|---|---|
| `privacy/OutputPrivacyRouter.ts` | Route response by privacy level (PII redaction) | Hybrid (LLM for PII detection, deterministic for role check) | **Authority — OK** (hybrid with LLM for judgment) |

## 13. Command & request routing

| Location | Decides | Style | Classification |
|---|---|---|---|
| `messaging/shared/CommandRouter.ts` | Decode `/command` and dispatch | Deterministic map | **Signal — OK** (pure dispatch) |
| `threadline/ThreadlineRouter.ts` | Route inter-agent ops | Deterministic map | **Signal — OK** (pure dispatch) |
| `server/routes.ts` — parameter regex validation | Reject malformed input | Deterministic regex | **Authority — OK** (hard-invariant input validation at system boundary) |

## 14. Recovery / error handling

| Location | Decides | Style | Classification |
|---|---|---|---|
| `core/TrustRecovery.ts` | Decay trust after incident | Deterministic formula | **Signal — OK** (modifies profile state that downstream gates read) |

---

## Violator summary (requires rework)

| # | Decision point | Domain | Rework |
|---|---|---|---|
| 1 | `server/routes.ts` junk-payload 422 path | Outbound messaging | Strip 422-block authority from `checkJunkPayload()`. `isJunkPayload()` becomes a pure signal module. The signal is passed into the outbound authority (`MessagingToneGate.review(text, { channel, recentMessages, signals: { junk: {...} } })`). The tone gate decides. Covered in T2.4. |
| 2 | `server/routes.ts` dedup 422 path | Outbound messaging | Same pattern. Strip 422-block authority from `checkOutboundDedup()`. The dedup check remains a pure signal module; its output flows into the tone gate's signals parameter. The tone gate decides. Covered in T2.4. |
| 3 | `MessagingToneGate` reasoning drift | Outbound messaging | Not a principle violation per se (LLM-backed authority, constrained domain), but its reasoning has been observed to cite rules not in the prompt. Rework: structured "why I blocked" log; rule-id field constrained to the seven literal patterns; over-block audit tail. Covered in T2.5. |

## Audit-flagged (review, not yet confirmed violators)

| Decision point | Concern | Next step |
|---|---|---|
| CoherenceGate specialist reviewers | Multiple LLM authorities; each could drift the same way the tone gate did | Apply the same structured-reasoning constraint when that work is scoped |

## Explicitly-OK patterns preserved

- Hybrid matrix + LLM (ExternalOperationGate).
- Word-count-gated regex for emergency signals (MessageSentinel short-path) — this is a constrained-domain use of deterministic logic with a clear gate to LLM for non-trivial cases.
- Deterministic lifecycle owners (SessionManager, CompactionSentinel, SessionRecovery) — these are mechanical state machines reacting to observable state, not judgment gates.
- Transport-layer mechanics (SkipLedger idempotency, InboundMessageGate rate limits) — explicitly scoped out of the principle per `docs/signal-vs-authority.md`.

---

## Summary metrics

- **Total decision points catalogued:** ~45 (consolidated from the initial sweep of 55–65 by merging sub-decisions inside the same class).
- **Violators:** 2 (both in the outbound-messaging path).
- **Audit-flagged:** 2 (tone gate reasoning drift; coherence specialists).
- **Explicitly OK:** 41 (distributed across all other categories).

The instar codebase is largely already compliant with the signal-vs-authority principle. The failure mode that triggered this audit (2026-04-15 compaction/respawn cascade) was concentrated in a recent wave of additions to the outbound path. That's an important finding: the instar core predates this principle but was already designed well. The recent drift is what needs to be fixed.
