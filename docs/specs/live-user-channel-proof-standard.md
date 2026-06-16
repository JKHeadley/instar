# Spec: Live-User-Channel Proof — the Instar Gold-Standard Testing Standard

**Status:** draft (pre-convergence)
**Author:** Echo (autonomous run, topic 13481)
**Date:** 2026-06-15
**Tracking:** CMT-1568
**Tags:** _(to be set by spec-converge)_

---

## 0. Why this exists (the earning incident)

On 2026-06-15 the operator (Justin) asked to test the multi-machine feature by
moving a live Telegram topic from the Laptop to the Mac Mini. The topic was
pinned to the Mini and reported `ok:true`, but the **seat never moved** — the
next message routed right back to the Laptop. The operator discovered this on
the **first** live interaction.

The real failure is not the transfer bug. The real failure is that **the
operator was the one who discovered it.** Every prior "test" of multi-machine
had been unit/integration tests and a single agent inspecting its own internals
("test-as-self" done as half a loop) — never a session acting as a real human
user driving the actual user channel end-to-end. A user-role session driving
Telegram **and** Slack would have caught "the seat doesn't actually move" before
the operator ever touched it.

The operator's directive, verbatim in intent:

> "The goal should be that the feature is tested in 90% of all of the scenarios
> we can think of in LIVE environments BEFORE the user ever has to test it. This
> means you have one session that takes the role of the user that then interacts
> THROUGH the user channel (which should always cover Telegram AND Slack). If the
> tests being done are volatile or dangerous or testing permissions, then these
> tests should be performed on throwaway agents with throwaway channels (demo
> slack workspace and demo telegram group). I want this to be the Instar GOLD
> STANDARD, and it should be represented and enforced by the constitution."

This spec turns that directive into: (1) a constitutional standard, (2)
structural teeth (a completion-gate veto that cannot be talked around), (3) a
user-role live-test harness that drives the real channels, and (4) the first
application of the standard — fixing and LIVE-proving the multi-machine transfer.

This is the same shape as the morning's anti-"follow-up-laundering" fix: a
standard alone is a wish (Structure > Willpower); the teeth are a structural gate
that refuses the exit.

---

## 1. Scope

In scope:

1. **The standard** — a new entry in `docs/STANDARDS-REGISTRY.md` + agent
   awareness (CLAUDE.md template) + migration to existing agents.
2. **The completion-gate teeth** — the autonomous completion judge / stop gate
   VETOES a "done"/"shipped" verdict for a **user-facing** feature unless a
   recorded **live-user-channel test artifact** exists (a scenario matrix with
   PASS/FAIL, run through Telegram AND Slack), anchored the same anti-hallucination
   way the existing `UnjustifiedStopGate` anchors artifact pointers.
3. **The user-role live-test harness** — a runner that drives a feature
   end-to-end **as a real human user through the real channels** (Telegram AND
   Slack), records the PASS/FAIL scenario matrix as the durable artifact the gate
   reads, and runs volatile/dangerous/permission scenarios on **throwaway agents
   + demo channels** (demo Slack workspace + demo Telegram group), never the live
   operator channel.
4. **First application: multi-machine transfer** — fix cross-machine
   topic-ownership replication (root-caused below) so a topic can actually move
   Laptop↔Mini, then prove it LIVE through the harness.

Out of scope (tracked, not done here):

- Retrofitting every existing user-facing feature with a live-channel artifact
  (the gate applies going forward; a backfill campaign is its own track).
- A demo-channel provisioning wizard beyond what the harness needs for the
  multi-machine proof (the harness defines the throwaway-channel contract; a
  general self-service provisioner is a follow-on).

---

## 2. Definitions

- **User-facing feature**: a capability whose behavior the operator experiences
  through a messaging channel or the dashboard (vs. purely internal infra like a
  sentinel's scoring math). The gate's veto applies only to user-facing features;
  internal-only changes are judged as today.
- **User-role session**: an Instar session that assumes the **human user's role**
  and drives a *target* through the real interface exactly as a human would —
  sending real messages on a real channel, reading the real replies — while
  (optionally) inspecting the target's internals. One loop, both lenses.
- **Live user channel**: Telegram AND Slack. "AND" is load-bearing — a feature
  proven only on Telegram is not proven (Slack has materially different session
  lifecycle, socket behavior, and threading).
- **Throwaway agent / demo channel**: a disposable agent home + a demo Slack
  workspace + a demo Telegram group used for volatile/dangerous/permission
  scenarios so the live operator channel is never the test surface.
- **Live-test artifact**: a durable, machine-written record of a harness run — a
  scenario matrix (each scenario → PASS/FAIL/BLOCKED + evidence) keyed to a
  feature id, with the channels exercised and a content hash. This is the object
  the completion gate reads. The agent cannot hand-write it (§5.4).

---

## 3. The Standard (constitution)

New entry for `docs/STANDARDS-REGISTRY.md`, in the registry's existing format
(Rule / In practice / Earned from / Traces to the goal / Applied through):

> ### Live-User-Channel Proof Before Done
>
> **Rule.** A user-facing feature is not "done" until a user-role session has
> exercised it end-to-end **through the real user channels — Telegram AND Slack —
> across an enumerated scenario matrix targeting ~90% of conceivable scenarios, in
> a LIVE environment, BEFORE the operator is ever asked to test.** The operator
> discovering a defect on first use is a process failure, not a normal outcome.
>
> **In practice.** Before claiming done/shipped on a user-facing feature, run the
> user-role live-test harness: one session acts as the human user and drives the
> feature over Telegram AND Slack, recording a PASS/FAIL scenario matrix as a
> durable artifact. Volatile, dangerous, or permission-changing scenarios run on
> throwaway agents + demo channels (demo Slack workspace + demo Telegram group),
> never the live operator channel. The completion gate refuses "done" without that
> artifact (§4) — the teeth, not the willpower.
>
> **Earned from.** 2026-06-15: the multi-machine topic transfer reported success
> but never moved the seat; the operator found it on the first live test. Every
> prior "test" was unit/integration or a half-done test-as-self loop — none drove
> the real channel as a user.
>
> **Traces to the goal.** A coherent, self-evolving agent must find its own
> defects before its principal does. Shipping unproven user-facing behavior
> transfers the agent's testing debt onto the operator — the opposite of "depend
> less on me."
>
> **Applied through.** The user-role live-test harness (§5); the completion-gate
> live-test-artifact veto (§4); the Testing Integrity Standard's Tier-4
> (test-as-self) becomes "user-role live testing" and is sharpened to require the
> real-channel drive half, not just internals inspection.

Migration parity (§6): the standard's agent-awareness text goes into the CLAUDE.md
template and is migrated to existing agents; no config behavior depends on the
prose alone.

---

## 4. The teeth: completion-gate live-test-artifact veto

### 4.1 Where it hooks

Two completion surfaces exist today:

- `CompletionEvaluator.evaluate(condition, transcriptTail)` — the autonomous run's
  "is the goal met?" judge (`src/core/CompletionEvaluator.ts`). Conservative,
  small-tier model, transcript-only.
- `UnjustifiedStopGate` — the Stop-hook authority that classifies a stop as
  continue/allow/escalate (`src/core/UnjustifiedStopGate.ts`), with the
  `U_LEGIT_COMPLETION` allow-rule. It already anchors evidence to verbatim
  artifact pointers the authority cannot hallucinate.

The live-test veto is a **deterministic pre-check** that runs BEFORE the LLM
completion judgment can resolve to "done" for a user-facing feature. It mirrors
the anti-laundering veto's shape (CMT-1561): the verdict cannot be "done" while a
disqualifying condition holds. Determinism matters — the gate must not depend on
the same LLM that might be motivated to declare done.

### 4.2 The rule

For an autonomous run (or stop-gate completion) whose goal/condition is a
**user-facing feature**:

```
IF the run is about to resolve "done"/"shipped" for a user-facing feature
AND no live-test artifact exists for that feature id covering BOTH Telegram AND Slack
   with all enumerated scenarios PASS (or BLOCKED-with-recorded-real-blocker)
THEN veto the "done" verdict; emit guidance "run the user-role harness over <feature>
     through Telegram AND Slack and record the scenario matrix before this can close."
```

The veto is **non-terminal**: it returns the run to work with explicit guidance,
exactly like the context-death continue path and the anti-laundering veto.

### 4.3 Determining "user-facing"

A run is treated as user-facing when its registered goal/condition references a
user-facing surface. Resolution order (deterministic, no LLM):

1. Explicit declaration on the autonomous job / commitment:
   `userFacing: true|false` (authoritative when present).
2. Otherwise a keyword classifier over the goal text (channel/dashboard/
   message/transfer/Slack/Telegram/UX/reply/...). Classifier is advisory and
   **fail-toward-applying** the gate when ambiguous (the safe direction is to
   require proof, not to skip it). An explicit `userFacing:false` is the only way
   to opt a genuinely-internal change out.

This is a design fork (see §8 Q1) — explicit-flag-first vs classifier-first. Lean:
explicit flag wins; classifier is the fallback and biases toward applying the gate.

### 4.4 Anti-hallucination anchoring (the load-bearing part)

The artifact MUST be machine-written by the harness and **cannot be hand-authored
by the agent to buy the exit** — this is the exact failure mode the standard
exists to kill. Mechanism, mirroring `UnjustifiedStopGate`'s artifact-pointer
discipline:

- The harness writes the artifact to a canonical, confined path
  (`state/live-test-artifacts/<featureId>/<runId>.json`) and records its content
  hash in a small append-only ledger (`state/live-test-ledger.jsonl`).
- The gate's evidence collector (server-side, like the stop gate's hook-enumerated
  artifact set) reads the ledger and the artifact from disk — the agent's
  transcript claims are NEVER the evidence. A "done" verdict must cite a ledger
  entry whose featureId matches, whose `channels` ⊇ {telegram, slack}, whose
  scenario rows are all PASS/BLOCKED-real, and whose content hash verifies.
- A BLOCKED row is only honored if it carries a real, recorded external blocker
  (same bar as the anti-laundering "genuinely blocked" exemption) — a BLOCKED row
  with no exhausted-blocker evidence counts as not-proven.

### 4.5 Rollout (dark-first, dev-gated)

Ships dark behind a config flag, dev-agent-gated, dry-run first (logs the veto it
WOULD apply without blocking), per the graduated-rollout ladder and the
dark-features-dogfood-on-dev-agents rule. The flag, default state, and dev gate
follow the existing `DEV_GATED_FEATURES` / `devGatedFeatures.ts` convention.

---

## 5. The user-role live-test harness

### 5.1 Responsibility

Drive a target feature end-to-end **as a real human user, through the real
channels**, and emit the live-test artifact §4.4 reads.

It is NOT a unit/integration test (those still apply per the Testing Integrity
Standard). It is the Tier-4 "user-role live test" — the real-channel drive that
test-as-self was supposed to be but had been half-doing (internals-only).

### 5.2 Shape

A scenario matrix per feature: a list of `{ id, description, channel:
telegram|slack|both, volatility: safe|volatile|permission, steps[], expect }`.
The harness, for each scenario:

1. Picks the surface: **safe** scenarios may run on the live operator's own
   channels read-as-user (non-destructive); **volatile/permission** scenarios run
   on throwaway agent + demo channel (§5.3).
2. Sends the real user input on the real channel (Telegram send / Slack post) as
   the user-role actor.
3. Reads the real reply from the channel and asserts `expect` (content, which
   machine answered, no-double-voice, history carried, latency bound).
4. Records PASS/FAIL/BLOCKED + evidence (message ids, the observed reply, the
   resolved owner machine) into the artifact.

### 5.3 Throwaway agents + demo channels

- A **demo Telegram group** and a **demo Slack workspace** are registered in
  config as the throwaway surfaces (`liveTest.demoChannels`). Volatile/permission
  scenarios target these, never the operator's live channel.
- A **throwaway agent home** (disposable `.instar` under a temp root) is spun for
  scenarios that mutate agent state irreversibly (permission grants, destructive
  ops). Reuses the existing `test-as-self` throwaway-home machinery
  (`instar test-as-self` deploys dist into a throwaway home) where possible.
- The harness MUST refuse to run a `volatile|permission` scenario against a live
  operator channel (a structural guard, not a convention).

### 5.4 How the actor drives the channels

The user-role actor needs to send/receive on Telegram and Slack as a *user*, not
as the agent's outbound relay. Two candidate mechanisms (design fork §8 Q2):

- **A. API-level injection** — the harness injects an inbound message via the
  platform adapter's receive path (simulating a user message arriving) and reads
  the outbound the agent produces. Fast, deterministic, no external creds; risk:
  it bypasses the real platform transport (the very layer that broke nothing here,
  but could mask a real transport bug).
- **B. Real-account drive** — the harness logs in as a real human (Telegram user
  account / Slack user via the demo workspace) and sends genuine messages through
  the platform, reading genuine replies. Highest fidelity (this is literally what
  the operator does); cost: real creds + Playwright/native client + slower.

Lean: **B for the headline proof** (the operator's exact path is the only thing
that would have caught this class of bug), with **A available** as a fast inner
loop for breadth. The standard's bar ("through the real user channel") is only
satisfied by B for the artifact the gate accepts; A-only runs are recorded but do
not satisfy the veto. This keeps the teeth honest.

### 5.5 Layered tests for the harness itself

Per the Testing Integrity Standard, the harness ships with unit (scenario-matrix
parsing, artifact writing, veto evidence matching), integration (the gate reads a
real artifact from the ledger and vetoes/permits correctly over HTTP), and E2E
("the harness is alive" — it can drive a demo channel and write a verifying
artifact). The "feature is alive" E2E is the single most important test.

---

## 6. Migration parity

- **CLAUDE.md template** (`src/scaffold/templates.ts` → `generateClaudeMd`): add
  the standard's awareness text + the harness/gate triggers.
- **PostUpdateMigrator**: `migrateClaudeMd` / `migrateAgentMdSections` append the
  standard section to existing agents (content-sniff guarded, idempotent);
  `migrateConfig` adds the new dark flags + `liveTest` defaults (existence-checked,
  never overwriting).
- **Skill**: the existing `test-as-self` skill is reframed as user-role live
  testing and points at the harness (idempotent skill-content migration, scoped to
  the default-skill allowlist).
- The conformance/standards-coverage audit (when live) will see the standard names
  a real guard on disk (the veto + the harness), not a documented-only wish.

---

## 7. First application: multi-machine transfer (the proof case)

### 7.1 Root cause (grounded, v1.3.586)

`SessionOwnershipRegistry` uses `InMemorySessionOwnershipStore`
(`src/core/SessionOwnershipRegistry.ts:32-62`) with **no cross-machine
replication**. Its own doc comment says the durable cross-machine store
("git single-ref-per-session push, mirroring `GitLeaseStore`") "swaps in for the
Track-H real-hardware proof" — it was **never wired in**. Consequently:

1. `POST /pool/transfer` on the source writes a `place`→`claim` CAS for the target
   into the **source's** in-memory Map (`routes.ts:12249-12250`) and sets a
   router-local pin (`routes.ts:12175`).
2. The coherence journal `emitPlacement` carries **metadata** (owner, epoch,
   reason) — not the ownership record itself — and the target never materializes
   an ownership record from it on the inbound path (`routes.ts:12239-12244`).
3. On the next inbound message, owner resolution reads the **local** in-memory
   store (`server.ts:16002-16012`); the target's Map is empty → `{owner:null}`.
4. `SessionRouter.dispatchOne` treats a null owner as **Unowned → place+claim
   locally** (`src/core/SessionRouter.ts:259`) instead of forwarding to the owner.
5. The pin that would force a forward is **also router-local** and never synced to
   the target (`server.ts:15643-15646`).

Net: the transfer pins and CASes on the source, but neither the ownership record
nor the pin crosses, so the seat cannot move. (In the operator's run the
source-side `placedOwnership` also came back `false`; the dominant architectural
defect — non-replicated ownership — makes the move impossible even when the
source CAS succeeds, so the fix targets replication; the source-side CAS-false
sub-reason is pinned during build with a live repro.)

### 7.2 Fix design (fork — §8 Q3)

The seat must move means: after a transfer, the **target** machine must resolve
itself as the topic's owner on inbound, and the **source** must forward (or have
released) so it does not re-place locally.

Two candidate designs:

- **A. Durable replicated ownership store** — wire the long-intended
  `GitLeaseStore`-style single-ref-per-session durable store behind
  `SessionOwnershipRegistry` (the "swaps in" the comment promised). Both machines
  read/write the same durable ref; ownership is globally consistent. Cleanest,
  matches the original design intent; cost: heavier, git-ref round-trip latency on
  the routing path, more failure modes.
- **B. Cooperative push handoff on transfer** — the transfer leg (which already
  contacts the target via `sendDrain`/working-set carrier) **pushes the ownership
  record + pin to the target** as part of the move, and the target CASes itself
  active before the move returns. The journal already replicates placement entries;
  add a receiver that **materializes an ownership record from a replicated
  placement entry** so an inbound on the target resolves owner=self. Smaller,
  reuses existing drain/carrier/journal seams; cost: handoff must be atomic enough
  that a crash mid-move can't strand the topic ownerless (mitigated by the pin +
  the existing reconciler).

Lean: **B** — materialize ownership on the receiver from the replicated placement
journal entry, and sync the pin to the target during transfer, so routing is
correct immediately rather than after a journal round-trip. It is the
smallest-correct change consistent with the existing replication infra and avoids
putting a git-ref round-trip on the hot routing path. A is the fallback if B can't
be made crash-safe without effectively rebuilding A.

### 7.3 Surface the false positive

`POST /pool/transfer` returning `ok:true` while `placedOwnership=false` /
`releasedLocalOwnership=false` is a lie-by-omission. The transfer response must
distinguish "the seat moved" from "the pin is set but ownership did not move." A
move that did not actually transfer ownership (and isn't a legitimate
already-there noop) returns a non-ok / explicit `seatMoved:false` with the reason,
so a caller (and the harness) can never read "ok" as "moved."

### 7.4 The proof

Apply the standard: run the harness over the transfer through **Telegram AND
Slack** on a throwaway topic. Required PASS scenarios (≥90% of the conceivable
matrix), each with recorded evidence:

- Idle topic Laptop→Mini: next message resolves owner=Mini, reply comes FROM the
  Mini, conversation history carried, no re-greeting.
- Active topic Laptop→Mini (drain leg): in-flight turn completes, then the seat
  moves; no double-voice (exactly one machine answers each message).
- Mini→Laptop reverse.
- Offline-target: transfer to an offline Mini → honest `needsConfirmation` / safe
  refusal, no half-move, no ownerless strand.
- The false-positive guard: a transfer that doesn't move ownership reports it.
- Same matrix over **Slack** (different session lifecycle).

The run is judged on this matrix existing as a real artifact with all rows PASS —
the bar the whole 24h run is held to.

---

## 8. Design forks (for spec-converge reviewers)

- **Q1 — "user-facing" classification:** explicit-flag-first (lean) vs
  classifier-first vs require-explicit-always. Lean: explicit flag wins,
  classifier fallback biases toward applying the gate.
- **Q2 — harness channel drive:** API-injection (fast, lower fidelity) vs
  real-account drive (high fidelity, the operator's exact path). Lean: real-account
  drive for the gate-satisfying artifact; API-injection as a fast breadth loop that
  does NOT satisfy the veto.
- **Q3 — transfer fix:** durable replicated store (A) vs cooperative push handoff
  + journal-materialized ownership on the receiver (B, lean).
- **Q4 — gate strictness at rollout:** dry-run-log-only first (lean, per dark
  rollout) vs warn vs hard-veto. Lean: dry-run → warn → veto on the graduated
  ladder.
- **Q5 — Slack "AND" hardness:** is Telegram-only ever sufficient (e.g. a feature
  with no Slack surface)? Lean: if the feature has a Slack surface, Slack is
  required; a feature genuinely absent from Slack records that absence as an
  explicit, audited exemption rather than silently passing on Telegram alone.

---

## 9. Acceptance criteria

1. The standard is in `docs/STANDARDS-REGISTRY.md` and migrated to existing agents.
2. The completion gate vetoes "done" for a user-facing feature lacking a verified
   live-test artifact (Telegram AND Slack), anchored anti-hallucination, dark-gated,
   dry-run-first — with unit + integration + E2E tests (both sides of the boundary).
3. The user-role harness drives Telegram AND Slack, writes the artifact the gate
   reads, refuses volatile scenarios on live channels — with unit + integration +
   E2E ("alive") tests.
4. The multi-machine transfer actually moves the seat (ownership + pin replicate),
   the false-positive is surfaced, and it is PROVEN LIVE through the harness over
   Telegram AND Slack with a recorded all-PASS scenario matrix.
5. Zero-failure suite; migration parity; deployed to both machines.

---

## Open questions

*(none)*
