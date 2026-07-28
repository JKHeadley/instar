# Side-Effects Review — WS5.3 escalation rides the topic (model-tier escalation follows a moved topic)

**Spec:** docs/specs/ws53-escalation-rides-topic.md (converged + approved — operator pre-approval, Justin topic 13481). **Parent:** Cross-Machine Coherence — One Agent, Robust Under Degraded Conditions.
**Ships DARK** behind `models.tierEscalation.ridesTopic` (default false) under the existing `tierEscalation.enabled`. Single-machine installs are a strict no-op.
**Files:** src/core/EscalationHintStore.ts (new), src/core/ModelTierEscalation.ts, src/core/TopicProfileTransferCarrier.ts, src/server/routes.ts, src/server/AgentServer.ts, src/commands/server.ts, src/scaffold/templates.ts, src/core/PostUpdateMigrator.ts

## What changed

1. **EscalationHintStore.ts (new):** the ephemeral per-topic escalation-hint carrier — `file` / `peek` (no consume) / `consume` (consume-once) / `clear` / `all`. TTL-bounded (default 6h, mirroring `maxEscalationTtlMs`), atomic tmp+rename writes, corrupt/absent file ⇒ no hints (the safe direction). NOT the durable topic profile — its own file `state/model-tier-escalation/rides-topic-hints.json`.
2. **ModelTierEscalation.ts:** new `ridesTopic: boolean` field on `TierEscalationConfig`, `ridesTopic: false` in `DEFAULT_TIER_ESCALATION_CONFIG`, and carried by `normalizeTierEscalationConfig` (the read-side add-missing normalizer every consumer goes through).
3. **TopicProfileTransferCarrier.ts:** the hint rides the EXISTING `topic-profile-pull` acquire pull. `TopicProfilePullEntry` gains an optional `escalationHint`; the serve handler gains an optional `escalationHintPeek` (peek, not consume); the carrier gains `onEscalationHintLanded`, fired in `applyLanding` AFTER the mandatory ownership recheck (so a hint never drives a re-admit on a non-owner) and independently of the durable-profile present/absent branch (an escalated topic with no pin still carries).
4. **routes.ts (`POST /pool/transfer` source leg):** when WS5.3 is enabled and the moving topic has a LIVE session on this machine on an escalated model id, and the topic is not `escalationOverride:'suppress'`, file the ephemeral hint (`trigger:'transfer'` audit label only). Only a REAL move files (noop/already-there never does). New `RouteContext.escalationHints?`. Response carries `escalationHintFiled:true` when one was filed. Imports `escalatedModelIds` + `normalizeTierEscalationConfig`.
5. **AgentServer.ts:** constructs the EscalationHintStore inside the existing model-tier block (cheap, file-backed, inert while dark) so the seams are ALIVE on the production init path; passes it to RouteContext; exposes `getEscalationHintStore()`; resets to null in the existing cascade-isolation catch.
6. **server.ts:** the destination re-admit driver `_driveEscalationReadmit` (bound after the AgentServer exists) — resolves the topic's resumed session and calls `ModelSwapService.swap(name,'escalated')` (serialized through the orchestrator's per-topic lock); the `topic-profile-pull` serve handler now passes `escalationHintPeek` (config-gated); the carrier wiring passes `onEscalationHintLanded`; `spawnSessionForTopic` consumes the LOCAL hint after the resumed-session spawn (the same-machine target==self arm). `normalizeTierEscalationConfig` promoted to a top-level static import.
7. **templates.ts + PostUpdateMigrator.ts:** an "Escalation rides a moved topic (WS5.3)" bullet EXTENDS the existing Model-Tier Escalation section — `generateClaudeMd` (new agents) + the section-install template AND an idempotent content-sniffed additive-bullet patcher (existing agents that already carry the section).

## Blast radius

- **The whole path is config-gated, not wiring-gated.** With `tierEscalation.enabled` false (the fleet default), every seam is a strict no-op: the source files nothing, the serve handler peeks nothing, the driver returns early, the local consume is empty. The EscalationHintStore is always constructed (so the feature can be turned on without a restart-to-rewire), but it does nothing until `ridesTopic` AND `enabled` are both true.
- **No bypass surface.** The destination re-admit is literally `ModelSwapService.swap(name,'escalated')` → `governor.admitEscalation()`. There is no second admit path. The hint only decides whether to CALL swap('escalated'); the answer always comes from the governor's full cost-guard chain. A refusal leaves the session on its default tier — exactly as a fresh escalation request would be refused.
- **Ownership-gated actuation.** The cross-machine landing fires the re-admit ONLY after the carrier's existing ownership recheck confirms this machine owns the topic. A hint that lands on a re-transferred topic is skipped (audited), never actuated.
- **No new HTTP route, no new MeshRpc verb.** The hint rides the EXISTING authenticated `topic-profile-pull` pull and the EXISTING `/pool/transfer` — N-machine-safe, no broadcast, no LAN assumption.

## Risk + mitigation

- **Risk:** a stale or forged hint drives a wrong escalation. **Mitigation:** the hint's `trigger` label is audit-only — the destination governor re-evaluates from REAL state, so a hint claiming a trigger the topic isn't under still has to pass every real guard. An expired hint (TTL) is treated as absent. Proven by the stale/forged-hint lens test.
- **Risk:** a topic bounced machine-to-machine escalate-flaps. **Mitigation:** the destination governor's dwell/hysteresis (in ModelSwapService, keyed on session.id) + lease TTL apply to the resumed session as to any escalation. Proven by the dwell lens test.
- **Risk:** a suppressed topic is re-escalated on arrival. **Mitigation:** double guard — the source files NO hint for a suppress topic, AND `swap()` re-consults the suppress pin at the destination. Proven by the suppress lens test.
- **Risk:** a carrier/driver/store error fails the transfer or spawn. **Mitigation:** every WS5.3 path is fire-and-forget and try/catch-guarded; the degrade is ALWAYS toward default tier (the cost-reducing, safe direction), audited where it matters. A transfer/spawn never fails because of WS5.3.

## Migration parity

- `ridesTopic: false` added to `DEFAULT_TIER_ESCALATION_CONFIG` AND carried by `normalizeTierEscalationConfig` — existing agents get the field automatically on read (config-read through the normalizer, never a literal default written to disk), so no `migrateConfig` change is needed.
- The CLAUDE.md bullet ships in `generateClaudeMd` (new agents) + an idempotent content-sniffed `migrateClaudeMd` additive-bullet patcher (existing agents). The section heading is UNCHANGED, so the feature-delivery-completeness `featureSections` entry + Codex/Gemini shadow markers stay green (the WS4.2 emptyState precedent: a sub-bullet into an already-tracked section needs no new entry).

## Dark-gate line-map

- UNCHANGED. `ridesTopic` is a new key on `DEFAULT_TIER_ESCALATION_CONFIG` in `ModelTierEscalation.ts` (referenced by `ConfigDefaults.ts` via the const), NOT an inline `enabled:` line in `ConfigDefaults.ts`. The dark-gate attributor reads `ConfigDefaults.ts` only and matches `enabled:` lines, so no line shifted. Verified: `node scripts/lint-dev-agent-dark-gate.js` → clean; `tests/unit/lint-dev-agent-dark-gate.test.ts` → 16/16.

## Rollback

- Set `models.tierEscalation.ridesTopic: false` (the default) → strict no-op. To fully revert: remove the EscalationHintStore + the `ridesTopic` field + the route source-capture + the carrier hint-carry + the driver + the local consume + the CLAUDE.md bullet. Dark + additive throughout.

## Tests

- `tests/unit/escalation-hint-store.test.ts` (13) — the store lifecycle, the serve-handler peek carry, and THE NAMED SAFETY INVARIANT (free-escalation-bypass + suppress + dwell lenses) driven through ModelSwapService against a synthetic governor.
- `tests/integration/escalation-rides-topic.test.ts` (4) — the cross-machine carry + re-admit end to end against a mock governor: ALLOW → swapped, REFUSE → default (the bypass invariant), owned-elsewhere → no re-admit, no-hint → no-op.
- `tests/e2e/escalation-rides-topic-lifecycle.test.ts` (3) — Phase-1 feature-is-alive on the production AgentServer init path: the store is constructed + exposed; dark default is inert; `/pool/transfer` answers the honest dark 503. tsc clean; dark-gate 16/16; no-silent-fallbacks + feature-delivery-completeness + docs-coverage green.

## Agent awareness

- An "Escalation rides a moved topic (WS5.3)" bullet extends the Model-Tier Escalation section in both `generateClaudeMd` and `migrateClaudeMd` (with a Codex/Gemini-parity shadow marker already covering the parent section). <!-- tracked: ws53-escalation-rides-topic -->
