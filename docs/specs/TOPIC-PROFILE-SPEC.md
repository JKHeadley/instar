---
title: "Topic Profile — sticky per-topic framework / model / thinking-mode"
slug: "topic-profile"
author: "echo"
parent-principle: "Structure beats Willpower — a topic's framework/model/thinking choice is durable DATA resolved at spawn, never a setting the agent must remember to re-apply each session"
status: "converged (round 16 — all five internal reviewers clean; externals waived rounds 12-16 per operator, coverage-scoped; awaiting operator approval)"
date: "2026-06-10"
eli16-overview: "TOPIC-PROFILE-SPEC.eli16.md"
build-target: "main (v1.3.x) via `instar worktree create` off JKHeadley/main — NOT the agent-home checkout (stale v1.2.62 lineage). Depends on the model-swap route + tier resolution + closed-enum model-id guard + cost gate that exist only in v1.3.x (shipped by the Model-Tier Escalation work). §14 gates the build on verifying those are actually merged on the target FIRST."
depends-on:
  - "docs/specs/FABLE-MODEL-ESCALATION-SPEC.md (the model-swap route POST /sessions/:name/model-swap {tier}, resolveModel + knownModelIds closed enum, the capture-pane idle-confirmation guard, the cost gate, the subscription-billing envelope)"
lessons-engaged:
  - "Structure > Willpower (sticky setting is data, not memory)"
  - "Signal vs Authority (a profile change is a ROUTING decision, never a block) — P2"
  - "Know Your Principal — An Unverified Identity Is a Guess (operator binding on all write surfaces)"
  - "No Silent Degradation to Brittle Fallback / Maturity honesty (the swap-quality matrix discloses real loss, incl. the Codex-resume + FABLE-canary contingencies)"
  - "Migration Parity (additive config, migrateClaudeMd awareness, legacy-store one-directional read-only seed)"
  - "Config-write-clobbers-operator-setting (single-writer CAS store; add-missing-only config)"
  - "B2 / B36 — Echo IS the interface; never instruct the operator to type a CLI/slash command"
  - "L5 — State-detection robustness (a living canary/drift guard on the Claude thinking-flag CLI surface)"
  - "P7 — LLM-Supervised Execution (the conversational-set path declares its supervision tier)"
  - "P8 — UX & Agent Agency (refusals carry recovery paths; busy-confirm shows consequences before consent; the breaker is a self-recovery path with the parked pin re-offered; the agent may voice concern about a pin before applying it — operator authority wins)"
  - "No dark-ship on dev agents"
  - "Maturing-feature health: no alerts (Justin directive 2026-06-10) — drift/health signals are silent maturation-track metrics with fix-vs-report heuristics, never attention items or per-event topics"
  - "Know Before You Claim / A Wall Is a Hypothesis (verify FABLE is merged on target before building; verify the thinking flag against the live CLI)"
review-convergence: "2026-06-11T22:12:03.450Z"
review-iterations: 16
review-completed-at: "2026-06-11T22:12:03.450Z"
review-report: "docs/specs/reports/topic-profile-convergence.md"
approved: true
approved-by: "Justin (telegram:23225, uid:7812716706), 2026-06-11 16:50 PDT — 'approved! please build'"
---

# Topic Profile — Spec

**Status:** converged at round 16 — awaiting operator approval · **Author:** Echo · **Date:** 2026-06-11

> **Relationship to Model-Tier Escalation:** that spec gives instar *automatic, policy-driven*
> model escalation (default ↔ ultra). THIS spec gives the operator *explicit, sticky, per-topic*
> control over three axes — framework, model, thinking-mode — that persists until they change it.
> §9 defines how they compose; both subsystems write the SAME profile store through the SAME
> per-topic single-writer lock so neither clobbers the other.

> **Round-1 convergence note:** the original draft asserted a "verified operator" guarantee it did
> not wire on ANY write surface, promised a Codex `resume` swap whose rollout-id is never persisted,
> and described a "debounce/coalesce" the cited infrastructure does not provide. v2 wires
> operator-identity on all three surfaces (§10), makes the swap-quality matrix honest about both the
> Codex-resume and FABLE-canary contingencies (§7), specifies the real coalescing + single-writer
> mechanism (§5.1, §8), and makes the legacy store a one-directional read-only seed (§5.1). Every
> round-1 finding → resolution is mapped in §15.

---

## 1. Motivation

A topic's execution characteristics are split across three half-built surfaces:

- **Framework** is already sticky-per-topic and works (`TopicFrameworksStore` →
  `state/topic-frameworks.json`, the `/route` command, read at every spawn). claude-code ↔ codex-cli.
- **Model** is *policy-driven* (global `frameworkDefaultModels` defaults + automatic tier-escalation),
  not a "this topic always uses model X" pin.
- **Thinking mode** (reasoning effort / extended thinking) has **no per-topic control**, though both
  frameworks expose the knob natively (Claude: extended thinking; Codex: `model_reasoning_effort`,
  `src/providers/adapters/openai-codex/models.ts:63`).

Operator requirement (Justin, topic 23225, 2026-06-10): **full per-topic flexibility over model,
thinking mode, and framework, as sticky characteristics that persist until changed — and when a
change needs a new session, swap smoothly with as little context loss as possible.**

These are three axes of ONE thing — *how this topic executes* — so they become one **Topic Profile**
with a single resolution point at spawn and a single classifier that applies a change with the
gentlest swap and an honest statement of what it costs.

## 2. Goals

- A sticky per-topic **Topic Profile** = `{ framework, model|modelTier, thinkingMode }`, persisted,
  surviving restart/compaction, changed only by an **authenticated operator** action.
- **One read point** at spawn (`resolveTopicProfile(topicId)`) feeding launch params.
- **One write surface, platform-agnostic** with three entry modes — **conversational is PRIMARY**
  (Echo is the interface; the agent never tells the operator to type a command, B2/B36); a `/topic`
  command is a power-user convenience; a Bearer-auth HTTP route for programmatic use. All three resolve
  the writer to the topic's **bound operator** (§10). The design routes through `MessageRouter` and the
  platform adapters, so it works on **Telegram AND Slack** (and any future adapter) — nothing is
  Telegram-specific (§10.5).
- A **respawn classifier** that picks the gentlest swap method and **discloses the expected context
  loss** — including the cases where the gentle path is unavailable.
- **Smooth swap** reusing the mature `SessionRefresh` kill→`--resume` path (which already has the
  in-flight guard); framework switches fall back to the CONTINUATION bootstrap with an honest notice.
- **Compose with tier-escalation** (§9), **framework-agnostic** (gemini/pi no-ops until wired),
  **migration parity**, **cost-guarded**, **signal-not-authority**, ships **dark on the fleet,
  ENABLED on dev agents** behind a flag with a dry-run canary.

## 3. Non-Goals

- A general "complexity classifier." Profiles are operator-set (the automatic axis is tier-escalation).
- Routing internal background LLM calls (sentinels/gates) — per-component routing governs those.
- Cross-framework transcript translation. Claude and Codex cannot share a transcript; we disclose the
  boundary (§7), never synthesize one.
- Hardcoding any vendor/model id in logic — config + framework adapters only.

## 3.5 Decision points touched

Introduces one **routing** decision: which framework/model/thinking-mode a topic's session launches
or swaps to. **No block.** Worst-case failure of every component = the session keeps its current
characteristics (today's behavior), with the one explicit exception that a profile which *repeatedly
fails to launch* trips the spawn-failure circuit breaker (§10.4) and reverts to last-known-good —
which is also a "keep working" outcome, surfaced honestly.

## 4. The Topic Profile object

```ts
interface TopicProfile {
  framework?: IntelligenceFramework;            // 'claude-code' | 'codex-cli' | (future) 'gemini-cli' | 'pi-cli'
  model?: string | null;                        // explicit BASELINE model id — validated through FABLE's closed enum (§10.2)
  modelTier?: 'default' | 'escalated' | null;   // BASELINE tier pin (resolved server-side via FABLE's tier resolver)
  escalationOverride?: 'inherit' | 'suppress';  // default 'inherit' — does the heavy-work ultra mandate still apply? (§9)
  thinkingMode?: 'off' | 'low' | 'medium' | 'high' | 'max' | null;
  updatedAt: string;                            // ISO
  updatedBy: string;                            // VERIFIED operator principal, stamped server-side (§10.1) — never body-supplied
}
```

- **`model` and `modelTier` are mutually exclusive — a HARD validation refusal**, not a silent
  winner. Setting both is rejected with "pick one: an explicit model or a tier" and the profile is
  unchanged. (Round-1 Adversarial: a one-time write-warning evaporates; a sticky profile is read
  rarely, so the dropped intent would be invisible.)
- **`model`/`modelTier` set the topic's BASELINE model** (the model normal conversational turns use)
  — they do NOT, by themselves, disable the heavy-work ultra mandate. `escalationOverride` (default
  `'inherit'`) governs that, per §9 — the operator-correction (2026-06-10) that the Fable/ultra mandate
  for spec-design + heavy work stays in force unless the operator explicitly opts a topic out.
- `thinkingMode` is a generic enum mapped per framework adapter:
  - **Claude**: off → thinking disabled; low/medium/high/max → ascending extended-thinking budget,
    against the flag verified live (§6 + the L5 canary §11).
  - **Codex**: low/medium/high → `model_reasoning_effort`; max → `xhigh`. **`off` is explicit:**
    Codex reasoning models have no "off" — `off` maps to the **lowest** effort (`low`) AND the
    operator is told once ("Codex has no thinking-off; using lowest effort"). Never silently
    reinterpreted, never errored.
  - A framework with no thinking knob → strict no-op (logged, not errored).
- Every field is independently nullable.

## 5. Storage & resolution

### 5.1 Store — single-writer, field-merged

`TopicProfileStore` persists to `state/topic-profiles.json`. It is modeled on `TopicFrameworksStore`
for the file/atomic-write shape, but with two deliberate departures the round-1 review requires:

- **Single-writer serialized `mutate(topicId, patch)`** (the CommitmentTracker CAS pattern referenced
  in CLAUDE.md), NOT a load→overwrite-whole-object `set`. The profile has THREE independently-writable
  axes — a whole-object rewrite would clobber a concurrently-set field. `mutate` does a
  read-modify-write under a **per-topic process-local lock**, merging only the changed fields. The
  same per-topic lock also serializes the *respawn* the write triggers (§8). **Tier-escalation NEVER
  writes this store** (round-4, both scalability and adversarial — an escalation write has no operator
  principal, would trip the model/modelTier mutual-exclusion, and an ephemeral escalation persisted
  sticky would hijack the next natural spawn): escalation **consults the store read-only** (§9) and
  tracks its own applied state in FABLE's ephemeral mode-state / last-applied-tier marker. The shared
  per-topic lock serializes **ordering** (an escalation swap vs a pin-triggered respawn), not shared
  fields — escalation acquires the lock around its live-session mutation but writes only its own
  marker. **Only operator pin writes arm the respawn debounce** — escalate/de-escalate cycles never
  arm it (otherwise every heavy-work cycle would run idle-confirmation subprocess churn against a
  by-definition-busy session). The §8 reconcile terminal and boot sweep compute
  **expected-live = resolved baseline ⊕ any active escalation marker** — a session legitimately
  running the escalated model under `inherit` is never read as divergence (no controller ping-pong).
  **Flushes are serialized store-wide** (round-4 security): a single flush queue snapshots the
  authoritative cache at flush time, so a later-completing flush can never persist an older snapshot
  (two concurrent different-topic mutates both survive a reload — §11 tests it).
  **Durability precedes acknowledgment** (round-5 adversarial — an async flush behind an immediate
  operator confirmation means a crash in the mutate→flush window silently drops an *acknowledged,
  disclosed* pin; worse, if the respawn already applied it to the live session, the boot reconcile
  sweep would read store-vs-live divergence and actively REVERT the session to the un-pinned profile
  — a silent undo of a change the operator was told succeeded): the operator-facing confirmation,
  the §8 mandatory disclosure, and the arming of the §8 respawn debounce all fire **only after the
  mutate's flush has durably landed** (tmp+rename completed) — the per-write flush is synchronous
  from the writer's perspective, like the CommitmentTracker pattern this store cites — **except its
  error handling** (round-6 integration — `CommitmentTracker.saveStore()` swallows write errors in
  a silent catch; a verbatim copy re-creates ack-without-durability through a different door, the
  flush failing while the confirmation fires anyway): **a failed flush REFUSES the write out loud**
  (operator-facing refusal + audit `outcome:'refused' reason:'flush-failed'`), per the §8
  never-a-silent-drop rule — **and ROLLS BACK the in-memory mutation** (round-7, four reviewers
  independently — the cache is authoritative for reads, so without rollback a "refused" write keeps
  driving every spawn until the boot reconcile silently reverts it: refusal-without-reversion, the
  inverse of the ack-without-durability bug this fix closed): on flush failure, the affected topics'
  cache entries — including the current→previous undo shift — are restored to the last
  durably-flushed snapshot under their per-topic locks BEFORE the refusals fire; on a failed
  COALESCED flush, every waiter whose write is not yet durable is refused and rolled back together.
  §11's flush-failure unit test asserts the refused pin is absent from `resolveTopicProfile`, absent
  from the next successful flush, and covers the multi-waiter arm. **Queued flush waiters COALESCE**
  (round-6 scalability — a mass-acquire/restore applying N topics must not pay N serialized
  full-file flushes): a mutate arriving while a flush is in flight is satisfied by a single trailing
  flush of the latest cache snapshot — all waiters ACK on its completion (each still ACKs only after
  a flush containing its write durably lands), so a batch of N costs O(1–2) flushes.
  **The undo snapshot is durable in the same file** (round-6 external — an in-memory-only previous
  snapshot makes §10.3's undo silently useless after any restart): each topic's entry holds
  `{ current, previous }`; `mutate` atomically shifts current→previous **once per delta-carrying
  disclosure — captured at the FIRST write of an active §8 coalescing window OR rate-cap overflow
  period, per accepted write only when each write is individually disclosed**
  (round-8 harmonization with §8/R7-4: per-write shifting inside a burst is exactly the
  attacker-chosen-undo-target hole R7-4 closed; §11's undo test pins the burst case — two writes in
  one window → undo restores pre-burst) — so the undo target survives restarts exactly as well as
  the profile itself. **`previous` under
  REPLACE and seed is pinned** (round-7 integration): a §5.3 transfer-apply or §12 restore-apply
  REPLACE sets `previous` to the receiving machine's pre-replace `current` (undo means "back to
  what this machine had" — undo-of-a-transfer is honest); **a REPLACE producing no effective delta
  (the arriving entry equals local `current` — e.g. an A→B→A round-trip or a duplicate retried
  pull) discloses nothing per §8 and therefore must NOT shift `previous`** (round-10 adversarial —
  the once-per-delta-carrying-disclosure cadence applies to the REPLACE door too; otherwise a
  silent no-op transfer destroys the operator's undo target, violating §8's
  "undo restores what the operator last saw disclosed" invariant; §11 adds the round-trip-undo
  arm: pin → transfer A→B→A unchanged → undo still restores the pre-pin profile); the §5.1
  legacy seed initializes
  `previous: null`, and an undo with no snapshot is refused plainly ("nothing to undo yet"). The on-disk file is
  **server-owned single-writer**: external edits are unsupported and reconciled only at boot.
- **In-memory cache is authoritative for reads.** `resolveTopicProfile`, the tier-escalation opt-out
  check (§9), and `classifyProfileChange` all read the in-memory cache and never re-parse the file
  per call/tick. The file is read once at boot and on explicit external-change invalidation only —
  per-spawn and per-escalation-tick resolution is **O(1)**. (Round-1 Scalability: avoid the
  `TopicResumeMap.load()`-per-call disk-read anti-pattern.)

**Legacy framework store — one-directional read-only seed (NOT write-through):**
- On first load, `TopicProfileStore` **reads `state/topic-frameworks.json` once** to seed the
  `framework` field for any topic absent from the profile store (never overwrites). A snapshot of
  that file at migration time is retained as the rollback artifact.
- `/route` and `resolveTopicFramework()` are **rewired to read/write the profile store's `framework`
  field**. The legacy file becomes a **read-only mirror regenerated from the profile store** on each
  framework write (sole writer = the profile store), so a binary rollback to the prior release still
  reads current framework data — with **no dual-write divergence surface** (the round-1
  Scalability/Adversarial/Integration concern). Retirement of the mirror is tracked as an explicit
  commitment tied to a named release (not "next release"), per Close-the-Loop.

`all()` is for admin/migration only; dashboard/read surfaces fetch a single `get(topicId)` (§12).

### 5.2 Resolution (single point)

`resolveTopicProfile(topicId): ResolvedProfile` in `src/commands/server.ts`, called from
`spawnSessionForTopic()` — replacing the standalone `resolveTopicFramework()` call. Precedence per
field:

```
profile-store field  >  config default  >  global default
```

- **Config-layer ordering for the model field** (round-1 Integration, no-clobber lesson): the
  topic-profile pin > `topicProfiles` config default > `frameworkDefaultModels` > account default.
  `migrateConfig` adds `topicProfiles` **add-missing-only**, never touching an existing
  `frameworkDefaultModels` (FABLE §10 add-missing-only wording).
- **The framework field's config-default layer remains `config.topicFrameworks`** (round-3
  integration — Migration Parity): read-through unchanged, never migrated destructively. An agent
  with operator-authored config-level framework defaults keeps them post-update; §11 adds the
  precedence unit test for a topic whose framework comes only from config defaults.
- **TopicLocalModelStore precedence (defined now, even though structural fold-in is deferred §13.1):** <!-- tracked: CMT-1369 -->
  a `/local-model` binding is **provider-level and wins the model arm** for that framework (it sets
  `--oss --local-provider` and bypasses the tier resolver, `frameworkSessionLaunch.ts`). Therefore a
  **profile `model`/`modelTier` pin on a topic that has an active local binding is REFUSED with a
  named reason** ("this topic has a local-model binding — clear it first to pin a cloud model"). This
  is an explicit precedence, not an undefined collision.
- **Spawn-time framework fallback** (round-1 Adversarial): if `resolveTopicProfile` yields a framework
  whose CLI is not launchable (validly pinned, then the binary was removed/broke), spawn falls back to
  the global default framework and surfaces a one-line notice — consistent with the §3.5 keep-working
  guarantee (a dead pane is NOT "today's behavior"). **The launchability check is cheap/cached**
  (round-3 — same hot-path discipline as the §11 canary): an `fs.existsSync` on the resolved binary
  path or the canary's TTL'd last-verified-at marker, never an unconditional per-spawn subprocess.
- **Fallback notices are deduped per state-transition** (round-3 scalability — a stale pin must not
  become a standing per-respawn notice flood, the Bounded-Notification class): both keep-working
  fallbacks (this one, and §10.2's read-time re-validation fallback) disclose **once per (topic, pin,
  reason)** — then stay silent (audit-log only) until the pin or the underlying condition changes. A
  persistent fallback also feeds the §10.4 machinery: the pin is annotated degraded/parked so the
  condition converges instead of re-announcing forever.
- **Disabled-flag semantics** (round-1 Integration, hardened round-2): when `topicProfiles.enabled:false`,
  reads still **honor existing on-disk pins** (a disable does not silently re-route live topics) but
  **new operator pins are refused**. Three round-2 corollaries are explicit:
  (a) **System safety-writes are exempt** from the write refusal — the §10.4 circuit-breaker revert and
  the spawn-time framework fallback are keep-working writes, not operator pins, so a topic can never end
  up degraded-and-unfixable while the feature is off.
  (b) **Clearing a pin is permitted while disabled** (a CLEAR is not a new pin) — "turn it off and go
  back to normal" genuinely works for already-pinned topics, per-topic or via an admin clear-all.
  **Re-applying a breaker-parked pin is permitted while disabled, on the same basis** (round-13
  adversarial — the §10.4 revert notice unconditionally promises "say re-apply when it's fixed",
  and with the breaker live in every regime (R12-2) a new-axis pin can park on a disabled agent via
  honor-on-read or a transferred pin; refusing the re-apply as a "new pin" would strand it
  parked-unrecoverable until re-enable — the exact degraded-and-unfixable outcome clause (a)
  exists to prevent, reopened through the recovery door): a re-apply restores PREVIOUSLY-ACCEPTED
  operator intent, not new intent — it rides the same §10.4 cooldown-confirm machinery and is
  audited as a re-apply. **The recovery writes — re-apply AND clear — are exempt from BOTH gating
  knobs: always LIVE writes, never routed to the §14 dry-run shadow** (round-14 adversarial +
  lessons, independently — round-13 carved this exemption against `enabled` only, repeating the
  one-knob-walked R12-2 pattern: under the shipped `dryRun:true` a shadowed re-apply never
  un-parks the pin and silently evaporates at the flip, and a shadowed CLEAR strands a live
  transferred pin — "turn it off and go back to normal" failing through the second knob, on every
  config that actually ships). Restoring or removing previously-accepted intent is recovery, not
  the new orchestration under canary — the dry-run shadow loses nothing by exempting it.
  **The recovery writes' APPLICATION arm is regime-governed like every other live write**
  (round-15 lessons — round-14 fixed the write arm and left the respawn arm ungoverned, the exact
  R10-1→R11-1 one-arm-walked root): in the fully-live regime the §8 orchestration applies the
  restored/cleared profile normally; in the non-fully-live regimes there is NO profile-triggered
  kill (no orchestration is live to do it safely) — the recovery write applies at the next natural
  spawn or boot-sweep reconcile, and the confirmation reply SAYS so out loud ("re-applied — takes
  effect at this topic's next session restart"), the §8 told-out-loud divergence precedent. The
  §10.4 breaker revert's immediate respawn (R12-2) is NOT contradicted — that is the one
  keep-working exception, moving AWAY from a failing profile; recovery writes move TOWARD a
  changed one and can wait. §14's
  exemption list mirrors this; §11 tests parked-pin re-apply under `enabled:false` AND under
  `dryRun:true` (the shipped dev config), plus CLEAR-of-a-live-pin under `dryRun:true` — each
  asserting the no-kill + told-out-loud apply-at-next-spawn behavior in the gated regimes.
  (c) **Honor-on-read covers the escalation arm:** the server-side pin consult (§9) is NOT gated by
  `topicProfiles.enabled` — an existing `escalationOverride:'suppress'` pin is still honored when the
  feature is disabled. Otherwise disabling the feature would silently flip a "never escalate this topic"
  into 2x-cost escalation — a silent cost-increasing event. §11 tests the disabled+suppress case.
  (d) **The legacy `/route` surface keeps working under the dark flag** (round-3 — adversarial AND
  integration both flagged this fleet regression): the §5.1 rewire routes `/route` framework writes
  into the profile store, but the fleet ships `topicProfiles.enabled:false` — read literally, that
  refuses `/route` writes and breaks a shipped, working capability on every non-dev agent.
  **Framework-arm writes via the pre-existing `/route` surface (and equivalent conversational
  framework switches) are EXEMPT from the disabled-flag refusal AND from the §14 dry-run shadow**
  (round-10 adversarial — §12.5 ships `dryRun:true` on BOTH the fleet and the dev-agent canary, so
  without the dry-run half of this exemption every `/route` write would land in the shadow
  `intendedProfile` field and the shipped capability would silently break through the second knob —
  the same R3-18 regression by another door). Both `enabled` and `dryRun` gate only the NEW axes
  (model/modelTier/thinkingMode/escalationOverride) and the new `/topic` + `/topic-profile` surfaces;
  a `/route` framework write is always a LIVE store write regardless of either flag.
  **The exemption covers the RESPAWN arm too, by riding the legacy path** (round-11 adversarial +
  lessons, independently — the R10-1 wording fixed only where the write lands, leaving three
  contradictory readings of which flag governs the framework-switch respawn): wherever the new
  orchestration is not fully live (`enabled:false` OR `dryRun:true`), an exempted framework write
  is served end-to-end by the **pre-existing legacy `/route` path, byte-for-byte today's shipped
  behavior** — live store write + immediate kill+CONTINUATION respawn via the existing
  `respawnSessionForTopic` with the resume-UUID drop (verified on live code: today's `/route` DOES
  respawn immediately; "apply at next natural spawn" would itself be a behavior change). The NEW
  §8 framework-switch orchestration (debounce, busy-refusal, coalescing, resume-map parking)
  takes over the framework arm ONLY when `enabled:true` AND `dryRun:false` — the §10.4 breaker is
  NOT on that list: it is a system safety-write live in every regime, counting attributable
  legacy-path failures too (round-12, §10.4).
  While `dryRun:true` on an enabled agent, §8 runs in SHADOW for framework switches — it logs its
  `[dry-run]` would-be decisions alongside the legacy path that actually serves the switch — which
  is exactly the §14 canary: the new orchestration is observed against real traffic before it
  takes over, and no agent (fleet or dev) ever loses or degrades the shipped capability in the
  interim.
  §11's back-compat test runs `/route` set+respawn **with `enabled:false` AND `dryRun:true`** (the
  shipped fleet default config, pinned so a builder cannot pass the test under a non-shipped
  combination), asserting the write lands LIVE in the store AND the legacy immediate respawn fires
  exactly as today — no §8 machinery engaged, no `[dry-run]` prefix on the user-facing reply.

### 5.3 Multi-machine (transfer-follow with revalidation — the real mechanism)

The round-2 reviewers caught that v2's findings table claimed this resolved with no body text. This
subsection IS the mechanism. A Topic Profile is **sticky operator intent** and MUST follow the topic
across a session-pool transfer — the opposite of FABLE's reset-on-transfer (correct for ephemeral
*policy* state, wrong for a deliberate operator pin). Verified on target: no generic state-file
replication exists (`MultiMachineCoordinator` syncs only the role registry), so transfer-follow is
explicit work, not an inherited property:

- **Carrier: pull-at-ACQUIRE — a named prerequisite sub-task** (respecified round-4 integration:
  verified on target, `POST /pool/transfer` carries no payload and has no receive-side hook — it sets
  a pin, releases ownership, and the target acquires lazily on its next inbound message, possibly
  much later, possibly after being offline; AND topics also change machines through paths that never
  run the planner at all — hard failover, quota-aware placement, lease movement). So the carriage
  hook lives at the **ownership-ACQUIRE chokepoint**, not the planner: when a machine acquires a
  topic, it **pulls the profile entry from the previous owner** (over the machine-auth channel),
  covering planner transfers, failovers, and placement moves with ONE mechanism.
  **Batch + latency bounds** (round-5 scalability): a mass acquire (whole-machine failover) issues
  **ONE batched pull per peer** carrying all topics acquired from it, with durable retry keyed per
  (peer, batch) with backoff — never N independent per-topic retries — and its
  defaults-with-disclosure notices aggregate into one summary ("N topics moved from <machine>; pins
  reconcile when it's reachable"). The pull runs with a **short hard budget (~1–2s) or fully async —
  the spawn NEVER waits beyond the budget**; the reconcile-on-pull-landing path handles late arrival.
  **Unreachable previous owner** (round-5 integration — "defaults" contradicted the retained local
  entry): while a pull is pending, resolution uses the **LOCAL entry if one exists** (disclosed
  "as of when this topic last lived here — possibly stale"; a slightly-stale operator pin beats
  defaults), falling to defaults only when no local entry exists; the wholesale REPLACE applies when
  the pull lands. **A late-landing pull never clobbers a fresher local operator write** (round-5
  security — while the pull is pending, the acquiring machine IS the owner of record, so an operator
  can validly pin a new profile locally; the stale entry arriving later from the returned previous
  owner must not silently overwrite that deliberate pin — the exact
  silent-override-of-operator-authority class §10.4 brands unacceptable): **the normative mechanism
  is event-ordered and clock-free** (round-6, four reviewers independently — `updatedAt` is
  peer-asserted (§5.3 provenance) and cross-machine clocks skew, so a timestamp compare alone lets a
  forged or skew-ahead stale entry outrank a genuinely fresher local pin): a local **operator** write
  to a topic with a pending pull sets a cancel marker under the per-topic lock that **CANCELS the
  pending REPLACE for that topic**, audited `pull-superseded-by-local-write`. **The cancel marker is
  as durable as the pull it cancels** (round-7 security + adversarial — the retry record is durable,
  so a process-local marker dies in a restart and the re-issued pull lands with "no recorded local
  write", dropping to the skew-vulnerable backstop): the cancel durably amends the pending-pull
  record itself (removes that topic from the (peer, batch) retry entry) at local-write time, keyed
  to the pull episode and cleared on pull resolution; a newly-pending pull for a topic supersedes
  any older pending pull (rapid A→B→C→B re-transfers can't leave two pulls racing). **Token-trust
  HTTP writes cancel too** (a token holder is already operator-equivalent for this API per §10.1),
  audited with `origin:'http'`; only system-attributed writes never cancel (below). **The cancel
  amendment fires only after the triggering write's flush durably lands** (round-8 lessons — the
  R7-1×R7-2 interaction: an at-write-time amendment by a write whose own flush then FAILS would
  cancel the transferred pin while the local pin is refused and rolled back, leaving NEITHER — a
  silent side effect of a refused write); a flush-refused write cancels nothing. §11's
  A→B(offline)→A test covers the restart-between-write-and-landing arm and the
  flush-refused-write-cancels-nothing arm. The `updatedAt`
  comparison (local newer wins, ties favor local) is a **backstop only**, for pulls landing with no
  recorded local write event — with the pulled entry's `updatedAt` **clamped to ≤ the pull-receipt
  time** on the receiving machine (a future-dated pulled entry is treated as older, audited).
  **System-attributed writes never cancel or supersede a pending pull** (round-6 adversarial — a
  `system:circuit-breaker` revert or a spawn-fallback annotation on the acquiring machine is not an
  operator decision; letting it shed a legitimately transferred pin would be the breaker overriding
  operator authority through a side door): the pull lands, is revalidated, and the §10.4
  parked-intended-pin machinery handles any conflict.
  §11 covers A→B(offline)→A including the B-writes-while-A-offline arm. **The durable retry
  distinguishes "protocol-unsupported" from "unreachable"** (round-5 integration, rolling-update
  version skew): a peer whose instar predates the pull protocol parks the retry until the pool's
  `protocolVersion` handshake reports support, instead of spinning backoff against a permanent 404.
  An arriving entry that is ABSENT on the previous owner
  clears nothing — the local entry stays (a failover-then-transfer-back must not wipe a still-valid
  pin with an empty replace). The store itself stays per-machine; there is no continuous replication
  in this release. This carrier is a **prerequisite sub-task like CodexResumeMap** — until it lands,
  the §7 cross-machine row disclosure is "a pin does not yet survive a machine move."
- **Receiving-machine revalidation (mandatory):** an arriving profile is **re-validated through the
  full §10.2 closed-enum + framework-compat + installed-CLI guard on the receiving machine BEFORE it
  can drive a launch** — never trusted because a peer sent it (a divergent or compromised peer store
  must not become an unauthenticated profile-injection path that bypasses the operator gate). A field
  that fails revalidation on the new host (uninstalled CLI, off-enum model) falls to the default for
  that field with a one-line disclosure.
- **Provenance survives — flagged as peer-asserted** (round-3 security): `updatedAt`/`updatedBy`
  travel with the entry verbatim, never re-derived from the receiving machine's local operator — but
  the receiving audit entry is tagged `origin:'transfer:<machineId>'`, so a transferred `updatedBy` is
  recorded as **peer-asserted provenance, never a locally-verified principal** (revalidation proves
  field validity, not write authorization — a compromised peer can forge enum-valid fields with forged
  attribution, and the audit must not launder that). The profile carriage rides the **existing
  Ed25519 machine-auth channel**.
- **Single resolver of record:** profile **writes are gated to the machine that owns the topic**
  (the lease/placement holder per `GET /pool/placement`) — a write arriving at a non-owner is
  **refused with the owner named** (v1 drops cross-machine write-forwarding entirely — a forward would
  have to carry the platform-authenticated sender uid as a peer assertion, reopening the
  token-as-operator hole cross-machine; round-3 security). This is the cross-machine analogue of the
  §5.1 per-topic lock, which is explicitly **process-local** and does not serialize cross-machine
  writers. **When the pool is dark/absent or no placement record exists** (the common single-machine
  case), the local machine is the owner of record and writes proceed locally — today's behavior.
- **Cache invalidation on transfer-acquire:** the §5.1 in-memory cache is invalidated/reloaded when a
  machine **acquires** a topic. **Transfer-apply is a wholesale per-topic REPLACE** of the receiving
  machine's entry (still under the per-topic lock, still §10.2-revalidated) — NOT a field-merge
  (round-3 integration: stores are per-machine and never deleted on transfer-out, so after a round-trip
  A→B→A a merge would skip nulls and resurrect a pin the operator cleared while the topic lived on B).
  A wiring test covers the round-trip-after-clear case and asserts a transferred profile is visible to
  `resolveTopicProfile` with no restart.
- **Transcript locality is machine-bound:** after a cross-machine move, BOTH frameworks' same-machine
  resume artifacts stay behind (`~/.claude/projects` JSONL, `~/.codex/sessions` rollouts), so the
  first post-transfer respawn is CONTINUATION (recent-only) regardless of profile — same honest
  disclosure as the §7 rollout-id-absent row. (The Working-Set Handoff covers project files, not
  framework transcript stores.) **A `/local-model` binding is machine-bound the same way** (round-6
  external — §13.1 keeps `TopicLocalModelStore` adjacent and machine-local, so a transferred topic's
  local binding does NOT follow): on the receiving machine the topic simply has no local binding —
  the profile resolves normally (cloud model per §5.2 precedence), the session launches fine, and
  the effective-model change is **disclosed** ("this topic ran a local model on <machine>; here it
  runs <resolved> — move it back or re-bind to restore that"). Never a silent behavior change, never
  unlaunchable. (Q1's fold-into-profile lean would make the binding travel + revalidate like any
  field; this disclosure rule is the honest adjacent-store behavior until then.)
- **Reads name their staleness** (round-4 integration — a non-owner machine's store retains a stale
  entry after a move): `GET /topic-profile/:topicId` and the conversational readout either proxy to
  the owning machine (the `/pool/transfer` holder-proxy pattern) or answer locally with an explicit
  "owner: <machine>, possibly stale" annotation when this machine is not the owner. Single-machine
  installs unaffected. The dry-run shadow `intendedProfile` field travels on the pull verbatim
  (revalidated the same way), and the boot sweep / divergence comparisons read only the live profile,
  never the shadow.

## 6. Launch-param wiring

`buildInteractiveLaunch()` (`src/core/frameworkSessionLaunch.ts`) gains a `thinkingMode` param
alongside `model`/`resume`:

- **claude-code**: emit the extended-thinking control for the resolved level via **flag OR env
  override — whichever the live CLI actually honors** (the budget may be env-controlled, e.g.
  `MAX_THINKING_TOKENS` through `buildInteractiveLaunch`'s existing `envOverrides` channel, rather
  than a launch flag) — verified at build time AND re-verified by the living L5 canary (§11), never a
  one-time assumption (the FABLE round-1→2 rearchitecture happened because an interactive-launcher
  flag was assumed and was wrong). **Contingency (round-3 lessons):** if NO launch-time thinking
  control (flag or env) is verifiable for claude-code, its `thinkingMode` degrades to a **disclosed
  no-op** (the §4 gemini/pi rule generalized) and the §7 Claude-thinking rows are marked contingent —
  the same honest treatment as the FABLE-canary and Codex-rollout-id contingencies. §6 verification
  covers **budget-level changes across `--resume`** (low→high), not only the off↔on toggle, **and
  MODEL changes across `--resume`** (round-4 lessons — thinking blocks carry model-coupled
  signatures; resuming an Opus transcript under Fable is plausibly the same ContextWedgeSentinel
  wedge class, and a wedge is permanent). If cross-model resume proves unsafe on the live CLI, the §7
  explicit-model rows degrade to fresh respawn (recent-only, disclosed); §10.4 breaker attribution
  EXCLUDES a cross-model-resume launch failure until verified (it is the resume path's failure, not
  the profile's). The §7 thinking **level-change** row carries the same contingent cell as the
  off↔on row ("or fresh, recent-only if unverified") — no unconditional none-loss on an unverified
  path.
- **codex-cli**: `-c model_reasoning_effort=<level>` (xhigh for `max`; `off`→`low` per §4).
- **gemini-cli / pi-cli**: no-op (logged) until they ship a reasoning knob.

Model + framework already flow through this builder; this spec adds the thinking-mode arm and the
single resolution point feeding it.

## 7. The respawn classifier & swap-quality matrix (the honest core)

`classifyProfileChange(old, new, sessionState)` returns
`{ requiresRespawn, swapMethod: 'in-flight'|'resume'|'continuation'|'none', expectedLoss:
'none'|'recent-only', reason }`. `classifyProfileChange` is a **pure in-memory comparison, no I/O.**

The matrix is the honest constraint the operator asked about. Note the contingencies — they are the
round-1 honesty fixes:

**Regime scope (round-12 — the R11-1 legacy carve-out made this implicit universal false):** this
matrix and the §8/§9 orchestration behaviors it pairs with (busy-defer, global stagger,
net-unchanged zero-respawn, escalation-marker clear, resume-entry parking, the §9 mandate
disclosure) govern the framework arm **only when `enabled:true` AND `dryRun:false`**. An exempted
legacy framework switch (§5.2(d) — every `/route`/conversational switch on the shipped fleet AND
dev-agent default configs) behaves **exactly as today's shipped `/route`, including the unguarded
immediate kill of a busy session and the resume-UUID drop** — disclosed here honestly rather than
implied away; preserving that behavior byte-for-byte IS the §5.2(d) no-regression contract. The
NEW axes are never served by the legacy path, so the matrix governs them in every regime where
they write live at all.

All kill-bearing rows require **confirmed idle at kill time** — a busy session **defers until idle per
§8**, never a silent mid-work kill (the "idle (confirmed)" cell below means exactly that; the matrix
and §8's busy-abort rule agree by construction).

| Change | Same framework? | Session state | Method | Context loss |
|---|---|---|---|---|
| **modelTier** pin (Claude) | yes | idle (confirmed) | in-flight model-swap route **IFF FABLE canary passed** | **none** |
| **explicit model id** (Claude), resume UUID captured | yes | idle (confirmed; busy defers per §8) | kill + `claude --resume` | **none** (full transcript) |
| model / thinking (Claude), **resume UUID NOT captured at kill** | yes | idle (confirmed) | kill + CONTINUATION | **recent-only, disclosed** |
| modelTier pin (Claude), FABLE canary NOT passed | yes | idle (confirmed; busy defers) | kill + `claude --resume` | **none** |
| thinking (Claude), **no off↔on toggle** | yes | idle (confirmed; busy defers) | kill + `claude --resume` | **none** |
| thinking (Claude), **off↔on toggle** | yes | idle (confirmed; busy defers) | kill + `claude --resume` **(verify §6) or fresh** | **none, or recent-only if unverified** |
| model / thinking (Codex) | yes | idle (confirmed; busy defers) | kill + `codex resume <rollout-id>` **IFF rollout-id captured** | **none** |
| model / thinking (Codex), rollout-id NOT captured | yes | idle (confirmed) | kill + CONTINUATION | **recent-only** |
| framework switch, session **idle** | NO | idle (confirmed) | kill + CONTINUATION bootstrap | **recent-only** |
| framework switch, session **busy (mid-build)** | NO | busy | **refuse-or-confirm** (does NOT silently kill) | n/a until confirmed |
| net-unchanged toggle (e.g. codex→claude→codex) | — | — | none (no-op detected, within the un-fired window) | none |

**The Claude rows carry the SAME capture contingency as the Codex rows** (round-3 lessons — the
symmetric lie-class): `beforeSessionKill` persists a UUID only when the hook-reported
`claudeSessionId` exists (`TopicResumeMap.findUuidForSession` deliberately "refuses to guess"). When
no hook id was ever captured (hook never fired, broken hook host), the kill persists nothing and the
respawn is CONTINUATION — so the §8 respawn phase **verifies the resume entry exists BEFORE the
kill** and, when absent, discloses the real loss class up front (mirroring the Codex wording) instead
of promising none-loss it cannot deliver.

Why the contingencies are mandatory honesty fixes:

- **Codex resume rollout-id is NOT persisted today** (round-1 Adversarial, **critical**).
  `TopicResumeMap` + the `beforeSessionKill` listener capture **only** Claude JSONL UUIDs
  (`~/.claude/projects`). Nothing captures Codex's rollout id from `~/.codex/sessions`. So the "Codex
  resume = none-loss" row is a **lie unless a `CodexResumeMap` capture path ships first.** This spec
  makes that an **explicit prerequisite sub-task**: until the rollout-id capture lands, the Codex
  same-framework rows **degrade to CONTINUATION (recent-only) and are disclosed as such** — never
  asserted as none-loss. **Scoping (round-2 integration):** the existing `FrameworkSessionStore`
  already resolves a rollout path GIVEN a sessionId, and `codex resume <id>` launch support exists —
  so `CodexResumeMap` is scoped to the **per-topic sessionId capture-at-kill only** (the
  `TopicResumeMap` analogue), not transcript-path machinery. **The capture source is NAMED, with a
  session fence** (round-5 adversarial — Codex has no hook, and a naive newest-rollout mtime scan is
  the wrong-conversation class §8 brands worse than disclosed loss): capture is **time-fenced
  discovery scoped to the spawned session** — record the spawn timestamp + pane cwd at launch, and
  accept only a rollout file created after spawn whose cwd/metadata matches the topic's session.
  A capture that validates against the fence carries fence provenance and qualifies for the none-loss
  row; anything that fails the fence is discarded (the row degrades to recent-only, disclosed) —
  never a blind newest-file guess. **The fence is zero-or-one** (round-5 adversarial — two Codex
  topics in the same project dir spawned near-simultaneously, e.g. under the §8 stagger K=2 or a
  boot sweep, can BOTH pass the time+cwd fence, and a passing-but-wrong capture later drives a
  wrong-conversation `codex resume` — the class §8 brands worse than disclosed loss): if more than
  one rollout candidate passes the fence, **capture nothing** — the row degrades to recent-only,
  disclosed — mirroring the "provably unambiguous" discipline the Claude mtime analogue already
  carries (a single-active-codex-session-in-cwd reading is the unambiguous fast path).
  **The system doesn't manufacture its own ambiguity** (round-6 adversarial + scalability — two
  codex topics legitimately sharing a project dir, respawned by the §8 stagger K=2, a boot sweep,
  or a clear-all, would put two candidates in every fence window, permanently degrading both
  topics' swaps to recent-only despite the stagger being trivially able to prevent it): the §8
  respawn FIFO **serializes same-cwd codex spawns** so two codex sessions sharing a cwd never spawn
  inside the same fence window — **with a bounded wait** (round-7 scalability — in the common
  deployment every topic shares the agent-home cwd, so this is effectively K=1 for codex batches,
  and a wedged codex spawn that never writes its rollout would otherwise stall the whole codex FIFO):
  the next queued spawn waits for the prior fence to resolve OR a hard timeout (the §8 RESPAWN-phase
  TTL, whichever fires first); on timeout it dequeues, and any resulting multi-candidate fence
  degrades honestly per the zero-or-one rule above — the timeout prevents the stall, it never
  reintroduces a blind capture. **Ambiguity-discards are counted separately from fence-validation
  failures** — only genuine validation failures (format/location mismatch) feed the drift
  threshold below; multi-candidate discards are a distinct non-drift metric (otherwise ambient
  same-dir ambiguity fires false "codex CLI format drifted" signals or masks real drift).
  **The fence itself gets L5 drift detection** (round-5 lessons — it is the FOURTH external-state
  parser, alongside the Claude thinking flag, the Codex `model_reasoning_effort` key, and the
  capture-pane idle marker: a codex CLI change to rollout location/format would make the fence fail
  persistently, silently degrading every Codex same-framework swap to recent-only forever — the
  per-swap loss disclosure says WHAT was lost but never that the capture MECHANISM drifted):
  consecutive fence-validation failures are counted per (machine, framework); past a threshold the
  same drift signal as the §11 canaries fires — routed per the §11 maturation-track rule, never an
  attention-queue item. §11 adds the fence-drift test case. And a Codex resume is none-loss **only on the machine that
  produced the rollout file** — after a cross-machine transfer the row degrades to CONTINUATION
  (§5.3 transcript locality), disclosed the same way. (Both resume stores adopt the §5.1 read/write
  discipline — in-memory authoritative, atomic tmp+rename flush — and the schema-extension work
  brings `TopicResumeMap`'s bare `writeFileSync` up to the same standard.)
- **In-flight Claude swap is contingent on the FABLE §5.3 canary** (round-1 Lessons). FABLE's
  mid-session swap is canary-gated and "degrades to launch-time-only if no reliable independent read
  can be established." So row 1 is true only when that canary passed; otherwise it collapses to
  kill+`--resume` (still none-loss, just a brief respawn). The operator-facing disclosure must not
  promise "silent, no session death" for the idle-Claude case unconditionally.
- **The in-flight route takes a TIER, never a raw model id** (round-1 Integration). `POST
  /sessions/:name/model-swap` body is `{ tier }` only (a deliberate FABLE injection boundary). So an
  **arbitrary explicit model id** can never use the in-flight route — it falls to kill+`--resume`.
  Only a `modelTier` pin (or a model id equal to the configured default/escalated id) is eligible for
  the in-flight row.
- **Idle is a confirmed read, not a guess** (round-1 Lessons + Gemini). The idle/busy classification
  reuses FABLE §5.3's capture-pane idle-confirmation guard (prompt marker AND blank input line). An
  **unconfirmed-idle read fails toward kill+`--resume`** (the safe, lossless direction) — never an
  in-flight injection into a possibly-live input line.
- **thinking-budget change + `--resume` can hit thinking-block corruption** (round-1 Adversarial).
  Resuming a JSONL transcript while toggling extended-thinking off↔on is exactly the mid-transcript
  thinking-config change CLAUDE.md's ContextWedgeSentinel documents as unresumable (`400 thinking
  blocks … cannot be modified`). §6 verifies whether the off↔on toggle is benign on the live CLI; if
  unverified, the off↔on row uses a fresh respawn (recent-only) and discloses it.

## 8. Orchestration, coalescing & operator-facing behavior

**The single-writer per-topic lock (§5.1) is the ordering primitive — held in TWO SHORT PHASES, never
across the debounce window** (round-2 scalability: holding it across the window would stall every
inbound message on the topic for seconds-to-minutes; releasing it without re-acquiring would reopen
the race):

1. **WRITE phase** (short): `acquire topic lock → mutate(store) → arm/extend the pending-respawn
   debounce → release`.
2. **RESPAWN phase** (when the trailing-edge timer fires): `re-acquire topic lock → re-resolve the
   profile from the cache AT THIS MOMENT → re-confirm idle (below) → [kill → respawn] → release`.

An inbound message during the (long) debounce window is **NOT blocked** — it is served by the current
session or coalesces into the pending respawn; only the brief respawn execution holds the lock, and an
inbound message arriving during THAT queues (never spawns a second session).

- **Idle is a precondition re-checked at kill time, never a value carried from classification**
  (round-2 TOCTOU): any kill-bearing swapMethod re-runs the FABLE capture-pane idle-confirmation as
  the last step before the kill, inside the lock. A busy reading at that point **aborts** the respawn
  and falls to refuse-until-idle — a session that started a build between classify and kill is never
  killed mid-work. **The idle read is three-valued** (round-4): confirmed-idle / busy / unconfirmed.
  §7's "unconfirmed fails toward kill+`--resume`" chooses the swap METHOD only (never an in-flight
  injection); at kill time, **unconfirmed is treated as busy (defer)** — never as permission to kill.
  **Pane-idle is not task-done** (round-4 adversarial — a multi-hour autonomous run presents a
  confirmed-idle pane at every turn boundary, so a delayed switch would fire mid-job and drop the
  run's working state): kill-bearing delayed swaps also consult the autonomous-session registry /
  session clock — **an active autonomous/time-boxed session is busy until it completes**, regardless
  of pane state; only the explicit "switch now" confirm overrides. §11 covers the
  idle-pane-but-active-run defer.
  **Protected sessions are never profile-killed** (round-4 lessons — `SessionRefresh.killSession` has
  no protected check of its own, and the debounce/boot-sweep paths fire autonomously long after the
  operator's turn): kill-bearing respawns check the protected-session list at kill time (same slot as
  the idle re-confirmation, inside the lock); a protected session defers, audited. The in-flight
  (no-kill) row also defers on a protected session, mirroring FABLE's refusal. **"switch now" NEVER
  overrides protection** (round-5 adversarial — it overrides busy/autonomous defer only;
  protection is a different authority): the protected-defer wording says so honestly — "this
  session is protected — unprotect it first, or the switch applies at the next natural restart" —
  and never offers a "switch now" that would silently not fire.
  **The escalation marker is session-scoped** (round-5 adversarial — a stale marker would make
  expected-live permanently wrong and strand the ultra lease): any profile-triggered kill — and the
  boot sweep, for a marker whose session no longer exists — **clears the topic's escalation marker
  and releases its lease BEFORE computing expected-live**. §11's boot-sweep test covers the
  stale-marker case.
  **Idle-confirmation drift gets its own signal** (round-5 lessons — the third external-state parser;
  a Claude UI update changing the prompt marker would make every read "unconfirmed" forever, deferring
  every swap with zero drift signal since defers never fail loudly): consecutive-unconfirmed idle
  reads per pending swap are counted; past a threshold the same drift signal as the §11 canaries
  fires — routed per §11's maturation-track rule (silent metric + audit breadcrumb, never an
  attention-queue item) — signal-only, never changing the defer decision. (Inherited FABLE gap —
  the fix lands at the shared guard.)
  **Lock hold-time is bounded** (round-4 scalability — a wedged CLI/tmux spawn would otherwise hold
  the per-topic lock forever and stall every subsequent write): the RESPAWN phase carries a TTL —
  if kill+spawn hasn't completed within it, the phase aborts, releases the lock, and leaves the
  divergence to the periodic/boot reconcile sweep (the existing backstop). WRITE-phase lock
  acquisition times out rather than queueing unboundedly behind a wedged respawn.
  **Re-resolution happens at DEQUEUE time** (round-4 — the global stagger inserts a FIFO queue
  between timer-fire and execution): re-resolution + idle re-confirm + net-unchanged skip all run at
  dequeue inside the lock, never at enqueue, so a toggle-back landing while a respawn waits in the
  queue is honored.
- **Kill-path precision** (round-2 adversarial — the two kill primitives fire `beforeSessionKill`
  differently, and v2 wired the suppression to the wrong one): a **same-framework resume respawn**
  kills via `SessionManager.killSession` (fires `beforeSessionKill` → the resume re-save is *wanted*).
  A **fresh respawn** (framework switch, unverified thinking-toggle) must (a) **remove BOTH resume
  stores' entries** — the Claude `TopicResumeMap` AND the new `CodexResumeMap` — **before the kill**,
  and (b) either kill via the direct tmux path (no event) or populate the suppression set
  (`contextExhaustionKills` pattern) before `killSession`, so NEITHER store's save-on-kill listener
  can re-persist a stale id during the kill. The suppression is **symmetric**: a stale Claude UUID
  must not poison the next Codex launch AND a stale Codex rollout-id must not poison a later switch
  back to Codex. **"Remove" means PARK, not delete** (round-5 adversarial — deletion destroys the
  only cheap recovery for the exact failure the breaker handles): both entries are marked
  `parked: mid-framework-switch` (ignored by resolution exactly like a mismatched tag) rather than
  hard-deleted; the §10.4 breaker revert **un-parks and resumes the matching-framework entry**,
  making the revert none-loss when the transcript survives (codex pin fails N times → revert to
  claude → the untouched Claude JSONL is resumed, not CONTINUATION'd). Hard deletion remains only for
  untagged legacy entries. **Parking — and therefore every un-park consumer (§10.3 undo, the §10.4
  revert's none-loss characterization) — exists only where this orchestration serves the switch**
  (`enabled:true AND dryRun:false`; round-12 adversarial): a legacy-served switch (§5.2(d), §7
  regime scope) DROPS the resume UUID exactly as today's `/route` does, so an undo or breaker
  revert following a legacy switch has nothing to un-park and recovers via CONTINUATION —
  **recent-context loss, disclosed in the §10.3 undo reply and the revert notice** ("fresh thread —
  the old conversation can't be resumed across that switch"). This re-opens nothing R5-7 closed —
  R5-7's none-loss guarantee was always a property of the new orchestration's parking; the legacy
  path never had it, and pretending otherwise would be the overclaim.
  **mtime-provenance entries are (almost) never resumed** (round-5 adversarial — the loss LABEL is
  not the BEHAVIOR): profile-triggered respawns pass only hook-provenance ids to `--resume`, with ONE
  exception — an entry written under the existing single-active-session guard (provably unambiguous;
  production resumes on it today), which resumes with the standard disclosure. Any other
  mtime-provenance entry falls to CONTINUATION and is never passed to `--resume` (a wrong-conversation
  resume is worse than disclosed loss).
- **ALL resume-map writers are enumerated and framework-gated** (round-3 adversarial — the kill
  listener is not the only writer; the 60s heartbeat alone would re-poison the map within a minute of
  a switch): the resume state has at least four writers — the `beforeSessionKill` listener, the **60s
  resume heartbeat** (`refreshResumeMappings`), the **8s post-spawn proactive save**, and the
  shutdown/refresh-route saves. Three structural rules close them all at once: (a) **resume entries
  are framework-tagged AND provenance-tagged** (`hook` | `mtime-fallback`), (b) every writer is
  **profile-gated** — the heartbeat's single-session mtime fallback MUST NOT write a Claude JSONL
  UUID for a topic whose resolved profile framework is not claude-code, and (c) **the spawn path
  REFUSES a resume id whose framework tag mismatches the resolved framework**, falling to
  CONTINUATION with disclosure — the last-line guard that holds even if a writer slips. Without
  these, the poisoning chain is: heartbeat re-writes the old Claude UUID → `codex resume
  <claude-uuid>` fails at launch → repeated failures trip the §10.4 breaker → the system reverts the
  operator's VALID codex pin while blaming the profile. §11's wiring test fires a heartbeat tick (and
  the 8s save) **between the kill and the assertion**, both directions.
  **Provenance gates the none-loss claim** (round-4 lessons): the heartbeat's mtime fallback can
  capture a non-topic Claude process's JSONL sharing the project dir — a same-framework
  wrong-CONVERSATION resume, worse than disclosed loss. The §7 none-loss rows require **hook
  provenance**; an mtime-fallback-only entry classifies as CONTINUATION-class loss (or triggers a
  fresh capture attempt) and is disclosed. The §7 pre-kill predicate is correspondingly **"the live
  session has a hook-reported `claudeSessionId` (or an existing hook-provenance entry)"** — not
  merely "an entry exists" (the none-loss entry is written AT the kill from the hook id; pre-kill the
  map may hold only a heartbeat entry).
  **Untagged legacy entries are grandfathered as `claude-code` + `hook`** (round-4 adversarial — on
  upgrade day every existing entry is untagged; refuse-on-untagged would inflict a one-time
  fleet-wide CONTINUATION loss, while blanket-accept reopens the poisoning window): provably safe —
  `TopicResumeMap` has only ever captured Claude JSONL UUIDs. Entries are tagged lazily on next
  write. §11 migration tests: untagged + claude-pinned topic resumes none-loss; untagged +
  codex-switched topic refuses to CONTINUATION with disclosure.
- **External kill/respawn initiators do not corrupt the sequence** (round-3 adversarial — watchdogs,
  sentinels, context-wall recovery, subscription-pool swaps, the reaper, and `/sessions/refresh` all
  kill/respawn outside the profile lock): (a) the **last-applied-profile marker is set at EVERY spawn**
  (natural, sentinel, or profile-triggered), and the RESPAWN phase — inside the lock — **re-verifies
  the topic's CURRENT live session and skips entirely when its launch characteristics already match
  the resolved profile** (an externally-respawned session that already picked up the new profile is
  never killed a second time); (b) the resume-save suppression is a **topic-scoped, time-bounded
  durable marker** ("topic N is mid-framework-switch — no resume saves"), not a flag keyed to one kill
  invocation, so an external kill inside the window cannot re-persist a stale id; (c) if the target
  session is **gone or replaced** when the respawn phase fires, the phase aborts spawn-only and relies
  on the next natural spawn to reconcile (the boot-sweep below is the backstop).
- **Boot-time reconcile sweep** (round-3 adversarial — the pending slot is process-local; tmux
  sessions and the store survive a server restart mid-debounce): at server boot, each live
  topic-bound session's last-applied profile is compared against the store; divergence arms the
  normal debounced, idle-gated respawn (or defers to next natural spawn) with the same disclosure as
  the rate-trip path. §11 tests: write a pin, kill the server before the timer fires, reboot, assert
  the divergence is detected and reconciled.
- **Busy-abort re-arms — "apply at idle" has a real carrier** (round-3 adversarial — an unbacked
  promise is not a mechanism): a busy-abort re-arms the pending slot, and the idle re-check
  **piggybacks an existing periodic tick** (the reaper/watchdog cadence — no per-topic pollers, no
  new subprocess churn). If the server restarts while a delayed switch pends, the boot sweep above
  picks it up. The operator promise is worded to match the mechanism: "I'll apply it when this task
  finishes (checked periodically) or at the next session restart, whichever comes first."
- **"switch now" is governed** (round-3 adversarial): the confirm is a **first-party bound-operator
  turn**, valid only for the **specific pending change that armed it**, expiring on a short TTL or
  when the pending slot is torn down. A "switch now" with no armed pending switch is a no-op with a
  plain reply. Quoted/forwarded content can never arm or fire it. **The confirm is recognized by the
  same server-side ingress parse as §10.1 conversational writes** (round-4 — it authorizes the
  destructive kill, so it must not be agent-mediated), matched against the armed pending slot by the
  authenticated sender uid.
- **EVERY accepted write discloses, regardless of origin or respawn-need** (round-4 security — the
  disclosure IS the detection loop, and a token-trust HTTP write to a dormant topic or a
  respawn-free field flip like `escalationOverride` would otherwise leave no operator-visible trace):
  every accepted profile write posts the one-line disclosure to the topic's owning platform
  conversation via the platform adapter — with the origin named for token-trust writes ("profile
  changed via API: …"). §11 asserts an HTTP write to a session-less topic produces the notice.
  **Transfer-apply's exemption is delta-gated, not blanket** (round-5 security — "re-applies an
  already-disclosed profile" holds only for an honest peer): transfer-apply stays silent only when
  the arriving profile equals the receiving machine's prior entry (or matches what resolution would
  already produce); when it CHANGES the topic's effective resolved profile, the standard disclosure
  fires with the origin named ("profile arrived with this topic from <machine>: …").
  **Batch-origin disclosures aggregate** (round-5 scalability — the per-write rule must not become
  the next notification flood): writes sharing one batch cause (a clear-all invocation, one boot
  sweep, one enum-shrink event, one mass-acquire) collapse into a single summary disclosure carrying
  the count + topic list; per-topic disclosure is for individually-initiated writes. Disclosure sends
  include the audit sequence/timestamp in the rendered text (and set the duplicate-suppression
  bypass) so the relay's exact-duplicate window can never silently swallow a repeat notice.
  **Per-write disclosures are themselves rate-bounded** (round-6 security — writes have no rate
  bound (only respawns are debounced) and the dedup bypass makes each disclosure suppression-proof,
  so a flapping automation or any Bearer-token holder hammering valid alternating payloads becomes
  an unbounded, dedup-proof message flood — the Bounded-Notification class through a door the
  topic-creation budget doesn't guard): writes to the same topic landing **within the active
  debounce window coalesce into ONE disclosure** carrying the change count + the final resolved
  profile (the detection loop is preserved — the operator still sees every effective change), and a
  per-topic disclosure rate cap backstops outside the window, overflow summarized — **and the
  overflow summary is itself a delta-carrying disclosure** (round-9 adversarial — a delta-free
  summary plus per-write undo shifting outside a coalescing window would let an undisclosed
  intermediate become the undo target, the R7-4 hole one door over): the summary carries the same
  "was: <last-disclosed> → now: <final> (N changes, origins named)" form, and **a rate-cap overflow
  period is treated as a disclosed burst for the undo shift** (`previous` captured at the first
  write of the overflow period) — the §8 invariant "undo always restores the profile the operator
  last saw disclosed" holds in BOTH regimes; §11's undo test gains the overflow arm. This mirrors
  the §5.2 once-per-transition fallback-notice discipline. **A coalesced disclosure carries the delta, and
  the undo snapshot shifts once per disclosed burst** (round-7 adversarial — endpoint-only
  disclosure hides an intermediate write inside the burst, and per-write `previous` shifting makes
  that unseen intermediate the undo target, so "that wasn't me — undo" would restore an
  attacker-chosen profile): the coalesced notice reads "was: <pre-burst> → now: <final> (N changes,
  origins named)", and `previous` is captured at the FIRST write of the window — undo always
  restores the profile the operator last saw disclosed.
  **WRITE-phase lock timeout is a spoken refusal, never a silent drop**: "couldn't apply — this
  topic's session is mid-restart; say it again in a minute", audited `outcome:'refused'
  reason:'lock-timeout'`. A net-unchanged teardown also closes its loop out loud ("you're back where
  you started — no restart needed").
- **Inbound-message choke point is named** (round-3 scalability — "queues" needs a mechanism): the
  topic-message dispatch in `server.ts` **consults the pending-respawn slot / per-topic lock before
  its spawn-or-forward decision** (today a message arriving between kill and re-register calls
  `spawnSessionForTopic` directly — the duplicate-spawn race entered through a different door). A
  message arriving during the brief locked respawn rides the spawning session's
  CONTINUATION/bootstrap delivery; the queue is bounded by the existing per-topic delivery path.
- **Global respawn stagger** (round-3 scalability — everything else is per-topic; a knownModelIds
  shrink, an admin clear-all, or a transfer batch herds N cold kill+spawns): profile-triggered
  respawns share a **global concurrency cap (max K in flight; others queue FIFO)**, reusing the
  `/sessions/restart-all` stagger pattern. The admin clear-all path is explicitly staggered.
- **Default debounce magnitudes** (round-3, tuning + disclosure precision): same-framework arm
  ~5–10s; framework-switch arm ~30–60s (config-tunable, §12.5). The write-time confirmation to the
  operator fires immediately ("pinned — applying in ~Ns"), so a long window never reads as a dropped
  command.
- **The debounce terminal reconciles the LIVE session, not the store** (round-2 adversarial): an
  intermediate in-flight swap may already have moved the live session (e.g. tier=escalated applied
  in-flight, then tier=default written within the window). The timer's action compares
  **last-applied-to-live vs the final resolved profile** (FABLE's last-applied-tier marker pattern) —
  a "store already equals resolved" check is NOT sufficient to skip reconciliation. The **in-flight
  swap path is itself debounced/coalesced and rate-bounded** under the same per-topic lock (it is a
  live-session mutation, not free): repeated tier toggles within the window collapse to ONE `/model`
  injection against the final tier.
- **Slot teardown:** the pending slot + timer are cleared when the debounced respawn fires AND when a
  net-unchanged sequence is detected (timer cancelled, nothing fires). Net-unchanged detection only
  suppresses respawns for toggles **within the un-fired window** — once a respawn has committed, a
  later return to the original profile is a new change with its own cost, not a free undo.

- **Real coalescing mechanism** (round-1 Scalability — the cited `SessionRefresh` rate guard
  *rejects*, it does not coalesce): a **per-topic pending-profile slot + a trailing-edge debounce
  timer**. The store write is immediate (cheap, idempotent via `mutate`); only the **respawn** is
  debounced. N changes within the window collapse to **one** respawn against the final resolved
  profile. A **net-unchanged** sequence (codex→claude→codex) is detected and fires **zero** respawns.
  The **framework-switch arm carries a heavier debounce / lower rate budget** than cheap same-framework
  swaps, because it is the cold-rebuild path (kill + CONTINUATION + dropped resume UUID). The
  `SessionRefresh` 5/10-min guard is the **backstop**, not the coalescer.
- **Rate-guard-trip behavior is explicit** (round-1 Security): if the backstop trips, the **pin
  persists** but the **respawn is postponed to the next natural session start** (store and live session
  reconciled on next spawn) and the operator is told — never a silent store-vs-session divergence.
- **In-flight swap** (Claude modelTier, confirmed-idle, canary passed): call the model-swap route; no
  session death.
- **Resume respawn** (same-framework model/thinking): `SessionRefresh` (which already has the inFlight
  guard) → kill → respawn with `--resume`. On any **fresh** respawn (framework switch, or the
  unverified-thinking-toggle case), the path **suppresses the `beforeSessionKill` resume re-save**
  (reusing the existing `contextExhaustionKills` kill-tracking pattern) so a stale Claude UUID cannot
  be re-persisted and then poison the next (e.g. Codex) launch.
- **Continuation respawn** (framework switch, idle): kill → fresh spawn with the CONTINUATION
  bootstrap. ONE honest line (authored as plain conversational text, NOT a key:value dump):
  > "Switching this topic to Codex. The full transcript can't follow across frameworks, so I'm
  > carrying recent history + memory — continuing from there."
- **Busy framework switch** (round-1 Adversarial, the destructive case): a framework switch while the
  session is mid-build would kill in-progress, uncommitted work — CONTINUATION carries none of it.
  Consistent with FABLE's non-idle model-swap refusal, the switch is **refused while busy** with:
  > "This topic is mid-task right now — switching frameworks would interrupt the running build and
  > lose its in-flight work. I'll apply the switch the moment it goes idle, or say 'switch now' to
  > interrupt."
  The switch then applies on the next idle boundary (or on explicit confirm).
- **Dry-run** (round-1 Adversarial; rescoped round-12 after the R11-1 legacy carve-out): the
  `[dry-run] would switch …` operator notice scopes to **shadowed NEW-axis writes only** — there,
  the real "Switching…" notice is never sent because no switch occurred. An exempted framework
  switch under dry-run IS served live (by the legacy path, §5.2(d)), so the operator receives the
  real legacy reply and ONLY that reply: **the §8 shadow's would-be decisions are
  audit/maturation-log-only, never operator-facing** — no `[dry-run]` message ever rides alongside
  a real switch (no double notice), and **the legacy reply is the disclosure-of-record for an
  exempted write** (it is the delta-carrying disclosure that anchors §5.1's undo-snapshot cadence —
  "no §8 machinery engaged" in §11 means the orchestration, not the disclosure accounting).
  **Disclosure-of-record duties attach to the legacy reply** (round-13 adversarial — a reply that
  is the record cannot be exempt from the record's rules): the legacy reply gains the audit
  sequence stamp + relay duplicate-suppression bypass every disclosure-of-record carries (R6-2 —
  otherwise an A→B→A flip within the dedup window has its third disclosure silently swallowed
  while `previous` shifts on it, breaking the undo invariant and blinding the R3-34 detection
  loop), and names a parked-pin supersession when the exempted write triggers one (R10-3).
  **"Byte-for-byte today's shipped behavior" scopes to BEHAVIOR** — the kill/respawn/store/timing
  semantics — never to reply bytes; R12-3 already adds loss-naming text to legacy-adjacent
  replies, and this is the same class of additive disclosure content.

## 9. Composition with Model-Tier Escalation (two layers, not a winner-take-all)

**Operator correction (Justin, 2026-06-10):** a topic profile does NOT change the "use Fable 5 / the
ultra model for spec design and heavy work" mandate — that mandate stays in force **unless the operator
specifically requests a different model for those heavy-work processes.** So composition is two layers,
not a winner-take-all:

- **Layer 1 — the topic BASELINE** (`model`/`modelTier`): the model normal conversational turns use.
- **Layer 2 — the heavy-work escalation mandate** (spec-design / build / long-autonomous → ultra),
  governed by tier-escalation. This is the org/work-mode default and it **keeps firing even on a topic
  with a baseline pin**, by default.

`escalationOverride` (default `'inherit'`) reconciles them:

- **`inherit` (default):** the baseline pin sets the topic's normal-turn model, AND heavy-work modes
  still escalate to the ultra model per the mandate. Pinning Opus as a topic's baseline does NOT stop a
  spec-converge or a build in that topic from running on Fable. (This is the operator's stated intent.)
- **`suppress`:** the baseline pin is authoritative even for heavy work — set ONLY when the operator
  **explicitly** asks for it ("use Opus even for heavy work here" / "don't escalate this topic"). The
  conversational write path sets `suppress` only on that explicit instruction, never as a side effect
  of a baseline pin. **To keep the path honestly Tier 0 (P7):** `suppress` requires an unambiguous
  explicit instruction; **any ambiguity defaults to `inherit`** (the safe direction — it preserves the
  mandate). The agent confirms a `suppress` back to the operator in plain words when setting it. No
  fuzzy intent-classification step decides to weaken the escalation mandate.

**Ultra-baseline accounting** (round-2 adversarial): when the baseline pin and the mandate resolve to
the SAME ultra id (operator pins Fable as a topic's baseline under `inherit`), cost accounting does not
fall in the gap between the layers — per §10.2's invariant, **any session on the ultra model is subject
to the FABLE cost guards and counts against the ultra budgets/lease, regardless of which layer put it
there.** A baseline pin is never a side door around `dailyUltraTokenCap` or the concurrency lease.

Wiring (round-3 lessons correction — the consult lives on the AUTHORITY side, not in the hook):

- **The pin consult runs SERVER-SIDE**: the **model-swap endpoint** and the **launch-time escalation
  resolver** consult `resolveTopicProfile(topicId)` (in-memory, O(1)) before performing any swap or
  escalated launch. The FABLE **hook keeps its pure-filesystem signal job unchanged** — FABLE's §5.3/§6
  contract forbids HTTP or re-parsing state files in the hook fast path, and a hook process cannot read
  the server's in-memory cache; putting the consult in the hook would force a builder to break one
  contract or the other. They short-circuit to the baseline pin ONLY when
  `escalationOverride === 'suppress'`; when `inherit`, heavy-work modes escalate as normal even though
  a baseline pin exists.
- **De-escalation lands on the TOPIC's baseline, never the global default** (round-4 adversarial —
  otherwise the swap-back silently drops the operator's pin): for a pinned topic, the tier resolver
  consulted by the model-swap endpoint and the launch resolver is **topic-aware** — `tier:'default'`
  resolves to that topic's pinned baseline (`model`/`modelTier`), falling to the global default only
  when no pin exists. §11 wiring test: pinned topic escalates for heavy work, then de-escalates back
  to the **pinned** baseline.
- **The mandate is framework-scoped — and a framework pin discloses that** (round-3 adversarial):
  tier-escalation only has an escalated model configured for claude-code today, so pinning a topic to
  codex-cli makes the heavy-work ultra mandate a structural no-op for that topic — an implicit
  suppress the operator didn't ask for. The framework-pin confirmation says so out loud ("heads up:
  heavy work in this topic won't auto-escalate to Fable while it's on Codex"), the readout is
  framework-aware (never claims "still uses Fable for spec/build work" on a codex topic), and if a
  codex escalated model is configured later, the mandate re-activates automatically.
- Both the pin write and any tier-escalation model application go through the **same per-topic
  single-writer lock + `mutate`** (§5.1), so neither clobbers the other.
- A **wiring-integrity test (§11)** asserts BOTH directions: an `inherit` pinned topic IS still
  escalated for heavy work; a `suppress` pinned topic is NEVER escalated.
- `thinkingMode`/`framework` pins are orthogonal to the tier decision, except that an escalation model
  swap on respawn must respect a pinned `thinkingMode`.
- The conversational readout discloses the state plainly: `inherit` → "this topic runs on Opus normally
  but still uses Fable for spec/build work"; `suppress` → "this topic is pinned to Opus for everything,
  including heavy work — auto-escalation is off for it."

## 10. Security, identity, validation, cost

### 10.1 Operator identity on ALL THREE write surfaces (the central round-1 fix)

`updatedBy` is a **verified operator principal stamped server-side**, never taken from message content
or a request body. Wired per surface:

- **Conversational** (PRIMARY) — **the parse runs SERVER-SIDE in the message-ingress pipeline**
  (round-3 security: the uid must never transit agent-authored content). The ingress layer
  (`handleCommand`/bridge, where `telegramUserId` is first-party) recognizes the profile intent and
  initiates the write itself, so the authenticated sender uid reaches the store through code, not
  through a body the agent composed (an agent-composed uid is fabricable by a prompt-injected agent —
  exactly the actor this gate exists for). The store **refuses the write unless that uid is the
  topic's bound operator** (`GET /topic-operator/:topicId`). Mirroring FABLE §5.4, the triggering
  intent derives from **first-party operator turn text only — never inbound peer/file/web content**.
  **Honest scope (round-3 lessons):** the first-party-only rule at the agent layer is a behavioral
  discipline, not a structural closure — the structural protections are (a) the server-side ingress
  parse above, (b) the **mandatory §8 disclosure notice, which IS the detection loop** (the bound
  operator always sees a switch they didn't ask for, in the same conversation), (c) the audit trail,
  and (d) a cheap revert ("that wasn't me — undo" restores the §10.4 last-known-good profile through
  the same operator-gated path). Injected-content-via-the-operator's-own-agent is
  **mitigated-and-detected, not closed** — stated so a future reader doesn't treat it as a solved
  property.
  **Out-of-grammar phrasings: propose-then-confirm** (round-4 lessons — a deterministic ingress
  grammar is closed by design, but the PRIMARY surface must handle ANY phrasing, "make this topic
  think harder", without bifurcating into canned-phrase writes vs an unattributed token-trust lane):
  when the agent recognizes a profile intent the ingress grammar didn't match, it **proposes the
  parsed change, and the operator's confirming FIRST-PARTY turn ("yes, do it") is what the ingress
  recognizes and converts to the operator-attributed write** — the §8 "switch now" pattern
  (change-scoped, TTL'd, first-party-only). **The proposal plumbing is pinned down** (round-5 —
  otherwise this is the one lane where an agent-composed payload gains operator attribution): (a) the
  pending structured delta is registered in an **internal server-side slot keyed to the topic**
  (never via the token-trust HTTP route), audited as agent-composed at arm time; (b) **the confirm
  prompt the operator sees is RENDERED BY THE SERVER from the registered structured delta** — never
  the agent's prose — so what the operator confirms is mechanically what will be written (an agent
  proposing "high thinking" in prose while registering a framework flip is exposed by the echo).
  **A mixed delta spanning the exempted and gated arms is SPLIT at propose time, with the split
  named in the server-rendered echo** (round-12 adversarial — "use codex here with high thinking"
  on an agent where the new axes are off/shadowed had two textually-supported readings, and a
  half-applied delta after an un-split echo would violate this very guarantee): the echo states
  each arm's fate before the confirm — e.g. "framework → codex: switches now (live); thinking →
  high: refused, the thinking control isn't enabled on this agent" (or "recorded as a dry-run
  intent" under `dryRun:true`) — and the confirm applies exactly that named split, each arm
  audited under its own regime. The operator never confirms an outcome the echo didn't state;
  (c) a re-proposal supersedes the prior armed one, so a "yes" can never fire a payload other than
  the most recently echoed — **and supersession invalidates any in-flight confirm** (round-6
  security + adversarial, the confirm-time TOCTOU: a prompt-injected agent could re-propose a
  different delta in the gap between the operator reading echo A and their "yes" arriving, so the
  stale "yes" would authorize an unseen payload): a confirm is accepted **only if its platform
  timestamp postdates the delivery of the latest registered proposal's echo**; a confirm answering
  a superseded echo is refused with a fresh echo re-issued ("I re-proposed — please confirm the new
  version"), and a re-proposal resets the TTL (the confirm must answer the latest echo). **The
  ordering is event-based on platform message ids, never a cross-clock timestamp compare** (round-7
  security + adversarial — comparing a platform-asserted confirm time against a locally-recorded
  delivery time is the same skew class §5.3 demoted, and Telegram's 1s granularity makes same-second
  ties ambiguous): the confirm must carry a platform message id greater than the latest echo's
  platform-returned id in the same conversation (Telegram ids are monotonic per chat; Slack `ts` is
  the analogue), ties refused toward re-echo; where the platform supports it, a reply-to/quote of
  the echo binds mechanically. **Re-proposals are rate-bounded per topic and churn is audited as a
  suspicion signal** (round-7 adversarial — delivery-postdating proves the echo was SENT, not READ;
  rapid supersession guarantees any "yes" postdates the latest echo by construction, and has no
  honest use): past the bound, the slot refuses further re-proposals for a cooldown and the armed
  proposal is torn down — the operator re-states their intent fresh;
  (d) the accepted write's audit carries `origin:'propose-confirm'` with
  payload provenance flagged agent-composed; (e) **the pending-proposal slot carries a TTL**
  (round-5 external — ephemeral state without a lifecycle invites a confirm landing long after the
  proposal left the operator's mind): it reuses `switchNowConfirmTtlMs` (§12.5); a confirm arriving
  after expiry is refused plainly ("that proposal has expired — say what you want again"). The ingress grammar's scope is the closed trigger set +
  the confirm; no fuzzy matcher ever holds write authority, and the Tier 0 claim (§14) holds because
  the authorizing parse is the deterministic confirm against a **server-echoed** delta.
  **Forwarded content never matches ANY ingress recognition** (round-5 — a FORWARDED message arrives
  with msg.from = the operator while the text is third-party): a message carrying platform forward
  metadata (`forward_origin`/`forward_from`/`forward_date`; Slack analogue) never matches the trigger
  grammar, the propose-confirm, or the switch-now confirm, regardless of sender — the same
  deterministic rejection the prompt-gate reply interceptor already applies. §11 tests the
  forwarded-trigger-refused case.
  **Pooled deployments: the ingress parse runs on the topic's OWNING machine** (round-5 integration —
  owner-gated writes and a dispatcher-side parse would otherwise refuse the PRIMARY surface on
  exactly the multi-machine agents this ships enabled on): in the session pool, inbound platform
  messages are delivered to the machine that runs the topic's session — the owner — over the pool's
  existing Ed25519 machine-auth ingress, which carries ALL operator turns and is not a new assertion
  surface. The parse + write therefore execute on the owner; no cross-machine write-forwarding is
  reintroduced. §11 tests a conversational pin on a topic owned by a non-dispatcher machine.
- **`/route` gets the same wiring** (round-4 security — the §5.2(d) exemption makes `/route` live
  fleet-wide while the feature is dark, so its auth model can't stay unspecified): `/route` framework
  writes get the **same forward-the-authenticated-sender + bound-operator check** as `/topic`, with
  the same first-message auto-bind fast path — single-operator installs see no behavior change.
  **Honest scope of the bound-operator check on the live target** (round-7 integration — verified
  on `JKHeadley/main`: BOTH ingress paths re-bind ANY `isAuthorizedSender` as the topic operator on
  EVERY inbound message, last-authorized-sender-wins — so an allowlisted sender's own `/route`
  message seats them as operator at ingress before the write authorization runs): for allowlisted
  senders the check's value is **attribution + audit + the §8 disclosure loop**, not a second
  authorization tier; the refusal tier bites against **unauthorized/unbindable senders and
  token-trust writes to unbound topics**. The earlier "a non-bound allowlisted user who could
  `/route` yesterday is refused tomorrow" claim is corrected accordingly (it cannot fire under
  last-sender-wins binding), and the upgrade note says what is true: allowlisted users' framework
  flips become attributed, audited, and disclosed — the self-DoS *thrash* bound comes from §8's
  debounce/rate machinery, while the *authorization* closure applies to non-allowlisted actors. (A
  binding-stability rule — authorize against the binding as it stood before the triggering message —
  would change shared Know-Your-Principal infrastructure and is explicitly NOT proposed here.) §11
  tests the satisfiable boundary: an unauthorized sender is refused; an authorized sender's write
  succeeds with the re-bind + attribution asserted in the audit.
- **`/topic` slash command**: the handler **forwards the authenticated sender uid** (`msg.from.id`,
  which `handleCommand` already has) down to the write — the existing `/route` dispatch drops it, so
  this is a required wiring change, not an inherited capability. The store stamps `updatedBy` from it
  and **refuses a non-bound-operator**. Explicitly: the existing `isAuthorized` allowlist is **NOT an
  operator check** (an empty allowlist returns true for everyone) — profile writes must additionally
  pass the **bound-operator** check.
- **HTTP route** (`POST /topic-profile/:topicId`): authenticated by **Bearer + `X-Instar-Request`**
  (matching sibling mutating routes), and **honestly demoted** (round-3 security — round-2's
  "stamp-from-bound-operator" was the token-as-operator escape renamed: any shared-token holder could
  write any bound topic's profile with the audit falsely attributing it to the operator): an HTTP write
  is recorded as **token-trust, never operator-attributed** — `updatedBy: 'api-token'`,
  `origin: 'http'` in the audit. It still refuses writes to topics with no bound operator, and a
  body-supplied `updatedBy` is ignored. **Operator-attributed writes happen only on the two
  platform-authenticated surfaces**; §10.3's self-DoS-closure claim is scoped accordingly (the HTTP
  surface is token-trust by construction — anything holding the shared token is already
  operator-equivalent for this server's API, and the audit now says so instead of laundering it).
- **First message on a fresh topic** (round-2 adversarial, clamped round-3): operator auto-bind from
  the authenticated sender completes **BEFORE** the profile-write authorization check on that same
  message — the first "use codex here" on a new topic binds and succeeds. **Trust floor:** the
  auto-bind-then-write fast path requires the sender to pass the platform trust floor (owner or
  explicit allowlist member). On an install with an **empty allowlist** (where `isAuthorized` returns
  true for everyone), the auto-bind-coupled write is **flagged `autoBound:true` in the audit** so a
  hostile fresh-topic binding is visible — and the spec states plainly that empty-allowlist installs
  accept that any reachable user gains per-topic profile authority (that is the allowlist's existing
  trust model, now named rather than implied). When no operator can be derived, the refusal text says
  so plainly. §11 adds the first-message-binds-and-succeeds test.

### 10.2 Field validation (EVERY field closed-enum clamped, before persist)

**Every profile field is clamped to its closed enum server-side BEFORE persist and before it can reach
a launch arg** — not just the model arm:

- `model`: **FABLE §5.1's `resolveModel` / closed `knownModelIds` enumeration + the
  `^[A-Za-z0-9._-]{1,64}$` regex**, refused with a named reason (profile unchanged) if not a member of
  the framework adapter's known set. The free-form string is **never** passed to a launch arg or
  send-keys without passing that closed enumeration — the pin write is a NEW untrusted entry point
  FABLE's config-sourced resolver did not cover. A `model` incompatible with the `framework` is refused.
- `thinkingMode` ∈ {off, low, medium, high, max} — it becomes a launch arg
  (`-c model_reasoning_effort=…`), so it is an injection surface symmetric to the model one.
- `escalationOverride` ∈ {inherit, suppress}; `framework` ∈ the supported framework set.
- §11's closed-enum unit tests cover the reject cases (newline, shell metachar, off-enum, >64 chars)
  for **all** fields, not only `model`.

**The clamp runs at the RESOLUTION boundary for every source** (round-4 security) — store pin,
config default (§12.5 `defaults`), and transferred entry — not only at store-write time. An off-enum
config-default value falls to the next precedence layer with the same once-per-transition disclosure
as §5.2's other fallbacks (config never persists through the store, so a write-time-only clamp would
leave it a named hole). §11 covers the config-sourced off-enum case.

**Read-time re-validation:** `resolveTopicProfile` re-validates a persisted model pin against the
**current** `knownModelIds` at spawn time (the enum can shrink after write — an account losing a model,
a FABLE update); a no-longer-member id falls back to the config/global default with a one-line notice.
The write-time check alone leaves a stale-id window; this is the read-side analogue of the §11 L5
canary. (Build-target symbol names: `resolveModelForFramework` in `frameworkSessionLaunch.ts`;
`knownModelIds` lives in `ModelTierEscalation.ts`.)

**Billing lane for explicit-model pins** (round-2 security): `knownModelIds` membership proves the id
is *recognized*, not that it is inside the subscription envelope. An explicit-model baseline pin is
resolved **through the same FABLE §7 launch/resume path and §8 cost guards as a tier pin** — the cost
gate, capped-account fall-back-to-default, and per-account concurrency lease run for `model` pins, not
only `modelTier` pins. A model id whose lane would be **per-token is refused at validation** (not just
enum-checked). **Ultra-model cost accounting is attributed wherever the ultra model runs:** a topic
baseline-pinned to the escalated id (e.g. Fable as baseline) is **itself subject to the FABLE cost
guards and counts against the ultra budgets/lease** — any session on the ultra model is accounted,
regardless of which layer put it there. This closes the round-2 adversarial case where an
ultra-baseline pin would run unbounded ultra spend outside every escalation guard; §11 adds the
wiring test (ultra-baseline-pinned topic still counts against `dailyUltraTokenCap`).

### 10.3 Signal not authority + cost

- Every component degrades to "keep current characteristics." No block (except §10.4's revert).
- Framework/model pins can move the billing lane; the pin path reuses the tier-escalation **cost gate
  + subscription-path envelope** (FABLE §7) — a pin can never introduce a per-token API path;
  `launchLane` in `GET /sessions` reflects the lane used.
- **Every respawn-triggering profile write is audited** (principal, topicId, old→new profile,
  swapMethod) to `logs/topic-profile-changes.jsonl` — matching FABLE's per-swap audit, and the
  evidence trail for the self-DoS bound below. **Logging discipline (mirrors FABLE):** the audit
  records only the structured profile delta + the server-verified principal uid + swapMethod — **never
  the triggering operator turn text or any message content** — and lives under the same `logs/` access
  scope as the other audit trails. **Refused writes are audited too** (round-3 — refusals are the
  probing signal): `outcome:'refused'` + the named reason + the asserted (unverified) principal, same
  scrubbing rules. **Rejected field values are never stored verbatim** (round-4 security — a value
  that failed the regex is by definition arbitrary text, and §12 makes this file an agent read
  surface, so verbatim storage is a stored-prompt-injection channel): the audit records the field
  name, failure class (off-enum / regex / length), the length, and a hard-truncated prefix clamped to
  the safe charset — and any agent-facing rendering wraps free-ish fields in an untrusted-content
  envelope. Refused entries from the same (principal, topic, reason) within a short window coalesce
  with a count; the file is size-capped like its sibling audit logs (or rotation lands as part of
  this work — no generic `logs/` rotation mechanism exists on target to "ride"). Breaker reverts are
  audited as `principal:'system:circuit-breaker'`. **Undo has a defined target:** the store retains
  the previous profile snapshot per the §5.1 cadence (once per disclosed burst inside a coalescing
  window, per accepted write outside one — §8/R7-4); "undo" is an operator-gated write like any
  other, restoring that snapshot. **Undo of a framework switch also un-parks the matching
  resume-map entry** (round-5 external — §8 parks both stores' entries on a fresh respawn and §10.4's
  breaker revert un-parks; the manual undo path must have the same lossless characteristic, or an
  operator's undo suffers unnecessary CONTINUATION loss while the automated revert doesn't): when an
  undo reverts a change that included a framework switch, the restore un-parks the
  matching-framework resume entry before the respawn classifies, so the undo resumes the surviving
  transcript when one exists.
- **thinkingMode pins are deliberately ungated on cost** (round-3, stated so it can't slip through
  unexamined): a `max` pin raises per-turn burn but stays inside the subscription envelope;
  BurnDetector is the observability backstop. If a per-token thinking surcharge ever appears, this
  bullet is the place the cost gate extends to.
- Combined with §10.1, the operator-gating closes the round-1 **self-DoS / thrash** vector: a
  non-operator can no longer trigger repeated cold framework flips.

### 10.5 Platform-agnostic surface (Telegram AND Slack)

The whole write/read/disclosure surface is platform-agnostic — operator requirement (Justin,
2026-06-10): "this must apply to Slack as well."

- **"Topic" generalizes to the platform's conversation unit — with a CONCRETE key scheme** (round-3
  integration: the adjacent stores are all keyed on bare numeric Telegram topic ids; a unified
  conversation id does not already exist to lean on): the profile store's key space is
  **bare numeric = Telegram topic id (back-compat)** and **`slack:<channel>[:<thread>]` for Slack** —
  the same scheme the operator-binding store adopts for its Slack arm. `POST /topic-profile/:topicId`
  accepts both forms (the path segment is treated as an opaque conversation key). The §14 gate probes
  that the target's operator-binding store can address Slack conversations, or names it part of the
  Slack prerequisite sub-task below.
- **Operator binding (§10.1) is platform-keyed:** `GET /topic-operator/:topicId` already records the
  bound operator as `{ platform, uid }` from the authenticated sender. The bound-operator check uses the
  authenticated sender id of the **triggering platform** — Slack's verified user id for a Slack message,
  Telegram's `msg.from.id` for a Telegram message. Neither platform accepts an identity from content.
- **The `/topic` command** is registered on **both** the Telegram and Slack command surfaces (Slack
  slash command), with the same forward-the-authenticated-sender wiring.
- **Honest foundation scope (round-2 lessons, tightened round-3):** `SessionRefresh` — the smooth-swap
  respawn engine — is **Telegram-only by construction today** (its topic-binding lookup
  `getTopicForSession` returns `not_telegram_bound` for non-Telegram sessions). The gap is **narrower
  than wholesale**: the kill-time Slack channel-resume save already exists (`beforeSessionKill` →
  `_slackAdapter.saveChannelResume`, and `TopicResumeMap.jsonlExistsPublic` exists for Slack resume
  writes) — what's actually missing is **SessionRefresh's binding resolution + a Slack-capable
  respawner path**. Since the operator requirement is explicit Slack parity, that extension is an
  **explicit prerequisite sub-task of this work** (like CodexResumeMap in §7) — NOT a postponed v2.
  Until it lands in the build, the store/validation/operator-binding surface is platform-agnostic but
  a respawn-requiring change on a Slack topic degrades to CONTINUATION-on-next-message, disclosed
  honestly. The §11 platform-parity test asserts FULL parity (including respawn) once the sub-task
  lands — it is not quietly scoped down to no-respawn writes.
- **Disclosure notices (§8)** route through `MessageRouter` to whichever platform owns the topic — the
  "Switching this topic to Codex…" / "[dry-run] …" / circuit-breaker-revert messages are authored as
  plain text and delivered via the platform adapter, never hardcoded to `telegram-reply.sh`.
- A **platform-parity test (§11)** asserts a profile set + bound-operator refusal works identically on a
  Slack-bound topic and a Telegram-bound topic.

### 10.4 Spawn-failure circuit breaker (Gemini external)

A profile can pass validation yet consistently crash the session on launch (a bad config, a broken CLI
version). After **N consecutive spawn failures attributable to the profile**, the store marks that
profile **unhealthy**, **reverts to the last-known-good profile (or the global default)**, and
notifies the operator: "Couldn't launch with the requested profile — reverting this topic to its last
working settings to keep it usable."

**The breaker is LIVE in every regime — it is a system safety-write, exempt from BOTH flags**
(round-12 adversarial — §5.2(a) exempted the revert from `enabled` so a topic can never end up
degraded-and-unfixable while the feature is off, but `dryRun` was added later and the exemption
was never re-walked against it; R11-1's "breaker counting" line listed the counting among §8
machinery without answering either question): (a) **legacy-path spawn failures DO count toward N**
when their failure class is on the attribution allowlist below — a CLI-not-found is the same
broken pin whichever path performed the respawn; (b) **a real breaker revert — live store write +
respawn — fires even under `dryRun:true`**. The revert is a keep-working safety action, not part
of the new orchestration being canaried; shadowing it would reopen §5.2(a)'s
degraded-and-unfixable hole for the entire dry-run period. (R11-1's §8 list is corrected
accordingly: the breaker is never dormant; only the §8 *orchestration* — debounce, busy-refusal,
coalescing, parking — waits for `enabled:true AND dryRun:false`.)

**Attribution is an allowlist, not a guess** (round-3 adversarial — an unattributed counter turns any
ambient outage into a silent override of operator authority): only failure classes plausibly caused by
launch characteristics count toward N — CLI-not-found, launch-arg rejected, model rejected by the
account. **Ambient classes never increment** (quota wall, tmux breakage, disk full — conditions that
would fail ANY profile), and a resume-id mismatch is excluded once §8's framework-tagging lands (that
failure is the resume map's, not the profile's). The counter **resets on any successful spawn**. The
reverted profile is **retained as intended-but-unhealthy** — surfaced in the readout and the revert
notice ("your codex pin is parked; say re-apply when it's fixed"), never discarded — and the revert is
audited (`system:circuit-breaker`). **A new deliberate operator pin supersedes the parked state**
(round-10 external — without this, the parked intended-but-unhealthy entry survives an unrelated
new pin as state cruft, and the readout shows both): an operator-attributed accepted write to the
same topic atomically clears any parked/intended-but-unhealthy profile and the breaker counter in
the same `mutate` (audited as superseded-by-new-pin, named in the write's disclosure) — "re-apply"
afterwards is refused plainly ("nothing parked — you've since set a new profile"); §11 adds the
park→new-pin→readout-clean arm. **Re-apply has a cooldown guard** (round-6 external — without
one, "re-apply" immediately after a trip restarts the fail-N-times→revert loop): re-applying the
SAME profile that just tripped the breaker within a short cooldown is met with the consequence
stated and an explicit confirm required ("this exact profile failed N times a minute ago — apply it
anyway?"); the operator's explicit confirmation overrides (their authority, knowingly exercised),
audited as such. A re-apply after the cooldown, or of a different profile, proceeds normally.
**All three confirm surfaces share ONE armed slot per topic** (round-7 adversarial — §8 switch-now,
§10.1 propose-confirm, and this cooldown confirm could otherwise be armed simultaneously, with a
bare "yes" ambiguous about which it fires; and this confirm — authorizing a profile KNOWN to fail —
must not be the one surface a builder can implement agent-mediated): the cooldown confirm rides the
SAME server-side ingress parse, `switchNowConfirmTtlMs`, first-party-only, and forward-metadata
exclusion as §10.1; arming any confirm supersedes the prior armed one with the §10.1(c) re-echo
discipline; a bare affirmative matches only the most-recently-echoed armed confirm — anything else
is refused with a fresh echo.

## 11. Testing (all three tiers — non-negotiable)

- **Unit:** `TopicProfileStore` `mutate` field-merge + per-topic-lock serialization + atomicity +
  one-directional legacy seed (legacy never overwrites profile); `resolveTopicProfile` precedence
  (both sides of each boundary, incl. local-model-binding refusal + disabled-flag honor-on-read);
  `classifyProfileChange` **full truth table** (every §7 row — Claude/Codex, idle/busy, canary
  on/off, rollout-id present/absent, off↔on thinking, net-unchanged no-op); model-id closed-enum
  refusal (newline, `;`, >64 chars, off-envelope, cross-framework id); model+modelTier hard refusal;
  Codex `off`→`low` mapping.
- **Integration:** `GET/POST /topic-profile[/:topicId]` 200 + persist + survive reload; a
  **body-supplied `updatedBy` is overridden**; a **non-operator authorized user is refused** on the
  slash + HTTP paths; the `/route` rewire still works (back-compat) **under the shipped fleet
  default config — `enabled:false` AND `dryRun:true` pinned in the test config, asserting the write
  lands LIVE in the store, not in the dry-run shadow, AND that the legacy immediate respawn fires
  exactly as today (no §8 orchestration engaged, no `[dry-run]` prefix on the reply)** (rounds 10–11);
  a **shadow-regime arm pinned to the dev-agent shipped config (`enabled:true` AND `dryRun:true`)**
  (round-12 lessons — P4, both sides of the boundary; without it the canary's own
  evidence-production is unpinned): a framework switch is served by the legacy path exactly as the
  fleet arm asserts, AND the §8 shadow decision log entries are PRESENT (the canary actually
  produces evidence — a silently-inert shadow fails the test), AND zero shadow-originated mutation
  or operator-facing `[dry-run]` notice occurs (no double message); the **§7/§8 busy-refusal E2E
  arm is pinned to the fully-live config (`enabled:true`, `dryRun:false`)** — and its legacy
  counterpart asserts today's unguarded busy kill still happens on exempted switches (the §7
  regime scope, both sides); a **mixed-delta split-echo arm** — a propose spanning framework +
  thinkingMode on a gated agent renders the per-arm fates in the echo and the confirm applies
  exactly the named split; a **dryRun-flip arm** — accumulated shadow intents are never promoted
  at the true→false flip, the flip clears them with the single coalesced expired-intents notice,
  and an accepted live write clears that topic's stale shadow; a **legacy-undo loss-disclosure
  arm** — undo after a legacy-served switch recovers via CONTINUATION with the loss named in the
  reply (nothing parked to resume); **parked-pin re-apply arms under `enabled:false` AND under `dryRun:true`** (the shipped dev
  config), plus **CLEAR-of-a-live-pin under `dryRun:true`** — the recovery writes are accepted as
  LIVE writes (never shadowed; ride the cooldown confirm, audited) rather than refused as new pins
  or silently shadowed (rounds 13–14); **shadow-skew arms** — a populated shadow arriving on a
  non-dry-run receiver is discarded with the expired-intent line in the transfer disclosure, a
  shadowless arriving entry never silently destroys a populated local shadow on a dry-run
  receiver, **and the shadow-only no-live-delta fixture is pinned: the transfer/restore disclosure
  fires carrying the shadow-fate line even when the live fields are unchanged, and `previous` does
  NOT shift** (rounds 13–14 — a builder taking §8's unqualified silent reading must fail this); a **legacy disclosure-of-record metadata arm** —
  the legacy reply carries the audit stamp + dedup bypass and names a parked-pin supersession when
  one fires (round-13); a **round-trip-undo arm** — pin,
  transfer A→B→A with no changes, undo still restores the pre-pin profile (a no-delta REPLACE must
  not shift `previous`, §5.1, round-10); validation refusals return a
  structured reason. **Platform parity:** a profile set + a bound-operator refusal behave identically on
  a **Slack-bound** topic and a **Telegram-bound** topic (§10.5).
- **E2E (feature-is-alive):** set a profile → spawn picks up framework+model+thinkingMode (assert the
  launched session's `model` via `GET /sessions`, and the codex `reasoning_effort` arg / Claude
  thinking flag actually present in the launch). Change framework (idle) → CONTINUATION respawn fires;
  change framework (busy) → refused-with-notice; change Claude modelTier (confirmed-idle, canary
  passed) → in-flight swap, no new session. Returns 200, not 503.
- **Wiring integrity:** `resolveTopicProfile` is actually invoked in the spawn path (not a shadow
  no-op); the **FABLE reconciler actually consults the pin** in BOTH directions — an `inherit` pinned
  topic IS still escalated for heavy work, a `suppress` pinned topic is NEVER escalated (§9); the
  classifier's deps are non-null; the thinking-mode arg reaches the CLI builder.
- **L5 canary:** a living check confirms the resolved Claude thinking-mode flag is still accepted by
  the installed CLI surface, emitting a drift signal when the CLI no longer recognizes it —
  mirroring FABLE's `knownModelIds` + event-normalizer canary. **Drift-signal destination — the
  maturation track, NEVER the attention queue** (round-5 lessons — operator directive, Justin
  2026-06-10, the `maturing-feature-health-no-alerts` rule born from three "Model swap unconfirmed"
  attention topics in one day, the same class as the 2026-05-22 sentinel flood): every drift/health
  signal this spec emits (both canary arms, the §8 idle-confirmation drift counter, the §7
  fence-drift counter) is a **silent maturation-track metric + audit-jsonl breadcrumb** feeding the
  feature's maturation evidence file, where fix-vs-report heuristics decide whether it becomes an
  autonomous fix through the dev pipeline or accumulates into a maturation report for the operator —
  never a per-event attention item or fresh topic at normal priority. **The sink is probed, not
  assumed** (round-6 lessons — no maturation-track evidence-file or fix-vs-report machinery exists
  on the build target yet; a signal with no consumer is an unbacked promise, the spec's own R3-15
  standard): the §14 pre-build gate probes for the maturation-track mechanism; until it exists on
  target, signals land in the audit-jsonl breadcrumb only — **still silent, never attention** — and
  the evidence-file sink is a named sub-task of this work (it is the directive's "required/default
  aspect of the feature maturation system", and this feature is its first consumer); if the sink
  sub-task is deferred, it receives the same durable CommitmentTracker registration tied to a named <!-- tracked: CMT-1369 -->
  release as the §14 migration sub-task (round-7 lessons — same Close-the-Loop carrier as its
  sibling, no asymmetry). A one-time
  build-time check is not sufficient. **Off the hot path** (round-2 scalability): the canary runs on a
  **cadence / once at server boot with a TTL'd last-verified-at marker** — NEVER an unconditional
  per-spawn subprocess probe (the spec keeps per-spawn resolution O(1); a spawn-time CLI probe would
  reintroduce a subprocess herd). **The canary covers BOTH framework arms** (round-4 lessons): the
  Codex `model_reasoning_effort` key is the symmetric external surface, and its failure mode is
  SILENT — a future codex CLI would likely ignore an unknown `-c` override, launching fine while the
  thinking pin becomes a quiet no-op (no spawn failure, so the §10.4 breaker never sees it). The
  canary verifies the key is still accepted by the installed codex CLI (pinned against the adapter's
  `models.ts`, canaried against the binary version), emitting the same drift signal as the Claude arm.

## 12. Migration parity

- **Config:** additive `topicProfiles` defaults block, **existence-checked** in `migrateConfig()`
  (add-missing-only; never touches `frameworkDefaultModels`). **`migrateConfig` never WRITES an
  `enabled` value** (round-13 lessons — an explicit written `enabled` defeats the dark-gate's
  `resolveDevAgentGate()` resolution; an explicit `false` would force-dark even dev agents, the
  exact PR #1001 failure the §12.5 lint guards against): enablement resolves through the
  DEV_GATED_FEATURES registration per §12.5; only an operator hand-writes an explicit override.
- **CLAUDE.md awareness:** `migrateClaudeMd()` + the scaffold template (`generateClaudeMd()`) gain a
  "Topic Profile" section with the **conversational triggers** ("use codex here", "pin this topic to
  Fable", "set high thinking on this topic") as the PRIMARY surface — the agent acts on intent and
  **never instructs the operator to type `/topic`** (B2/B36). The `/topic` command is documented as a
  power-user convenience only. **The READ direction too** (round-2 lessons, P5): the section includes
  the proactive read surface — `GET /topic-profile/:topicId` for "what is this topic pinned to?" and
  `logs/topic-profile-changes.jsonl` for "why/when did it change?" — as Registry-First entries, so the
  agent reaches for them when asked instead of guessing. (The conversational/slash `/topic` surface is
  wired in the `server.ts` command dispatch where `/route` lives today; the `/topic-profile` HTTP route
  is in `routes.ts` — two different files, stated so the builder doesn't mis-locate either.)
- **Store:** `TopicProfileStore` one-directional read-only seed from legacy `topic-frameworks.json`;
  legacy file becomes a profile-store-written mirror; retirement tracked to a named release —
  **registered as a durable commitment via CommitmentTracker** (active re-surfacing per Close-the-Loop,
  not a passive release-name note), as is the CodexResumeMap prerequisite if it is ever deferred. <!-- tracked: CMT-1369 -->
  **Mirror crash-window self-heal** (round-2 scalability): write order is profile file first (source of
  truth), mirror second, best-effort; on boot, a mirror that diverges from the profile store is
  regenerated (always recoverable since the live path never reads it); the mirror is rewritten only
  when the framework field actually changed. The mirror is **per-machine**, like the store.
  **Rollback round-trip reconcile** (round-3 integration, predicate made concrete round-4 — the
  legacy file has only a FILE-level `updatedAt`, no per-topic stamps): the comparison is **file-level
  legacy `updatedAt` vs per-entry profile `updatedAt`**, re-seeding **only topics whose framework
  VALUE differs** (framework arm only, audited as `rollback-window reconcile`), BEFORE any mirror
  regeneration. The mirror writer records a **mirror-generation stamp**; the reconcile skips re-seed
  when the legacy `updatedAt` equals the last mirror-write stamp, so the §12 crash-window mirror
  self-heal can never be misread as rollback-window evidence. §11's legacy-seed tests cover the
  roll-forward-after-rollback case.
- **`/route` + `/local-model` response texts updated to the conversational register** (round-3, B2):
  the rewire carries the handlers but NOT their "Run /route claude-code … to switch" instruction
  texts — replies state the current value plainly and the change path is "just tell me," with slash
  syntax mentioned only as the power-user alternative.
- **Route location** (round-1 Integration): the new `/topic-profile` route lands in
  `src/server/routes.ts` (alongside the existing `POST /sessions/:name/model-swap`, L5135 on target),
  while `resolveTopicProfile` + the spawn-path wiring are in `src/commands/server.ts`.
- **Dashboard:** read-surface via the **existing API (`GET /topic-profile/:topicId`) + the `/topic`
  Telegram readout** — NOT a new dashboard topic-view (round-1 Integration confirmed no per-topic
  detail view exists on target; we do not promise unbuilt dashboard work). If a topic-detail panel is
  later added, the profile renders there.
- **GET route auth:** `GET /topic-profile/:topicId` requires the standard Bearer auth like sibling
  read routes (profile entries carry the operator's platform uid in `updatedBy`).
- **Backup/restore — each new file's fate decided explicitly** (round-5 integration — the only
  checklist item with zero prior coverage: `BackupManager`'s `DEFAULT_CONFIG.includeFiles` is a
  closed allowlist, so a snapshot/restore cycle would silently lose every operator pin):
  (a) `state/topic-profiles.json` **joins `config.backup.includeFiles`** via the existing
  `PostUpdateMigrator.migrateBackupManifest()` union pattern — it is durable operator intent,
  exactly the identity/continuity class the backup protects (the operator-binding store
  `topic-operators.json` it authorizes against joins the same union, so a restore can't produce pins
  whose bound operator is absent); (b) the resume maps (Claude UUID / Codex rollout-id) are
  **machine-local ephemera, explicitly EXCLUDED** — they reference transcripts that don't travel;
  (c) **restore-apply follows the §5.3 transfer rules** (wholesale per-topic REPLACE, §10.2
  revalidated, boot reconcile sweep picks up live-session divergence, disclosed) so a stale snapshot
  can never silently resurrect cleared pins — the R3-24 resurrection class through a different door.
  **Operator-binding restore gets the same discipline** (round-6 security — restoring a stale
  binding snapshot silently resurrects WRITE AUTHORITY to a stale principal, strictly worse than
  resurrecting data): a restored binding that differs from the live binding is **disclosed to the
  topic and superseded by the next auto-bind from an authenticated operator message** (the §10.1
  fast path) — never silently authoritative.
  **The path shape is pinned** (round-6 integration — `migrateBackupManifest`'s existing
  `.instar/`-prefixed sibling entries do NOT resolve in `BackupManager.createSnapshot()`, which
  joins entries onto a `stateDir` that already IS `<project>/.instar`; copying that shape produces
  a silently-dead manifest entry, reproducing the exact loss this bullet closes): the union entries
  are **stateDir-relative** — `state/topic-profiles.json`, never `.instar/state/...`. §11 adds the
  integration test: snapshot → assert the manifest's files contain the profile store → restore →
  pin survives reload.
  **Restore-apply has a named carrier** (round-6 integration — `restoreSnapshot()` is a blind file
  copy with no hook, and the §5.1 cache is authoritative, so an in-place restore would be served
  stale from cache and clobbered by the next flush): the restore route fires the §5.1 explicit
  external-change invalidation → restore-apply (REPLACE + revalidate + disclose) for the profile
  store; a server-down restore is covered by the boot reconcile sweep.
- **Idempotency:** every migration existence-checks before patching.

### 12.5 Config schema (the concrete `topicProfiles` block)

Round-3 integration: knobs referenced in prose need names and defaults for `migrateConfig()` to add
and for operators/dashboards to tune (mirroring FABLE §9's complete block):

```jsonc
"topicProfiles": {
  // NO literal `enabled` in ConfigDefaults (round-13 lessons — the dev-agent dark-gate lint,
  // PR #1056 on target, REFUSES `enabled: false` literals): `topicProfiles` registers in
  // DEV_GATED_FEATURES and the gate resolves dark-on-fleet / live-on-dev from `developmentAgent`
  // via resolveDevAgentGate(). An operator's EXPLICIT `enabled` in .instar/config.json remains
  // the documented force-dark / fleet-flip override; everything in this spec that says
  // "`enabled:false`" means the RESOLVED gate value.
  "dryRun": true,                         // §14 — shadow-field dry-run, see §14 semantics
  "respawnDebounceMs": 7000,              // same-framework trailing-edge window (§8)
  "frameworkSwitchDebounceMs": 45000,     // heavier framework-switch window (§8)
  "maxConcurrentProfileRespawns": 2,      // global stagger cap K (§8)
  "spawnFailureBreakerThreshold": 3,      // §10.4 N (attributable failures)
  "switchNowConfirmTtlMs": 300000,        // §8 'switch now' validity window
  "defaults": {}                          // optional per-topic config-default profiles (§5.2);
                                          // keys use the §10.5 conversation-key scheme
}
```

The in-flight swap arm **reuses `respawnDebounceMs`**; the SessionRefresh backstop budget, the
launchability/L5-canary TTLs, and the fallback-notice dedupe lifetime are **hardcoded v1 constants**
(stated so a builder doesn't invent knobs; promote to config only if tuning proves needed). The
`:topicId` path key is clamped at the route boundary — numeric, or `slack:<channel>[:<thread>]` with
platform-real id charsets — refused otherwise.

## 13. Decisions (all resolved — none open)

All five forks are decided. Items 1, 3, 4, 5 were resolved by Echo under Justin's standing
autonomy directive (2026-06-11, this topic: design forks with a researched lean are the agent's to
call; the operator reads the ELI16 afterward and can override cheaply). Each records its rationale
so an override has something concrete to disagree with.

1. **`TopicLocalModelStore` — DECIDED (echo, 2026-06-11): keep adjacent this release** with the
   §5.2 precedence (local binding wins the model arm; a cloud pin is refused while a local binding
   is active). Folding a working store mid-feature couples two risk surfaces for zero
   operator-visible gain; the fold-in question is parked on the maturation track (not a private
   intention) and revisits once the profile store is proven. **If the maturation-track sink itself
   is deferred (the §11 contingency), this revisit is registered as a durable CommitmentTracker <!-- tracked: CMT-1369 -->
   commitment tied to a named release** (round-15 lessons — the same clause its §12 legacy-mirror
   sibling carries; a carrier that exists only in the default-plan regime is the R6-6
   "slated-with-no-carrier = abandoned" class).
2. **tier-escalation interaction — DECIDED (Justin, 2026-06-10):** a baseline pin does NOT disable the
   heavy-work ultra mandate (`escalationOverride: 'inherit'` default); the mandate only steps aside when
   the operator explicitly opts the topic out (`'suppress'`). See §9.
3. **Codex same-framework swap — DECIDED (echo, 2026-06-11): ship the `CodexResumeMap` rollout-id
   capture as a prerequisite sub-task of THIS work**, so the §7 matrix is none-loss on both
   frameworks from day one. Shipping with Codex changes degraded to recent-only would make the
   feature's first impression on Codex topics a real (if disclosed) context loss — the worse fork
   when the capture is already specified (§8) and bounded.
4. **Thinking-mode granularity — DECIDED (echo, 2026-06-11): 5-level enum** (off/low/medium/high/max)
   mapped per framework — Codex already has 4 native reasoning levels and Claude maps to thinking
   budgets; on/off would discard expressiveness the CLIs already ship and force a breaking enum
   widening later.
5. **Busy framework switch — DECIDED (echo, 2026-06-11): refuse-until-idle with the "switch now"
   override** (§8) — least disruptive default, operator authority preserved through the override;
   always-confirm would tax the common case to protect the rare one. (Scoped to the fully-live
   regime per §7; exempted legacy switches keep today's behavior.)

## 14. Rollout

- **Pre-build gate (Know Before You Claim — concrete probes, round-2):** before any code, verify on
  the build-target worktree: (1) `POST /sessions/:name/model-swap` exists (non-404), (2) `resolveModel`
  + `knownModelIds` + the capture-pane idle guard + the cost gate symbols resolve, AND (3) — the part a
  merge-check alone misses — **a RUNTIME confirmation signal, not the static `SWAP_CAPABILITY`
  declaration** (round-4 integration: verified on target, `SWAP_CAPABILITY` is a static per-framework
  map that reports `mid-session` even while every live swap returns `unconfirmed` — today's three
  production "swap unconfirmed" alerts prove exactly that). The probe reads the **recent-swap-audit
  confirmed rate** (`.instar/state/model-tier-escalation/audit.jsonl`: injected vs swap-unconfirmed)
  or the gated live-canary E2E result. **The classifier's runtime canary read** is a **durable
  recent-confirmation marker with a TTL** — no recently-confirmed swap ⇒ the in-flight row is treated
  as unavailable and the change classifies straight to kill+`--resume`. **Unconfirmed-attempt
  choreography:** if an in-flight attempt fires and returns `unconfirmed`, the path does not guess —
  the debounce terminal's live-vs-resolved reconcile applies the kill+`--resume` fallback at the next
  confirmed-idle window, disclosed. FABLE itself states the read-back oracle "is not assumed to
  exist" and may permanently degrade claude-code to launch-time-only; if so, §7's in-flight row is
  unavailable and every Claude modelTier change uses kill+`--resume` from day one — the spec's
  fallback row, disclosed as the actual behavior.
  **Pool-infrastructure probes** (round-3 integration — §5.3 newly depends on a second v1.3.x-only
  subsystem): verify `POST /pool/transfer` + `GET /pool/placement` exist on the target AND that the
  transfer path exposes an extension point for carrying an opaque per-topic payload with a
  receive-side apply hook. If the planner's shape differs, §5.3's carrier becomes a prerequisite
  sub-task with the cross-machine matrix row honestly degraded (pin does not yet survive a move),
  exactly like the CodexResumeMap treatment.
- **Dry-run is a TRUE dry-run — shadow field, never silently live** (round-3 adversarial): in dry-run,
  the write persists to a **shadow `intendedProfile` field that `resolveTopicProfile` ignores** — so a
  dry-run pin can never quietly take effect at the next natural spawn. The `[dry-run]` notice and the
  readout show the intended profile distinctly ("would-be: codex / high thinking — dry-run"). §11
  tests that a dry-run pin does not affect a real spawn. **The dry-run shadow scopes to the NEW axes
  only** (round-10 adversarial): `/route` framework writes (and equivalent conversational framework
  switches) bypass the shadow exactly as they bypass the disabled-flag refusal — §5.2(d) — because
  §12.5 ships `dryRun:true` everywhere and a shadowed `/route` would silently break a live fleet
  capability. **The full shadow-exemption list** (round-14 — every member earned by a prior
  finding, stated once so no future knob-walk misses one): exempted framework writes (§5.2(d)),
  the §10.4 breaker revert + spawn-time fallback (system safety-writes, R12-2), and the §5.2(b)
  recovery writes — re-apply and clear (they restore/remove previously-accepted intent, R14).
  Everything else on the new axes shadows under `dryRun:true`. **How dry-run still canaries the framework-switch path** (round-11 — the previous
  sentence read alone made the canary claim false): while `dryRun:true`, exempted framework
  switches are SERVED by the legacy `/route` path (today's exact live behavior, per §5.2(d)) while
  the new §8 orchestration runs in shadow, logging the `[dry-run]` decisions it WOULD have made
  (debounce, busy-refusal, coalescing, parking) against that real traffic. The new orchestration
  takes over the framework arm only when the canary passes and `dryRun` flips false — the
  riskiest cold-rebuild arm never reaches any agent without having been observed first, and the
  shipped capability is never interrupted.
  **The shadow field's lifecycle across the `dryRun` true→false flip is pinned** (round-12
  integration — the flip is exactly where a builder plausibly adds a "now apply the collected
  intents" step, and a stale shadow makes the readout state a false mode): accumulated shadow
  `intendedProfile` intents are **NEVER promoted to live at the flip** — there is no promotion
  step, at the flip or ever; the flip **clears every topic's shadow field**, surfacing the expired
  would-be intents ONCE as a single coalesced operator notice ("dry-run ended — these recorded
  intents were never applied; re-issue any you still want: …") so re-issuing is the operator's
  deliberate act; a post-flip readout never labels anything "dry-run"; and independently of the
  flip, an accepted LIVE write to a topic clears that topic's stale shadow entry (the same
  supersession discipline §10.4 applies to parked pins). §11 pins promotion-never-happens and the
  flip-clear notice.
  **Arriving-shadow fate under regime/timing skew** (round-13 adversarial — the flip-clear is
  one-shot, but §5.3 pulls and §12 restores carry the shadow verbatim, so a populated shadow can
  land AFTER a machine flipped, and a wholesale REPLACE can land on a still-dry-run machine whose
  local shadow the arriving entry lacks): (i) a receiver that is NOT in dry-run **discards the
  arriving shadow at apply time**, folding the same expired-intent line into the transfer/restore
  disclosure ("a dry-run intent recorded elsewhere can't apply here — re-issue it if you still
  want it") — the post-flip readout invariant holds with no silent rot; (ii) a still-dry-run
  receiver applies an arriving shadow per normal REPLACE, but **an arriving entry with NO shadow
  never silently destroys a populated local shadow** — the local dry-run intent is retained and
  its retention named in the transfer disclosure (a transfer must not silently delete a recorded
  operator intent). **A shadow discard or named retention IS a delta for disclosure purposes**
  (round-14 adversarial + integration, independently — a dry-run intent is by construction often
  shadow-ONLY, so the carrying REPLACE has no live delta and §8/R10-2 mandate silence: two
  normative sentences otherwise specify opposite outcomes for the same apply, and the silent
  reading destroys the recorded intent with no notice anywhere — the source machine never
  flipped, so no flip-clear notice ever covers it): the transfer/restore disclosure FIRES carrying
  the expired-intent or retention line even when the live fields are unchanged — while still NOT
  shifting `previous` (R10-2 governs the undo snapshot: the live profile the operator last saw
  disclosed is unchanged; §8's silence rule is qualified accordingly — silence requires no live
  delta AND no shadow fate to name). §11 covers both skew arms INCLUDING the shadow-only
  no-live-delta fixture (a builder taking the silent reading must fail the test).
- Dark on the fleet, **enabled on dev agents (Echo)** via the dev-agent dark gate —
  `topicProfiles` registers in `DEV_GATED_FEATURES`, ConfigDefaults OMITS the `enabled` literal,
  and `resolveDevAgentGate()` resolves dark-on-fleet / live-on-dev (round-13 lessons; §12.5) — per
  the graduated-rollout track + the no-dark-ship-on-dev-agents lesson. **Maturation-track health
  reporting from day one** (round-5 lessons): this feature's health events route per the §11
  maturation-track rule. The inherited FABLE swap-unconfirmed **Attention items migrate as an
  in-scope sub-task of this build** (round-6 lessons — "slated" with no carrier is untracked =
  abandoned; this work builds the very routing the migration lands on, and
  `ModelSwapService.ts:308-316` verifiably violates the directive today): if the sub-task is
  deferred for any reason, it is **registered as a durable CommitmentTracker commitment tied to a <!-- tracked: CMT-1369 -->
  named release** at build time — the same treatment §12 gives the legacy-mirror retirement. The
  §14 probe is unaffected — it reads the audit jsonl, not the attention queue.
- **Dry-run** logs intended respawns without performing them (operator notices prefixed `[dry-run]`,
  §8) for a canary pass before the framework-switch path goes live.
- **Supervision tier (P7):** the conversational-set path is **Tier 0** — a deterministic parse to a
  validated enum profile; §10 validation refuses ambiguous/invalid input with a named reason. No
  policy decision is made by an unsupervised LLM step.

## 15. Round-1 findings → resolutions

| # | Reviewer | Finding (sev) | Resolution |
|---|---|---|---|
| 1 | security | Conversational write settable by content (high) | §10.1 — bound-operator stamp + first-party-only intent |
| 2 | security | Slash write forwards no sender id; allowlist ≠ operator (high) | §10.1 — forward `msg.from.id`, bound-operator check |
| 3 | security | HTTP updatedBy unspecified (med) | §10.1 — server-side stamp, body ignored, Bearer+X-Instar-Request |
| 4 | security | Model pin needs closed-enum guard (med) | §10.2 — FABLE knownModelIds + regex before persist |
| 5 | security | Respawn write = self-DoS; no audit/bound (med) | §10.1 gating + §10.3 audit + §8 rate-trip behavior |
| 6 | security | Cross-machine replication unspecified (low) | §5.3 — transfer-follow w/ receiving-machine revalidation (real body text, round-3) |
| 7 | scalability | Debounce/coalesce has no mechanism (high) | §8 — pending slot + trailing-edge debounce; guard is backstop |
| 8 | scalability | Legacy write-through doubles writes/diverges (high) | §5.1 — one-directional read-only seed + mirror |
| 9 | scalability | Full-file last-writer-wins clobber across 3 axes (med) | §5.1 — single-writer CAS `mutate` field-merge |
| 10 | scalability | Resolution cost unbounded (med, non-mat) | §5.1 — in-memory O(1) stated |
| 11 | scalability | Framework-switch asymmetric cost / no anti-thrash (med) | §8 — heavier debounce for framework arm + no-op detection |
| 12 | adversarial | Codex resume rollout-id never persisted (CRITICAL) | §7 — gated on CodexResumeMap; else degrade to recent-only, disclosed |
| 13 | adversarial | Profile write races respawn / inbound msg (high) | §8 — per-topic lock orders write→respawn; inbound queues |
| 14 | adversarial | Pin-suspend crosses 2 stores, races FABLE (high) | §9 — FABLE reconciler reads pin first; shared lock; wiring test |
| 15 | adversarial | Busy framework switch drops in-flight work (high) | §7/§8 — refuse-until-idle + disclosure |
| 16 | adversarial | Stale resume UUID survives framework switch (med) | §8 — suppress beforeSessionKill re-save on fresh respawn |
| 17 | adversarial | thinking change + --resume corruption risk (med) | §6/§7 — verify off↔on or fresh-respawn, disclosed |
| 18 | adversarial | model+modelTier silent winner (med, non-mat) | §4 — hard refusal |
| 19 | integration | Cross-machine pin vanishes on transfer (high) | §5.3 — transfer planner carries the profile; revalidated on receive (round-3) |
| 20 | integration | TopicLocalModelStore precedence undefined (high) | §5.2 — local binding wins; cloud pin refused while active |
| 21 | integration | Legacy reversibility/dual-write (med) | §5.1 — one-directional mirror eliminates divergence |
| 22 | integration | Dashboard topic-view may not exist (med) | §12 — API + /topic readout, no unbuilt dashboard promise |
| 23 | integration | Route file location imprecise (med, non-mat) | §12 — routes.ts for the route, server.ts for resolution |
| 24 | integration | In-flight route takes tier, not raw id (med) | §7 — split idle-Claude row by pin shape |
| 25 | lessons | In-flight row inherits unproven FABLE canary (high) | §7 — row contingent on canary; else kill+--resume |
| 26 | lessons | Thinking flag needs L5 canary, not one-time (high) | §6/§11 — living drift canary |
| 27 | lessons | /topic risks B2/B36 (med) | §2/§12 — conversational PRIMARY, plain-English readout |
| 28 | lessons | Idle detection brittle, no signal-vs-authority (med) | §7 — reuse FABLE capture-pane idle-confirmation; fail-safe |
| 29 | lessons | Codex 'off' thinking unmapped (low) | §4 — off→low with disclosure |
| 30 | lessons | Legacy retirement deferral risk (low) | §5.1 — one-directional + tracked retirement commitment <!-- tracked: CMT-1368 --> |
| 31 | lessons | Build-target FABLE-merged asserted not verified (low) | §14 — pre-build verification gate |
| 32 | lessons | P7 supervision tier undeclared (low) | §14 — Tier 0 declared |
| G2 | gemini | Spawn-failure loop unrecoverable (med) | §10.4 — circuit breaker reverts to last-known-good |
| G3 | gemini | "minimal" Codex loss ambiguous (med) | §7 — replaced with precise none-IFF-rollout-id / else recent-only |

### Round-2 findings → resolutions

| # | Reviewer | Finding (sev) | Resolution |
|---|---|---|---|
| R2-1 | security | Cross-machine resolution dangling — table only, no body (high) | NEW §5.3 — full mechanism; §15 rows 6/19 corrected |
| R2-2 | security | Explicit-model pin bypasses tier-shaped cost gate (high) | §10.2 — model pins run the FABLE launch path + cost guards; per-token-lane ids refused |
| R2-3 | security | thinkingMode/escalationOverride/framework not enum-clamped (med) | §10.2 — EVERY field clamped before persist + launch arg; §11 tests all fields |
| R2-4 | security | http:authToken-as-operator escape (med) | §10.1 — HTTP route enforces bound-operator; no token-as-operator path |
| R2-5 | security | Audit log scrubbing unstated (med, non-mat) | §10.3 — delta+uid only, never turn text |
| R2-6 | security | Write-time-only enum check, stale pin after shrink (low, non-mat) | §10.2 — read-time re-validation at spawn |
| R2-7 | scalability | Lock-vs-debounce stall-or-race (high) | §8 — two-phase locking (short write phase; respawn phase re-acquires) |
| R2-8 | scalability | Replicated profile invisible to running server (high) | §5.3 — applied via mutate(); cache invalidated on transfer-acquire; wiring test |
| R2-9 | scalability | Mirror crash-window divergence (med, non-mat) | §12 — write order + boot self-heal + change-gated rewrite |
| R2-10 | scalability | L5 canary on spawn hot path (med, non-mat) | §11 — cadence/boot + TTL marker, never per-spawn |
| R2-11 | scalability | Pending-slot lifecycle (low, non-mat) | §8 — slot teardown stated |
| R2-12 | adversarial | beforeSessionKill wired to wrong kill path (high) | §8 — kill-path precision per swapMethod; both maps removed pre-kill |
| R2-13 | adversarial | TOCTOU idle classify-vs-kill (high) | §8 — idle re-confirmed inside lock at kill time; busy aborts |
| R2-14 | adversarial | Ultra-baseline pin escapes escalation accounting (high) | §9 + §10.2 — ultra accounting attributed wherever ultra runs |
| R2-15 | adversarial | In-flight swap strands live session vs store (med) | §8 — terminal compares live-vs-resolved (last-applied marker) |
| R2-16 | adversarial | Codex rollout-id symmetric poisoning (med) | §8 — symmetric suppression both directions + both-direction test |
| R2-17 | adversarial | Disabled-flag vs circuit-breaker write conflict (med) | §5.2 — system safety-writes exempt; clears allowed while disabled |
| R2-18 | adversarial | Fresh-topic bind ordering refuses first message (med) | §10.1 — auto-bind before authorization; test added |
| R2-19 | adversarial | In-flight path unbounded vs SessionRefresh guards (med, non-mat) | §8 — in-flight debounced + rate-bounded under the lock |
| R2-20 | adversarial | Net-unchanged implied lossless across commits (low, non-mat) | §8 — scoped to the un-fired window |
| R2-21 | integration | §5.2/§12 transfer text missing (high) | NEW §5.3 (same as R2-1) |
| R2-22 | integration | Two machines resolve different profiles (high) | §5.3 — writes gated to topic owner; invalidate on transfer-acquire |
| R2-23 | integration | CodexResumeMap scope + transcript locality (med) | §7 — scoped to capture-at-kill; same-machine-only none-loss |
| R2-24 | integration | Disabled-flag = half-rollback (med) | §5.2 — clears permitted while disabled / admin clear-all |
| R2-25 | integration | Pre-build gate not concrete (med) | §14 — named probes incl. swapCapability === 'mid-session' |
| R2-26 | integration | Mirror dual-machine writer (low, non-mat) | §12 — mirror is per-machine, stated |
| R2-27 | integration | /route lives in command dispatch not routes.ts (low, non-mat) | §12 — both locations named |
| R2-28 | lessons | Slack parity contradicts Telegram-only SessionRefresh (HIGH, foundation) | §10.5 — SessionRefresh Slack extension is an in-scope prerequisite sub-task |
| R2-29 | lessons | Gate verifies merged, not canary-passed (med) | §14 — swapCapability probe (same as R2-25) |
| R2-30 | lessons | Disabled flag silently re-enables escalation on suppress pins (med) | §5.2(c) — reconciler consult not gated by enabled flag; test |
| R2-31 | lessons | suppress-intent is a policy judgment vs Tier 0 claim (low, non-mat) | §9 — suppress needs unambiguous explicit ask; ambiguity → inherit |
| R2-32 | lessons | Commitments named mechanism (low, non-mat) | §12 — CommitmentTracker registration stated |
| R2-33 | lessons | P5 read-direction awareness missing (low, non-mat) | §12 — read surface added to CLAUDE.md section |

### Round-3 findings → resolutions

| # | Reviewer | Finding (sev) | Resolution |
|---|---|---|---|
| R3-1 | security | Conversational uid provenance / token-as-operator renamed (high) | §10.1 — parse runs server-side in ingress; HTTP demoted to token-trust (`updatedBy:'api-token'`, never operator-attributed) |
| R3-2 | security | Transfer revalidation ≠ write authorization; forged provenance (med) | §5.3 — Ed25519 machine-auth carriage; audit `origin:'transfer:<machineId>'` peer-asserted; forwarding DROPPED (refuse-with-owner-named) |
| R3-3 | security | Auto-bind grants authority to anyone past an empty allowlist (med) | §10.1 — trust floor; `autoBound:true` audit flag; empty-allowlist trust model named |
| R3-4 | security | Refused writes not audited (low, non-mat) | §10.3 — `outcome:'refused'` audited |
| R3-5 | security | thinkingMode spend ungated (low, non-mat) | §10.3 — deliberately ungated, stated; BurnDetector backstop |
| R3-6 | security | GET route auth unstated (cosmetic) | §12 — standard Bearer |
| R3-7 | scalability | Fallback notices flood per-respawn (med) | §5.2 — once-per-state-transition dedupe; degraded pin feeds §10.4 |
| R3-8 | scalability | Inbound-queue choke point unnamed (med) | §8 — dispatch consults pending slot/lock before spawn-or-forward |
| R3-9 | scalability | No global respawn cap (med) | §8 — global cap K + FIFO, restart-all stagger pattern; clear-all staggered |
| R3-10 | scalability | Launchability check could be per-spawn subprocess (low) | §5.2 — existsSync / TTL marker, cached |
| R3-11 | scalability | Idle-boundary carrier unnamed (low) | §8 — piggybacks reaper/watchdog tick; boot sweep backstop |
| R3-12 | scalability | Debounce magnitudes unspecified (low, non-mat) | §8 + §12.5 — named defaults; write-time confirmation immediate |
| R3-13 | adversarial | Resume heartbeat re-poisons map post-switch → breaker reverts valid pin (high) | §8 — ALL writers enumerated; framework-tagged entries; profile-gated heartbeat; spawn refuses mismatched tag; heartbeat-tick test |
| R3-14 | adversarial | External kill initiators bypass the lock (high) | §8 — last-applied marker at EVERY spawn; respawn phase skips when live matches; durable topic-scoped suppression; session-gone behavior named |
| R3-15 | adversarial | Busy-abort never re-arms; "apply at idle" unbacked (high) | §8 — re-arm + periodic tick carrier; honest promise wording; boot sweep |
| R3-16 | adversarial | Server restart mid-debounce strands divergence (med) | §8 — boot-time reconcile sweep + test |
| R3-17 | adversarial | Codex pin silently exits Fable mandate (med) | §9 — framework-scoped mandate disclosed at pin time; framework-aware readout |
| R3-18 | adversarial | /route breaks under dark flag (med) | §5.2(d) — framework-arm exemption; test under enabled:false |
| R3-19 | adversarial | Breaker attribution undefined (med) | §10.4 — attribution allowlist; ambient never counts; reset-on-success; parked-pin re-offer; audited |
| R3-20 | adversarial | 'switch now' ungoverned (low) | §8 — first-party bound-operator, change-scoped, TTL'd |
| R3-21 | adversarial | Dry-run store-write ambiguity (low) | §14 — shadow `intendedProfile`, never silently live |
| R3-22 | integration | Same as R3-18 (high) | §5.2(d) |
| R3-23 | integration | §14 gate misses pool-transfer infra (high) | §14 — pool probes + §5.3 single-machine owner-of-record default |
| R3-24 | integration | Transfer field-merge resurrects cleared pins (med) | §5.3 — wholesale per-topic REPLACE + round-trip test |
| R3-25 | integration | Rollback round-trip loses rollback-window changes (med) | §12 — newer-updatedAt re-seed, audited |
| R3-26 | integration | config.topicFrameworks layer fate (med) | §5.2 — remains the framework arm's config layer, read-through unchanged |
| R3-27 | integration | Config schema never enumerated (med) | NEW §12.5 — concrete block with defaults |
| R3-28 | integration | Slack key scheme asserted not specified (med) | §10.5 — bare numeric = Telegram; `slack:<channel>[:<thread>]`; route accepts both |
| R3-29 | integration | Forwarded-write identity channel (low) | §5.3 — forwarding dropped in v1 (same as R3-2) |
| R3-30 | integration | Body round-count mismatch (cosmetic) | header synced |
| R3-31 | lessons | No Claude-UUID-not-captured row — asymmetric honesty (high) | §7 — symmetric contingency row; §8 verifies resume entry pre-kill; conditional disclosure |
| R3-32 | lessons | §9 consult crosses FABLE's hook process boundary (med) | §9 — consult moved to the server authority (swap endpoint + launch resolver); hook untouched |
| R3-33 | lessons | Claude thinking assumes a flag exists (med) | §6 — flag OR env (envOverrides); disclosed no-op contingency; level-change resume verification |
| R3-34 | lessons | Prompt-injection "closed" overstates (med) | §10.1 — mitigated-and-detected wording; disclosure-as-detection-loop; undo affordance |
| R3-35 | lessons | §7 idle/busy cells contradict §8 busy-abort (med) | §7 — cells corrected to "idle (confirmed; busy defers per §8)" |
| R3-36 | lessons | P8 not engaged (low) | frontmatter — P8 added with the walk |
| R3-37 | lessons | /route texts violate B2 (low, non-mat) | §12 — conversational-register texts |
| R3-38 | lessons | Slack sub-task over-scoped (cosmetic) | §10.5 — tightened to binding resolution + respawner (capture half exists) |

### Round-4 findings → resolutions

| # | Reviewer | Finding (sev) | Resolution |
|---|---|---|---|
| R4-1 | security | /route auth unspecified under the §5.2(d) exemption (high) | §10.1 — /route gets forward-sender + bound-operator + auto-bind fast path; back-compat consequence stated; both-direction tests |
| R4-2 | security | Refused-value audit = stored prompt injection (med) | §10.3 — field name + failure class + length + clamped prefix, never verbatim; untrusted-content envelope on render |
| R4-3 | security | Disclosure loop conditional on respawn (med) | §8 — EVERY accepted write discloses, all origins; HTTP-to-dormant-topic test |
| R4-4 | security | Config defaults not clamped (low) | §10.2 — clamp at the RESOLUTION boundary for every source |
| R4-5 | security | Cross-topic flush race loses a suppress pin (low) | §5.1 — store-wide flush queue, snapshot-at-flush |
| R4-6 | security | Slack key charset (low, non-mat) | §12.5 — route-boundary clamp |
| R4-7 | security | Undo target undefined (cosmetic) | §10.3 — prior snapshot retained on every accepted write |
| R4-8 | scalability | Tier-escalation writing the store → ping-pong + churn (high) | §5.1 — escalation NEVER writes the store; lock = ordering only; expected-live = baseline ⊕ escalation marker; only operator writes arm the debounce |
| R4-9 | scalability | RESPAWN lock hold unbounded (med) | §8 — phase TTL; write-acquire timeout; reconcile sweep backstop |
| R4-10 | scalability | In-flight debounce knob unnamed (low, non-mat) | §12.5 — reuses respawnDebounceMs |
| R4-11 | scalability | Cache invalidation trigger unnamed (low, non-mat) | §5.1 — file is server-owned single-writer, boot-only reconcile |
| R4-12 | scalability | Bookkeeping retention (low, non-mat) | in-memory bookkeeping evictable; store pruning lever = §5.2(b) clear |
| R4-13 | scalability | Refused-audit growth (cosmetic) | §10.3 — coalescing + rotation |
| R4-14 | adversarial | De-escalation drops the pin (high) | §9 — tier resolver topic-aware; default = the topic's baseline; test |
| R4-15 | adversarial | Untagged legacy resume entries (high) | §8 — grandfathered claude-code+hook; lazy tagging; migration tests |
| R4-16 | adversarial | §5.1 vs §9 contradiction (med) | §5.1 rewritten (same as R4-8) |
| R4-17 | adversarial | Pane-idle ≠ task-done for autonomous runs (med) | §8 — active autonomous/time-boxed session = busy until complete; switch-now override |
| R4-18 | adversarial | Thinking level-change row unconditional (med) | §6/§7 — contingent cell mirrored |
| R4-19 | adversarial | FIFO dequeue staleness (low, non-mat) | §8 — re-resolution at dequeue inside the lock |
| R4-20 | adversarial | switch-now parse location (low, non-mat) | §8 — same server-side ingress parse |
| R4-21 | adversarial | Dry-run shadow vs transfer/sweep (cosmetic) | §5.3 — travels verbatim; sweep reads live profile only |
| R4-22 | integration | Non-planner moves lose the pin (high) | §5.3 — carrier respecified to pull-at-ACQUIRE (covers failover/placement); absent entry clears nothing |
| R4-23 | integration | Carrier delivery semantics + missing extension point (med) | §5.3 — named prerequisite sub-task; durable retry; defaults+disclosure until landed |
| R4-24 | integration | SWAP_CAPABILITY probe is static (med) | §14 — probe the audit confirmed-rate / live E2E; TTL'd recent-confirmation marker; unconfirmed-attempt choreography |
| R4-25 | integration | Non-owner reads stale (med) | §5.3 — proxy-to-owner or owner+staleness annotation |
| R4-26 | integration | Legacy timestamp predicate (low) | §12 — file-level vs per-entry, value-diff only, mirror-generation stamp |
| R4-27 | integration | §12.5 missing knobs (low, non-mat) | §12.5 — hardcoded v1 constants stated |
| R4-28 | integration | resolveModel naming drift (cosmetic) | §10.2 — resolveModelForFramework + ModelTierEscalation.ts cited |
| R4-29 | lessons | Out-of-grammar phrasings bifurcate the PRIMARY surface (high) | §10.1 — propose-then-confirm; confirm is the operator-attributed parse; grammar scope stated |
| R4-30 | lessons | Cross-model --resume unverified (med) | §6 — added to verification; degrade + breaker carve-out |
| R4-31 | lessons | Codex reasoning-effort surface drifts SILENT (med) | §11 — canary covers both arms |
| R4-32 | lessons | Protected sessions killable (med) | §8 — protected check at kill time; defer like busy-abort; audited |
| R4-33 | lessons | Resume provenance + pre-kill predicate (med) | §8 — hook|mtime-fallback tags; none-loss requires hook; predicate reworded |
| R4-34 | lessons | Three-valued idle ambiguity (low, non-mat) | §8 — unconfirmed = busy at kill time, method-selection only in §7 |

### Round-5 findings → resolutions

Round 5 ran as the convergence check (5 internal reviewers + external Gemini; codex/grok CLIs not
installed, openai CLI present but unauthenticated — externals attempted, Gemini landed). 8 new
material findings; all folded below. Round 6 is the next convergence check.

| # | Reviewer | Finding (sev) | Resolution |
|---|----------|---------------|------------|
| R5-1 | lessons | Drift/health signals routed to Attention items — contradicts the operator's 2026-06-10 maturing-feature-health-no-alerts directive; inherited verbatim from FABLE, whose swap-unconfirmed Attention items are the directive's named first migration target (high) | §11 — all drift/health signals are silent maturation-track metrics + audit breadcrumbs with fix-vs-report heuristics, never attention items; §8 idle-drift + §7 fence-drift route the same way; §14 notes the FABLE migration; frontmatter lessons-engaged entry added |
| R5-2 | security | Late-landing pull clobbers a fresher local operator write (B pins while A offline; A returns, stale REPLACE lands) (med) | §5.3 — local operator write cancels the pending REPLACE / landing apply compares updatedAt, ties favor local, audited pull-superseded-by-local-write; §11 B-writes-while-A-offline arm |
| R5-3 | adversarial | Codex rollout fence has no multi-match rule — two same-cwd near-simultaneous spawns both pass; passing-but-wrong capture → wrong-conversation resume (med) | §7 — fence is zero-or-one: >1 candidate ⇒ capture nothing, degrade to recent-only disclosed; single-active-codex-session-in-cwd as the unambiguous fast path |
| R5-4 | integration | Backup/restore wholly unaddressed — BackupManager closed allowlist silently loses every pin on snapshot/restore (med) | §12 — topic-profiles.json + topic-operators.json join includeFiles via migrateBackupManifest union; resume maps explicitly excluded (machine-local ephemera); restore-apply follows §5.3 transfer rules |
| R5-5 | lessons | The rollout-file fence is the FOURTH external-state parser with no L5 drift detection — codex CLI format change silently degrades every Codex swap forever (med) | §7 — consecutive fence-validation failures counted per (machine, framework); threshold fires the §11 drift signal (maturation-track); §11 test case |
| R5-6 | adversarial | ACK-before-flush: a crash in the mutate→flush window drops an acknowledged pin; boot sweep then actively reverts the applied session (low) | §5.1 — confirmation/disclosure/debounce-arm fire only after the flush durably lands (synchronous per-write, CommitmentTracker pattern) |
| R5-7 | external (Gemini) | Manual undo doesn't un-park resume entries — operator undo of a framework switch suffers CONTINUATION loss the breaker revert doesn't (low) | §10.3 — undo of a framework switch un-parks the matching-framework resume entry before classification |
| R5-8 | external (Gemini) | Propose-confirm pending slot has no TTL (low) | §10.1(e) — reuses switchNowConfirmTtlMs; expired confirm refused plainly |

Non-material builder notes also folded: §10.3 audit-log rotation wording corrected (no generic
`logs/` rotation exists on target — size-capped like siblings or rotation ships with this work);
§5.3 durable retry distinguishes protocol-unsupported (park until peer version supports) from
unreachable (retry/backoff); frontmatter round counter synced.

### Round-6 findings → resolutions

Round 6 (5 internal + external Gemini; same external availability as round 5). 11 unique material
findings after dedup — notably FOUR reviewers independently flagged the round-5 pull-anti-clobber
fix's timestamp arm (clock skew + peer-asserted updatedAt), and all findings target round-5
additions or newly-probed foundations, the expected convergence shape.

| # | Reviewer(s) | Finding (sev) | Resolution |
|---|-------------|---------------|------------|
| R6-1 | security + scalability + adversarial + lessons | R5-2's two "equivalent" anti-clobber arms are NOT equivalent: peer-asserted/forgeable updatedAt + cross-machine clock skew let a stale pulled entry outrank a fresher local pin (med) | §5.3 — event-ordered cancel-on-local-OPERATOR-write is normative (clock-free, under the per-topic lock); updatedAt compare demoted to backstop with pulled updatedAt clamped ≤ pull-receipt time; system-attributed writes never cancel a pending pull |
| R6-2 | security | Per-write disclosures unbounded + dedup-bypassed = token-holder message flood (med) | §8 — same-topic writes within the debounce window coalesce to ONE disclosure (count + final profile); per-topic disclosure rate cap, overflow summarized |
| R6-3 | security | topic-operators.json restore can silently resurrect stale WRITE AUTHORITY (med) | §12 — binding restore disclosed + superseded by next authenticated auto-bind, never silently authoritative |
| R6-4 | security + adversarial | Propose-confirm TOCTOU: supersession between echo-read and "yes" fires an unseen payload with operator attribution (med/low) | §10.1(c) — confirm must postdate the latest echo's delivery; supersession invalidates in-flight confirms (fresh echo re-issued); re-proposal resets the TTL |
| R6-5 | lessons | The maturation-track sink doesn't exist on target — signals routed to an unbacked mechanism (med) | §11 — §14 probes the sink; until it exists, audit-jsonl-only (still silent, never attention); evidence-file sink is a named sub-task of this work |
| R6-6 | lessons | FABLE attention→maturation migration "slated" with no carrier (untracked = abandoned) (med) | §14 — in-scope sub-task of this build; if deferred, durable CommitmentTracker commitment tied to a named release <!-- tracked: CMT-1369 --> |
| R6-7 | integration | migrateBackupManifest's existing entries use a path shape createSnapshot can't resolve — copying it reproduces silent snapshot loss (med-low) | §12 — stateDir-relative shape pinned (state/topic-profiles.json); §11 snapshot→restore→pin-survives test |
| R6-8 | integration | Restore-apply has no carrier — blind file copy + authoritative cache = restore silently clobbered (low) | §12 — restore route fires the §5.1 external-change invalidation → restore-apply; server-down restore covered by boot sweep |
| R6-9 | integration | CommitmentTracker's saveStore swallows write errors — verbatim copy re-creates ack-without-durability (low) | §5.1 — failed flush REFUSES out loud (audit outcome:refused/flush-failed); §11 flush-failure unit test |
| R6-10 | scalability | N-topic batch apply pays N serialized flushes (low) | §5.1 — flush waiters coalesce to a trailing snapshot flush; durability-precedes-ACK preserved |
| R6-11 | scalability + adversarial | Stagger/boot-sweep manufactures fence ambiguity (same-cwd codex pairs permanently lose none-loss); ambiguity-discards pollute the drift counter (low) | §7/§8 — FIFO serializes same-cwd codex spawns; ambiguity-discards counted separately from validation failures |
| R6-12 | external (Gemini) | Local-model-bound topic transferred to a machine without the model: outcome undefined (flagged high; actual behavior is defined-but-undisclosed) | §5.3 — binding is machine-bound like transcripts; receiving machine resolves normally; effective-model change disclosed with recovery path; Q1 note |
| R6-13 | external (Gemini) | Breaker re-apply loop: nothing guards immediate re-application of the just-tripped profile (med) | §10.4 — cooldown guard: same-profile re-apply within cooldown requires explicit consequence-stated confirm; operator authority overrides, audited |
| R6-14 | external (Gemini) | Undo snapshot durability undefined — in-memory-only would make undo useless after restart (med) | §5.1 — store schema holds { current, previous } per topic; mutate shifts atomically; undo target survives restarts |

### Round-7 findings → resolutions

Round 7 (5 internal + external Gemini). External Gemini: **CLEAN, zero new material findings.**
Internals: 9 unique material findings after dedup, every one a tightening of round-5/6 text — the
dominant one (flush-refusal needs cache rollback) was independently flagged by FOUR reviewers.

| # | Reviewer(s) | Finding (sev) | Resolution |
|---|-------------|---------------|------------|
| R7-1 | security + scalability + adversarial + lessons | Flush-failure refusal lacks cache rollback — a "refused" write keeps serving from the authoritative cache (and the coalesced multi-waiter failure arm is undefined) (med) | §5.1 — rollback to the last durably-flushed snapshot (incl. the current→previous shift) before refusals fire; coalesced-failure refuses + rolls back all undurable waiters together; §11 asserts post-refusal reads |
| R7-2 | security + adversarial | Cancel marker not durable/episode-keyed — restart resurrects the REPLACE onto the skew-vulnerable backstop; token-trust writes unclassified (med) | §5.3 — cancel durably amends the pending-pull record, keyed to the (peer,batch) episode; newer pull supersedes older; token-trust writes cancel (audited origin:http); §11 restart arm |
| R7-3 | security + adversarial | Confirm-postdates-echo is a cross-clock compare and read-time-blind; rapid re-proposal churn defeats it (med) | §10.1(c) — event-ordered on platform message ids (monotonic per chat), ties refuse toward re-echo, reply-to binds where supported; re-proposals rate-bounded per topic, churn audited as suspicion, slot torn down past the bound |
| R7-4 | adversarial | Coalesced disclosure hides the intermediate write AND makes it the undo target (med) | §8 — coalesced notice carries was→now + origins; previous captured at the FIRST write of the window (undo restores what the operator last saw disclosed) |
| R7-5 | adversarial | Three armed confirm surfaces, no arbitration; the §10.4 cooldown confirm has no mechanics (med) | §10.4 — ONE armed slot per topic shared by all three; cooldown confirm rides the same ingress parse/TTL/first-party/forward-exclusion machinery; bare affirmative matches only the most-recently-echoed |
| R7-6 | integration | Bound-operator check assumed sticky bindings; target is last-authorized-sender-wins, so the R4-1 refusal claim cannot fire (med) | §10.1 — honest scope: for allowlisted senders the check is attribution+audit+disclosure; refusal tier = unauthorized senders + token-to-unbound; R4-1 claim corrected; §11 test re-scoped to the satisfiable boundary |
| R7-7 | scalability | Same-cwd codex serialization has no bounded wait — a wedged spawn stalls the codex FIFO (low) | §7 — wait bounded by fence-resolution OR the RESPAWN-phase TTL; on timeout dequeue, multi-candidate degrades per zero-or-one |
| R7-8 | integration | Fate of `previous` under transfer-REPLACE/restore/seed unstated (low) | §5.1 — REPLACE sets previous to the pre-replace current; legacy seed previous:null, undo-with-no-snapshot refused plainly |
| R7-9 | lessons | The §11 sink sub-task lacks the if-deferred CommitmentTracker clause its §14 sibling carries (low) | §11 — same durable registration tied to a named release if deferred <!-- tracked: CMT-1369 --> |

### Round-8 findings → resolutions

Round 8: security, scalability, and external Gemini all returned **CLEAN / zero new material
findings**. Adversarial + integration + lessons converged on 3 unique material findings — every one
a sentence-level reconciliation between round-7 fixes, no design changes.

| # | Reviewer(s) | Finding (sev) | Resolution |
|---|-------------|---------------|------------|
| R8-1 | adversarial + integration + lessons | §5.1/§10.3 still mandated per-write undo shifting — the exact behavior §8's R7-4 fix closed; the spec mandated both the bug and its fix (med-low) | §5.1 + §10.3 harmonized: previous shifts once per disclosed burst (first write of an active window), per-write outside one; §11 pins the burst case |
| R8-2 | lessons | R7-1×R7-2 interaction: the cancel amendment fired at write time, so a flush-REFUSED write would still cancel the transferred pin — neither pin survives (low) | §5.3 — the cancel amendment fires only after the triggering write's flush durably lands; flush-refused writes cancel nothing; §11 arm added |
| R8-3 | lessons | ELI16 still claimed a strict "operator-only check" — stale against R7-6's honest scope (low) | ELI16 reworded: unauthorized = never; authorized = attributed + announced + undoable |

Non-material builder note carried: the §5.3 durable pending-pull retry record is machine-local
transfer ephemera — excluded from backup like the resume maps (keeps §12's explicit-fate invariant).

### Round-9 findings → resolutions

Round 9: security, scalability, integration, lessons-aware, AND external Gemini all returned
**CLEAN / zero new material findings** (Gemini's third consecutive clean round). Adversarial found
ONE low material finding — the last reconciliation:

| # | Reviewer | Finding (sev) | Resolution |
|---|----------|---------------|------------|
| R9-1 | adversarial | The rate-cap overflow regime (writes outside any coalescing window, summarized delta-free) still shifted `previous` per write — an undisclosed intermediate could become the undo target, violating §8's own "undo restores what the operator last saw disclosed" invariant (low) | §8 — the overflow summary is itself a delta-carrying was→now disclosure, and an overflow period is treated as a disclosed burst for the undo shift; §5.1 cadence restated as once-per-delta-carrying-disclosure; §11 overflow arm |

### Round-10 findings → resolutions

Round 10 (rerun after the 2026-06-10 session respawn killed the first attempt mid-flight):
security, scalability, integration, AND lessons-aware all returned **CLEAN / zero new material
findings**. Adversarial found 2 material findings and external Gemini found 1 (its first non-clean
round since round 6) — all three single-sentence reconciliations/lifecycle clarifications, no
design changes:

| # | Reviewer | Finding (sev) | Resolution |
|---|----------|---------------|------------|
| R10-1 | adversarial | §14 dry-run shadow × §5.2(d): the `/route` exemption covered only the `enabled` flag, but §12.5 ships `dryRun:true` on BOTH fleet and dev-agent configs — read literally, every `/route` write lands in the shadow field wherever dryRun is true, recreating the R3-18 "live capability silently broken" regression through the second knob; the §11 back-compat test never pinned dryRun (med) | §5.2(d) + §14 — the framework-arm `/route` exemption covers the dry-run shadow the same way; both flags gate only the NEW axes; §11 back-compat test pinned to the shipped fleet default (`enabled:false` AND `dryRun:true`), asserting the write lands live |
| R10-2 | adversarial | §5.1 R7-8 × §8 delta-gated silence: a transfer/restore REPLACE unconditionally shifted `previous` while a no-delta REPLACE (A→B→A round-trip, duplicate retried pull) discloses nothing — silently destroying the undo target, violating the R7-4/R9-1 invariant through the REPLACE door (low) | §5.1 — a REPLACE producing no effective delta must NOT shift `previous` (the once-per-delta-carrying-disclosure cadence applies to the REPLACE door too); §11 round-trip-undo arm added |
| R10-3 | external (Gemini) | Parked intended-but-unhealthy pin lifecycle under a subsequent NEW operator pin undefined — the §5.1 field-merge would retain the parked entry as state cruft and the readout shows both (low) | §10.4 — a new deliberate operator pin atomically clears the parked state + breaker counter in the same `mutate` (audited as superseded-by-new-pin, named in the disclosure); stale "re-apply" refused plainly; §11 park→new-pin→readout-clean arm |

### Round-11 findings → resolutions

Round 11 (operator-approved continuation past the 10-iteration cap, Justin 2026-06-11): security,
scalability, integration, AND external Gemini all returned **CLEAN / zero new material findings**
— with the three internals each independently verifying the round-10 patches opened nothing new.
Adversarial and lessons-aware independently found the SAME root issue (counted once):

| # | Reviewer(s) | Finding (sev) | Resolution |
|---|-------------|---------------|------------|
| R11-1 | adversarial + lessons (independently) | R10-1 fixed only where the `/route` WRITE lands; no sentence governed the framework-switch RESPAWN arm under the two flags — three contradictory readings (fleet kill-bearing §8 respawns / un-canary-able framework switches / unspecified disclosure), and §14's "dry-run canaries the framework-switch path" claim + the ELI16 sentence were false under the patched semantics. Reviewers disagreed on today's live `/route` behavior; verified on live code (`src/commands/server.ts` onRouteCommand): today's `/route` does an IMMEDIATE kill+respawn (med) | §5.2(d) — wherever the new orchestration is not fully live (`enabled:false` OR `dryRun:true`), exempted framework writes are served end-to-end by the legacy `/route` path byte-for-byte (live write + immediate legacy respawn + resume-UUID drop); the new §8 framework-switch orchestration takes over ONLY when `enabled:true` AND `dryRun:false`; while dry-run on an enabled agent §8 runs in SHADOW logging `[dry-run]` would-be decisions against the real traffic the legacy path serves — restoring the §14 canary claim honestly. §14 + ELI16 reconciled; §11 back-compat arm extended: legacy respawn fires exactly as today, no §8 machinery, no `[dry-run]` prefix |

### Round-12 findings → resolutions

Round 12: security and scalability returned **CLEAN** (each independently verifying the R11-1 patch
opened nothing new in their lanes). External Gemini was **unavailable this round** (terminal
provider quota wall mid-run; recorded honestly per the round-5 precedent for unavailable externals
— its read rejoins at the next round). Adversarial found 5, integration 1, lessons 1 — all residue
of one root: **R11-1 declared the legacy carve-out without re-walking every section that makes
unqualified claims about framework-switch behavior.** All folded as one regime-scoping pass:

| # | Reviewer | Finding (sev) | Resolution |
|---|----------|---------------|------------|
| R12-1 | adversarial | §7/§8/§9 framework-switch guarantees (never-silent-mid-work-kill, busy-refusal, stagger, net-unchanged, marker-clear, parking, §9 mandate disclosure) remained unqualified universals while R11-1 routes BOTH shipped default regimes through the legacy immediate-kill path — mutually exclusive behaviors specified for the same event (med) | §7 — explicit regime scope: the matrix + §8/§9 orchestration behaviors govern the framework arm only when `enabled:true AND dryRun:false`; exempted legacy switches behave exactly as today's `/route` including the unguarded busy kill, disclosed honestly; §11 busy-refusal arm pinned to the live config with a legacy counterpart asserting today's behavior |
| R12-2 | adversarial | The §10.4 breaker vs the two flags: §5.2(a) exempts the revert from `enabled` (anti degraded-and-unfixable) but `dryRun` was never re-walked; R11-1 listed "breaker counting" as gated §8 machinery — contradictory, and legacy-failure counting was unanswered (med) | §10.4 — the breaker is a system safety-write LIVE in every regime, exempt from BOTH flags; attributable legacy-path failures count toward N; a real revert fires even under `dryRun:true`; §5.2(d)'s machinery list corrected (breaker removed) |
| R12-3 | adversarial | §10.3 undo-un-park (R5-7) + §10.4 revert "none-loss" assume the §8 parking that only the fully-live orchestration performs; a legacy-served switch DROPS the UUID, so undo/revert after it suffers undisclosed CONTINUATION loss (med-low) | §8 — parking and every un-park consumer scoped to the fully-live regime; after a legacy switch, undo/revert recover via CONTINUATION with the loss named in the reply; R5-7's guarantee was always the new orchestration's property — claiming it for the legacy path would be the overclaim |
| R12-4 | adversarial | Mixed multi-axis delta spanning exempted + gated arms: split-vs-wholly-gated ambiguity, and a half-applied delta after an un-split echo violates §10.1(b)'s "what you confirm is what is written" (low) | §10.1 — mixed deltas SPLIT at propose time with each arm's fate named in the server-rendered echo; the confirm applies exactly the named split, each arm audited under its own regime; §11 split-echo arm |
| R12-5 | adversarial | §8's round-1 dry-run bullet ("the real notice is never sent when no switch occurred") stale against R11-1; whether shadow decisions are operator-facing and which message anchors §5.1's undo cadence was builder-divergent (low) | §8 — `[dry-run]` notices scope to shadowed NEW-axis writes; shadow decisions are audit/maturation-log-only, never operator-facing (no double notice); the legacy reply IS the disclosure-of-record anchoring the undo cadence |
| R12-6 | integration | The shadow `intendedProfile` lifecycle across the `dryRun` true→false flip was unspecified: nothing forbade a builder "promote collected intents" step (undisclosed respawn herd at the flip), and a stale shadow made the readout state a false mode (low) | §14 — shadow intents are NEVER promoted, at the flip or ever; the flip clears every topic's shadow with ONE coalesced expired-intents notice (re-issue is the operator's deliberate act); an accepted live write clears that topic's stale shadow; post-flip readouts never say "dry-run"; §11 flip arm |
| R12-7 | lessons | R11-1 created a third regime (`enabled:true AND dryRun:true` — the dev agent's shipped config) with no §11 arm: a silently-inert shadow (no decision logs) would pass every test while voiding the canary; nothing pinned zero shadow-originated mutation/double-notice (low) | §11 — named shadow-regime arm pinned to the dev shipped config: legacy serves the switch, shadow decision logs are PRESENT, zero shadow mutation, no operator-facing `[dry-run]` alongside the real reply |

### Round-13 findings → resolutions

Round 13 (externals waived by operator directive, Justin 2026-06-11 — "cross-model review is
additional, not required"; Gemini remained quota-walled): security, scalability, AND integration
returned **CLEAN** — integration explicitly verified the whole R12 fold composes with
backup/restore, multi-machine skew, config, and rollback. Adversarial found 3, lessons found 1:

| # | Reviewer | Finding (sev) | Resolution |
|---|----------|---------------|------------|
| R13-1 | adversarial | §10.4's revert notice promises "say re-apply when it's fixed" in every regime (R12-2), but on a disabled agent a parked NEW-axis pin's re-apply is an operator write §5.2 refuses — parked-unrecoverable until re-enable, the degraded-and-unfixable outcome reopened through the recovery door (med-low) | §5.2(b) — re-applying a breaker-parked pin is permitted while disabled, same basis as CLEAR (it restores previously-ACCEPTED operator intent); rides the §10.4 cooldown confirm, audited as re-apply; §11 arm |
| R13-2 | adversarial | The R12-6 flip-clear is one-shot, but §5.3 pulls/§12 restores carry the shadow verbatim — a populated shadow can land AFTER the flip (readout invariant violated, intent rots silently), and a shadowless REPLACE on a still-dry-run machine silently destroys a recorded local intent (med-low) | §14 — arriving-shadow fate under skew: a non-dry-run receiver discards the arriving shadow with the expired-intent line folded into the transfer/restore disclosure; an arriving entry with NO shadow never silently destroys a populated local shadow (retained + named in the disclosure); §11 both arms |
| R13-3 | adversarial | The legacy reply was designated disclosure-of-record (R12-5) yet "byte-for-byte" structurally barred it from the record's own duties — the R6-2 dedup bypass (an A→B→A flip's third disclosure silently swallowed while `previous` shifts), the audit stamp, and R10-3's supersession naming (low) | §8 — disclosure-of-record duties attach to the legacy reply (audit stamp + dedup bypass + supersession naming); "byte-for-byte" scoped to BEHAVIOR (kill/respawn/store semantics), never reply bytes — same additive class as R12-3's loss-naming; §11 arm |
| R13-4 | lessons | §12.5 prescribed a literal `"enabled": false` and §12 had `migrateConfig` write the enable flag — the exact shape the dev-agent dark-gate lint (PR #1056, merged on target 2026-06-10, AFTER §12.5 was authored) structurally refuses; a literal build hits the CI wall, and the cheap workaround (DARK_GATE_EXCLUSIONS) would void the spec's own no-dark-ship lesson (med) | §12.5 + §12 + §14 — `topicProfiles` registers in `DEV_GATED_FEATURES`; ConfigDefaults OMITS the `enabled` literal (gate resolves dark-on-fleet / live-on-dev via `resolveDevAgentGate()`); `migrateConfig` never writes an `enabled` value; an operator's explicit config value remains the documented force-dark/fleet-flip override; "`enabled:false`" throughout the spec means the RESOLVED gate value |

### Round-14 findings → resolutions

Round 14 (externals waived per operator): security AND scalability returned **CLEAN**. The other
three reviewers found 5 findings that reduce to 3 roots (two found independently by two reviewers
each — the convergence signal of overlapping discovery):

| # | Reviewer(s) | Finding (sev) | Resolution |
|---|-------------|---------------|------------|
| R14-1 | adversarial + lessons (independently) | R13-1's re-apply exemption was carved against `enabled` only — the exact one-knob-walked R12-2 pattern: under the shipped `dryRun:true` a re-apply lands in the shadow (never un-parks, evaporates at the flip with a "never applied" notice — a false recovery promise on every shipped config), and a CLEAR of a live transferred pin is shadowed the same way (med) | §5.2(b) — the recovery writes (re-apply AND clear) are exempt from BOTH knobs: always live, never shadowed (restoring/removing previously-accepted intent is recovery, not the orchestration under canary); §14 now carries the full shadow-exemption list in one place so no future knob-walk misses a member; §11 arms pinned under `dryRun:true` |
| R14-2 | adversarial + integration (independently) | R13-2's discard/retention disclosure duties presuppose a transfer disclosure that §8/R10-2 mandate SILENT in the common case (a dry-run intent is shadow-only, so the carrying REPLACE has no live delta) — two normative sentences requiring opposite outcomes for one apply; the silent reading destroys the recorded intent with no notice anywhere (med-low) | §14 — a shadow discard or named retention IS a delta for disclosure purposes: the transfer/restore disclosure fires carrying the expired-intent/retention line even with live fields unchanged, while still NOT shifting `previous` (R10-2 governs undo); §8's silence rule qualified (silence = no live delta AND no shadow fate to name); §11 pins the shadow-only fixture |
| R14-3 | lessons | Foundation drift one layer below (PR #1058, merged on target 2026-06-10, after the round-13 baseline): /spec-converge now enforces Decision-Completeness — the tag script refuses to stamp convergence while unresolved operator decisions remain, and §13 carries FOUR (items 1, 3, 4, 5). Also noted: §13's numbered heading happens to evade the gate's regex — using that gap would void the lesson, and the gap is reported upstream instead (med) | §13 — resolved: items 1, 3, 4, 5 decided by Echo with recorded rationale under Justin's standing autonomy directive (2026-06-11: design forks with a researched lean are the agent's to call, reported in the ELI16 after); ELI16 decision section updated to match; the regex gap filed as JKHeadley/instar#1060 rather than exploited |

### Round-15 findings → resolutions

Round 15: security, scalability, integration, AND adversarial all returned **CLEAN** —
adversarial's verdict followed an explicit final composition sweep across the accumulated patches
(walks recorded in the round transcript; three explicitly NON-material residuals noted and
accepted). Lessons-aware found 3:

| # | Reviewer | Finding (sev) | Resolution |
|---|----------|---------------|------------|
| R15-1 | lessons | Foundation drift: PR #1059 (merged on target 2026-06-10 17:03, after the R14-3 audit) makes external cross-model review delta-gated MANDATORY — the last successful external read was round 11, and stamping would carry a clean external-RAN flag over a body (rounds 12–15) the external never saw, overstating coverage (med-low) | EXTERNAL-COVERAGE SCOPE note below + carried verbatim into the convergence report; the operator waiver (2026-06-11) governs whether externals run, NOT the coverage claim — the stamp must not overstate; the waiver-vs-mandatory-gate tension filed upstream as JKHeadley/instar#1063 rather than silently absorbed |
| R15-2 | lessons | R14-1 fixed the recovery writes' WRITE arm and left the APPLICATION arm ungoverned in the two shipped regimes (the exact R10-1→R11-1 one-arm-walked root): immediate-kill vs apply-later was builder-divergent (low) | §5.2(b) — regime-governed application: fully-live = §8 orchestration; gated regimes = NO profile-triggered kill, applies at next natural spawn/boot sweep, said out loud in the confirmation (told-out-loud precedent); breaker revert's immediate respawn stands as the keep-working exception; §11 arms assert no-kill + told-out-loud |
| R15-3 | lessons | §13-1's fold-in revisit was parked on the maturation track, but in the spec's own deferred-sink <!-- tracked: CMT-1369 --> contingency that carrier evaporates — the R6-6 "slated-with-no-carrier = abandoned" class, the sibling-asymmetry R7-9 closed elsewhere (low) | §13-1 — if the maturation-track sink is deferred, <!-- tracked: CMT-1369 --> the revisit registers as a durable CommitmentTracker commitment tied to a named release (same clause as the §12 legacy-mirror sibling) |

**EXTERNAL-COVERAGE SCOPE (honest stamp boundary):** external cross-model review last saw this
spec at **round 11** (Gemini: CLEAN — its fourth consecutive clean read; it reviewed every round from 1 through 11 that ran externals, landing findings in rounds 5–6 and 10). Rounds 12–16
ran **without externals**: Gemini was terminally quota-walled mid-round-12, codex/grok CLIs are
not installed on this machine, and the operator explicitly waived externals for the remainder
(Justin, 2026-06-11: "the cross model review is additional, not required"). Any external-coverage
flag on this spec's convergence therefore attests to the round-11 body only; rounds 12–16 (the
regime-scoping, recovery-write, shadow-fate, and decisions folds) are covered by the five internal
perspectives alone. This note rides the convergence report verbatim.

### Round-16 — CONVERGED

Round 16 (the confirming pass; externals waived per operator, coverage scoped above): **ALL FIVE
internal reviewers returned CLEAN / zero new material findings.** Adversarial walked the three R15
folds against the §7 regime scope, the §8 boot-sweep reconcile, the §10.4 cooldown-confirm
composition, and the §11 arms (recording four explicitly NON-material residuals, each decidable
from the normative text); integration verified all four deferral carriers <!-- tracked: CMT-1369 --> now share one
CommitmentTracker shape; lessons re-verified both upstream issues (#1060, #1063) exist and are
open, re-audited the foundation (`JKHeadley/main` tip `7267119ca` — nothing new since round 15),
and confirmed the ELI16 is true of the final body. **Convergence criterion met: zero material
findings in a full round.**
