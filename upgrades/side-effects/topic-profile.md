<!--
  Side-Effects Review Artifact — Topic Profile.
  Driven by docs/specs/TOPIC-PROFILE-SPEC.md (review-convergence 2026-06-11; approved: true).
-->

# Side-Effects Review — Topic Profile (sticky per-topic framework / model / thinking-mode)

**Version / slug:** `topic-profile`
**Date:** `2026-06-12`
**Author:** `echo`
**Second-pass reviewer:** `echo (dedicated reviewer subagent — session lifecycle + gates, see below)`

## Summary of the change

Topic Profile gives every conversation topic a durable, sticky profile that pins its BASELINE framework (`claude-code`/`codex-cli`/…), model (an explicit id OR a tier — never both), and thinking depth (`off`/`low`/`medium`/`high`/`max`). Pins survive restarts and follow the topic. The profile is resolved at session spawn; when a pin changes, an orchestrator (`TopicProfileOrchestrator`) classifies the change (`classifyProfileChange`) and picks the GENTLEST swap path: a within-framework Claude model-tier change on a confirmed-idle session swaps in-flight (zero loss, only when the §11 canary verifies an independent thinking-control read — which v1 ships OFF, so it degrades to resume); otherwise a kill + `claude --resume` (none-loss) or, when no resume is capturable, a CONTINUATION (recent-history + memory). The conversational surface is PRIMARY ("use codex here" / "pin this topic to Fable" via the propose-confirm ingress); the `/topic-profile` HTTP route + `/topic` command are operator/power-user surfaces. The feature ships DARK behind a dev-agent gate (`resolveDevAgentGate`, dryRun default true) — the fleet serves 503.

Primary files: `src/core/TopicProfileStore.ts`, `TopicProfileResolver.ts`, `TopicProfileOrchestrator.ts`, `TopicProfileTransferCarrier.ts`, `classifyProfileChange.ts`, `CodexResumeMap.ts`, `topicProfileIngress.ts`, `topicProfileWriteSurface.ts`, `topicProfileValidation.ts`, `slackRefreshBinding.ts`; wiring in `src/commands/server.ts` (composition root) + `src/server/routes.ts` + `AgentServer.ts`; `SessionRefresh.ts` (§10.5 Slack respawn); migrations in `PostUpdateMigrator.ts`; awareness in `scaffold/templates.ts`; classification in `server/CapabilityIndex.ts`.

## Decision-point inventory

- `classifyProfileChange()` (swap-method decision) — **add** — pure function: maps (lastApplied, resolved, idle/canary/resume verification state) → `none | in-flight | resume | continuation`, with protected-session deferral. The source of truth; tested across every §7/§11 matrix row both canary arms.
- `TopicProfileOrchestrator` §8 kill/respawn orchestration — **add** — debounced, globally-capped (K=2) respawn engine; protected sessions never profile-killed; busy/autonomous sessions defer (switch-now overrides busy, never protection); §10.4 circuit breaker parks the pin + reverts after N attributable failures.
- Write-surface operator gate — **add** — every profile WRITE requires the topic's verified bound operator + the `X-Instar-Request` intent header (route) / authorized-sender (ingress); deny-by-default.
- Dev-agent dark gate (`resolveDevAgentGate`) — **add** — the whole feature resolves LIVE per-call; dark arm returns 503 (route) / no-op (orchestrator).
- §8(2) resume-map write-gate chokepoint — **modify** — ALL `_topicResumeMap` writers now pass through `orchestrator.claudeResumeWriteGate(topicId)` so a park/unpark during an in-flight swap can't be clobbered.
- Obligation-7 ingress `switch-now` → `orchestrator.handleSwitchNow` bridge — **add** — routes an operator's "switch now" reply to the orchestrator's own armed confirm when no write-surface slot is armed (precedence-preserving).
- Migrations: CLAUDE.md awareness section, additive config defaults, `/topic-profile` capability classification, framework-shadow markers — **add** — Migration-Parity for existing agents.
- Legacy `topic-frameworks.json` mirror — **modify (read-only seed)** — one-directional: the new store seeds FROM it once; the store never writes back. Full retirement is deferred and tracked (CMT-1368).

---

## 1. Over-block

**What legitimate inputs does this change reject that it shouldn't?**

The only block/allow surface is the profile WRITE gate. Concrete over-block shapes:
- A legitimate operator says "use codex here" in a topic that has NO verified bound operator yet → the write is refused (403 `no-bound-operator`). This is intentional (Know-Your-Principal: an unverified principal can't set routing), but it IS an over-block in the narrow sense that a real operator's intent is declined until their identity is bound from an authenticated send. Mitigation: operator binding is automatic from the authenticated sender, so in practice the first authorized message binds them; the refusal only fires for a genuinely unbound topic.
- A `/topic-profile` route write without the `X-Instar-Request` header → 403. Intentional CSRF-class guard; a same-origin dashboard/agent caller always sends it.
- A malformed topic key (non-numeric) at the route boundary → 400 (clamped). Correct.

No conversational MESSAGE is ever blocked — a non-trigger turn falls straight through to normal conversation; only an explicit profile-trigger phrase from an authorized sender is acted on.

---

## 2. Under-block

**What failure modes does this still miss?**

- The §11 thinking-control canary ships OFF (`claudeThinkingControlAvailable:false`), so the orchestrator NEVER claims an in-flight thinking swap it can't verify — it degrades to resume. This is deliberately under-claiming (the safe direction); the "miss" is that a thinking-mode change always costs a respawn rather than a zero-loss in-flight swap, until the canary is built. Disclosed in the swap-quality matrix.
- `readIdle` is three-valued and fails toward BUSY (an unconfirmed pane read defers the kill). A session that is actually idle but reads `unconfirmed` will defer a respawn to the next tick — a latency miss, never a wrong kill.
- The in-flight swap, on an `unconfirmed` swap result, never guesses again — it falls back to kill+resume on the next confirmed-idle window. A swap that genuinely succeeded but reported `unconfirmed` would cost an unnecessary respawn (none-loss), not a wrong state.

---

## 3. Level-of-abstraction fit

**Is this at the right layer?**

The swap DECISION is a pure low-level classifier (`classifyProfileChange`) — cheap, deterministic, fully unit-tested both arms. The ORCHESTRATION (kill/respawn/in-flight/defer) is a stateful authority that consumes that classification plus live idle/verification reads. This is the correct split: the brittle part (which swap method) is a pure function with no side effects; the authority part (when to actually kill) layers protection/busy/breaker disciplines on top and is the only thing that touches sessions. It FEEDS the existing session-spawn path (`spawnSessionForTopic`) and the existing model-swap route (`ModelSwapService.swap`) rather than re-implementing them; it USES the existing `_topicResumeMap` (gated at one chokepoint) rather than a parallel resume store. No lower-level primitive is re-implemented.

---

## 4. Signal vs authority compliance

**Required reference:** [docs/signal-vs-authority.md](../../docs/signal-vs-authority.md)

**Does this change hold blocking authority with brittle logic?**

- [x] No — this change has no block/allow surface on the hot path. A profile change is a ROUTING decision (P2: "a profile change is a routing decision, never a block"). The orchestrator produces RESPAWNS, never a block of a user message or an operation.

The one allow/deny surface (the write gate) is not brittle: it is the existing verified-operator binding (an authenticated-sender fact, not a heuristic) plus a static intent-header check. No LLM, no brittle classifier owns any block authority. The orchestrator's kill decisions are disciplined by hard invariants (protected never killed — fails CLOSED to protected on a read fault; busy defers; breaker parks), not by a guess.

---

## 5. Interactions

- **Shadowing:** the §8(2) resume-map write-gate sits in front of EVERY `_topicResumeMap` writer. Verified it gates (park/unpark coordination) without dropping writes — an ungated write during an in-flight swap was the clobber risk; the chokepoint serializes it. The ingress `switch-now` bridge runs only in the empty-write-surface-slot branch, so it never shadows the propose-confirm/reapply handlers (precedence preserved; pinned by `topic-profile-server-wiring.test.ts`).
- **Double-fire:** the spawn-path success recorder is guarded by `!_orchestratorSpawnInFlight.has(topicId)` so an orchestrator-initiated respawn does not double-count into the §10.4 breaker (which it is mid-evaluating). Verified.
- **Races:** the store is a single-writer CAS (`mutate()`); concurrent writes serialize. Protected-session reads fail CLOSED. The 30s orchestrator tick and the carrier tick are unref'd and best-effort (a fault is swallowed and retried next tick — `@silent-fallback-ok` justified). Disclosures route through the adapter directly, bypassing the `/telegram/reply` exact-duplicate window, and carry an audit sequence so consecutive notices are never byte-identical (interaction with the duplicate-message suppression — confirmed non-colliding).
- **Feedback loops:** none. A respawn re-resolves the (now-updated) pin and applies it once; `recordApplied` marks it so the next reconcile sees convergence, not a re-trigger.

---

## 6. External surfaces

- **Other agents (same machine / mesh):** adds one MeshRpc verb `topic-profile-pull` (capability-gated; a peer must advertise it). The transfer carrier pulls a topic's profile at acquire-time; a local durable write cancels a pending REPLACE pull. No effect on peers that don't advertise the capability.
- **Install base (existing agents):** receives the CLAUDE.md awareness section, additive config defaults (add-missing-only), the `/topic-profile` capability classification, and framework-shadow markers — all via `PostUpdateMigrator` (idempotent). New agents get them via `init`.
- **External systems:** Telegram disclosures (the §8 propose-confirm / switch-now / breaker notices) post to the topic via the adapter. No Slack/GitHub/Cloudflare surface beyond the existing §10.5 Slack session-refresh path.
- **Persistent state:** new additive files — `state/topic-profiles.json` (the pin store), `state/topic-profile-orchestrator.json` (orchestrator slots), `logs/`-side audit appends (`appendTopicProfileAudit`). The legacy `topic-frameworks.json` is read ONLY (one-directional seed). No existing file's schema changes.
- **Timing:** a profile change on a busy/autonomous session defers to the next idle window — user-visible only as "I'll apply the switch the moment it goes idle, or say 'switch now'."

---

## 7. Rollback cost

- **Hot-fix:** the feature ships DARK behind `resolveDevAgentGate` + `dryRun:true`. The instant back-out is config (no code revert needed): the dark arm already serves 503 / no-op on the fleet. A code revert is a clean patch — the new modules are additive; the only modification to existing hot paths is the resume-map write-gate chokepoint (reverts to ungated) and the ingress switch-now branch (reverts to the plain no-op reply).
- **Data migration:** none required. The new state files are additive and self-initializing; deleting them resets profiles to defaults with no corruption. The legacy mirror is untouched (read-only).
- **Agent state repair:** none — existing agents that received the migration keep an awareness section + inert config defaults that no-op while the gate is dark.
- **User visibility:** none during rollback — a dark feature going darker is invisible; a dev-agent that had it enabled would simply stop applying new pins (existing sessions unaffected; pins persist in the store for when it re-enables).

---

## Conclusion

This review produced no design changes to the core orchestration (it was already converged over 16 rounds), but the integrating session DID change one thing as a direct result of re-examining the deferral surface: obligation 7 (the ingress `switch-now` confirm bridge) was found to be a genuine dead-end (the orchestrator disclosed "say 'switch now'" while the ingress replied "nothing pending") and was BUILT rather than shipped deferred — precedence-preserving, so no existing confirm flow changed behavior. The feature is clear to ship: it holds no brittle block authority (a profile change is a routing decision), the one allow/deny surface is the existing verified-operator gate, every kill decision is disciplined by hard invariants that fail in the safe direction, and the whole feature is dark-gated with a config-only back-out. Residual deferrals (legacy-mirror retirement, maturation-track sink, the §11 in-flight thinking canary) are tracked via durable commitments CMT-1368/CMT-1369 and the spec's §11 contingency.

---

## Second-pass review (if required)

**Reviewer:** echo (dedicated reviewer subagent — required: the change touches session lifecycle (kill/respawn) AND gate/auth surfaces)
**Independent read of the artifact: concur** — I traced the real code on all six review axes and the artifact's safety claims hold; the change is shippable with the minor advisory follow-ups noted below (none ship-blocking).

Evidence verified against the code:

- **Session-lifecycle safety (PASS).** Protection is a hard precondition. `respawnPhase` checks `classification.protectedDeferral` and defers (`TopicProfileOrchestrator.ts:943-948`) BEFORE it ever computes `switchNow` (`:950`) or reaches the kill path (`:993+`), so "switch now" structurally cannot kill a protected session. `protectedDeferral` is sourced from `session.isProtected` in the classifier (`classifyProfileChange.ts:157, 74-75`), and the dep FAILS CLOSED: `isProtectedSession` returns `true` on a read fault (`server.ts:13361-13368`, `catch { return true }`). The global respawn cap K is real and enforced — `maxConcurrentProfileRespawns: 2` (`server.ts:13386`) gates the FIFO drain loop (`TopicProfileOrchestrator.ts:794`). An `unconfirmed` idle read defers rather than kills: `readIdle` returns `'unconfirmed'` on a null tail (`server.ts:13260`), and at kill time `deferUntilIdle = busyish = !confirmedIdle` treats unconfirmed as busy (`classifyProfileChange.ts:151-153`, `:976` defers). The in-flight (no-kill) row also honors `protectedDeferral` (`:943` runs before the in-flight branch at `:953`).

- **Gate / auth surface (PASS).** Every write requires a verified bound operator: `authorize()` refuses operator writes when unbound or sender≠bound-operator, and refuses token writes when no operator is bound (`topicProfileWriteSurface.ts:697-734`). The HTTP route is token-trust (`principal: { kind: 'token' }`, `routes.ts:5467`) with body `updatedBy` ignored by construction. The dark gate is consulted LIVE per-call, not a cached literal: `regime`/`getConfig` are closures calling `resolveDevAgentGate(cfg?.enabled, config)` on every invocation (`server.ts:3877-3883, 13377-13390`), and `resolveDevAgentGate` is a pure `explicitEnabled ?? !!config.developmentAgent` over the live config object (`devAgentGate.ts:40-45`) → DARK on the fleet. The route refuses without the intent header — `requireTopicProfileWrite` returns 403 when `req.headers['x-instar-request'] !== '1'` (`routes.ts:5432-5433`), applied to every mutating `/topic-profile/*` route.

- **§8(2) resume-map write-gate chokepoint (PASS).** `_topicResumeMap.setWriteGate(...)` is wired to `orchestrator.claudeResumeWriteGate` (`server.ts:13412-13414`). The gate is enforced INSIDE the map, not at callsites: `TopicResumeMap.save()` early-returns on a refused gate (`TopicResumeMap.ts:181`) and `refreshResumeMappings()` skips refused topics (`:347`). Since the ~20 `_topicResumeMap.save()` callsites in server.ts all funnel through that one method, the "ALL writers pass through the gate" claim is true — I found no `save`/`refreshResumeMappings` path that bypasses `gateAllows`.

- **Obligation-7 switch-now bridge (PASS, precedence-preserving).** `case 'switch-now'` peeks the write-surface slot FIRST (`server.ts:1593`); only the empty-slot branch (`!armedSlot`) consults `_topicProfileOrchestrator.handleSwitchNow` (`:1603-1606`); an armed write-surface slot routes to `handleProfileConfirm` UNCHANGED (`:1612`). `handleSwitchNow` only fires a slot whose `kind === 'switch-now'` (`:1224-1231`), and `executeSwitchNow` sets `switchNowOverride` but the respawn phase still re-checks protection first — so the bridge cannot override protection.

- **Signal-vs-authority (PASS).** The only allow/deny surface is the write gate, which is a verified-operator fact + a static `x-instar-request` header check — no LLM, no heuristic owns block authority on the hot path. Every kill decision is disciplined by hard invariants (protected fail-closed; busy/unconfirmed defer; breaker parks), consistent with the artifact's §4 claim.

Advisory follow-ups (NOT ship-blocking; the feature is dark-gated):

- **Codex resume gate is defined but unwired.** `orchestrator.codexResumeWriteGate` (`TopicProfileOrchestrator.ts:1524`) is never installed on `_codexResumeMap` — `CodexResumeMap` has no `setWriteGate` mechanism at all, and `_codexResumeMap` has zero external save callsites in server.ts (it is orchestrator-private, written only by `captureAtKill` under the respawn lock). So there is no actual mid-switch re-poison vector to gate today, and the absence is SAFE — but the artifact's §8(2) framing ("ALL resume-map writers pass through the gate") is precisely true only for the Claude map. Recommend a one-line note in the build report that the codex gate is dormant-by-design until codex resume is captured on the natural spawn path (the matching obligation to CMT-1368's codex work).

- **`gateAllows` fails OPEN on a gate throw** (`TopicResumeMap.ts:163-172`, `catch { return true }`). This is the deliberate "a broken gate must not silence resume capture" direction and is correctly distinct from the session-kill protection (which fails CLOSED). Worth one explicit sentence in the artifact's §2/§4 so the two opposite fail-directions (resume-write fails-open vs kill-protection fails-closed) are not conflated by a future reader. No code change needed.

Both follow-ups are documentation precision, not behavior defects. No protection-bypass, auth hole, or data-loss race found.

---

## Evidence pointers

- Build: `pnpm build` EXIT 0 (clean).
- Tests: unit tier green; integration 278 files / 2592 passed; topic-profile e2e lifecycle 8/8; my changed unit files 285/285 (`TopicProfileOrchestrator`, `capabilities-discoverability`, `topic-profile-server-wiring`, `feature-delivery-completeness`, `no-silent-fallbacks` ratchet 5/5).
- Wiring integrity: `tests/unit/topic-profile-server-wiring.test.ts` (20 assertions over the composition root — construction, object-identity late-bind, real-deps-not-noops, lifecycle hooks, carrier mesh verb, the §11 conservative-canary flags, the obligation-7 bridge).
- Canary both arms: `tests/unit/classifyProfileChange.test.ts` (canary-passed→in-flight, canary-off→resume, idle-unconfirmed→never-in-flight, cross-model/level/off↔on/codex-rollout rows).
- Recovery ledger: `docs/specs/reports/topic-profile-BUILD-PROGRESS.local.md`.

## 2026-07-16 addendum — resolved door/model confirmation

Post-swap disclosure now consumes the newly spawned session's applied profile. The interactive
launch default resolver is shared with the Codex and Gemini argv builders, so an unpinned/defaulted
model is reported from the same decision that launched it. Successful framework, model, and tier
respawns all emit `Now driving this topic: <Door> door, <concrete model> model.` The fallback text
`account-default` remains only for doors whose CLI owns an opaque account default (Claude/Pi), where
inventing a concrete identifier would be dishonest.

Interaction review: the spawn port's optional `applied` result is backward-compatible with existing
ports and tests; when absent, the orchestrator retains its prior resolved-profile behavior. The
terminal disclosure still uses the existing audited, duplicate-bypass send path, and no new timer,
write authority, kill decision, persistent schema, or external endpoint is introduced. Rollback is
a code-only revert with no data repair.
