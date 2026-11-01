# Side-Effects Review — Native app conversations, increment 1

**Version / slug:** `mobile-native-conversations-inc1`
**Date:** `2026-11-01`
**Author:** `echo`
**Second-pass reviewer:** `independent general-purpose reviewer subagent (read-only)`

## Summary of the change

Increment 1 of docs/specs/mobile-native-conversations.md, behind `mobilePairing.native.enabled` (dev-agent gated, read at boot). New: `AppConversationStore` (per-conversation append-only JSONL, fsync'd commits, torn-tail truncation, ingestSeq, delivery reduction, derived SQLite index with boot catch-up/rebuild), `AppConversationsReplicatedStore` (the `appConversations` kind, `app-conversation-event` journal kind), `AppConversationService` (alias re-derivation, bind-app/unbind-app on lease changes, boot recovery of stranded requests, stop/pause effects, push hook point), `appInboundDispatch` (inject or admit+spawn with `INSTAR_CONVERSATION_ID=<alias>` and a scoped bind token), `mobileConversationRoutes` (create/list/rename/delete/send/browse/sync), `POST /app/session-reply` in routes.ts, `app-reply.sh` + `AppReplyRelayInstaller` (init, migrator, boot, drift verifier), registry ops `mint-app`/`bind-app`/`unbind-app` with an `'app'` descriptor variant, a shared `MobileChatRequestStore` on `MobilePairingService` (with an `extra` reservation field and `stranded()`), the device allowlist entries, the send-route rate-limit skip, a `SpawnAdmission` callsite, a write-domain entry, state-registry entries, CapabilityIndex, devGatedFeatures, and the CLAUDE.md section with its content-sniffed migration.

## Decision-point inventory

- Device allowlist (`DEVICE_ALLOWLIST`) — modify — seven new exact routes, strict lowercase UUID patterns.
- Auth-time device rate limit — modify — skipped for send routes only when native is on (preflight keeps 20/min).
- Send preflight — add — feature setting, rate, requestId age, scanInbound; token REMOVAL (exact match), credential shape is a signal only.
- Exact emergency stop — add (pass-through of `isExactStopMessage`) — bypasses setting and rate limit; still reserved once.
- Pause/stop intercept after persist — pass-through — the existing `MessageSentinel.decideInboundDisposition`, fail-open.
- Reply authority (`/app/session-reply`) — add — bind token (existing `verifyConversationBind`) + ownership (`holdsLease && bind-app`); outbound gate is the existing `checkOutboundMessage`.
- Exact-duplicate reply suppression — add — same text from the agent within 15 min, ≥40 chars.

---

## 1. Over-block

No content-based refusal exists: an app message is never refused for what it says. A message whose text includes a lookalike of a pairing invite (`tlinv1:x.y`) loses that span even when the operator was discussing the format; this is the exact-format rule the spec chose. A reply that genuinely repeats a long earlier reply within 15 minutes is suppressed (same as Telegram's exact-duplicate rule). A send accepted on a non-owner answers 503 `owner-unavailable` after persisting (forwarding is not built in this increment); the message is kept.

---

## 2. Under-block

Credential-shaped text is delivered as written by design (operator decides in the app; the app-side prompt ships with increment 5). Ownership with the session pool ON still uses the serving lease, not pool placement (documented gap). The duplicate-suppression check reads only the last 20 messages.

---

## 3. Level-of-abstraction fit

The send route reuses the existing primitives instead of re-implementing them: `MobileChatRequestStore` (now shared through `MobilePairingService.chatRequests()` so two instances never overwrite one file), `MessageSentinel`, `SpawnAdmission`, `verifyConversationBind`, `checkOutboundMessage`, `SessionChannelRegistry`, the replicated-store foundation. The store is the source of truth; the registry only holds per-machine aliases, as the spec requires.

---

## 4. Signal vs authority compliance

**Required reference:** [docs/signal-vs-authority.md](../../docs/signal-vs-authority.md)

- [x] No — this change produces a signal consumed by an existing smart gate.
- [ ] No — this change has no block/allow surface.
- [ ] Yes — but the logic is a smart gate with full conversational context.
- [ ] ⚠️ Yes, with brittle logic — STOP.

Credential-shape detection is a signal (`credentialShaped: true`) only. Token removal is an exact-structure transform of two authority-bearing formats, not a judgment about content. The reply path's blocking authority stays with the existing outbound gate. The ownership/bind refusals are structural invariants, not heuristics.

---

## 4b. Judgment-point check (Judgment Within Floors standard)

No new static heuristic at a competing-signals decision point. The new refusals are invariants (signature, allowlist, bind token, recorded ownership, request-id record); the spec's "Decision points touched" table classifies each, and credential shape is the one judgment-candidate, held as a signal.

---

## 5. Interactions

- **Shadowing:** `/mobile/chat/:topicId` matches one path segment, so `/mobile/chat/app/<uuid>` never reaches it; the conversation router is mounted before the pairing router.
- **Double-fire:** the Telegram chat route and the native routes share ONE request store instance (previously the chat route lazily created its own; two instances over one file would have overwritten each other's records).
- **Races:** check-and-reserve stays synchronous; JSONL append + fsync + index write are synchronous; a crash between file commit and index write is repaired by boot catch-up.
- **Feedback loops:** replicated events are ingested through `ingestReplicated`, which never calls the emit hook, so received events are not re-emitted.

---

## 6. External surfaces

New device-signed routes (dark on the fleet). New `/app/session-reply` (Bearer + bind token). New agent-installed script `app-reply.sh` on every agent (inert outside an app session). New durable state under `.instar/app-conversations/` and `state/app-session-registry.json`. New journal kind `app-conversation-event` on the coherence journal. Operator surface: the iPhone app (increment 5) is the human surface; no operator-only or PIN action is added.

---

## 6b. Operator-surface quality (Operator-Surface Quality standard)

No operator surface — not applicable (no dashboard file is touched).

---

## 7. Multi-machine posture (Cross-Machine Coherence)

**replicated** — conversation events ride the `appConversations` replicated-store kind (always on when native is on; injected into the resolved stateSync flags); peers' events are landed at boot from the peer streams and on every commit. Registry aliases and bind-app bindings are machine-local, derived from the replicated store and rebuildable. The app session registry is machine-local by design (a session runs on one machine). No user-facing notices are emitted. Ownership follows the serving lease (pool placement is a later increment); a non-owner keeps the message and answers 503.

---

## 8. Rollback cost

Switch `mobilePairing.native.enabled` off: routes answer 503, files stay on disk. Reverting the code leaves `mint-app`/`bind-app`/`unbind-app` journal lines that the previous version skips as unknown ops (it raises one attention item and suspends registry snapshot writes until re-upgrade, the registry's documented version-skew behaviour), and leaves `app-reply.sh` installed (inert). No user-visible regression on the fleet (dark).

---

## Conclusion

Clear to ship as a dark increment. Documented gaps carried to later increments: signed-record verification/receipt/ledger (2), dashboard pairing and push without Telegram (3; the push hook point exists as `onAgentReplyAppended`), Slack (4), pool-placement ownership and owner forwarding (a send on a non-owner answers 503 after persisting).

---

## Second-pass review (if required)

**Reviewer:** independent general-purpose reviewer subagent (read-only, fresh context)
**Independent read of the artifact: concur** (after the fixes below; the first read was "concern")

The first read raised one must-fix and seven minor points; each was resolved in this change before commit:
- **Must-fix — an app emergency stop did less than a Telegram stop in production.** The bootstrap-wired service in server.ts now passes `onEmergencyStop`, which pauses the resume queue, cancels the conversation's queued revivals, clears its autonomous run (`stopAutonomousTopic`) and records the operator stop; the AgentServer fallback does the same. Pinned by a source wiring test (tests/unit/app-conversation-service.test.ts) and an integration assertion that the stop side effects run once.
- A failed append (disk full, fsync error) now cuts the file back to where the line started, so no fragment is left for the next append to fuse onto.
- A missing dispatcher records `refused` (an honest "not dispatched") instead of `unknown`.
- The AgentServer fallback installs app-reply.sh at boot and checks relay readiness before spawning.
- A failed `bind-app` write after persist now answers `outcome-unknown` instead of rejecting the handler.
- A replicated tombstone releases this machine's `bind-app` binding.
- Conversation mutations use their own rate bucket, so renames can never starve sends.
- Kept as designed: a send accepted on a non-owner answers `503 owner-unavailable` after persisting (spec §4.8 fallback; owner forwarding is a later increment).

---

## Evidence pointers

tests/unit/app-conversation-store.test.ts, tests/unit/app-conversation-identity.test.ts, tests/unit/app-conversation-service.test.ts, tests/integration/mobile-native-conversations.test.ts, tests/e2e/mobile-native-conversations-alive.test.ts.

---

## Class-Closure Declaration (display-only mirror)

No agent-authored-artifact defect — not applicable. The new `AppConversationService` interval tick is not a self-triggered actuator: it journals bind/unbind only on an observed lease change and recovers each stranded request at most once (a recovered request leaves the `entered` state), so it converges.

---

## Follow-up: unit-gate fixes (local verify)

Local verify on PR #2530 found four unit gates red; fixed in a follow-up commit without changing behaviour:
- `AppConversationStore` is listed among the long-lived SQLite stores (it already registers its index handle with `registerSqliteHandle`).
- The lease-binding catch in `AppConversationService.leaseTick` reports through the injected degradation reporter and the next lease change retries; it now carries `@silent-fallback-ok` with that reason (baseline not raised).
- `POST /app/session-reply` accepts an optional `metadata` object and passes `toneAdvisoryMetadata()` to `checkOutboundMessage`, so the tone gate's advisory comply/override reaction works on the app path as on Slack and Telegram. No other metadata key has any effect. This widens the accepted body by one optional field; destination authority is still the bind token alone.
- The CLAUDE.md awareness wording no longer contains "is not built yet" (a phrase another section's test requires absent); same meaning.
