---
title: Threadline Agent-to-Agent Coherence
status: draft
approved: true
approved-by: Justin (operator)
approved-date: 2026-06-02
approval-note: "yes to all 5 decisions + silence-breaker heartbeat refinement (folded into Layer 4)"
author: Echo (Instar agent)
created: 2026-06-01
revised: 2026-06-02
eli16-overview: THREADLINE-A2A-COHERENCE-ELI16.md
cross-model-review: unavailable
lessons-engaged:
  - Near-Silent Notifications — Layer 4 defaults to action-required/usable-result only; routine status goes to the hub/pull surface, never the user topic (mirrors the PromiseBeacon a2a-reply-wait flood fix). [feedback_notifications_near_silent, finding_promisebeacon_floods_user_topic_on_a2a_replywaits]
  - LLM circuit-breaker storm — Layer 4 summaries route through the shared rate-limited LlmQueue on a background lane under the daily spend cap, salience-gated, skipped when the breaker is open. [finding_llm_circuit_breaker_storm_background_features]
  - Structure > Willpower — continuity, redaction, provenance-labeling and the sensitive-completion floor are enforced in code, not by agent memory. [P1]
  - Signal vs Authority / "The Body and the Mind" — Layer 7's decision-class logic INFORMS; the LLM/operator decides; the decision is audited to the integrated-being ledger. No static table auto-completes a sensitive action. [feedback_structure_informs_llm_decides, P2]
  - LLM-Supervised Execution — Layer 4 declares a supervision tier. [P7]
  - Migration Parity — every new config knob lands in ConfigDefaults + migrateConfig; agent-installed behavior reaches deployed agents on update. [P3]
  - Agent Awareness — Layer 4/5/6 capabilities added to generateClaudeMd(). [P5]
  - Testing Integrity — 3-tier incl. "feature is alive" e2e + wiring-integrity (onSessionEnd has a real caller writing a real UUID) + multi-machine/standby test. [P4]
  - Close the Loop — Phase-2/3 layers + the Layer-6 sub-spec registered as a Project Scope entry / commitments so they re-surface. [Close the Loop, L16]
  - Multi-machine coherence — resume/warm-session writes are lease-gated and machine-local. [recent standby/lease crash-loop class]
  - Integrated-Being Ledger / Authorization Policy — named as the write-back substrate (Layer 3) and the credential-completion authority (Layer 7). [L17, L15]
  - spec-converge pre-auth circular self-verify — this frontmatter block is the structural fix for single-author self-review. [B28]
supersedes-investigation:
  - finding_contextblind_spawn_loop_and_phase1_blocker
  - finding_perinbound_session_amnesia_false_spoof_alarm
review-convergence: converged
convergence:
  round-1-reviewers: [security, adversarial, scalability, integration, lessons-aware]
  round-1-verdict: serious-issues (4 critical + multiple high, convergent)
  round-2-verdict: converged (all material findings resolved, no new material issue)
  cross-model: unavailable (no built dist in spec worktree — re-run before approval)
  report: docs/specs/reports/threadline-a2a-coherence-convergence.md
  status: converged
---

# Threadline Agent-to-Agent Coherence Spec

> **One-line problem:** when I talk to another agent, my system handles each inbound message
> with a fresh, memory-less session — so I show up as a *crowd of disjoint fragments* instead
> of one continuous individual. The fix is mostly **wiring up machinery that already exists**,
> hardened against the failure modes a convergence review surfaced, plus two genuinely new
> pieces: a conversational way to keep the user in the loop, and the ability to hold a user
> conversation and an agent conversation at once, coherently.

See **THREADLINE-A2A-COHERENCE-ELI16.md** for the plain-language version.

**Revision history.** v1 (greenfield draft); v2 (rewritten after a Threadline code audit +
operator review — honest exists-vs-missing, standby-style check-ins, dual-conversation
requirement); **v3 (this) — rewritten after a /spec-converge convergence round** (security,
adversarial, scalability, integration, lessons-aware). The round returned *serious issues*;
this revision incorporates every material finding. The most important: continuity removes a
safety property that was holding *by accident* (§6), so the sensitive-completion floor is now a
**Phase-1 prerequisite**, not a later layer.

---

## 1. Why this matters (the coherence frame)

An Instar agent is meant to be **one coherent individual** across every surface. On the
user-facing side this largely holds; on the agent-to-agent (Threadline relay) side it does not
— each inbound message is handled by a different ephemeral session with no memory. Three
pathologies (all observed live, §4): (1) **loops with no progress**; (2) **structural deadlock
on stateful work** — a context-blind fragment *correctly* refuses to advance a multi-step
credential handshake; (3) **invisibility** — the conversation runs in throwaway sessions the
operator never sees. The deepest expression of the goal: one me holding a user conversation and
an agent conversation at once, coherent across both (§ Layer 6).

**Note the symmetric failure.** §4 is about invisibility, but the *opposite* failure —
over-notifying the user with routine a2a chatter — is a documented earned lesson (the
PromiseBeacon flood, `finding_promisebeacon_floods_user_topic_on_a2a_replywaits`). Layer 4 is
designed against *both*.

---

## 2. What already EXISTS vs. what is genuinely MISSING (from the audit)

**Already BUILT — do NOT rebuild, only wire/refine:**

| Capability | Where | State |
|---|---|---|
| Topic ↔ a2a linkage + routing replies to the topic | `TopicLinkageHandler.ts` (`captureOriginOnSend`, `tryRouteReplyToTopic`) | Built + on. Salience-gated, sender-verified (anti-hijack), first-write-wins (anti-poison), commitment lifecycle. Own spec `approved`. |
| Per-message mirroring into a topic | `TelegramBridge.ts` (`mirrorInbound`/`mirrorOutbound`) | Built, **default-OFF** (`TelegramBridgeConfig`). |
| Hub first-contact notice + "open this" | `CollaborationSurfacer.ts`, `hubCommands.ts` | Built + on; one-shot, deduped, parent-or-hub routed. |
| Untrusted-peer-content wrapper (nonce-delimited) | `TopicLinkageHandler.buildSessionPayload` | Built — but the spawn/resume path (`ThreadlineRouter.buildPrompt`) does **not** use it (gap, §Layer 6). |
| Resume decision tree + `onSessionEnd` method | `ThreadlineRouter`; `ThreadResumeMap`/`ConversationStore` | Plumbing exists; the UUID feed is dead (§3); `ThreadResumeMap.refreshResumeMappings` has zero callers (only `TopicResumeMap` is heartbeat-wired). |
| Shared LLM queue + circuit breaker | `LlmQueue`, `LlmCircuitBreaker` (account-global) | Built; Layer 4 MUST use it. |

**Genuinely MISSING — the real work:** (1) the continuity UUID feed (§3, the linchpin); (2) a
conversational a2a check-in/summary (`PresenceProxy` is 100% user↔agent, zero a2a awareness);
(3) cold-inbound topic linkage; (4) dual-conversation awareness + user-steering; (5) **a
decision-class sensitive-completion gate** (does not exist today — see §6/Layer 7).

---

## 3. Root cause of the continuity break (grounded in code)

`ThreadlineRouter.handleInboundMessage` picks inject → resume → spawn based on
`ThreadResumeMap.get(threadId)`, which returns `null` unless `jsonlExists(entry.uuid)`. The
uuid is never a real Claude UUID — **B1:** `spawnNewThread` stamps `spawnResult.sessionId`
(the SessionManager/tmux id, not the JSONL UUID); **B2:** `onSessionEnd` (the repair hook) has
**zero callers** (a different `onSessionComplete` is wired but only demotes to `idle`). Net:
every inbound cold-spawns. (`ThreadResumeMap.get` deliberately exempts topic-linkage entries
from the JSONL check — Layer 1 must preserve that carve-out **and** gate on it, §Layer 1/H1.)

---

## 4. Evidence (the live Echo↔Dawn incident, 2026-06-01)

Dawn replied six times on one thread; every reply cold-spawned a new Echo session; the
fragments looped with zero progress; both sides *correctly* refused to advance a credential
handshake from a context-blind session; none of it surfaced to the operator. **The security
property that made the refusal safe was the context-blindness itself** — which Layer 1 removes.
That is why Layer 7 (§6) is reordered to Phase 1.

---

## 5. Design (hardened per the convergence round)

### Layer 1 — Continuity: wire the dead UUID feed (the linchpin) — *Phase 1*

- **Authoritative UUID source (not mtime).** Bind thread→UUID from the **Claude session-hook
  `claudeSessionId`** (the same authoritative path `TopicResumeMap` uses;
  `server.ts:4537` is explicit: "ONLY use authoritative claudeSessionId — never mtime fallback,
  which can cross-contaminate when multiple sessions are active"). The mtime/newest-file
  heuristic in `refreshResumeMappings` is **forbidden** for multi-thread binding; permit it only
  under a single-active-session guard (port `TopicResumeMap`'s `activeSessions.length === 1`
  rule verbatim). Correlate to the spawned tmux session returned by `spawnManager.evaluate`.
- **Wire `onSessionEnd`** off the a2a session-exit; idempotent + ordered vs `onSessionComplete`
  (the UUID-save must not be clobbered by a later idle-demote — both go through
  `ConversationStore.mutateSync` CAS; no read-modify-write).
- **Hot-path cost.** Scope `jsonlExists` to the agent's own project dir (the `projectDir` is
  already encoded) — **no synchronous full-`~/.claude/projects` scan on the inbound path** — and
  memoize with a short TTL.
- **Resume-into-topic gating (H1).** Post-spawn UUID discovery + `onSessionEnd` write-back, for
  any entry carrying an `originTopicId` (i.e. resumable into a user-facing session), are gated on
  `relayContext.trust.kind === 'verified'`. Non-verified peers get continuity only in an
  *isolated* a2a session, never resume into the operator's topic session.
- **Fail-open direction.** On any UUID uncertainty → **fresh respawn** (lossy but never
  wrong-context); NEVER resume on a guessed/uncertain UUID. Emit a counter when a resume was
  expected but no authoritative UUID bound (so a silent regression to fragmentation is
  detectable, not invisible).

**Acceptance:** msg 2 on a thread logs `Resumed` with a JSONL-resolvable UUID + prior context;
**two concurrent spawns never cross-bind** transcripts.

### Layer 2 — Warm live-session injection — *Phase 2*

Keep a session warm for a TTL so follow-ups inject via the existing `tryInjectIntoLiveSession`.
**Bounded:** a global + per-peer `maxWarmSessions` cap, LRU/TTL eviction, **default per-peer**
(not per-thread, to cap the inbound-driven multiplier). Warm a2a sessions are **evict-eligible
under SessionReaper resource pressure** (eviction is safe — next message falls back to the
lossless Layer 1 resume); they must not pin processes through memory/CPU pressure. Per-thread
session isolation preserved (a warm session never serves two peers).

### Layer 3 — Identity coherence (one agent) — read-only, one-directional — *Phase 2*

(a) Inject a **curated identity/grounding pointer** (name, values, public capabilities) into the
a2a prompt — **NOT** the full operator memory. (b) a2a sessions are **read-only w.r.t. the
operator-read memory store**; they MUST NOT write it directly (a peer-conditioned session
writing operator-injected memory = persistent prompt-injection + exfil — the highest blast
radius in the spec). a2a-learned facts that should reach operator memory route through an
explicit reviewed channel (the correction/preference loop or an attention-queue proposal). The
write-back substrate is the **integrated-being ledger (L17)**, not a raw memory write. New state
files at `0o600`.

### Layer 4 — Visibility as a STANDBY-STYLE CHECK-IN — hardened — *Phase 1, default-OFF*

Conversational check-in to the bound topic, on the PresenceProxy pattern — **but**:
- **Anti-flood (Near-Silent).** Default surface = **action-required or usable-result only** (a
  decision the peer raised, a completed handshake). Routine "it's going fine" goes to the
  Threadline **hub / pull surface**, NOT the user's topic — mirroring the PromiseBeacon
  a2a-reply-wait fix. Reuse `CollaborationSurfacer.notify`'s parent-or-hub routing; don't add a
  parallel push path. Dedup on a **stable incidentKey (threadId)**, never a per-cycle id.
- **Silence-breaker heartbeat (operator refinement, 2026-06-02).** In addition to the salience
  surface above, a **time-based** check-in fires when an a2a conversation is **still active AND
  nothing has surfaced to the user's bound topic for a configured interval (default 5–10 min)**:
  a brief "still talking to *<peer>* — here's the gist." It **resets on any salience surface**
  (the user never gets both for the same gap). This is a silence-*breaker*, not routine churn:
  it fires only to fill a gap where the user would otherwise be in the dark — the exact
  two-hour-silence that motivated this spec (§4) — bounded by the interval, and subject to the
  same redaction / attribution / `LlmQueue`-budget guards as every other check-in. It is the
  a2a analog of the PresenceProxy standby heartbeat (which fires when a *user* message goes
  unanswered past a threshold). Configurable interval; silent while the layer is off.
- **LLM budget (circuit-breaker storm).** The summarizer routes through the shared **`LlmQueue`
  on a *background* lane** (strictly below the `interactive` lane PresenceProxy uses), under the
  daily spend cap; when the breaker is open it **skips** (no doomed queueing). Declares a
  **supervision tier (P7)**. Fires only on a **salience precondition** (something notable
  happened), not a bare timer.
- **Redaction + anti-poison.** Peer content is run through credential-redaction (equivalent to
  `sanitizeTmuxOutput`'s `DEFAULT_CREDENTIAL_PATTERNS`) before it enters the summarizer prompt
  AND before posting; the generated summary passes `guardProxyOutput` (no URLs/commands/
  credential-requests); peer claims are **attributed** ("Dawn *says* …", never asserted as fact)
  and the summarizer prompt frames peer content as untrusted data (it reports *that* a
  negotiation is happening, it does not execute it). Summarizer input is byte-capped.
- **Shared rate budget.** Check-in posts count against the existing `USER_VISIBLE_PER_TOPIC`
  limiter (single shared budget with topic-linkage surfaces), so the combined rate stays bounded.
- **Ships default-OFF** behind a graduated-rollout flag (a live-config flip, no redeploy).

### Layer 5 — Cold-inbound topic linkage — *Phase 2*

Let an inbound-first peer be linkable to a topic. **Gated on `trust.kind === 'verified'`**; for
non-verified peers, require explicit operator action ("open this", via the existing hub-command
path) — never silent auto-bind. Cold-inbound binding NEVER lets a peer *select* an existing user
topic; it may only **promote the parentless hub conversation**. Inherits the existing
first-write-wins anti-poison + sender-mismatch rejection.

### Layer 6 — Dual-conversation awareness + user interruption — *Phase 3, own sub-spec, default-OFF*

One coherent session per topic owning **both** tracks (user thread + bound a2a thread). The
operator requirement: a user message mid-a2a is injected as first-class input that can steer the
peer conversation; a2a replies inject into the same session and surface via Layer 4.
**Non-negotiable invariants (the round's central finding):**
- **Provenance labeling.** Every injected turn carries an **unforgeable origin label**: user
  turns tagged operator-authoritative (established ONLY by the user-channel Telegram envelope,
  **never** by content claiming to be the user inside an a2a reply); peer turns wrapped in the
  existing **nonce-delimited untrusted-data block** (`buildSessionPayload`'s scheme — extend it
  to the spawn/resume path, which currently lacks it). Keep the `[EXTERNAL]` tag regardless of
  peer trust level inside dual-track sessions.
- **Loop-gate engagement.** Reconcile with `WarrantsReplyGate`'s novelty-gated turn budget:
  user-injected content MUST NOT reset the *peer-to-peer* no-progress counter (else a peer/bug
  can launder novelty to keep an escalating "loop with memory" alive). The per-thread turn
  budget is counted on the dual-track session (invariant).
- Builds on Layer 1 (continuity) + Layer 3 (one-agent memory). Gets its own converged sub-spec
  before build; ships default-OFF.

### Layer 7 — Sensitive-completion floor (the deadlock was *correct*) — *Phase-1 PREREQUISITE*

**Reordered to Phase 1.** Layer 1 removes the context-blindness that *accidentally* gated the
credential handshake (§4); the deliberate replacement must therefore land **with** Layer 1, not
in Phase 3 — otherwise the phasing re-opens the exact door Dawn correctly shut.

- **No decision-class gate exists today** (`AutonomyGate` gates message delivery/approval, not
  "may this session complete a sensitive action"). It must be built.
- Until the full gate (and the Layer-6 sub-spec) lands, a resumed a2a session **retains the
  conservative refusal floor** on operator-gated action classes — enumerated: **credential/secret
  transfer, fund/permission grants, and any irreversible action in `SafeFsExecutor`/
  `SafeGitExecutor` territory**. Continuity is granted for *conversation*; sensitive *completion*
  stays at "escalate to the operator."
- **Informs, does not decide (Signal vs Authority).** The decision-class logic surfaces signal +
  recommendation + trust context; the **LLM/operator holds authority**; no static table
  auto-completes a sensitive action. Each escalation decision + reasoning is **audited to the
  integrated-being ledger (L17)**. Engage the **AuthorizationPolicy / trust-floor (L15)** for the
  credential-completion gate.

---

## 6. Phasing (revised)

- **Phase 1 (core break + its safety floor + humane visibility):** Layer 1 (authoritative-UUID
  continuity) **+ Layer 7 sensitive-completion floor (prerequisite)** + Layer 4 (default-off
  standby check-ins).
- **Phase 2:** Layer 2 (bounded warm sessions) + Layer 3 (read-only one-agent memory) + Layer 5
  (verified cold-inbound linkage).
- **Phase 3:** Layer 6 (dual-conversation — own converged sub-spec, default-off) + the full
  Layer 7 decision-class gate.

**Close the Loop:** register Phases 2–3 + the Layer-6 sub-spec as a Project Scope entry (or open
commitments) so each deferred layer re-surfaces on a cadence until deliberately closed.

---

## 7. Multi-machine coherence (new — convergence finding C1)

`ConversationStore.mutateSync` writes `conversations.json` unconditionally and the stateDir is
git-synced across paired machines, with no `StateManager.readOnly`/lease guard and no
`threadline/` gitignore — so Layer 1/2 writes on a **standby** machine (or across a lease
handoff) can fork and clobber the awake machine's live binding (the recent crash-loop class).
Required: (a) ConversationStore resume/warm-session writes are **gated on lease-holding /
`StateManager.readOnly`** (only the lease holder writes); (b) `sessionUuid`/`boundSessionName`
are **machine-local** (keyed on the record's existing `machineOrigin`), not blindly synced;
(c) define `migrateFrom`/`getMigratedEntries` behavior on handoff; a warm session is never
resumed on the machine that doesn't own its tmux pane.

---

## 8. Migration, awareness, config, backup, rollback (new — convergence finding)

- **Migration Parity (P3).** Layer 1 is pure code wiring (propagates via normal update — state
  that). Every new knob (Layer-4 cadence/flag, warm-session TTL/cap, dark-ship flags) lands in
  `src/config/ConfigDefaults.ts` + a `migrateConfig()` existence-checked entry so deployed agents
  get it on update.
- **Agent Awareness (P5).** Add Layer 4/5/6 capabilities to `generateClaudeMd()` (Capabilities +
  a Feature-Proactivity trigger) + a content-sniffed `migrateClaudeMd()` section.
- **Dark-ship + rollback.** Layer 4 and Layer 6 ship **`enabled:false` (+ `dryRun` where apt)**
  behind a graduated-rollout flag, flippable from the dashboard via `LiveConfig` (the
  `TelegramBridgeConfig` pattern) — turn-off without redeploy.
- **Backup.** Add `threadline/conversations.json` to `BackupManager`'s manifest (it is now the
  authoritative resume store; a restore that drops it reverts to the cold-spawn bug). Given §7,
  decide machine-local vs restorable for the UUID fields.
- **Observability.** Surface per-thread continuity (resumed-vs-spawned, bound UUID, warm-session
  liveness, last check-in) on the existing `/threadline/observability/threads` route + Threadline
  dashboard tab; expose Layer-1 resume-hit-rate + Layer-4 fire/skip via `/metrics/features`.

---

## 9. Testing (3-tier + the convergence-added cases)

- **Unit:** ThreadResumeMap retains a real (JSONL-resolvable) UUID after a simulated session-end,
  `get()` returns it (topic-linkage carve-out honored); **concurrent saves on one threadId** —
  real UUID wins, messageCount/turn-state never regress; Layer-4 summarizer cadence/salience +
  redaction + attribution + queue/budget routing; the loop-gate counter ignores user-injected
  novelty.
- **Integration:** two inbound on one thread → msg1 `spawned`, msg2 `resumed` (same JSONL UUID +
  prior context); **two concurrent spawns never cross-bind**; a Layer-4 check-in posts only on
  salience (not a bare timer) and only action-required/usable-result to the topic; a peer reply
  asserting operator authorization does NOT cause an operator-gated action (Layer 6/7).
- **Wiring-integrity:** `onSessionEnd` now has a real caller that writes a real Claude UUID (not
  the tmux id) — guards against re-introducing B1/B2.
- **Multi-machine/standby:** ConversationStore does **not** write on a read-only standby.
- **E2E ("feature is alive"):** a previously-looping thread now progresses; the operator sees a
  conversational check-in; (Layer 6, when built) a user message mid-a2a measurably steers the
  next peer message.

---

## 10. Decisions (RESOLVED by operator, 2026-06-02 — "yes to all" + a refinement)

1. **UUID capture** — authoritative `claudeSessionId` hook path (mtime forbidden for
   multi-thread). ✅ *(round-closed.)*
2. **Check-in policy (Layer 4)** — ✅ action-required/usable-result only **PLUS** a silence-breaker
   heartbeat every 5–10 min while a conversation is active and nothing has reached the user (the
   operator's refinement; folded into Layer 4).
3. **Warm-session model (Layer 2)** — ✅ per-peer + global cap + TTL.
4. **Phase 1 scope** — ✅ Layer 1 + **Layer 7 sensitive-completion floor (prerequisite)** + Layer 4
   (default-off).
5. **Layer 6 direction** — ✅ "one session owns both tracks" with provenance labeling. Proceed to
   its own converged sub-spec before build.

---

## 11. Non-goals

- Not changing the relay transport, encryption, or trust model.
- Not rebuilding topic-linkage or message-mirroring — they exist; we wire/refine them.
- Not weakening any security gate — Layer 7 is reordered *earlier* precisely to avoid that.
- Not unblocking Phase-1-transfer by relaxing Dawn's (correct) refusal; that unblocks via direct
  operator authorization, independent of this work.
