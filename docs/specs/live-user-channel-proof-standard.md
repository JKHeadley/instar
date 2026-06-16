---
title: "Live-User-Channel Proof — the Instar Gold-Standard Testing Standard"
slug: "live-user-channel-proof-standard"
author: "echo"
parent-principle: "Observation Needs Structure"
eli16-overview: "live-user-channel-proof-standard.eli16.md"
review-convergence: "2026-06-16T02:57:30.138Z"
review-iterations: 6
review-completed-at: "2026-06-16T02:57:30.138Z"
review-report: "docs/specs/reports/live-user-channel-proof-standard-convergence.md"
cross-model-review: "codex-cli:gpt-5.5"
single-run-completable: true
frontloaded-decisions: 5
cheap-to-change-tags: 3
contested-then-cleared: 2
approved: true
approved-by: "echo (autonomous run, standing pre-approval — Justin 2026-06-15 'start a 24h autonomous session to implement this'; design-fork autonomy granted)"
---

# Spec: Live-User-Channel Proof — the Instar Gold-Standard Testing Standard

**Status:** converged (iteration 6) + self-approved under standing autonomous pre-approval
**Author:** Echo (autonomous run, topic 13481)
**Date:** 2026-06-15
**Tracking:** CMT-1568

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

This is the same shape as the morning's anti-laundering fix: a
standard alone is a wish (Structure > Willpower); the teeth are a structural gate
that refuses the exit.

---

## 1. Scope

In scope:

1. **The standard** — a new entry in `docs/STANDARDS-REGISTRY.md` + agent
   awareness (CLAUDE.md template) + migration to existing agents.
2. **The completion-gate teeth** — the autonomous completion judge / stop gate
   VETOES a "done"/"shipped" verdict for a **user-facing** feature unless a
   recorded, **signed** live-user-channel test artifact exists (a scenario matrix
   with PASS/FAIL covering the required risk categories §4.6, run through the
   feature's real surfaces — Telegram AND Slack for channel features), anchored the
   same anti-hallucination way `UnjustifiedStopGate` anchors artifact pointers.
3. **The user-role live-test harness** — a runner that drives a feature
   end-to-end **as a real human user through the real channels** (Telegram AND
   Slack), records the signed PASS/FAIL scenario matrix as the durable artifact the
   gate reads, and runs volatile/dangerous/permission scenarios on **throwaway
   agents + isolated demo channels** (demo Slack workspace + demo Telegram group),
   never the live operator channel.
4. **First application: multi-machine transfer** — fix cross-machine
   topic-ownership replication (root-caused below) so a topic can actually move
   Laptop↔Mini, then prove it LIVE through the harness.

Out of scope (tracked, not done here):

- Retrofitting every existing user-facing feature with a live-channel artifact
  (the gate applies going forward; a backfill campaign is its own track).
- A self-service demo-channel provisioning wizard beyond the deterministic
  config + migration contract the harness needs (§5.3).

---

## 2. Definitions & glossary

- **User-facing feature**: a capability whose behavior the operator experiences
  through a messaging channel OR the dashboard (vs. purely internal infra like a
  sentinel's scoring math). The gate's veto applies only to user-facing features.
- **Surface**: where a feature is experienced — `channel` (Telegram/Slack) and/or
  `dashboard`. Proof requirements are surface-specific (§4.5).
- **User-role session**: an Instar session that assumes the **human user's role**
  and drives a *target* through the real interface exactly as a human would —
  sending real messages on a real channel, reading the real replies — while
  optionally inspecting the target's internals. One loop, both lenses.
- **Live user channel**: Telegram AND Slack. "AND" is load-bearing for a channel
  feature — Slack has materially different session lifecycle, socket behavior, and
  threading than Telegram.
- **Throwaway agent / demo channel**: a disposable agent home + an **isolated** demo
  Slack workspace (NOT the operator's) + a demo Telegram group, used for
  volatile/dangerous/permission scenarios so the live operator channel is never the
  test surface.
- **Live-test artifact**: a durable, **harness-written + signed** record of a run —
  a scenario matrix (each scenario → PASS/FAIL/BLOCKED + evidence) keyed to
  `{featureId, runId}`, with the surfaces exercised, the risk categories covered,
  a canonical content hash, and an Ed25519 signature over that hash. The object the
  completion gate reads. The agent cannot hand-write it to buy the exit (§4.4).
- **seat** (multi-machine): the live ownership of a topic — which machine actually
  serves it and answers the user. "Move the seat" = the conversation genuinely runs
  on the destination machine, not just a pin pointing at it.
- **pin** (`topicPinStore`): a router-local hint recording which machine a topic
  *prefers*. Today it is set on transfer but not synced cross-machine (a defect §7).
- **CAS / ownership record / epoch**: the `SessionOwnershipRegistry`'s
  compare-and-swap over a per-topic record (`place`→`claim`→`active`/`release`),
  carrying a monotonically increasing `ownershipEpoch` so a stale write loses to a
  fresher one.
- **drain leg**: the transfer step that finishes the in-flight turn on the source,
  suspends any autonomous run, and hands the topic to the target so an active
  conversation moves whole rather than half-moving.
- **reconciler** (`OwnershipReconciler`): the background process that converges
  ownership when records disagree, so a crash mid-move resolves to exactly one
  owner.

---

## 3. The Standard (constitution)

New entry for `docs/STANDARDS-REGISTRY.md`, in the registry's existing format
(Rule / In practice / Earned from / Traces to the goal / Applied through):

> ### Live-User-Channel Proof Before Done
>
> **Rule.** A user-facing feature is not "done" until a user-role session has
> exercised it end-to-end **through its real user surface — Telegram AND Slack for
> a channel feature, the real dashboard for a dashboard feature — across the
> required risk categories, in a LIVE environment, BEFORE the operator is ever asked
> to test.** The operator discovering a defect on first use is a process failure,
> not a normal outcome.
>
> **In practice.** Before claiming done/shipped on a user-facing feature, run the
> user-role live-test harness: one session acts as the human user and drives the
> feature over its real surface, recording a signed PASS/FAIL scenario matrix that
> covers the required risk categories (happy-path, channel-parity, lifecycle
> boundaries, permission/volatile, failure/rollback, concurrency, idempotency,
> regression). Volatile, dangerous, or permission-changing scenarios run on
> throwaway agents + isolated demo channels, never the live operator channel. The
> completion gate refuses "done" without that artifact (§4) — the teeth, not the
> willpower.
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
> (test-as-self) is sharpened to "user-role live testing" — the real-channel drive
> half is required, not just internals inspection.

Migration parity (§6): the standard's agent-awareness text goes into the CLAUDE.md
template and is migrated to existing agents; no behavior depends on the prose alone.

---

## 4. The teeth: completion-gate live-test-artifact veto

### 4.1 Where it hooks

Two completion surfaces exist today:

- `CompletionEvaluator.evaluate(condition, transcriptTail)` — the autonomous run's
  "is the goal met?" judge (`src/core/CompletionEvaluator.ts`).
- `UnjustifiedStopGate` — the Stop-hook authority (`src/core/UnjustifiedStopGate.ts`)
  with the `U_LEGIT_COMPLETION` allow-rule, already anchoring evidence to verbatim
  artifact pointers the authority cannot hallucinate.

The live-test veto is a **deterministic pre-check** that runs BEFORE a "done"
verdict can resolve for a user-facing feature. It mirrors the anti-laundering veto
(CMT-1561).

### 4.2 Signal vs. Authority — where the blocking authority lives (conformance + lessons-aware finding)

The keyword classifier (§4.3) is a **brittle low-context filter** and therefore
holds **NO blocking authority** (Signal vs. Authority). Blocking authority rests
ONLY on two **objective** facts:

1. **An author-declared `userFacing` value** (an objective declaration on the
   job/commitment, not a guess), and
2. **The presence-or-absence of a verified, signed live-test artifact** (an
   objective on-disk fact).

The block is: `userFacing == true (declared) AND no verified artifact → veto`. The
classifier never blocks by itself; it only emits **signals**:

- When `userFacing` is undeclared and the goal text looks user-facing → the
  classifier **surfaces** "declare `userFacing` and run the harness, or justify
  `userFacing:false`" and the run is returned to work (a non-terminal nudge, not a
  hard block on an unverifiable guess).
- When `userFacing:false` is declared but the changed files / touched surfaces look
  like they contradict it → this is raised as a **surfaced review signal** (an
  attention item + a recorded `userFacingWaiverContested` note), NOT a standalone
  veto. "Touched surfaces" detection is itself heuristic, so per Signal-vs-Authority
  it may not hold blocking authority; making it a hard block would re-introduce
  exactly the classifier-authority the design rejects (codex r2 finding). The
  contradiction is made VISIBLE (the operator/reviewer sees the questionable waiver)
  rather than silently honored — which closes the escape hatch through *visibility*,
  not a brittle auto-block. (A future objective surface-ownership manifest — reviewed
  path→surface mappings — could upgrade this to a deterministic hard signal; until
  that exists, it is signal-only.)
- **In `veto` mode specifically (the end state), a contradicted waiver is not free**
  (codex r4): a `userFacing:false` whose surfaced signal conflicts requires an
  **operator-attested** waiver (recorded attestation) OR the path→surface manifest
  before it suppresses the gate. In `dry-run`/`warn` it is signal-only as above. So the
  hard-teeth state cannot be talked around by an un-reviewed self-waiver, while the soak
  states stay non-blocking.

`CompletionEvaluator` cannot override the veto: the artifact is objective, so the
"is it proven?" question is not an LLM judgment. The "is it user-facing?" scope IS
the declared/objective side. This split is stated explicitly so the
authority-placement is consistent with the rest of the system (the LLM judges
fuzzy end-state; structure enforces objective facts).

### 4.3 Determining "user-facing" (signal only)

Resolution order (deterministic, no LLM authority):

1. Explicit `userFacing: true|false` on the autonomous job / commitment —
   authoritative.
2. Otherwise the keyword classifier (deterministic, whole-word/boundary match over a
   fixed, unit-tested keyword set: channel, dashboard, message, transfer, Slack,
   Telegram, UX, reply, …) emits a **signal** per §4.2 — never a standalone block.

`userFacing:false` requires a recorded `userFacingWaiverReason` AND is **always surfaced
on the "done" claim** (recorded + operator-visible on every such claim, not only when a
heuristic contests it — codex r5) — so a misdeclared scope cannot pass silently even if
the touched-surface heuristic misses it. A waiver that looks like it conflicts with
touched surfaces is additionally flagged for review (signal-only, §4.2); in `veto` mode a
contradicted waiver requires operator attestation. The path→surface manifest, once it
exists, upgrades the contradiction check to deterministic.

### 4.4 Anti-hallucination anchoring (the load-bearing part)

The artifact MUST be machine-written by the harness and **cannot be hand-authored
by the agent to buy the exit** — the exact failure mode the standard exists to kill.
Mechanism (hardening the `UnjustifiedStopGate` artifact-pointer discipline with the
security reviewers' findings):

- **Canonical serialization + content hash.** The harness serializes the artifact
  canonically (sorted keys, normalized line endings), computes `sha256` at
  write-time, and writes the artifact to `state/live-test-artifacts/<featureId>/<runId>.json`.
- **Signature + runner identity.** The harness signs the content hash with an
  Ed25519 key bound to the **harness runner identity** (the machine/agent that ran
  it). The ledger entry (`state/live-test-ledger.jsonl`) records
  `{featureId, runId, contentHash, signature, runnerFingerprint, channels|surfaces,
  riskCategories, createdAt, prevEntryHash}`.
- **Hash-chained, single-writer-per-machine ledger (codex r4 — avoid concurrent-append
  divergence).** Each MACHINE appends only to **its own ledger segment**
  (`state/live-test-ledger.<machineId>.jsonl`), hash-chained **within that segment** — so
  there is never cross-machine concurrent append to one file, no order-dependent merge,
  and replication only ever *adds* a peer's segment (it cannot fork a shared chain). The
  gate reads the **union** of all segments. A broken chain *within a segment* is a real
  tamper signal (reject that segment's entries); a missing peer segment is just
  replication lag (treated as not-yet-proven on this machine, never a false veto of an
  unrelated feature). This removes the "two machines append → false broken-chain veto"
  failure mode.
- **Gate verification (server-side, like the stop gate's hook-enumerated evidence).**
  A "done" verdict must cite a ledger entry whose `featureId` matches the run's goal
  (§4.7), whose surfaces satisfy §4.5, whose risk categories satisfy §4.6, whose
  signature verifies against a trusted runner key, whose `contentHash` **re-verifies
  against the artifact re-read from disk** (mismatch → TAMPERED → reject), and whose
  rows are all PASS or BLOCKED-real (§4.6). The agent's transcript claims are NEVER
  the evidence.
- **Recency + replay.** The gate uses the **freshest** `{featureId, runId}` entry and
  requires it to be from the current autonomous session (or the immediately preceding
  one); a stale-artifact replay is rejected.
- **Threat model (honest, like `UnjustifiedStopGate`).** This is **drift-correction,
  NOT a security boundary against a compromised runner.** The signing + hash-chain
  defend against an LLM *drifting* into self-certification (hand-authoring an artifact
  to buy "done") — they make that require deliberate, multi-step forgery rather than a
  one-line transcript claim. A deliberately adversarial runner that controls both the
  artifact and the ledger before replication can still forge the chain; we do not
  claim otherwise. The cheap external strengthening is that artifacts + ledger are
  **committed to git** as part of the run, so git history is an out-of-band,
  agent-write-fenced anchor (tampering after the fact is visible in the diff). A
  server-side monotonic ledger outside agent write authority is the stronger follow-on
  if the threat model ever needs to harden.
- **`seatMoved:false` poison rule.** Any scenario whose recorded evidence contains a
  feature-level failure signal (e.g. `seatMoved:false`, an `ok:true`-but-no-effect
  response) is recorded as **FAIL** — it can never sit under a PASS row. A PASS row
  whose evidence contradicts the verdict poisons the artifact (rejected).
- **What the signature does and does NOT prove (codex r3 — narrow the claim).** The
  signature proves **harness-origin + tamper-evidence**, NOT scenario adequacy — a
  trusted key signed this, not "a meaningful scenario truly ran." So a PASS row MUST
  carry **deterministic protocol evidence captured from the real platform**, which is
  the primary evidence: the platform **message ids** (Telegram message_id / Slack ts),
  channel/group id, sender + responder ids, the **responder machine id** + an
  **ownership-record snapshot** (for transfer scenarios), and timestamps. A row whose
  protocol evidence is absent or internally inconsistent (e.g. responder machine ≠ the
  expected owner) is rejected regardless of its verdict. This is the non-LLM, objective
  spine of the artifact; the signature is the wrapper, the protocol evidence is the
  substance.

### 4.5 Surface-specific proof (codex finding)

- **Channel feature** → required surfaces = {telegram, slack}. A feature genuinely
  absent from Slack records that absence as an explicit, audited exemption
  (`surfaceExemption: {surface:"slack", reason}` in the artifact), never a silent
  Telegram-only pass.
- **Dashboard feature** → required surface = a browser-driven live check (the harness
  drives the real dashboard via Playwright and asserts the rendered result) recorded
  as the artifact.
- **Both** → both surfaces required.

### 4.6 Risk-category coverage + BLOCKED taxonomy (codex/lessons/decision findings)

"~90% of conceivable scenarios" is replaced by **required risk-category coverage** —
objective and gate-checkable. The artifact must cover, per applicable surface:
**happy-path, channel-parity (Telegram vs Slack agree), lifecycle boundaries
(restart/transfer/wedge), permission/volatile, failure/rollback, concurrency,
idempotency, regression.** Uncovered categories are recorded explicitly; the gate
requires every applicable category present with at least one PASS (a category with
only BLOCKED rows is not covered).

Categories are a **floor, not a checklist to box-tick** (codex r2 finding). The matrix
declares, per feature, which categories apply and a one-line **per-category rationale**
naming the concrete scenario(s) that exercise it — so a thin category (one trivial PASS
standing in for real coverage) is *visible* to the Tier-1 supervisor (§5.6) and a
reviewer, not hidden behind a green checkmark. The category set is the minimum; a
feature with more failure modes records more.

**Environment-readiness vs feature-completion (codex r2 finding).** A platform outage or
missing demo credential is an *environment* problem, not a *feature* problem, and the
two are separated so ordinary shipping is not held hostage to third-party state. The gate
is already per-feature, so a Slack outage only affects features with a Slack surface. For
those: a recent **harness-health artifact** (Telegram/Slack infra reachable) is the
environment precondition; when the platform is genuinely down, the load-bearing
categories (happy-path, channel-parity) **cannot** be proven, so the feature is honestly
**not-done-yet** (the correct outcome — don't ship unproven). The escape valve is an
**operator-gated, time-bounded platform-unavailable waiver** (recorded, attested,
expiring) that permits a *degraded release class* with the unproven surface explicitly
flagged — never a silent pass, and never self-granted.

**BLOCKED taxonomy.** A BLOCKED row is honored ONLY when it carries a recorded,
machine-verifiable external blocker: a platform API error (status code + body
captured), an external-service outage (with expiry/retry recorded), or an
operator-approved exemption (recorded in the ledger with attestation). A
self-authored BLOCKED with no recorded external error counts as **FAIL**. BLOCKED
never satisfies a **happy-path** or **channel-parity** scenario (the load-bearing
ones) — those must PASS.

### 4.7 featureId provenance (security/decision finding)

`featureId` is derived from an authoritative source: the run's CMT commitment id or
GitHub issue/PR if present, else a slug deterministically derived from the goal;
immutable once assigned and recorded in both artifact and ledger. The gate validates
that the cited `featureId` matches the current run's goal/condition — an artifact for
a different feature cannot satisfy this run.

### 4.8 Rollout (dark-first, dev-gated, graduated)

Ships dark behind `monitoring.liveTestGate` (dev-agent-gated, omit `enabled` per the
dev-gate convention; registered in `DEV_GATED_FEATURES`). Strictness ladder
`mode: "dry-run" | "warn" | "veto"` (default `dry-run` — logs the veto it WOULD apply
without blocking), promoted along the graduated-rollout ladder.

**Dry-run is a bounded soak, not permanent theater (conformance: Structure beats
Willpower).** The end state is `veto` — the structural teeth. `dry-run`/`warn` exist only
to measure false-positive rate before the teeth bite, and the promotion is a **tracked,
time-bounded obligation** (a registered commitment with a promotion criterion: e.g. "N
dev-agent runs with zero false-positive vetoes → promote to `warn`, then `veto`"), so it
**Closes the Loop** rather than resting in dry-run forever. A gate stuck in dry-run past
its soak window surfaces as an overdue commitment, not silent willpower. On the dev agent
the gate runs live-in-dry-run from day one (dogfood); the fleet promotion follows the
measured soak. When the gate cannot
verify an artifact (ledger stale/unreadable on this machine), it treats the feature as
**not-proven → veto (return-to-work)** — the safe direction is to keep working until
proof exists, which is non-destructive (it never lets a false "done" through, and
never hard-stalls since the run simply continues its job). This is distinct from an
*advisory* gate's fail-open; a safety veto fails toward requiring proof.

---

## 5. The user-role live-test harness

### 5.1 Responsibility

Drive a target feature end-to-end **as a real human user, through the real
surface**, and emit the signed live-test artifact §4.4 reads. It is the Tier-4
"user-role live test" — the real-channel drive test-as-self was supposed to be but
had been half-doing (internals-only). Unit/integration tests still apply (Testing
Integrity Standard).

### 5.2 Shape

A scenario matrix per feature: `{ id, description, surface: telegram|slack|dashboard,
riskCategory, volatility: safe|volatile|permission, steps[], expect, timeoutMs }`.
For each scenario the harness:

1. Picks the surface per §5.3 (safe → may use the operator's own channel read-as-user,
   non-destructive; volatile/permission → throwaway agent + demo channel only).
2. Sends the real user input on the real surface as the user-role actor.
3. Reads the real reply and asserts `expect` (content, which machine answered,
   no-double-voice, history carried, latency bound).
4. Records PASS/FAIL/BLOCKED + evidence (message ids, observed reply, resolved owner
   machine) into the artifact.

### 5.3 Throwaway agents + isolated demo channels (security/adversarial findings)

- **Isolation is structural, not convention.** Demo channels live in **separate
  workspaces/groups** from the operator's (the demo Slack workspace is NOT the
  operator's workspace; a demo Telegram group). Demo-channel bindings are written
  once to `state/demo-channel-bindings.json`, **signed**, and the harness refuses to
  run if the bindings changed unsigned.
- **Credential segregation.** Demo-account credentials live in a **separate vault
  namespace** (`vault://demo/*`) from production. A `volatile|permission` scenario
  that resolves a production-tier credential or a non-whitelisted channel **throws
  before any message is sent** — the harness asserts the target channel **ID**
  (not name) is on the signed demo whitelist. Unit-tested with intentional
  mismatches.
- **Permission-scenario isolation.** Permission-changing scenarios run in a **fresh
  throwaway agent home that is discarded after**, and always **after** safe
  scenarios — a permission mutation can never bleed into a later safe scenario.
- **Transcript masking.** Credential names/values are redacted before any transcript
  or artifact capture (reuse the existing `SecretRedactor`).
- The throwaway-home machinery reuses the existing `test-as-self` deploy path where
  possible.

### 5.4 How the actor drives the surfaces (Frontloaded — D2)

Two mechanisms:

- **A. API-level injection** — inject an inbound via the platform adapter's receive
  path and read the agent's outbound. Fast, no external creds; bypasses real
  transport. Recorded as **NON-satisfying** for the gate (a fast breadth inner-loop
  only).
- **B. Real-account drive** — the harness sends genuine messages as a real human via
  the demo account (Telegram user client / Slack user in the demo workspace) and
  reads genuine replies. This is the only mechanism that produces a **gate-satisfying**
  artifact (it is the operator's exact path — the only thing that catches this bug
  class). Dashboard features use Playwright against the real dashboard (also B-class).

Credential model (D2, frontloaded): demo creds in `vault://demo/*`, provisioned via
the secret-drop/vault path, never the operator's live account by default; missing/
revoked demo creds → the affected scenario is **BLOCKED-real (credential-unavailable)
and surfaced**, never silently skipped or downgraded to A.

**Platform-sanctioned automation modes (codex r4 — ToS + token types are load-bearing).**
The harness uses only platform-APPROVED automation per surface, validated before a run:
- **Slack**: a real human actor in the **demo workspace** driven via a Slack **user
  token** scoped to that workspace (or the workspace's approved test-automation path) —
  never bot-token-masquerading-as-user, never the operator's workspace. The harness
  asserts the token type + workspace id match the signed demo binding.
- **Telegram**: a dedicated **demo bot** OR a user account in the demo group via the
  official client API where ToS-permitted; brittle/disallowed user-client automation is
  NOT used — if a surface has no ToS-compliant automation mode available, that scenario
  records **BLOCKED-real (automation-unavailable)** and is surfaced, rather than the
  harness doing something against platform policy.
The approved mode per platform is documented in the harness config and validated at
startup (fail-fast with a clear reason, never a silent fallback to a non-compliant mode).

### 5.5 Flakiness management (gemini/scalability finding)

Live external services flake. The harness: per-scenario timeout (`timeoutMs`, default
30s, range 10–120s); automatic retry (bounded, e.g. 2×) before recording anything. **A
generic timeout is recorded as FAIL by default** (codex r3) — it is NOT auto-promoted to
`BLOCKED-real`, because a timeout can equally be app slowness or a harness bug. A timeout
only becomes `BLOCKED-real` when **independently attributed** to a verified platform
outage (the harness-health probe §4.6 confirms the platform is down) or an accepted
**flake quarantine**. A run with >N timeouts escalates (harness stops, returns the
partial artifact) rather than hanging; total run cap (~10 min). Quarantine: a scenario
flagged persistently flaky is recorded as quarantined (visible, not silently dropped) and
does not satisfy its risk category.

### 5.6 Tier-1 LLM supervision (LLM-Supervised Execution standard)

The harness drives real external channels and mutates throwaway state — a critical
shipping path. **Deterministic assertions are PRIMARY and required** (codex r3): the
protocol evidence (§4.4 — message ids, channel/sender/responder ids, machine id,
ownership snapshot, no-duplicate-reply) is what passes or fails a scenario, encoded as
exact checks. Per the LLM-Supervised Execution standard, a **Tier-1 supervisor**
(Haiku-class) runs ONLY over the residue the deterministic checks cannot encode — a
**semantic/natural-language** expectation ("the reply actually answers the question,
not just that *a* reply arrived"). The supervisor is advisory (it can downgrade a PASS
it cannot semantically confirm to BLOCKED-needs-review), never the channel-driving
authority, and never the substitute for a missing deterministic check. The gate's
artifact verification (§4.4) stays deterministic — the supervisor hardens the harness's
*authoring* of NL expectations, not the gate's *reading* of the artifact. This keeps
fuzzy interpretation off the critical proof path.

### 5.7 Layered tests for the harness itself

Per the Testing Integrity Standard + L5 (State-Detection Robustness): unit
(scenario-matrix parse, canonical-hash + signature, ledger hash-chain, veto evidence
matching, both sides of the user-facing/BLOCKED/surface boundaries), integration (the
gate reads a real signed artifact from the ledger over HTTP and vetoes/permits
correctly), and E2E ("the harness is alive" — it drives a demo channel and writes a
verifying signed artifact the gate accepts). The "alive" E2E is the single most
important test. **L5 explicit:** the gate's check is deterministic (hash + signature +
schema) — rationale: artifact authenticity is an objective, signable fact, not a fuzzy
judgment; a **ledger schema version + canary** fires on an unreadable/format-drifted
ledger; the E2E proves real data flows end-to-end (no mocks-only).

---

## 6. Migration parity

- **CLAUDE.md template** (`src/scaffold/templates.ts` → `generateClaudeMd`): add the
  standard's awareness text + the harness/gate triggers.
- **PostUpdateMigrator**: `migrateClaudeMd` / `migrateAgentMdSections` append the
  standard section to existing agents (content-sniff guarded, idempotent);
  `migrateConfig` adds the dark flags + `liveTest` defaults (existence-checked).
  Config keys are committed to git and distributed; an offline machine runs the
  idempotent migration on next startup.
- **Skill**: the `test-as-self` skill is reframed as user-role live testing and points
  at the harness (idempotent skill-content migration, scoped to the default-skill
  allowlist).
- The conformance/standards-coverage audit will see the standard names a real guard on
  disk (the veto + the harness), not a documented-only wish.

---

## 7. First application: multi-machine transfer (the proof case)

### 7.1 Root cause (grounded, v1.3.586)

`SessionOwnershipRegistry` uses `InMemorySessionOwnershipStore`
(`src/core/SessionOwnershipRegistry.ts:32-62`) with **no cross-machine replication**.
Its own doc comment says the durable cross-machine store ("git single-ref-per-session
push, mirroring `GitLeaseStore`") "swaps in for the Track-H real-hardware proof" — it
was **never wired in**. Consequently:

1. `POST /pool/transfer` on the source writes a `place`→`claim` CAS for the target into
   the **source's** in-memory Map (`routes.ts:12249-12250`) and sets a router-local pin
   (`routes.ts:12175`).
2. The coherence journal `emitPlacement` carries **metadata** (owner, epoch, reason) —
   not the ownership record itself — and the target never materializes an ownership
   record from it on the inbound path (`routes.ts:12239-12244`).
3. On the next inbound, owner resolution reads the **local** in-memory store
   (`server.ts:16002-16012`); the target's Map is empty → `{owner:null}`.
4. `SessionRouter.dispatchOne` treats a null owner as **Unowned → place+claim locally**
   (`src/core/SessionRouter.ts:259`) instead of forwarding to the owner.
5. The pin that would force a forward is **also router-local** and never synced to the
   target (`server.ts:15643-15646`).

Net: the transfer pins and CASes on the source, but neither the ownership record nor
the pin crosses, so the seat cannot move. (In the operator's run the source-side
`placedOwnership` also came back `false`; the dominant defect — non-replicated
ownership — makes the move impossible even when the source CAS succeeds, so the fix
targets replication; the source-side CAS-false sub-reason is pinned during build with
a live repro.)

### 7.2 Fix design (D3 — DECIDED after cross-model review: durable replicated store)

**Both external reviewers (gemini, codex) plus three internal reviewers** rejected the
original "cooperative push handoff" lean as reinventing distributed lease/consensus
(atomicity, split-brain, epochs, exactly-one-owner convergence). **Decision reversed**
to the design the code comment always intended:

**Wire the durable, cross-machine-replicated ownership store behind
`SessionOwnershipRegistry`** — the `GitLeaseStore`-style single-ref-per-session
durable record, mirroring the existing replicated-state machinery (the same
coherence-journal replication path the 7 memory stores now use). Concretely:

- The ownership record is **persisted and replicated** (not an in-memory Map): a CAS
  `place`/`claim`/`release` writes the durable record, which replicates to peers via
  the existing journal-replication path. The target machine reads ownership from the
  **replicated durable record** (`store.read(sessionKey)` hits the persisted/replicated
  state), so an inbound on the target resolves `owner=self`.
- **Off the hot path (the latency answer that drove the original lean).** The routing
  hot path reads an **in-memory cache** of the ownership record; the cache is
  invalidated by a new replicated journal entry (watch/subscription) or a short TTL.
  The durable/replicated write is **not** inline on every message — only on an
  ownership *transition*. So the hot path stays an in-memory read; the git-ref/replication
  round-trip happens only on transfer, not per message. SLO: ownership read <100ms p99.
- **Epochs + reconciler for crash-safety.** The existing `ownershipEpoch` orders writes;
  `OwnershipReconciler` converges divergent records to exactly one owner. A transfer
  records the placement with a fresh epoch; a concurrent/raced write loses to the
  higher epoch.
- The pin is also synced to the target (or made unnecessary by the replicated record) so
  routing is correct from the replicated ownership, not a router-local pin.

**Consistency contract under partition (codex r2 — "git refs are not consensus").** This
is **CP-leaning, lease-fenced**, aligned with instar's EXISTING fenced-lease awake-machine
model (the numbered "who's in charge" badge) rather than a new consensus service:

- **Lease authority (made concrete, codex r3).** The authority is the EXISTING fenced
  awake-machine lease (`multiMachine.syncStatus.leaseHolder` / `leaseEpoch` — the
  numbered "who's in charge" badge), NOT a new service. The **fencing token** is that
  `leaseEpoch`; it is issued/renewed by the existing lease machinery (clock-proof,
  monotonic across restarts — a restart re-acquires under a higher epoch, never reuses an
  old one). **Compare/write atomicity** is the durable store's CAS over the
  `{ownerMachineId, ownershipEpoch, leaseEpoch}` record (a single atomic ref update).
  **Reconciliation precedence:** higher `ownershipEpoch` wins; ties broken by higher
  `leaseEpoch`; a record carrying a `leaseEpoch` below the current lease is stale and
  discarded.
- An ownership transition is authorized by the **lease holder** and stamped with the
  **fencing token** (lease epoch). A write carrying a stale fencing token is rejected —
  this is the split-brain guard.
- **Under partition / unreachable remote, the transfer REFUSES rather than completing
  optimistically** (it reuses the existing offline-target `needsConfirmation` path). We do
  not move a seat we cannot durably hand off — the safe direction is "the topic stays whole
  on its current machine," never two optimistic owners. Exactly-one-owner is preserved by
  refusing the move when the remote authority can't be reached, not by hoping replication
  catches up.
- Availability tradeoff stated honestly: a partition makes a *cross-machine move*
  temporarily unavailable (it refuses); it does NOT make the *existing* owner stop serving.
  The conversation keeps working where it is.
- **Claim scope, narrowed honestly (codex r4).** "Exactly-one-owner" holds *given* the
  existing fenced lease's mutual-exclusion invariant (one lease holder at a time, monotonic
  epoch). This layer does NOT independently re-solve lease split-brain — where the LEASE
  itself is in an unresolved split-brain (the rare case the existing system surfaces to the
  operator as an attention item), ownership transfer **refuses** rather than asserting a
  resolution the lease layer hasn't reached. We claim exactly-one-owner *under a healthy
  lease*, and *refuse-on-doubt* otherwise — not a new consensus guarantee.

This is no longer a bespoke protocol — it reuses the proven replicated-state + reconciler
+ fenced-lease infrastructure, with caching to keep reads off the hot path.

### 7.3 Crash-safety contract (§9.4; security/lessons findings)

Formally: at every step (pin-set → durable place → durable claim → cache-invalidate),
a crash leaves the topic owned by **exactly one** machine after the reconciler runs —
never zero, never two:

- Epochs make a half-written transition lose to the last fully-committed one.
- A message arriving during an ownership-in-flight window routes **conservatively**:
  it is **queued as ownership-contention** (the existing `placing`/`transferring`
  branch in `SessionRouter`), never double-routed and never lost.
- Bound: the reconciler runs on a fixed cadence (config) and on inbound contention; a
  topic is never ownerless longer than one reconciler cadence, and contended messages
  queue rather than mis-route during it.

### 7.4 Surface the false positive

`POST /pool/transfer` returning `ok:true` while ownership did not move is a
lie-by-omission. The response must distinguish "seat moved" from "pin set but ownership
did not move": a move that did not actually transfer ownership (and isn't a legitimate
already-there noop) returns a non-ok / explicit `seatMoved:false` with the reason, so a
caller (and the harness) can never read "ok" as "moved." The harness records
`seatMoved:false` as a scenario FAIL (§4.4 poison rule).

### 7.5 The proof

Apply the standard: run the harness over the transfer through **Telegram AND Slack** on
a throwaway topic. Required PASS scenarios across the risk categories, each with recorded
evidence:

- Idle topic Laptop→Mini: next message resolves owner=Mini, reply comes FROM the Mini,
  history carried, no re-greeting. (happy-path, lifecycle)
- Active topic Laptop→Mini (drain leg): in-flight turn completes, then the seat moves;
  no double-voice. (lifecycle, concurrency)
- Mini→Laptop reverse. (happy-path)
- Telegram vs Slack agree. (channel-parity)
- Offline-target → honest `needsConfirmation`/safe refusal, no half-move, no ownerless
  strand. (failure/rollback)
- Crash mid-move → single-owner convergence (§7.3). (failure/rollback)
- The false-positive guard: a transfer that doesn't move ownership reports it.
  (regression)
- Repeat-transfer idempotency. (idempotency)

The run is judged on this matrix existing as a signed all-PASS artifact — the bar the
whole 24h run is held to.

---

## 8. Frontloaded Decisions

Resolved here (my lean is the decision; this run is pre-approved for design-fork
autonomy). Honest reversibility per the Decision-Completeness reviewer.

- **D1 — "user-facing" classification.** DECIDED: explicit `userFacing` flag wins;
  absent it, a deterministic keyword classifier emits a **signal only** (§4.2) — it
  never blocks standalone. Tie-break: explicit flag is final; an undeclared
  user-facing-looking goal is surfaced (return-to-work nudge), not hard-blocked; a
  `userFacing:false` that looks contradicted by touched surfaces is surfaced for review
  (signal-only), not auto-blocked. _Reversibility:
  cheap-to-change-after — classification logic behind the dark flag, no external
  side-effect._
- **D2 — harness channel drive.** DECIDED: **real-account drive (B)** via isolated
  demo accounts is the only gate-satisfying mechanism; API-injection (A) is a
  non-satisfying fast inner-loop. Credential model: `vault://demo/*`, never the live
  account by default; missing creds → BLOCKED-real + surfaced (§5.4). _Reversibility:
  NOT cheap — touches real platform credentials + a published testing contract;
  frontloaded with the credential/isolation model in §5.3–5.4._
- **D3 — transfer fix architecture.** DECIDED (reversed after cross-model review):
  **durable replicated ownership store** off the hot path with an in-memory cache +
  epoch + reconciler (§7.2), NOT the bespoke push handoff. _Reversibility: NOT cheap —
  changes cross-machine routing authority; frontloaded with the crash-safety contract
  (§7.3) + false-positive surfacing (§7.4) as acceptance criteria._
- **D4 — gate strictness at rollout.** DECIDED: graduated ladder
  `dry-run → warn → veto`, dark + dev-gated first (`monitoring.liveTestGate.mode`).
  Cannot-verify → not-proven → veto (return-to-work), the safe direction (§4.8).
  _Reversibility: cheap-to-change-after — a config dial behind the dark gate; promotion
  is an operator-visible step._
- **D5 — Slack "AND" hardness + dashboard.** DECIDED: channel features require
  {telegram, slack}; a genuine Slack absence is an explicit audited exemption recorded
  in the artifact; dashboard features prove via a Playwright live check (§4.5).
  _Reversibility: cheap-to-change-after — artifact-matching policy behind the dark flag._

---

## 9. Acceptance criteria

1. The standard is in `docs/STANDARDS-REGISTRY.md` and migrated to existing agents.
2. The completion gate vetoes "done" for a user-facing feature lacking a verified,
   **signed** live-test artifact (right surfaces §4.5, required risk categories §4.6),
   anchored anti-hallucination (canonical hash + Ed25519 signature + hash-chained ledger
   + recency/replay + seatMoved poison), with the classifier holding NO standalone
   blocking authority (§4.2). Dark-gated, dry-run-first. Unit + integration + E2E tests
   covering both sides of every boundary (user-facing/internal, PASS/BLOCKED-real,
   surface-present/absent, tampered/clean, fresh/stale).
3. The user-role harness drives the real surface (Telegram AND Slack for channel,
   Playwright for dashboard), writes the signed artifact the gate reads, isolates
   volatile scenarios to signed demo channels (refusing live channels by ID), manages
   flakiness (§5.5) — with unit + integration + E2E ("alive") tests.
4. The multi-machine transfer actually moves the seat (durable replicated ownership +
   cache off the hot path), the false-positive is surfaced (§7.4), a crash mid-move
   never strands the topic ownerless (§7.3 / §9.4), and it is PROVEN LIVE through the
   harness over Telegram AND Slack with a recorded all-PASS scenario matrix.
   - **§9.4 crash-safety:** an interrupted transfer (process killed between pin-set,
     durable place, durable claim, cache-invalidate) leaves the topic owned by exactly
     one machine after the reconciler runs — never zero, never two — and messages
     arriving in the in-flight window queue (ownership-contention) rather than
     double-route. Covered by an integration test injecting a crash at each step and
     asserting single-owner convergence + no double-route.
5. **Multi-machine posture (§10):** the artifact store + ledger replicate; the gate
   runs on the machine executing the run and treats unverifiable/stale evidence as
   not-proven (veto), never a false pass. Hot-path ownership reads stay <100ms p99.
6. Zero-failure suite; migration parity; deployed to both machines.

---

## 10. Multi-machine posture (mandatory cross-machine declaration)

Per the Cross-Machine Coherence check, every state surface this spec introduces
declares its posture:

- **`state/live-test-artifacts/` + per-machine ledger segments
  `state/live-test-ledger.<machineId>.jsonl`** — **REPLICATED** via the existing
  coherence-journal replication path (the same machinery the 7 memory stores use). An
  artifact written on machine A is readable on machine B; each machine's hash-chained
  ledger SEGMENT replicates append-only (a peer only ever *adds* its own segment — never
  a shared concurrent append, §4.4). The gate reads the **derived union** of all
  discovered `live-test-ledger.*.jsonl` segments (discovery = glob the segment files);
  the union is computed on read, not materialized into a shared file. Identity is
  `{featureId, runId}`.
- **Gate evaluation** — runs on the **machine executing the autonomous run**. If that
  machine has not yet seen the ledger entry (replication lag beyond a freshness bound),
  the gate treats the feature as **not-proven → veto (return-to-work)**, never a false
  pass and never a hard stall. (The run can re-run the harness locally, or the entry
  arrives via replication.)
- **`liveTest.demoChannels` + `demo-channel-bindings.json`** — **REPLICATED** via git
  config + migration so every machine sees the same signed demo bindings.
- **Ownership store (§7.2)** — **REPLICATED** durable record + per-machine in-memory
  cache (proxied/cached-on-read), the load-bearing fix.

Retention/scale: the ledger compacts (>90d archived to `state/live-test-ledger-archive/`,
monthly files; the gate reads active + current archive); gate evidence is cached
(journal-invalidated, SLO <500ms first-run / <100ms cache-hit); artifacts capped per
feature.

---

## 11. Observability (Observable Intelligence standard)

The gate and harness emit effectiveness metrics so the standard itself can be tuned —
you can't improve what you can't see:

- **Gate metrics** (per-feature, into the existing `/metrics/features` surface, feature
  key `live-test-gate`): veto **fired** vs **noop** vs **shed**, the strictness `mode`
  at decision time, the reason a veto fired (no-artifact / wrong-surface / category-gap /
  tampered / stale), and the artifact-verification latency.
- **Harness metrics** (feature key `live-test-harness`): scenarios run, PASS/FAIL/
  BLOCKED-real counts, risk-category coverage per feature, flake rate + quarantined
  count, per-surface run time.
- **The headline effectiveness metric — operator-found escapes.** When the operator
  reports a defect in a feature that had ALREADY passed the gate, it is recorded as an
  `operatorFoundEscape` against that feature id (the gate let a real bug through). This
  is the true north-star: the standard exists to drive operator-found escapes toward
  zero. A rising escape rate means the scenario matrices are too thin — surfaced, not
  buried. **This is also the answer to "performative coverage" (codex r4/r5):** no static
  check can judge whether a category's scenarios are *deep enough*, but an escape
  attributed to a shallow-matrix category is the empirical signal that thickens it.
  Category presence is the floor; the escape metric is the ratchet — the standard
  self-corrects from real escapes rather than pretending presence/PASS proves adequacy.
- Read surface: `GET /metrics/features?feature=live-test-gate` / `live-test-harness`;
  the dashboard renders the escape rate + coverage in plain language. Read-only
  observability — it never gates.

## Open questions

*(none)*
