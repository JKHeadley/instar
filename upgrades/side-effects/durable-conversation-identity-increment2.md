# Side-Effects Review — Durable Conversation Identity, Increment 2 (the proof consumer)

**Spec:** docs/specs/durable-conversation-identity.md (CONVERGED round 11 — 0 CRITICAL / 0 MAJOR; approved under the standing Session-A operator preapproval, topic 29836). **Parent:** Structure beats Willpower — a commitment made in a Slack thread must survive a server restart and land back in that exact thread, and that guarantee lives in durable machinery (registry WAL + funnel), never in a session remembering to re-post.

**This increment is §6.1 STEP 2 — the flagship proof consumer.** It delivers the Phase-1 live proof: *create a commitment from a Slack THREAD, restart the server, watch the beacon heartbeat land back in that thread.* It also lands the deferred §4 hash-copy consolidation (increment-1 §4 note), the §5.2/§5.0(a) funnel hardening that ships WITH the funnel's first consumer, and the §7 bind-token authority primitive.

**Delivery stays dev-gated.** The `id<0` funnel arm is dark-on-fleet / live-on-dev via `conversationIdentity.followThrough` (`enabled` OMITTED → the developmentAgent gate resolves it) with `dryRun: true` FIRST — exactly as spec §9 prescribes. The Telegram lane (`id>0`) is byte-identical when the flag is off; a beacon whose `deliverMessage` dep is unwired falls back to today's `sendMessage` path verbatim.

## §6.1 steps this increment comprises

Per the spec's rollout section (§6.1), increment 2 = **step 2 (Commitments + PromiseBeacon, the proof consumer)** plus the two clauses the spec explicitly assigns to ship WITH this increment (they are unimplementable/unsafe without a live consumer):

- **§4 hash-copy consolidation** (deferred from increment 1's §4 note): the three legacy `-(Math.abs(hash)+1)` copies collapse onto `candidateIdForRoutingKey`. `slackRefreshBinding.slackRoutingKeySyntheticId` is now a re-export; the `routes.ts` build-heartbeat inline copy mints (get-or-create) through the registry with a shared-candidate fallback; the `server.ts:slackChannelToSyntheticId` closure delegates to the registry. The mint-idiom ratchet allowlist shrinks accordingly (a fourth copy is still a CI failure).
- **The §5.2 `/telegram/reply/:topicId` 400-on-negative** (a behavior change, spec-assigned to the funnel increment, not the foundation): a negative id is a minted conversation and is refused with a 400 the recovery policy already classifies terminal (4xx → escalate), so no negative-id relay row retries forever.
- **§5.0(a) E1 ambiguous-outcome idempotency guard** — durable `send-intent` / `ambiguous-send` / `send-retire` / `send-intent-resolved` WRITERS (the op enum + replay shipped in increment 1); retirement-based LOGICAL lane, WINDOW-based CONTENT-HASH lane (R3-M1/R7-M2), the R8-M1 lane-scoped boot conversion, the R5-M3 inter-store crash order.
- **§3.5.2 bind-pin overlay WRITERS** (`bind-pin` / `bind-release`) + the record-carried `boundTuple` delivery rule with the SHARED id↔tuple coherence check (`idWithinCoherenceBound`, one implementation — R4-M1/R5-M2/R6-M4).
- **§5.1 permanent-vs-transient classification** over `SlackApiError.slackError` (the pinned set `{is_archived, channel_not_found, not_in_channel}` + the L5 drift canary), reachability flip/auto-clear + flap dampening, mass-unreachable P17 aggregation, the fire()-re-arm-in-finally + N-fail dead-letter, and the R3-M16 non-owning STAND-DOWN + ownership-recheck.
- **§7 bind-time authority** — the stateless self-authenticating per-session bind token (R4-M3), minted at spawn into `INSTAR_BIND_TOKEN`, verified at `POST /commitments` on a minted id (fail-closed); the positive-id branch (R6-minor-4) + the R7-minor-2 straggler grace stamp.

The E1 `deterministicKind` gate-exempt arm (increment 3) and the §5.2 P17 per-conversation/global budgets (increment 5) are DEFERRED to their own §6.1 increments and are NOT in this increment — named explicitly, not silently.

## What changed

1. **conversationIdentity.ts** — new `idWithinCoherenceBound(id, tuple)`: the ONE shared §3.5 ingest ≡ §3.5.2 delivery coherence predicate (`cand − MAX_PROBE_DISTANCE ≤ id ≤ cand`). Increment-9 replication ingest MUST reuse this export (a second copy is a CI failure per §10).
2. **conversationBindToken.ts (new)** — the §7 primitive: `ensureBindTokenSecret` (first-boot 32-byte secret, stateDir, EXCLUDED from the backup manifest — R5-minor-4), `mintBindToken`/`verifyBindToken` (HMAC-SHA256, base64url, stateless — validation reads the bootstrap set FROM the token so a live tmux session's token survives any number of server restarts), `ensureBindDeployStamp`/`bindDeployStampAgeDays` (the R7-minor-2 grace clock), and `createConversationBindAuth` (the ctx surface).
3. **ConversationRegistry.ts** — increment-2 WRITERS: `bindPin`/`bindRelease`/`getBindPinTuple` (§3.5.2, fsynced); `recordSendIntent`/`recordLikelyPosted`/`retireSend`/`resolveSendIntent`/`isSendSuppressed`/`pruneSendGuardState` (§5.0(a), durable, lane-tagged); `convertOrphanedSendIntents` (R8-M1 lane-scoped boot conversion, staged post-compose + fsynced before serving — R9-low-3/R10-minor-1); `setReachability` (§5.1, idempotent, flap-tracked); `readIdForRoutingKey` (the §4 READ-ONLY comparison path — no get-or-create side-effect); and the durable-bind WAL-ensure on a pre-existing speculative entry (a durable bind is not re-derivable, so its journal line is fsynced NOW). `ambiguousSends` gains a `lane` tag (snapshot-complete). Health carries a `sendGuard` block.
4. **deliverToConversation.ts** — the funnel grows the increment-2 arms: `classifySlackSendError` (§5.1); the §3.5.2 overlay (boundTuple → coherence-check → resolve(tuple), else the local pin, else resolve(id)) with the redirect/incoherent/pending typed outcomes; the E1 guard (lane select → suppress read → durable intent → post-outcome record/retire/resolve); reachability flip + mass-unreachable coalescing; new outcomes `already-delivered-recently` (DELIVERED-EQUIVALENT, R7-M1) and the `standDown`/`permanent` flags on `not-delivered`.
5. **CommitmentTracker.ts** — `boundTuple` + `boundBy` fields on `Commitment`; a `ConversationBinder` dep (late-bound via `setConversationBinder`); `record()` performs the durable bind on a minted (negative) id (typed refusal THROWS — a minted-id commitment is never created silently unpinned) and denormalizes `boundTuple`; `mutateSync`/`applyMutationWithCAS` release the pin refcount on a TERMINAL transition (`delivered`/`withdrawn`/`expired` only — never verified/violated, which oscillate).
6. **PromiseBeacon.ts** — the funnel swap: `deliverMessage`/`retireSend`/`ownsConversation`/`deadLetterAfterConsecutiveFailures` deps; `emitUserSend` routes every send through `deliverMessage` when wired (logicalSendId = `<commitmentId>:<sendSeq>`, boundTuple carried); `applyDeliveryOutcome` implements the R5-M3 seq-before-retire order, the R7-M1 delivered-equivalent seq advance, the §5.1 permanent dead-letter, the transient N-fail dead-letter, and the R3-M16 stand-down; fire() now re-arms in `finally` (a thrown send can never kill the timer); `saveHotState` is atomic tmp→rename (R4-minor-1); `recheckStandDowns` rides the existing external-block sweep (R4-minor-4, no new timer).
7. **slackRefreshBinding.ts** — `slackRoutingKeySyntheticId` is now a re-export of `candidateIdForRoutingKey` (§4 copy retired).
8. **routes.ts** — the `/telegram/reply` 400-on-negative; the build-heartbeat inline-hash retirement (registry mint + shared-candidate fallback); the §7 bind gate on `POST /commitments` (minted-id fail-closed, positive-id token-validated, token-less legacy fail-open + straggler attention); the §6.1 dark-window undeliverable-notice; typed binder refusals → 409; new ctx surfaces `conversationBindAuth` + `conversationFollowThrough`.
9. **SessionManager.ts / types.ts** — `mintBindToken` on `SessionManagerConfig`; `bootstrapConversationIds` on both spawn option shapes; `bindTokenEnvFlags` injects `INSTAR_BIND_TOKEN` into both the headless and interactive tmux -e blocks (a failed mint never blocks a spawn).

## Blast radius

- **Delivery cannot fire on the fleet.** The funnel's `id<0` arm is dev-gated + dryRun-first; PromiseBeacon's `deliverMessage` dep is only wired on the dev-gate live path (bootstrap wiring lands in the next commit of this increment). When unwired, the beacon uses today's `sendMessage` verbatim.
- **The §4 consolidation is value-identical by golden parity.** Every retired copy computed `-(Math.abs(sumShiftHash(key))+1)`; the registry records the same value. The read-only build-heartbeat callsite falls back to the shared candidate when the registry is degraded/absent (§3.6 fail-toward-delivery), so the PresenceProxy suppression signal is unchanged.
- **The 400-on-negative is the one intentional behavior change.** No live caller sends `reply/<negative>` today (Slack proxy sends route through `slack.sendToChannel`, not `/telegram/reply`); the 400 only bites a future mis-wired negative-id relay row, which the recovery policy already terminalizes.
- **The bind gate is inert until `conversationBindAuth` is wired.** With it unwired (this commit), `POST /commitments` behaves exactly as today. Once wired, minted-id binds are fail-closed and positive-id binds keep today's behavior unless the session carries a token.

## Risk + mitigation

- **Risk:** a crash between the transport-accept and the E1 suppressor append double-posts the re-fire. **Mitigation:** the durable `send-intent` (fsynced BEFORE the send) + the R8-M1 lane-scoped boot conversion — a beacon-lane orphan converts to a suppressor, a content-hash orphan resolves toward retry.
- **Risk:** the seq resets on a torn hot-state write and re-collides against the durable E1 entry, silently suppressing a legitimate post-restart heartbeat. **Mitigation:** `saveHotState` is atomic tmp→rename (R4-minor-1).
- **Risk:** an ownership migration delivers via bare `resolve(id)` and reopens the C3-class misdelivery. **Mitigation:** the record-carried `boundTuple` + the shared coherence check; an incoherent pair is a typed non-delivery on NEITHER field (R6-M4).
- **Risk:** a confused session binds into a foreign conversation. **Mitigation:** the §7 bind token (fail-closed on minted ids); `boundBy` is recorded from the verified payload, never the request body.
- **Risk:** a mass bot-removal fans out N dead-letter attention items. **Mitigation:** the §5.1 emitter coalescing window (60s) → ONE summary item; flap dampening for archived↔unarchived bounce.

## Migration parity

- No config-default change in THIS commit (the `followThrough`/`recording` blocks + backup manifest landed in increment 1). The §7 bind-token secret + deploy stamp are created at first boot by the runtime (not the migrator) and are deliberately NOT backup-manifest entries (R5-minor-4).
- `Commitment.boundTuple`/`boundBy` are additive optional fields — the CommitmentsSync receive clamp (`clampReplicatedRow`) type-clamps `boundTuple` (platform enum + channelId/threadTs regexes) on the wire; a legacy row without them falls back to `resolve(id)`.

## Rollback

- Runtime: `conversationIdentity.followThrough` (dev-gate → off, or dryRun:true) reverts all `id<0` delivery. The §4 consolidation is rollback-by-revert (pure refactor). The 400-on-negative and the bind gate revert with the code.
- Rotating `INSTAR_BIND_TOKEN`'s secret (delete `state/conversation-bind-token.secret`, restart) is the revocation lever — a LOUD deliberate trade (live sessions hit the typed refusal until respawned), never a silent side effect.

## Tests

- `tests/unit/conversation-identity.test.ts` — extended: the shared `idWithinCoherenceBound` predicate (candidate, within-bound offset, out-of-bound reject, positive/zero reject).
- `tests/unit/conversation-bind-token.test.ts` (new) — mint/verify round-trip, tampered-payload reject, wrong-secret reject, bootstrap-set membership, stateless survival across a fresh verifier (restart proxy), deploy-stamp grace.
- `tests/unit/conversation-registry.test.ts` — extended: bind-pin refcount (two binds/one close → holds; last close → released), reachability flip/idempotent/auto-clear/flap, the E1 durable send-guard (suppress read both lanes, the R8-M1 boot conversion both lanes, the missing-lane retry), the durable-bind WAL-ensure on a speculative entry, `readIdForRoutingKey` no-write.
- `tests/unit/deliver-to-conversation.test.ts` — extended: `classifySlackSendError` (the pinned set + canary + clean vs ambiguous), the E1 idempotency (ambiguous → single post, clean-transient → not suppressed, content-hash window split), the boundTuple overlay (redirect, incoherent refusal, pending), permanent → reachability flip + not-delivered permanent, dryRun still typed non-delivery.
- `tests/unit/promise-beacon-conversation-delivery.test.ts` (new) — the fire()-re-arm-in-finally on a thrown send, the R5-M3 seq-before-retire order, the R7-M1 un-mute (ambiguous → suppressed re-fire → next tick posts seq+1), the restart-double-post + restart-between-heartbeats shapes, the R3-M16 stand-down + recheck, the permanent dead-letter, dead-letter scoping (non-owning never counts), the funnel-unwired legacy passthrough.
- `tests/integration/conversation-registry-routes.test.ts` — extended: `/telegram/reply/<negative>` → 400; `POST /commitments` on a minted id with a valid/missing/tampered bind token; the dark-window undeliverable notice.
- `tests/e2e/conversation-registry-lifecycle.test.ts` — extended: the full inbound→mint→commitment(boundTuple)→restart→beacon→funnel→Slack-thread delivery cycle (the flagship Phase-1 proof), and the mint-idiom ratchet still green after the §4 consolidation.

## Agent awareness

The GET /conversations* Capabilities entry shipped in increment 1 covers the read surface. No new agent-facing route in this increment (the funnel is internal; the bind token is spawn-env infrastructure the agent never touches directly). <!-- tracked: durable-conversation-identity -->

## CONTINUATION NOTE (for the next session)

**Done (committed, typecheck-green):**
- **Core (commit 1):** the ConversationRegistry writers, the funnel §5 arms, CommitmentTracker binder + boundTuple + terminal release, PromiseBeacon funnel-swap machinery, the §4 consolidation (all three copies), the 400-on-negative, the §7 bind-token module + SessionManager env plumbing + the routes bind gate, the shared coherence predicate.
- **Bootstrap wiring (commit 2 — the ACTIVATION):** `createConversationDelivery` constructed in server.ts with the real Slack adapter send + `resolveDevAgentGate(followThrough)`; `conversationFollowThrough` + `conversationBindAuth` exposed on the AgentServer ctx; `commitmentTracker.setConversationBinder({ bind, release })` backed by `mintForDurableBinding` + `bindPin`/`bindRelease`; `mintBindToken` threaded into the SessionManager config (constructed early so the spawn env carries the token); `deliverMessage`/`retireSend`/`ownsConversation` threaded into the PromiseBeacon; the Slack spawn passes `bootstrapConversationIds: [conversationId]`; `ensureBindDeployStamp` on first boot; AgentServer default-constructs `conversationBindAuth` so the bind gate is alive on every init path. **The feature is now LIVE-on-dev (dryRun-first) / dark-on-fleet.**

**Remaining (tests + the §4 server.ts closure retirement — the next session's scope):**
1. **The tests** (all three tiers, per the Tests section above): the new `conversation-bind-token.test.ts` + `promise-beacon-conversation-delivery.test.ts` unit suites; the registry/funnel unit extensions; the integration route tests (400-on-negative, bind-token gate, dark-window notice); the e2e restart-delivery cycle. **These are REQUIRED for a green CI** — the Testing Integrity Standard is non-negotiable. Author them against the pure surfaces first (funnel + registry + bind-token are all injectable/deterministic).
2. **Existing-test sweep (behavior-change-breaks-old-tests):** the `/telegram/reply` 400-on-negative and the PromiseBeacon `fire()` re-arm/`emitUserSend` return-type changes may break existing beacon/route tests — sweep `tests/**` for `reply/-` negative-id posts and beacon send assertions BEFORE pushing (sharded CI surfaces them one slow round at a time otherwise).
3. **The §4 read-shaped callsites in server.ts** — the `slackChannelToSyntheticId` closure still exists; several comparison callsites (`=== topicId`) use it. Retire it to `conversationRegistry.readIdForRoutingKey` (READ path — added this increment, no write side-effect) / `idForSessionKey` (mint path), keeping the `slackProxyChannelMap` reverse lookups working (a staged migration keeps both until the reverse map is fully removed). Follow-up commit — the mint-idiom ratchet allowlist still lists `commands/server.ts` so the closure is allowed until retired.

The clean seam: commit 1 is additive/inert; commit 2 activates it dev-gated. The Telegram lane is byte-identical when `followThrough` is off; a beacon whose `deliverMessage` dep is present but whose id resolves `id>0` still takes today's Telegram path.

## Post-push landing note (ratchet baseline)

CI's `no-silent-fallbacks` ratchet flagged two catch blocks in `conversationBindToken.ts` (the verify-MAC decode → null, and the deploy-stamp age reader → null). Both are intentional fail-CLOSED / observability paths, not degraded-service fallbacks — tagged `@silent-fallback-ok` with their safe-direction justification so the ratchet holds at its 491 baseline with zero untagged swallows from this increment.
