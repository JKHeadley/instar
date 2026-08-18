---
title: "Duplicate-session stand-down (cooperative quiescence for the losing copy)"
slug: "duplicate-session-standdown"
author: "Echo"
date: 2026-08-17
version: 2
parent-principle: "Cross-Machine Coherence — One Agent, Robust Under Degraded Conditions. When two machines hold live sessions for one conversation, exactly one voice may continue; the other must fall SILENT and STILL without destroying the work it holds."
parent-spec: "docs/specs/closeout-activeness-bypass-confirmed-move.md (round-4 verdict: the terminate primitive was rejected; this spec is the operator-chosen replacement — 'build the stand-down', 2026-08-17 21:13 PDT, topic 46473)"
risk-class: safety-relevant (constrains a live session's outbound sends and new tool calls; never kills, never blocks reads)
eli16-overview: "docs/specs/duplicate-session-standdown.eli16.md"
lessons-engaged:
  - "P2 Signal vs Authority — the hook is a thin deterministic enforcement point; the registry is a local ENFORCEMENT CACHE of verdicts whose authority lives in the replicated ownership records and the reconciler's evidence ladder. No new detector gains blocking power."
  - "P11 Check the wall against the toolkit — every capability claim in this spec cites the file that ships it, and round 1 CAUGHT three unverified claims (the idle-close path, the egress funnel, the migration freebie); each is now either verified or replaced with declared new work. The predecessor died on exactly this failure shape."
  - "P14 Distrust Temporary Success — v1 claimed to add no KEEP-guard bypass; round 1 proved the drained close NEEDS a bounded carve-out. Rather than hide it, §Drained-close declares it as THE standard-shaped exit the three prior patches were groping toward: one explicit, corroborated, narrowly-scoped crossing — not a fourth ad-hoc flag."
  - "P19 No Unbounded Loops — episode-scoped admission latch, notice caps, TTL that resumes rather than resets, release hysteresis, and a terminal expired state; every cycle a reviewer found (tiebreak oscillation, expiry re-registration, snapshot flap) has a named brake."
  - "P20 Verify the State, Not Its Symbol — drained is corroborated (idle prompt + child-process shape + transcript quiet EXCLUDING block-echo turns + zero non-blocked calls since registration), never inferred from the registry write; the impossible-state canary cross-checks hook-local decisions against the server registry on separate paths."
review-convergence: "2026-08-18T04:48:47.478Z"
review-iterations: 2
review-completed-at: "2026-08-18T04:48:47.478Z"
review-report: "docs/specs/reports/duplicate-session-standdown-convergence.md"
cross-model-review: "codex-cli:gpt-5.5"
approved: true
approved-by: Justin
approved-via: "Telegram topic 46473 (2026-08-17 23:01 PDT): conversational approval — 'Approved' — following the ELI16 overview + convergence report handoff at 21:49 PDT. Operator had previously chosen the stand-down primitive over the rejected terminate/kill (2026-08-17 21:13 PDT) and confirmed the generality requirement (not scoped to topic 46473)."
approved-at: "2026-08-18T06:01:00Z"
single-run-completable: true
frontloaded-decisions: 8
cheap-to-change-tags: 1
contested-then-cleared: 12
---

# Duplicate-session stand-down

## Problem statement

When one conversation has live sessions on two machines (the 2026-08-17 topic-46473 incident:
pinned to the Laptop, live on the Mini anyway), today's only remedies are (a) the post-transfer
closeout, whose KEEP-guards refuse to end a busy session — and a duplicate is busy by
construction, so the wrong copy survives until a human kills it; or (b) a forced kill, which
round-4 review rejected: symmetric split-brain lets BOTH machines kill their own copy, a
succeeding kill resets every brake so an undiagnosed creation cause becomes an unbounded
kill/respawn loop, and a mid-tool-call kill destroys in-flight work with no audit trail.

The chosen primitive is COOPERATIVE QUIESCENCE: the losing copy is told to stop emitting
user-visible output and stop STARTING new tool calls, allowed to finish the step it holds, and
then closed by an explicit, bounded drained-close rule (§Drained-close — round 1 established
the pre-existing idle pipeline does NOT close anything at normal pressure, so v1's "the
existing pipeline closes it" claim was false and is withdrawn).

**Generality (operator-confirmed requirement, 2026-08-17):** nothing in this design is scoped
to one topic or one machine pair — the stand-down keys on the same ownership verdicts the
reconciler and closeout already compute for every conversation on every machine. Its
ENFORCEMENT coverage, however, is framework-dependent and declared honestly in
§Framework coverage matrix rather than implied uniform.

## Proposed design

### The state: a server-side stand-down registry (a local ENFORCEMENT record, not an authority)

`StandDownRegistry` (new, `src/core/StandDownRegistry.ts`): a durable machine-local map
`sessionName → entry` where an entry is
`{ topicId, ownerMachineId, ownershipEpoch, reason, issuedAt, expiresAt, state, episodeId }`
with states `standing-down → drained → closed` plus `expired` and `released`.

**Naming honesty:** the registry is a machine-local ENFORCEMENT CACHE of verdicts whose
AUTHORITY lives elsewhere — the replicated ownership records and the reconciler's evidence
ladder. It never decides who owns a conversation; the cadence re-verify (§Release) keeps it a
mirror with bounded staleness.

**The identity key is the tmux session name** (`INSTAR_SESSION_NAME`, the env var the
pr-hand-lease-guard precedent already resolves — there is no "sessionId" in session env). A
session without the env (headless one-shots) is outside the hook's reach and fails open.

**One admission standard, two producers:** BOTH producers route their registration through
`validateConfirmedMoveAssertion` — the predecessor's hardened evidence bar (trusted local
identity, dwell, TTL ceiling, liveness-proof age, session binding), reused verbatim:

1. **The post-transfer closeout** (`SessionReaper.#runCloseoutGated`): on the same
   liveness-CONFIRMED move + dwell + freshest-interaction preconditions that previously
   attempted a terminate, it registers a stand-down and keeps the session alive.
   *Inherited defect, fixed in this build:* the dwell streak is not owner-scoped
   (`TopicMovedStreakValue` records no owner — predecessor round-4 finding 7); since
   registration reuses the dwell, this spec's build adds `ownerMachineId` to the streak
   record and resets the count on an owner change.
2. **The duplicate reconciler** (`DuplicateSessionReconciler`): its seam is `armCloseout`
   (record repair — it never armed a terminate directly; v1 mischaracterized this). It keeps
   exactly that seam: it repairs the record, and the CLOSEOUT (producer 1) does every
   registration through the one validated path. There is therefore ONE producer in effect;
   the reconciler contributes verdicts, never entries.

**Registration refusals (before the assertion is even built):**
- A topic whose local session holds `structural-long-work` or `active-subagent` evidence is
  NOT registered — contested REAL work is the human's call, immediately: one deduped
  attention item ("a duplicate holds live work — decide"), no entry, no muzzle. v1's "a
  duplicate holding a live build finishes it muzzled" was self-contradictory (a build is a
  SEQUENCE of tool calls; the hook would freeze it at the first boundary) and is withdrawn.
- A topic with a LIVE autonomous run is treated exactly like structural-long-work: refusal
  + ONE attention item ("a duplicate on the wrong machine is running an autonomous job —
  your call"), no entry, no muzzle. Round 2 corrected the v2 draft here: the draft
  auto-triggered the transfer path's suspend-at-turn-boundary primitive, but that primitive
  is CONSENT-GATED (a live run answers 409 needsConfirmation) — auto-invoking it would mint
  a new authority (a machine suspending an operator's run with no human in the loop) that
  the primitive was never granted. Refusal-plus-attention keeps the human in the loop and
  still prevents the Stop-hook/stand-down deadlock (no entry means no blocking), at the
  cost the spec accepts everywhere else: contested real work waits for the human.

`GET /standdown` lists live entries + episode latches with their evidence (Registry First).
`POST /standdown/evaluate` is Bearer-authed and strictly side-effect-free apart from its
audit row, which rides the same coalesced stream as every other transition row (a model
retry-looping blocked calls must not write one row per attempt).

### Enforcement half 1 — no new tool calls (the PreToolUse hook)

`standdown-guard.js` — a new canonical PreToolUse hook on a **`*` matcher** (every tool).
The ALLOWLIST of tools it never blocks is explicit and code-owned inside the hook: `Read`,
`Glob`, `Grep`, `TodoWrite` — genuinely observation-local surfaces. Everything else is
blocked while standing down: `Bash`, `mcp__.*`, **`Write`/`Edit`/`MultiEdit`/`NotebookEdit`**
(file mutation is action — and an unmatched Write could rewrite the guard script itself,
round-1 security finding 1), **`Task`** (spawning subagents is starting new work, and a live
subagent would block drain forever), **`WebFetch`/`WebSearch`** (outbound egress — blocked
rather than argued about), and every FUTURE tool name (unknown = mutating = blocked; an
allowlist fails closed for tool classes that do not exist yet).

**Cost discipline (round-1 scalability finding 1 — the one change that must precede even
dryRun):** the hook's fast path is LOCAL and byte-cheap. The registry (single-writer,
in-process) maintains a marker file `state/standdown-active.json` listing the live muzzled
session names, rewritten on every transition via write-temp+rename (hooks read it from
other processes; a torn read must be impossible, and a failed read fails open) and
regenerated from the registry at every BOOT — including the corrupt-file boot, where the
empty registry produces an empty marker rather than a stale one — and REFRESHED
PERIODICALLY (every reaper tick) while entries exist, so a deleted/corrupted marker cannot
silently lift the muzzle until "the next transition" (round-2 finding: deletion between
transitions was a single point of silent bypass). The hook: (1) config/env enable gate — exits 0
with ZERO I/O beyond the config read when the feature is dark, honoring an explicit
`enabled: false` even on a dev agent; (2) stats the marker file — absent, or own
`INSTAR_SESSION_NAME` not listed → exit 0, no HTTP (the steady state for ~100% of tool calls
on ~100% of machines); (3) only a listed session pays the HTTP call to
`POST /standdown/evaluate` for the authoritative verdict + audit row, with a **≤1.5s
timeout** (not the lease guard's 5s — this hook is on every tool call, and fail-open makes a
short timeout free).

- **Verdict block** → exit 2 with a FIXED-TEMPLATE message interpolating only the
  charset-clamped `ownerMachineId` (never nicknames or free-text reasons — a peer-influenced
  string in instruction position is a prompt-injection surface, round-1 security finding 4):
  *"This session is standing down: the conversation and its work continue on machine
  {ownerMachineId}. Do not retry this call or route around the block; stop, and remain
  idle."* One-turn-actionable and truthful — it does NOT say "finish your current step"
  while blocking the steps (v1's notice directed behavior the floor prevented).
- **Any uncertainty** (no entry, server down, timeout, malformed) → exit 0, fail-OPEN.
- **Migration parity is DECLARED NEW WORK, not a freebie** (round-1 integration finding 1 /
  lessons finding 8): `instarSettingsHooks.ts` today canonicalizes only the `Bash` +
  `mcp__.*` matchers, and the migrator's `mcp__.*` handling is existence-only — it never
  appends to a present matcher. This build adds a canonical `*`-matcher set + an
  `ensureInstarWildcardPreToolUseHooks` mirror consumed by BOTH init and
  `PostUpdateMigrator.migrateSettings`, plus an anti-drift test asserting init and migrator
  consume the same canonical sets. The script BODY rides the existing always-overwrite path.

### Enforcement half 2 — no user-visible output (the send funnels, honestly scoped)

Round 1 established two facts v1 got wrong: `/telegram/reply` carries NO authenticated
session identity (the route resolves the topic's current binding; metadata is
caller-supplied), and `telegram-egress.ts` is the Bot-API network door, not the
conversational funnel. The v2 design:

- **Topic-keyed refusal at the two conversational funnels**: `/telegram/reply/:topicId`
  (positive ids) AND `deliverToConversation` (negative/minted ids — Slack and future
  platforms), each consulting the in-process registry: a send TO a topic with a live
  stand-down entry on THIS machine is refused `409 standing-down` naming the
  charset-clamped owner machine id. This muzzles the losing COPY because the entry exists
  only on the losing MACHINE — the winner's sends, on its own machine, never see an entry.
  **The refusal re-checks ownership at fire time** (round-2 codex fold): before refusing,
  the funnel consults the CURRENT ownership record in-process; if this machine is now the
  owner (ownership moved back; a legitimate replacement session started here), the entry is
  released on the spot and the send proceeds — a topic-keyed muzzle must never outlive the
  ownership fact it mirrors, and a lingering entry through hysteresis must not suppress the
  rightful speaker. This is the Ownership-Gated-Side-Effects check applied at the
  side-effect's own fire time, which is where the constitution wants it.
- **Server-internal senders, verified per class** (round-2 corrected a fresh false claim
  here): reap-notify, cold-start fallback, and the owner-dark ladder call
  `telegram.sendToTopic` directly and never traverse these funnels — exempt by
  construction, so the stand-down's own episode notice and genuine system notices deliver.
  **The standby (PresenceProxy) is NOT on that path** — it sends via
  `POST /telegram/reply/:topicId` (server.ts ~14549), so its proxy lines about a muzzled
  topic WOULD be 409-refused, and its error handling would loop on that. The decided
  behavior: the standby consults the registry FIRST and, for a standing-down topic,
  replaces its classification with the honest one-liner "this copy is standing down — the
  conversation continues on the owner machine" (sent at most once per episode, riding the
  same per-episode notice budget) instead of "actively working" heartbeats about a
  deliberately frozen copy. Its funnel sends for such topics are thereby never attempted;
  the 409 remains the backstop, classified terminal. The integration test pins the
  per-class table, not a blanket claim.
- **`409 standing-down` is terminal and non-retryable** for the delivery-recovery machinery
  (classified alongside 400/404), with the retry-exhaustion escalation suppressed — a
  muzzled reply must not terminate in a false "I had a reply for you but couldn't deliver
  it" loss notice (round-1 lessons finding 16; the invisible-payload incident is the warning
  label).
- **Session self-identification is a tracked refinement, not load-bearing**: stamping
  `INSTAR_SESSION_NAME` into the relay payload would let the refusal key on the sender
  (attribution, not authentication — it is self-reported by the constrained party). v1's
  "keyed sessionId+topicId" claim is withdrawn; the topic-keyed check plus the hook half
  carry the enforcement. <!-- tracked: CMT-2031 -->

**In-process fail direction:** the registry lives in the same server process as both
funnels, so "registry unreadable" is not a reachable runtime state for these checks. A
corrupt durable file at BOOT starts the registry EMPTY with a loud log; producers re-derive
their verdicts over the following ticks (minutes, not one tick — the dwell must
re-accumulate across distinct snapshot generations; v1's "within one tick" was false). The
window's failure mode is the pre-existing status quo, never a new leak — but it IS a
known fail-open window, stated as such (round-2 codex fold): a corrupt durable registry at
boot raises ONE attention item and a degraded-mode row in `GET /standdown`, so minutes of
un-enforced stand-downs are visible rather than silent.

### Inbound messages — nothing is silently swallowed

The scenario that CREATES a duplicate is routing divergence, so the muzzled copy holding the
user's freshest message is the EXPECTED case (the reconciler deliberately excludes
recent-interaction from its ladder for this reason). Three named behaviors:

1. **At registration**: if the topic's freshest local inbound is unanswered, the
   registration hands it to the existing durable-inbound-queue machinery to re-deliver
   toward the owner; where that path cannot deliver, the queue's existing honest loss
   notice fires ("resend anything still needed"). Never silent.
2. **Post-registration fresh LOCAL user message** (the user is demonstrably addressing THIS
   copy): a named **release-or-divert** condition — if the mesh can forward the message to
   the owner, it is diverted (durable queue) and ONE per-episode notice tells the user the
   conversation continues on the other machine; if the owner is unreachable — **or the
   durable inbound queue is dark/dry-run on this machine** (it ships behind
   `multiMachine.sessionPool.inboundQueue`, fleet-default off; the coupling is declared,
   not assumed) — the entry is RELEASED and this copy answers (reachability wins — the
   muzzle never outlives the user's live attention).
3. **A composed-but-refused reply**: abandoned-with-audit (the transcript retains it; the
   409 row records it), AND covered by the same per-episode notice so the user knows to
   expect the answer from the owner. The owner does not receive the composed text in v1 —
   and a DIVERTED user message may reference content that exists only in the loser's
   transcript, so the owner can answer without the referent (the per-episode notice
   partially mitigates by telling the user which machine answers). Both are one declared
   residual, not an accident. <!-- tracked: CMT-2031 -->

### Drained-close — the ONE declared carve-out (P14, engaged honestly)

v1 claimed "the existing idle pipeline closes it — no bypass needed." Round 1 proved both
premises false: `thresholdMs()` returns null at normal pressure (the idle pipeline reaps
NOTHING on an unpressured machine), and `hasActiveProcesses` keeps a claude session with
resident idle MCP children forever at normal tier. An honest design needs an explicit close
rule, and this spec declares it as what it is — the bounded, standard-shaped exit the three
prior ad-hoc bypasses were groping toward:

- **Eligibility**: entry.state = `drained`, where drained is CORROBORATED (P20): idle prompt
  + no non-baseline children EXCLUDING the resident MCP stack + transcript quiet where
  block-echo turns (the model reacting to exit-2 messages) do not count as activity + zero
  non-allowlisted tool calls completed since registration's drain boundary, all sustained
  for `drainConfirmTicks` (default 2). An additional drained signal: a session whose only
  activity since registration is blocked calls and which has returned to its prompt counts
  as drained — a block-loop that ENDS must not be held un-drained by the transcript noise
  the blocks themselves generated.
- **What it crosses — exhaustive against ReapGuard's ACTUAL reason enumeration** (round-2
  finding: a non-exhaustive list is how a silent hole ships): THREE keep-reasons, each with
  the reason it is safe here — `recent-user-message` (the inbound rules above guarantee any
  fresh local message already released or diverted the entry, so a residual hold is stale by
  construction); `active-process` ONLY in its idle-MCP-children shape (the corroborated
  drain established no work is running); and `open-commitment` (a commitment binds the
  AGENT, not this copy — the registration preconditions proved the conversation is served
  on the owner, whose copy carries the commitment; holding the drained duplicate open for
  it would convert most real episodes into TTL/attention noise while protecting nothing,
  since duplicate topics are mid-work conversations by construction). Tier-independent;
  counts against the normal `maxReapsPerTick`/`maxReapsPerHour` budgets.
- **What it never crosses**: `protected`, `active-subagent`, `structural-long-work`,
  `recovery-in-flight`, `pending-injection`, `relay-lease`, `spawn-grace` (a just-spawned
  session is inside the dwell anyway), and `main-process-uninspectable`/`process-uninspectable`
  (uncertainty is not evidence — the predecessor's rule, kept). The registration refusals
  above mean entries are not created behind `active-subagent`/`structural-long-work` at all.
- The close is recorded in the reap-log with reason
  `topic moved — stand-down complete (owned by <machineId>)`; the `topic moved` PREFIX is
  deliberate: `ResumeQueue.classify` already hard-excludes that prefix, so the existing
  exclusion catches this close with zero new code (round-2 finding: the v2 draft's reason
  string missed the prefix and would have needed new exclusion work),
  and reap-notify SUPPRESSES its per-topic notice for this reason — the episode notice
  (§Inbound) is the single user-facing line, so the user is not told "your session was shut
  down" about a conversation that is alive and answering on the owner.

### Relationship to SpawnAdmission (the creation half)

SpawnAdmission owns PREVENTION (refusing to start a copy on a non-owning machine); the
stand-down owns REMEDIATION (retiring a copy that exists anyway); CMT-2027 owns the open
question of WHY the creation happens. The episode latch does not block re-registration
after a clean `closed` (that episode ended correctly), so an undiagnosed creation cause can
produce a spawn → register → drain → close cycle. It is bounded and visible rather than
braked: each cycle is a full dwell + drain (tens of minutes, not seconds), and the
standdown-health check counts closed episodes per topic per 24h — more than 3 raises the
episode's attention item naming the churn and pointing at the creation cause (CMT-2027).

### Episode brakes (P19 — every churn a reviewer found, named and braked)

An **episode** is `(sessionName, topicId, ownershipEpoch)` with a durable `episodeId` and a
persistent latch that outlives its entry:

- **Admission latch**: a `released` or `expired` episode blocks re-registration for the same
  episode key; re-admission requires a STRICTLY NEWER ownershipEpoch (new evidence) or an
  operator ack. This kills the tiebreak-release→re-register oscillation and the
  expiry→re-register hourly loop — the producers' unchanged verdicts cannot re-mint an
  episode the system already adjudicated. **The latch cannot become a silent enforcement
  hole** (round-2 finding): the epoch-mint rule is stated — the reconciler bumps the
  ownershipEpoch on each fresh adjudication of a topic, so a PERSISTING duplicate is
  re-adjudicated and re-admitted under the new epoch — and, as the backstop for a duplicate
  the reconciler never revisits, N consecutive latch-blocked re-registration attempts
  (default 5) raise the episode's attention item so a released-then-latched live duplicate
  is never invisible.
- **Notice cap**: ONE injected tmux notice per episode (not per registration), suppressed
  entirely in dryRun (a cooperative model complying with a dryRun notice would silently
  enforce a mode sold as observe-only — round-1 adversarial finding 10).
- **TTL resumes, never resets**, across re-registrations within one episode.
- **Release hysteresis**: the cadence re-verify releases only after 2 consecutive failed
  legs (a single dark-peer tick cannot flap the muzzle), mirroring `mutualMuzzleGraceTicks`.
- **Expired semantics (the fork v1 punted; round-2 codex corrected the first answer)**: at
  TTL expiry BOTH enforcement halves PERSIST — tools stay blocked and voice stays muzzled.
  Expiry changes exactly two things: the attention item fires (once, per episode) and the
  drain clock stops being consulted. The first answer (tools resume, voice muzzled) would
  have produced a silent local actor — a session free to mutate files and spawn work while
  unable to explain itself to anyone, which is not quiescence but unaccountable autonomy.
  A frozen session awaiting the human is the honest terminal state: the P19 loop risk is
  carried by the episode latch (no re-registration churn), not by dropping enforcement.
  Operator ack of the attention item is the only path to release. `expired` is terminal per
  episode, so the health canary counts real distinct episodes, not one stuck loop.

### Release, the coherence invariant, and the anti-mutual-muzzle rule

- **Cadence re-verify (the agreement invariant):** every reaper tick re-verifies each live
  entry against the CURRENT replicated ownership record AND the liveness snapshot: *an
  entry may exist only while the record names a DIFFERENT machine as owner and the owner
  holds a live session for the topic*. Either leg failing (with the hysteresis above) →
  `released`, session resumes. The stand-down owners' machineIds are included in the
  snapshot's `ownerSet` so this read stays a synchronous local Map lookup and the fan-out
  stays owner-scoped (a coverage gap here would read `'unknown'` every tick and churn
  release/re-register — round-1 scalability finding 5).
- **Asymmetric admission**: a machine the current record names as owner refuses to register
  its own copy (`self-is-owner`, the predecessor's validated check) — a symmetric episode
  requires both records wrong at once.
- **Anti-mutual-muzzle tiebreak**: when local entries exist, a pool-scope read (scoped to
  exactly those topics, riding the shared WS4.4(f) pool poll-cache; ZERO peer HTTP when the
  registry is empty) checks whether every live copy of a conversation is muzzled; if so,
  the copy on the lexicographically-lowest machine id releases and serves. Chosen
  deterministically WHEN both sides hold the same view; under stale/partitioned membership
  the sides may compute different live-copy sets, in which case release-on-uncertainty
  governs (after `mutualMuzzleGraceTicks`, default 2) and two voices are possible — the
  stated tradeoff below. The lowest-id bias (the same machine always wins ties, including
  when its own corrupted record caused the episode) is acknowledged and acceptable because
  the attention item surfaces every mutual-muzzle episode to the human.
- **The tradeoff, stated:** under partition, "at most one voice" and "at least one voice"
  cannot both be guaranteed. This spec chooses at-least-one-voice: a partitioned episode
  can briefly produce two speaking copies — (a) exactly the pre-existing condition, never
  worse than the status quo; (b) bounded in harm by the exactly-once inbound ledger and
  outbound duplicate suppression; (c) self-healing on partition heal via the cadence
  re-verify. Fail-toward-silence would turn every partition into an unreachable agent — the
  worse harm by the constitution's own ordering.

### Framework coverage matrix (declared, per the stall-coverage discipline)

| Framework | Tool muzzle (hook) | Voice muzzle (funnels) | Drain detection |
|---|---|---|---|
| claude-code | YES (this spec) | YES | Full (transcript + idle prompt) |
| codex-cli | NOT in v1 — `installCodexHooks` has its own path; a codex guard is a tracked increment <!-- tracked: CMT-2031 --> | YES | Partial — where the transcript probe cannot resolve, the entry routes to the TTL/attention path BY DESIGN (a shorter `standDownTtlMinutes` for unprovable frameworks is a config knob) |
| gemini-cli / pi-cli / grok-build | NO (no hook infrastructure) | YES | Same as codex |

A non-claude duplicate is therefore muzzled on VOICE immediately and on tools not at all in
v1 — declared, and acceptable because voice is the user-facing harm and the attention path
bounds the rest.

## Decision points touched

| Decision | Classification | Justification |
|---|---|---|
| "Register a stand-down for this session?" | invariant | One producer path, gated on the predecessor's validated assertion; AND the reconciler's evidence ladder escalates on ANY ambiguity before a verdict exists (hard-pin → admissible epoch → probe-confirmed live run → escalate), so the upstream judgment never reaches registration. Conservative default = no entry. |
| "Refuse registration (live work / autonomous run)?" | invariant | Existing evidence booleans (`structural-long-work`, `active-subagent`, live-run state file); refusal escalates to the human — the conservative direction. |
| "Block this tool call?" (hook) | invariant | Marker-file + registry lookup; code-owned allowlist; fail-OPEN on every uncertainty. |
| "Refuse this outbound send?" (funnels) | invariant | In-process topic-keyed lookup; internal senders exempt by construction; fail direction is the pre-existing status quo. |
| "Is the session drained?" | invariant | Corroborated multi-signal predicate (P20), uncertainty = not drained (wait). |
| "Release this entry?" (re-verify + tiebreak) | invariant | Deterministic over replicated data with declared hysteresis; every uncertainty fails toward RELEASE — the reachability-preserving direction. |
| "What happens at TTL expiry?" | judgment-candidate — floor: BOTH halves stay enforced (frozen, zero destruction), ONE attention item, episode latch blocks re-registration churn; arbiter: the OPERATOR via the item; deterministic terminal rung: hold frozen, do nothing further. | Whether an undrained muzzled session should be forced dead is a genuine competing-signals call; it goes to the human, floored at zero destruction and zero unaccountable action. |
| `validateConfirmedMoveAssertion` (reused) | invariant | Classified in the predecessor's table; unchanged. |

## Agent Awareness & Migration (the standard's §3, owed and named — round-2 fold)

Two audiences, both load-bearing, both shipped as `generateClaudeMd()` sections WITH
content-sniffed `migrateClaudeMd()` entries so existing agents receive them on update:

1. **Every agent** — a capability section: what a stand-down is, the Registry-First read
   (`GET /standdown` — "why did my tool call get blocked / my send get a 409 / my other
   copy go quiet?" → read it, never guess), and the proactive trigger (user asks "why did
   you go quiet in that conversation on my other machine?" → the stand-down retired a
   duplicate; the conversation continued on the owner).
2. **The muzzled session itself** — a durable behavioral contract, because the hook's block
   message and the one tmux notice are the only in-band channels and neither survives
   context pressure: *"a stand-down block means the conversation you were serving now lives
   on another machine. Stop starting work, do not route around the block via any tool, do
   not retry; finish your reasoning and remain idle — the session will be closed cleanly
   and nothing you produced is lost."* This contract is what makes cooperative drain
   CONVERGE rather than depend on a model's reaction to repeated tool errors.

The operator-facing recovery moves (release an expired episode, answer the live-work
attention item) are conversational-first per Mobile-Complete: the attention items carry the
decision in plain words; no curl is ever the operator's surface.

Test plan addition (E2E): the template section exists in `generateClaudeMd()` output and
`migrateClaudeMd()` is idempotent and content-sniffed.

## Multi-machine posture (Cross-Machine Coherence)

- The registry + marker file are **machine-local BY DESIGN** — `machine-local-justification:
  hardware-bound-resource` (an entry muzzles a PROCESS on this machine's disk). The
  verdicts it mirrors are replicated; the cadence re-verify is the declared agreement
  invariant with one-tick bounded staleness (+hysteresis).
- `GET /standdown` is **proxied-on-read** (`?scope=pool`, the shipped fan-out pattern,
  riding the shared pool poll-cache).
- Episode latches are machine-local (they brake THIS machine's producers); the ownership
  epochs they key on are replicated, so a genuine new adjudication re-admits everywhere.

## Rollout & rollback

- Ships behind `monitoring.standDown` — dev-gated (live on a development agent, dark on the
  fleet), **dryRun-FIRST even on dev**: producers register entries, the hook and funnels LOG
  would-block/would-refuse verdicts without blocking, the tmux notice is NOT injected, and
  the marker-file fast path is exercised (so the dryRun soak measures the true cost).
  **The dryRun→enforce flip is the operator's, on named evidence** (would-block
  false-positive count over the soak window) — the repo's standing convention, stated so it
  is not a mid-rollout stop-and-ask. dryRun entries that reach TTL are tagged `dry-run` and
  EXCLUDED from the standdown-health trigger, and their attention items are suppressed — a
  mode sold as observe-only must not page the operator with enforcement-shaped alarms
  (in dryRun nothing is blocked, so busy sessions reaching TTL is the expected state, not a
  signal).
- The hook's enable check honors an explicit `enabled: false` on a dev agent (no per-call
  chatter when deliberately off — the lease-guard's dev-gate-only check is NOT copied
  verbatim).
- The predecessor's terminate bypass is retired: the `closeoutActivenessBypass` CODE default
  flips to false, and `migrateConfig` rewrites a persisted `true` (dev agents that dogfooded
  it) with a guard-posture breadcrumb — otherwise the rejected kill stays armed on exactly
  the machines that tested it.
- Rollback: `monitoring.standDown.enabled: false` — production of entries stops, hooks
  exit-0 on the config gate, funnels stop consulting, entries and latches age out by TTL.
  Nothing durable needs repair.

## Observability

- Transitions land in `logs/standdown.jsonl` — **coalesced** (first blocked/refused row per
  (session, tool) + every Nth + a terminal count on the episode) with the reap-log's
  rotation/retention bounds. **dryRun would-block rows are EXEMPT from coalescing** — they
  are the soak's false-positive evidence, and the flip criterion needs per-call context the
  coalescing would drop (the enforce-mode coalescing keeps totals via the episode counters).
- **Pruning, consistent with the expiry decision**: `closed` and `released` entries are
  pruned from the durable map on transition (history lives in the JSONL). `expired` entries
  are NOT pruned — both enforcement halves persist past expiry, and the funnels/hook consult
  the live map, so an expired entry stays in it until the operator ack releases it. Episode
  LATCHES are pruned when their ownershipEpoch is superseded by the current replicated epoch
  or after 30 days, whichever first — a latch for a dead epoch is dead weight. Live-map size
  is bounded by concurrent duplicates plus operator-pending expired episodes (each of which
  has an open attention item by construction, so growth here is growth the human already
  sees).
- `GET /standdown` serves live entries, episode latches, and counters.
- **The impossible-state canary, redefined so it is reachable, in BOTH directions** (v1's
  version was true by construction; round 2 added the inverse leg): the HOOK writes its
  local block decisions to its own append path (the lease-guard audit pattern); the server
  cross-checks that stream against the registry. Leg 1: a hook-side block with no
  server-side entry. Leg 2: a live entry + observed tool-call activity from that session +
  ZERO evaluate calls within the window — the signature of a lifted/bypassed marker, which
  leg 1 can never see.
- **Trigger ownership**: the `standdown-health` check rides the guard-posture probe: more
  than 2 distinct EPISODES expired in 7 days, or any canary hit, raises ONE attention item.
  Owner: the probe (machinery), not memory.
- **The user-facing posture is silence on the normal path** (decided, not omitted): a clean
  stand-down (register → drain → close) is housekeeping — the winner is already answering,
  and a notice would be noise. The user hears exactly one line only when their attention
  intersects the episode (the §Inbound per-episode notice) or when the human is genuinely
  needed (the TTL/mutual-muzzle attention items).

## Maturation plan

This is a safety-relevant enforcement layer, so it climbs the standard dark ladder — but
each rung is dated by CRITERION, not by hope, and the ladder terminates in a fleet flip
rather than dark-forever.

- **test-agent-live:** deploy to a throwaway agent via `/test-as-self`; register a
  synthetic stand-down entry against a scripted session and drive the full lifecycle
  (register → blocked call → refused send → drain → drained-close), confirming the marker
  fast path, the audit rows, and the 503-when-dark route posture. Proves the feature is
  alive before any real conversation meets it.
- **dev-agent-live:** live on this agent (echo) in **dryRun** — the genuinely multi-machine
  deployment, and the one that actually produces duplicates (topic 46473 is the incident
  class). The dryRun soak logs would-block/would-refuse verdicts with the notice and all
  attention surfaces suppressed/tagged, and exercises the marker fast path so the per-call
  cost is measured, not asserted.
- **graduation criterion:** (dryRun → enforce, dev agent) a 7-day dryRun window with ZERO
  would-block false positives (a would-block row against a session that was NOT a genuine
  duplicate — adjudicated against the ownership records at review time) and at least one
  TRUE positive or synthetic drill proving the path runs (an all-zero window is a dead
  check, not a pass). The flip is the operator's, on this named evidence (Frontloaded 8).
- **fleet:** after 14 further days enforcing on the dev agent with no muzzle-flap episodes
  (release-hysteresis breaches), no canary hits, and no operator-reversed attention
  decisions, the feature ships fleet-dark-off in the ordinary release and is flipped on by
  the standard graduated-rollout process; single-machine agents are a strict no-op either
  way.
- **dark-window:** the fleet dark window is bounded at 60 days from the dev-agent enforce
  flip — if the fleet flip has not happened by then, the standdown-health surface raises
  ONE attention item naming the stall (a feature with no path to maturity shipping dark
  forever is incoherence, not caution).

## Open questions

*(none)*

## Frontloaded Decisions

1. **Tuning values** — `standDownTtlMinutes` 60 (unprovable-framework value 15),
   `drainConfirmTicks` 2, `mutualMuzzleGraceTicks` 2, release hysteresis 2 — all
   config-tunable under `monitoring.standDown`; cheap-to-change-after: dev-gate + dryRun
   phase, no durable schema, pacing only; the zero-destruction floor is code, not config.
2. **Expiry never escalates to a kill**; tools resume, voice stays muzzled, the human
   decides. Decided here.
3. **The hook fails OPEN** (precedent: pr-hand-lease-guard, soaked) — with the marker-file
   fast path and ≤1.5s timeout as REQUIRED cost discipline, not optimizations.
4. **The funnel refusal is deterministic, not LLM-gated.**
5. **Reuse of the predecessor's validated evidence assertion** as the single admission bar.
6. **Normal-path silence** toward the user; one per-episode notice only where the user's
   attention intersects the episode (§Observability).
7. **Enforcement surface set (v1)**: `*`-matcher hook with the 4-tool allowlist;
   topic-keyed refusal at `/telegram/reply` + `deliverToConversation`; internal
   deterministic senders exempt. Codex hook coverage and sender-identity stamping are
   tracked increments, not silent gaps. <!-- tracked: CMT-2031 -->
8. **The dryRun→enforce flip is the operator's, on named soak evidence.**

## Deferral carriers (frozen excerpts) <!-- tracked: CMT-2031 -->

Each deferral marker above names a registered commitment <!-- tracked: CMT-2031 -->; the
carrier's immutable text is inlined so a reader can check coverage without API access. The
machine-checked ledger is `docs/specs/carriers/duplicate-session-standdown.json`.

> **CMT-2031** — Deliver the stand-down v1 residual increments: (1) codex-cli tool-muzzle coverage via installCodexHooks (v1 muzzles non-claude frameworks on voice only); (2) sender-identity stamping in the relay payload (INSTAR_SESSION_NAME as attribution) so the funnel refusal can key on the sender; (3) forwarding the muzzled copy composed-but-refused reply text and referenced-context to the owner machine (v1 ab
>
> _(status: pending · owner: agent · blockedOn: none)_

## Test plan

Unit: registry lifecycle (register/drain/expire/release; episode latch blocks
re-registration absent a newer epoch; idempotent re-register inside an episode; TTL resumes;
terminal pruning; marker-file rewrite on every transition); hook verdicts (allowlist,
unknown-tool blocked, marker-file fast path short-circuits, fail-open on server-down /
timeout / missing env / explicit-disabled); funnel refusals (topic-keyed, 409 terminal
classification, internal-sender exemption); registration refusals (live work → attention
item, autonomous run → suspend-first); drained corroboration (block-echo turns excluded;
idle-MCP-children shape; the alternate only-blocked-calls signal); owner-scoped dwell reset.

Integration: end-to-end busy duplicate → registered → tool blocked → send refused → drains →
drained-close lands with reap-notify suppressed and resume-queue excluded; release resumes a
muzzled session (hysteresis honored); fresh local user message → release-or-divert; dryRun
logs everything and blocks nothing (notice not injected); the flap brakes (tiebreak
oscillation latch, expiry latch).

E2E: production wiring — canonical `*`-matcher entry present in BOTH init and migrator
outputs (the anti-drift test), script body written by the migrator, routes alive behind the
gate (503 when dark), `GET /standdown` pool read merges, `closeoutActivenessBypass`
persisted-true migration runs.
