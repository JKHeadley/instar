# Convergence Report — Notification Selectivity — Quiet by Default

## Cross-model review: codex-cli:gpt-5.5

RAN — clean pass. A real GPT-tier external review ran through the agent's
codex CLI in ALL THREE rounds (`gpt-5.5`, status `ok` every round), and a
real Gemini-tier review ran in all three rounds as well
(`gemini-3.1-pro-preview`, status `ok` every round — a notable break from
recent convergences where gemini timed out). The Anthropic clean-door
second-read family was attempted every round and refused with
`no-supported-framework` (config-dark on this runner) — recorded as its own
disclosure, never counted toward the cross-model flag.

## ELI10 Overview

The agent's background machinery — watchdogs, health checks, job reports,
"I noticed something" notes — has been allowed to message the operator on
Telegram. A July-10 fix stopped these from creating a new Telegram *topic*
per alert, but every alert still *pushes a message*. This spec is the
redesign the operator approved on June 13 (and whose converged spec file was
then lost when its build session was killed): by default, everything the
agent generates on its own goes to internal logs and a dashboard inbox — it
does NOT ping the operator. The operator opts in, per category, to anything
they want pushed. Only a tiny hardcoded class (security incident, data loss,
agent-cannot-operate) may reach the one Attention topic without an opt-in,
and even that is volume-capped. Real replies to the operator are untouched,
and every failure direction bends toward delivering them.

The design is deterministic on purpose: the send-or-log decision keys on
where a message came from (its provenance), never on what its text says, and
no AI model sits on the delivery path. A CI test fires 1,000 automated
signals through the real pipeline and fails the build if even one stray
message would push without an opt-in.

The main tradeoffs: quiet items must genuinely stay discoverable (the spec
answers with unread badges, per-project surfacing, aging counters, and an
opt-in daily digest), and the rollout must not silently change behavior the
operator relies on (the spec answers with a dark → observe → operator-flipped
ladder, grandfathering of existing effective choices — listed at flip time
with one-tap disable-all — and instant rollback levers until the final
cleanup).

## Original vs Converged

Three review rounds materially hardened the reconstruction:

- **The dodge-class holes got closed with mechanism, not intention.**
  Originally, a message's category was a label its emitter chose, and
  "conversation-serving" was corroborated by "the topic is active." Reviewers
  showed both were fakeable — the same dodge shape as all four historical
  floods. Now: categories bind to named emitter modules (lint-enforced, with
  typed wiring-time stamper handles), conversation-serving sends must cite
  the SPECIFIC operator message they answer, and the raw-send bypasses around
  the funnel (including a generic `send()` method the first draft's census
  missed) are enumerated and lint-closed.
- **The opt-in surface became deterministic.** Originally the agent could
  write a category opt-in with an attested "the operator confirmed
  conversationally." Now a conversational opt-in must cite the operator's
  actual confirming message (verified against the inbound ledger AND the
  verified-operator binding), the server itself mints the visible
  confirmation reply, and a write without a valid citation is refused — the
  agent structurally cannot grant itself push.
- **The push door got bounded.** Review surfaced that the July-10 hub fix
  left per-source hub MESSAGE volume unbounded (a real foundation gap, now
  named in the spec). The converged design adds per-category push budgets, a
  protected separate lane for significant alerts, a global ceiling, and
  storm-proof coalescing (including against the unique-source-label dodge),
  so even an opted-in category can never become flood round five.
- **Multi-machine honesty.** Relayed sends between the agent's machines now
  carry an explicit relay marker + protocol version; the delivering machine
  re-classifies everything fresh; an envelope-less relayed REPLY fails toward
  delivery (never eaten) under a pinned, self-expiring skew rule; opt-in
  toggles fan out durably with apply-time revalidation so a stale queued
  change can never resurrect a reverted choice.
- **Two decisions were surfaced to the operator instead of silently
  defaulted:** the rollout keeps an off-lever until a final cleanup increment
  (bending the June-13 "no break-glass" — flagged DEV-1), and stuck-promise
  notices staying quiet-by-default collides with a standard ratified one day
  after the June-13 conversation (flagged DEV-6/FD-14). Both are put in front
  of the operator in the ELI16 for the fresh sign-off this reconstruction
  requires anyway.

## Iteration Summary

Internal reviewers ran as Claude subagents of the authoring session
(model: claude-fable-5, all rounds — no silent drop to opus observed).
Externals ran per available family, every round (body hash changed each
round, so no delta-skips).

| Iteration | Standards-Conformance Gate | Cross-model | Reviewers who flagged | Material findings | Spec changes |
|-----------|---------------------------|-------------|-----------------------|-------------------|--------------|
| 1 | ran (3 flags: Agent Carries the Loop, Close the Loop, No Deferrals) | codex ok (MINOR), gemini ok (MINOR), claude-code clean-door: refused `no-supported-framework` | all 6 internal (adversarial, integration, lessons SERIOUS; security, scalability, decision-completeness MINOR) + both externals | ~20 (category/corroboration gaming, reply-route inversion gaps, legacyGate laundering, funnel bypasses, self-opt-in, relayed-origin trust, storm mechanics, hot-path I/O, #1417 foundation gap, FD authority gaps…) | v2: emitter-bound categories + inbound-id corroboration, promoted breadcrumbs, sole-writer opt-in route, legacyGate default-false rule + snapshot migration, §5.2 push budget, §2.5 recency map, storm coalescing, untrusted-data injection envelope, FD-11…FD-14, DEV-6/DEV-7 |
| 2 | ran (1 flag: Agent Carries the Loop — the named DEV-6 operator decision) | codex ok (MINOR), gemini ok (MINOR) | all 6 internal (adversarial SERIOUS; others MINOR) + both externals | 7 (funnel census missed `send()`, opt-in alarm self-quieted, FD-7 replay ordering, relay-carrier unimplementable as written, coalesce-mechanics contradiction, spawn-path pool fetch, record-contract) | v3: corrected census + build-time re-enumeration, deterministic confirmation citations, relay body marker + fresh holder classification, pinned durability/coalesce mechanics, significant/routine lanes + global ceiling, FD-7 versioned revalidation, FD-15, ELI16 items 14–15 |
| 3 | ran (1 flag: same standing operator-decision flag; lessons-aware judged the surfacing SUFFICIENT in both rounds 2 and 3) | codex ok (MINOR), gemini ok (MINOR) | all 8 flagged only one-clause minors/editorial | **0** | (converged) round-3 minors folded editorially: operator-bound citations, server-minted confirmation, relay-fallback closure + marker lint, significant-lane reservation, sourceContext key caps, machine-qualified versions, grandfathered listing + disable-all, transitional record shim, typed stamper factories, SQLite alternative entry, census-echo fixes, ELI16 item 16 |

## Full Findings Catalog

### Iteration 1 (spec v1 → v2)

**Standards-Conformance Gate (code-backed):** 3 flags — *The Agent Carries
the Loop* (quiet decision-request notices can swallow a stuck obligation),
*Close the Loop* (no default cadence re-surfaces quiet items), *No Deferrals*
(legacy-lever consolidation deferred). Resolutions: DEV-6 + FD-14 named
operator decision; §4.3 unbound-item aging + lifeline boot surfacing +
unread-aging counter; deferrals carry tracked markers + build-time CMT
minting (lessons-aware judged the No-Deferrals form compliant).

**Security (MINOR):** MATERIAL relayed-origin peer-asserted vs posture claim
→ §2.4 trust model + holder re-demotion + `relayedOrigin` ledger field;
MATERIAL §4.3 injection lacked untrusted-data envelope → clamps + delimited
envelope; minors: fallback rotation (→2MB), pool-read clamping/HTML-escape,
reply-route lint + corroboration residual honesty, skew asymmetry note,
opt-in id validation.

**Scalability (MINOR):** MATERIAL no storm coalescing (17.5k-row eviction
risk) → coalescing + rotation-prune + boot index; MATERIAL §2.3 "no I/O"
contradiction → §2.5 in-memory recency map; minors: §6 recursion pin test,
counters-as-soak-evidence, event-sourced acks, pool cursors, §4.3 numeric
bound.

**Adversarial (SERIOUS):** category free-text + fakeable corroboration →
emitterModules + inbound-id binding; significantClass gaming + undefined
episode key → registry-bound classes + episode key; reply-route inversion
incomplete → reply-route lint + FD-9 concrete exit criteria; legacyGate
laundering (reapNotify default-true) → default-false lint + snapshot
migration; funnel not total (raw sendMessage sites) → census + lint;
Bearer self-opt-in → FD-11; minors: relay trust scoping, inactivity-proof
clean window (→ traffic floor), digest content pinning, pass-through
spoofing (→ module-private object).

**Integration (SERIOUS):** relayed envelope-less reply eaten under skew →
kindMetadata fallback; default-true legacyGate defeats D-1 → snapshot at
Increment D; Standard-A on per-machine opt-in config → unified durable
fan-out + corrected pool-read citation (attention's own TTL fan-out, not
PoolPollCache); topic transfer strands quiet items → topic-scoped pool read;
minors: §6 Standard-B brake declaration, dead toggle (co-write legacyGate),
sole-writer vs PATCH /config, dryRun store semantics + relay test.

**Decision-completeness (MINOR):** FD-2 cheap tag REJECTED → narrowed +
demotion canary; M-1 opt-in authority → FD-11; M-2 flip authority + window →
FD-12; M-3 table binding → FD-13; M-4 block bound + tab name.

**Lessons-aware (SERIOUS):** Agent-Carries-the-Loop temporal collision →
DEV-6 + FD-14 + `commitment-deadletter` category; #1417 unbounded per-source
hub stream (foundation gap) → §5.2 budget + §8.1 naming + opted-in burst-test
arm; minors: unbound-item aging, CMT minting, gate self-composition clause,
kindDivergence ledger field.

**codex gpt-5.5 (MINOR):** record return contract; envelope-absence lint
posture; §3.2 window/identity model; quiet-aging policy; significant-class
definitions; rollback blast-radius warning. All folded (§2.3 contract, §9
lints, §3.2 concrete bindings, §4.3 aging, §5 examples, FD-8 warning).

**gemini (MINOR):** onboarding/discovery → Increment-D announcement + tab
intro; multi-machine config consistency → FD-7; glossary; artifact-loss
process note → History (commit-at-authoring-time).

### Iteration 2 (spec v2 → v3)

**Security (MINOR):** rounds-1 folds verified; minors → relayed
category/class also peer-asserted (→ holder classifies FRESH, pre-decided
never crosses mesh), FD-7 apply-time revalidation, §5.2 summary pinning.

**Scalability (MINOR):** MATERIAL coalesce-row self-contradiction →
in-memory accumulate + ≤1 flushed row/(key,window) + `coalescedApprox`;
MATERIAL spawn-path cross-machine fetch → local-first + hard ≤2s TTL-cached
budget + missed-not-lost; minors: recency-map LRU/cap, per-machine budget
honesty, FD-7 queue TTL/versioning.

**Adversarial (SERIOUS):** M1 census factually wrong (missed
`TelegramAdapter.send()` + a prompt branch) → corrected census + `send()`
into the funnel + build-time re-enumeration; M2 the mass-opt-in alarm was
quiet-routed by this spec's own default (guard guarded nothing) →
deterministic confirmingMessageId citation, refusal without it; M3 FD-7
stale-replay resurrection → monotonic only-if-newer; minors: pre-decided
single-use, runtime emitterModules honesty (→ wiring-time capability
handles), global ceiling.

**Integration (MINOR):** MATERIAL protocol-version had no carrier → relay
body `{relayed, machineId, protocolVersion}`, absence = legacy signal;
MATERIAL same census fix; minors: offline-owner outcome, snapshot idempotency
(only-if-absent + marker), version authority + divergence-comparison owner.

**Decision-completeness (MINOR):** N-1 budget default unbound → FD-15; N-2
ELI16 missing FD-9 → item 14. FD-2-narrowed and FD-6 tags upheld.

**Lessons-aware (MINOR):** digest-off honesty in FD-14/ELI16 #2;
significant-overflow summaries must NAME the class. Conformance flag judged
SUFFICIENT (deliberately-surfaced operator decision; the standard pins
non-swallowing + exactly-once, not a delivery channel).

**codex gpt-5.5 (MINOR):** reply-route laundering residual (→ FD-9's
server-minted promotion mechanism named); grandfathering explicitness (→
named + ELI16); store durability semantics (→ pinned paragraph); §5.2
accounting order (→ lanes + summary-does-not-consume-budget); §4.3 raw-body
injection (→ structured metadata only); glossary depth.

**gemini (MINOR):** lexicon density (→ glossary extension + five-line
summary); FD-9 manual-audit scalability (→ bounded ledger-driven checklist +
automation-as-future-work); truncated-context process note (recorded).

### Iteration 3 (confirmation on v3; minors folded editorially into v4)

**Security (MINOR):** rounds-2 folds verified genuine; minors →
confirmingMessageId must bind to the VERIFIED topic-operator (folded), relay
fallback needs a pinned closure condition (folded: registered legacy peer
required, dead when none exists, marker construction lint-restricted).

**Scalability (MINOR):** all resolved; minors → significant-lane reservation
within the global ceiling (folded), sourceContext-keyed map TTL/caps +
category-level secondary coalesce (folded).

**Adversarial (MINOR):** all three round-2 MATERIALs verified genuinely
closed (census verified against source; the citation check judged genuinely
better than the alarm — fail-closed at write time, self-revealing pushes,
audit-named citation); minors → stale-"seven" echoes (folded), server-minted
confirmation reply instead of agent willpower (folded), relay-receive marker
lint extension (folded).

**Integration (MINOR):** all resolved; minors → stale census echoes
(folded), machine-qualified version minting (folded).

**Decision-completeness (MINOR):** counts finalized — 15 frontloaded
decisions, 2 surviving cheap tags, 3 contested-then-cleared; minor → FD-10
missing from the ELI16 (folded: item 16).

**Lessons-aware (MINOR):** both round-2 minors verified folded; conformance
flag judgment HOLDS for v3; minor → census echoes (folded).

**codex gpt-5.5 (MINOR):** typed stamper factories + import lint (folded);
record-contract transitional shim (folded); grandfathered categories listed
at announcement + one-tap disable-all (folded); SQLite alternatives entry
(folded); pool-wide max visibility + global-budget follow-up (folded);
implementation summary (folded).

**gemini (MINOR):** jargon density (glossary + five-line summary stand);
custom-store philosophy (answered by the SQLite alternatives entry);
FD-9 manual-audit interim (already noted as future automation). All
advisory; none required further change.

**Standing conformance flag, disposed honestly:** *The Agent Carries the
Loop* flags in every round because the spec's quiet default for
decision-request/dead-letter notices is a genuine tension with that standard
— resolved BY DESIGN as a named operator decision (DEV-6/FD-14, ELI16 item
2, "Operator confirmation requested"), per the operator's own June-13 D-2
and the July-10 reaffirmation. The lessons-aware reviewer examined and
upheld this disposition in rounds 2 and 3. Spec text cannot clear this flag;
only the operator's fresh sign-off can.

## Convergence verdict

Converged at iteration 3. The round-3 review of the v3 body produced ZERO
material findings across all six internal reviewers, both cross-model
externals, and the conformance gate (whose single remaining flag is the
deliberately-surfaced DEV-6 operator decision). Round-3 one-clause minors
were folded editorially per the established final-round precedent and are
enumerated above. The spec is ready for operator review — NOTE: this is a
RECONSTRUCTION of the lost June-13 design; the June-13 "Approved" is
recorded as design provenance only, and the spec carries NO approved tag.
Fresh operator approval is required before any build starts.
