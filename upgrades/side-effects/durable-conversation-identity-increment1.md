# Side-Effects Review — Durable Conversation Identity, Increment 1 (registry + crash-proof journal + eager mint)

**Spec:** docs/specs/durable-conversation-identity.md (CONVERGED round 11 — 0 CRITICAL / 0 MAJOR; approved under the standing Session-A operator preapproval, topic 29836). **Parent:** Structure beats Willpower — durable identity must be a registry, not a convention three copies of a hash function remember.
**Behavior-identical for existing flows.** The foundation RECORDS identity (always-on, kill-switchable); DELIVERY stays dark-gated: `conversationIdentity.followThrough` omits `enabled` (the developmentAgent gate resolves it — live-on-dev, dark-fleet) with `dryRun: true` FIRST, exactly as spec §9 prescribes.
**Files:** src/core/conversationIdentity.ts (new), src/core/ConversationRegistry.ts (new), src/core/deliverToConversation.ts (new), src/server/routes.ts (read-only `GET /conversations*`), src/commands/server.ts (registry construction + adoption pass + §6.3 eager mint), src/core/types.ts + src/config/ConfigDefaults.ts (`conversationIdentity` block), src/core/devGatedFeatures.ts (followThrough registration), src/core/PostUpdateMigrator.ts (backup manifest + config defaults + CLAUDE.md), src/scaffold/templates.ts (Agent Awareness).

## What changed

1. **conversationIdentity.ts (new):** the SINGLE hash + identity surface (§4). The frozen 32-bit sum-shift hash, the mint candidate `-(abs(hash)+1)` (golden-parity with `slackRoutingKeySyntheticId`), the v1 structured tuple `(platform, channelId, threadTs?)`, canonical-key/tupleKey forms, the frozen schema-v1 constants (`MAX_PROBE_DISTANCE=64`, probe DOWN, `HLC_ABS_MIN/MAX`), shape clamps, and `walkDisplacement` — the ONE shared displacement implementation §3.3 and the future §3.5.1 merge both call.
2. **ConversationRegistry.ts (new):** the sparse join table (canonical key ⇄ tuple ⇄ minted negative id). Synchronous in-memory assignment (probe included; returned == will-persist), the §3.4 WAL journal at the stateDir ROOT (`conversation-registry.jsonl` — the one glob shape the deployed `BackupManager.expandGlob` expands, R3-C4): probed/durable-binding mints append+fsync ONE line BEFORE the id returns; speculative non-probed mints ride the batched snapshot only. Torn-tail truncate-discard; NON-tail corruption fails CLOSED (quarantine-aside + attention + durability incident — R7-minor-3); UNKNOWN-op skip-and-preserve with snapshot-flush SUSPENSION (R8-minor-2/R9-M1/R10-M1) surfaced on health (R11-low-1); single global monotonic `seq` across rotations + restarts (R3-M14); rotation 8 MB/50k lines with fully-superseded-only pruning behind a 7-day retention floor; size-adaptive batched snapshot (2 s base → 60 s max; off-loop write past 20k entries/2 MB); snapshot completeness for bind-pins / ambiguous-sends / send-intents (R4-M2/R6-M1 — the op enum + replay ship NOW so later increments' records and rollbacks across them replay correctly; their WRITERS land with §6.1 steps 2+). Mint-rate breaker (per-channel windows, speculative drop-to-nowhere + durable-binding carve-out with its OWN cap → typed `conversation-registration-capacity`, adversarial-B), the D1 `recording.enabled` kill-switch (live-read; degraded = in-memory candidate + collision-checked read B6; minted-id durable binds refused typed), §3.1 workspace pinning (config pin authoritative; local-observed self-corroborating; per-machine `multi-workspace-unsupported` refusal; `_`→teamId in-place upgrade by the LOCAL authenticated adapter only), §6.2 authorized-traffic-gated adoption pass, and the §8 health surface.
3. **deliverToConversation.ts (new):** the §5 funnel SKELETON — typed, non-exceptional §5.1 results (dark/dryRun return the SAME `not-delivered` shape as unresolvable, plus a would-deliver audit line; NEVER success-shaped), `id>0` → today's Telegram path, `id<0` → local-origin-only resolution (KYP), system-channel suppression inside the funnel (§4), in-thread Slack delivery when live. ZERO consumers migrate in this increment; the E1 guard, P17 budgets, `deterministicKind` arm, and permanent-error classification land WITH their §6.1 increments (2/3/5) before any consumer rides the funnel.
4. **Read-only routes (§8):** `GET /conversations`, `/conversations/health` (the e2e alive target), `/conversations/resolve`, `/conversations/:id` — Bearer-gated, labels HTML-escaped on render (B3), no write routes (mint happens only at internal chokepoints — §7).
5. **§6.3 eager mint at Slack inbound:** the dispatch mints (get-or-create) the resolved routing key's conversation id on every inbound and carries it as the pinned `conversationId` field in message metadata + the session bootstrap context. Wrapped fail-toward-delivery: a mint degradation never blocks a message.
6. **Config/rollout (§9):** `conversationIdentity.recording.enabled: true` default (existence-checked in migrateConfig, NEVER materialized false — the #1001 mechanism); `followThrough.enabled` OMITTED + registered in DEV_GATED_FEATURES; `followThrough.dryRun: true`. PostUpdateMigrator adds the backup-manifest entries (`state/conversation-registry.json` + the top-level glob `conversation-registry.jsonl*`) and the CLAUDE.md Capabilities entry; `generateClaudeMd` carries it for new agents.

## Blast radius

- **Recording is additive observability.** No existing store changes shape; no store version bump; the registry file is inert data to old code (verified: zero old-code reads of `state/conversation-registry.json`). Rollback-by-revert for the code; `recording.enabled:false` is the runtime kill-switch that restores byte-identical legacy hashing without a redeploy.
- **Delivery cannot fire on the fleet.** The funnel has zero callers in this increment AND the `id<0` arm is dev-gated + dryRun-first; on a dev agent it returns typed non-deliveries with audit lines until a deliberate `dryRun:false` flip.
- **The eager mint adds one in-memory map hit per Slack inbound** (post-first-mint) plus, for a NEW conversation, one O(1) journal append (fsync only when probed). The O(N) snapshot is batched off the hot path — the CommitmentTracker freeze shape is structurally avoided (§3.4).
- **Hash copies are NOT rewired in this increment.** The three legacy copies keep computing the same values the registry records (value-identical by golden parity); the §4 callsite consolidation is the next increment. The mint-idiom grep ratchet pins the current copy set so a FOURTH copy is a CI failure.

## Risk + mitigation

- **Risk:** registry failure costs a message. **Mitigation:** every mint path is typed-degrading (unparseable key / breaker drop / recording-off / probe overflow → "no durable id" or a collision-checked read); the inbound dispatch wraps the mint in try/catch. Identity never costs a message (§3.6) — pinned by unit tests.
- **Risk:** a crash loses a probed/thread-level id a durable consumer bound to. **Mitigation:** the WAL rule — fsynced journal line BEFORE the id returns; replay restores it (pinned by the crash tests, no snapshot flush needed).
- **Risk:** journal corruption silently loses committed records. **Mitigation:** non-tail corruption HALTS replay into quarantine-aside + ONE attention item + a durability-incident record (the §3.7 SQLite-migration tripwire input) — never skip-and-continue.
- **Risk:** a rollback across a future op-enum extension trips the corruption machinery or composes wrongly. **Mitigation:** unknown-op skip-and-preserve + snapshot-flush suspension (the pre-skew snapshot stays put; prune keys on the static pre-skew watermark) — pinned by the suspension unit test.
- **Risk:** a mint flood grows the store unboundedly (auto-join, thread storms). **Mitigation:** the per-channel mint-rate breaker (speculative drops re-mint for free; durable carve-out has its own cap + typed refusal), the adoption pass's authorized-traffic gate (security-B8), and the 80%-of-ceiling health tripwire.

## Migration parity

- migrateConfig: adds `conversationIdentity.recording.enabled: true` ONLY when absent; NEVER writes `followThrough.enabled` or a literal `false` anywhere in the block (pinned by a unit test — the #1001 mechanism).
- Backup manifest: `state/conversation-registry.json` + top-level glob `conversation-registry.jsonl*` join `config.backup.includeFiles` via the existing idempotent set-union migrator (stateDir-relative; the Tier-2 test drives the REAL BackupManager and asserts the glob's expanded set lands in the snapshot — R3-C4).
- CLAUDE.md: `GET /conversations*` Capabilities entry via `migrateClaudeMd()` (existing agents) AND `generateClaudeMd()` (new agents) — P3 + P5 both.

## Rollback

- Runtime: `conversationIdentity.recording.enabled: false` (kill-switch — legacy-identical degradation); `followThrough` stays dark on the fleet by default. Full revert: delete the three new modules + the route block + the dispatch mint lines + the config/migrator entries; `state/conversation-registry.json` + `conversation-registry.jsonl*` are inert to old code. A later RE-enable needs no special path — the idempotent boot adoption pass + journal replay compose over whatever is on disk (R8-low-1).

## Tests

- `tests/unit/conversation-identity.test.ts` — golden parity with the legacy hash (channel + thread), frozen schema-v1 constants, tuple/key forms + shape clamps, the shared displacement walk + its MAX_PROBE_DISTANCE bound.
- `tests/unit/conversation-registry.test.ts` — mint idempotency (incl. across re-open), the crafted in-charset collision pair probing to DISTINCT ids in either order, WAL crash-durability (probed + durable-binding survive with NO snapshot flush; speculative writes no synchronous journal line), torn-tail discard, non-tail-corruption fail-closed, unknown-op suspension, rotation-spanning replay with one global seq, idempotent replay, snapshot completeness (bind-pins/ambiguous-sends/send-intents), alias one-hop + the boot assignment-beats-alias invariant, breaker (speculative drop + re-mint, durable carve-out + typed capacity refusal), recording kill-switch both arms, workspace pinning (self-corroboration, multi-workspace refusal, config-pin authority, `_`→teamId in-place upgrade), adoption-pass gating + idempotency, resolution surfaces, health shape.
- `tests/unit/deliver-to-conversation.test.ts` — §5.1 typed contract (dark/dry/unresolvable/replicated-only/system-channel/no-adapter/transport-error all non-exceptional, never success-shaped; dryRun audit line), in-thread delivery, Telegram passthrough.
- `tests/unit/conversation-identity-mint-idiom-ratchet.test.ts` — the §10 wiring-integrity grep ratchet (a fourth mint-idiom copy is a CI failure).
- Integration (`tests/integration/conversation-registry-routes.test.ts`) — the `GET /conversations*` HTTP pipeline (auth, 404 semantics, label escaping, resolve), migrateConfig never-materializes assertions, the backup-manifest-through-real-BackupManager test.
- E2E (`tests/e2e/conversation-registry-lifecycle.test.ts`) — Phase-1 "feature is alive": production-init wiring answers `GET /conversations/health` 200 (not 503), adoption pass state present, inbound→mint→resolve cycle.

## Agent awareness

- A "Durable Conversation Identity" Capabilities entry (GET /conversations*, the health surface, what a negative topicId means) ships in `generateClaudeMd` + an idempotent content-sniffed `migrateClaudeMd` section. <!-- tracked: durable-conversation-identity -->

## Part-2 landing note (wiring)

Part 1 landed the three core modules + Tier-1 tests. Part 2 (this commit)
lands the wiring: the read-only `GET /conversations*` routes (labels escaped —
the only Phase-1 render surface), the AgentServer plumbing (bootstrap instance
takes precedence; a read-only fallback keeps the health surface alive on any
init path — it can never become a second journal writer because eager mint
uses the bootstrap instance only), the server-bootstrap construction (live
kill-switch reads, late-bound workspace source, attention wiring), the §6.3
eager mint + bootstrap-context carry, the §6.2 adoption pass (session-registry
membership as the authorized-traffic record), config types/defaults +
DEV_GATED_FEATURES registration, the PostUpdateMigrator additions (backup
manifest, dev-gate strip, CLAUDE.md section + shadow markers), the scaffold
template section, and the Tier-2/Tier-3 tests + docs-coverage artifacts
(release fragment + architecture page).

## Part-3 landing note (surface classification + test parity)

CapabilityIndex gains the `/conversations` prefix classification (agent-facing
capability — surfaced in /capabilities discovery, not INTERNAL_PREFIXES), and
the backup-manifest parity test learns the two new manifest entries (the
predictable behavior-change-breaks-old-tests category, swept before push).

## Part-4 landing note (release-fragment polish)

The release fragment's "What to Tell Your User" line drops inline code
formatting (the pre-push gate's plain-conversational rule).

## Part-5 landing note (fail-safe tagging)

Every intentional fail-safe catch this increment introduced carries an
explicit `@silent-fallback-ok` tag with its safe-direction justification
(registry: fsync best-effort / prune-retains / workspace-degrades-to-
placeholder / shutdown teardown; wiring: fail-toward-delivery on boot-load,
eager mint, adoption pass, attention raise) — the no-silent-fallbacks ratchet
stays at its 491 baseline with zero untagged swallows from this PR.
