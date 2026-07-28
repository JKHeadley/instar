# Round 1 Findings — machine-coherence-guard

Reviewed: `docs/specs/machine-coherence-guard.md` (commit 08cbcb9c4 draft, worktree
branch `echo/machine-coherence-guard` at v1.3.728).
Panel: 6 internal lenses (security, scalability, adversarial, integration,
decision-completeness, lessons-aware — each grounded against the real
pool/heartbeat/registry code, not memory) + 2 external cross-model passes
(GPT-tier `gpt-5.5` via the `pi` CLI's openai-codex provider — the codex CLI is
not installed on this machine, noted honestly; `gemini-2.5-pro` via the gemini
CLI) + the Standards-Conformance Gate.

Standards-Conformance Gate: **ran (2 flags)** — `Agent Proposes, Operator
Approves` and `Operator-Surface Quality`, both against the §4.2 alarm body
(raw config keys + `PATCH /config` as the primary operator surface). Parent-
principle fit check: **fit**. Both flags are folded into M9 below.

External verdicts: pi/gpt-5.5 **NOT-CONVERGED (2 CRITICAL, 9 MAJOR, 3 MINOR,
2 LOW)**; gemini-2.5-pro **NOT-CONVERGED (1 CRITICAL, 1 MAJOR, 1 MINOR, 1 LOW)**.
Both independently converged with the internal lenses on the duplicate-alarm
gap and the `awakeMachineCount: number|null` published-surface break.

**VERDICT: NOT CONVERGED — 3 CRITICAL, 12 MAJOR, 9 MINOR, 5 LOW.**
(Round 1; expected. The spec's evidence base and code-grounding index held up
under re-verification — the flaws are in unstated pool-scope alarm semantics,
one unimplementable-as-cited mechanism, and parked decisions.)

Integration lens re-verified the §11 grounding index against the real tree:
**all sampled citations correct in substance**; only cosmetic line drift
(`setInterval(refreshPool)` at server.ts:17255 not :17251; `PERSISTENCE_TICKS`
at GuardPostureProbe.ts:54; `captureHardware` at MachinePoolRegistry.ts:26-37).
The transport-security claims also verified true: `session-status` is a signed,
replay-guarded, RBAC'd MeshRpc read (`src/core/MeshRpc.ts:241-296`);
observations are keyed on the registry's machine id, never a body-claimed id
(`src/core/PeerPresencePuller.ts:243-254`).

---

## CRITICAL

**C1 — No designated alarmer: every live-guard machine raises its own HIGH
item; property (b) fails by construction at pool scope.** (adversarial A1,
decision-completeness DC-2, lessons F1, integration I-4, pi CRITICAL#2,
security adjacent-note — 6/8 reviewers independently) §0(b)/§3.3/§4.2. Every
machine runs the evaluator independently over its own pool view; the
idempotency the spec leans on is machine-local only — `createAttentionItem`
dedupes against an in-memory per-machine map + per-bot state file
(`src/messaging/TelegramAdapter.ts:3799-3802`, `:450`), and `episodeId` is
never defined, so it cannot be cross-machine-deterministic. On any pool where
the guard resolves live on ≥2 machines (a two-dev pair — exactly the §7
graduation-soak topology and the §9 acceptance pair), BOTH machines confirm the
same skew and each mints its own HIGH Telegram topic: two alarms, two
resolution markers, two escalations for one skew. The spec's headline "ONE
attention item" guarantee is currently only true for a single-evaluator pool —
a contradiction with its own premise. Fix direction: elect a raiser (the
serving-lease holder raises/updates/resolves; standbys evaluate + record jsonl
only; explicit fallback when the holder's guard is dark or dry-run), and
declare the multi-machine posture of every new surface (episode file, status
route, attention item, audit log) per the mandatory integration check.

**C2 — §5b is unimplementable as grounded: the per-peer lease-observation view
the spec says "already" exists does not exist.** (integration I-1, scalability
SC-2, pi MAJOR#9) §5b claims "The pull loop already collects exactly this view
(it is what latches leasePullContested)." Reality:
`LeaseCoordinator.observedPeerLease()` returns ONE most-recently-observed
lease record — a single latest slot (`src/core/LeaseCoordinator.ts:464-478`,
`this.d.tunnel?.observed().lease`), and the contested latch
(`src/core/MultiMachineCoordinator.ts:1341-1355`) compares only that single
record against self. There is no per-peer freshest-observation map, no receipt
times, no staleness bound — and the pulled record is the peer's *view of the
lease* (which can name a third machine), not a self-claim, so "peer naming
ITSELF as holder" is not distinguishable from the existing data. The counting
design also leaves freshness windows, duplicate machine ids, and
post-failover stale-claim overcount undefined (pi). Stakes are higher than
telemetry: `splitBrainState` derives from the count and has load-bearing
in-code consumers that gate behavior (`src/commands/server.ts:4959` suppression,
`:12383` leaseStable, `:20604` splitBrainItemOpen) plus the operator
"demote machine X?" attention flow. §5b must be rewritten against the real
seam: name the new retained state (peerId → {observed lease, observedAtMs}
map + staleness bound + cleanup), define what a peer-reported lease naming a
third machine contributes, and state explicitly that peer claims are advisory
and can never auto-demote (security SEC-4).

**C3 — Seven open questions are parked on "the convergence reviewers"; the
spec cannot converge while any remain, and several are load-bearing for the
build.** (decision-completeness DC-1; pi MAJOR — manifest membership "central
to correctness"; DC-4/gemini/pi — Q5 is a published-surface change that is
never cheap-to-change-after) §10. `write-convergence-tag.mjs` structurally
refuses to stamp while `## Open questions` has live entries. All seven are
author/reviewer-decidable now; proposed resolutions are appended at the end of
this report for the round-2 fold. Two are singled out: **Q1** (manifest
membership) — the builder cannot ship without the final list; and **Q5** —
`awakeMachineCount: number|null` alters a published interface (see M10), which
under the non-cheap taxonomy must be decided in-spec, not deferred. The spec
also lacks the `## Frontloaded Decisions` / `## Decision points touched`
sections the skill's minimum structure expects (DC-6): the good inline
defaults (ticks, bounds, priority) exist but are unattributable as decisions.

## MAJOR

**M1 — Episode lifecycle vs. online-set change is underspecified; the cheap
reading emits a false "coherence restored" marker and a fresh HIGH topic per
sleep/wake cycle.** (scalability SC-1, adversarial A2, lessons F7, pi MAJOR#6)
§3.3/§4.1/§4.3. `online` = router receipt within `failoverThresholdMs`
(default 15 min — `src/commands/server.ts:17018`;
`src/core/MachinePoolRegistry.ts:313-314`), so a nightly laptop sleep flips
the skewed peer offline → comparison set shrinks → zero skew for
`resolveTicks` → episode auto-resolves with a "restored" marker that is FALSE
(the divergent machine is merely asleep) → wake → skew re-confirmed → "a
later divergence is a NEW episode" → new HIGH item. One persistent skew on a
sleep-cycled machine mints one new HIGH topic per day, indefinitely. The
alternative reading ("same online peer set" ⇒ hold open) instead fires the 24h
escalation against a merely-offline peer. Pin: a close-reason taxonomy
(`restored` vs `suspended-peer-offline` — only `restored` may claim
restoration), whether changed-set passes count toward `resolveTicks`, and
offline-skewed-peer semantics (hold, don't resolve).

**M2 — No brake on episode RECURRENCE, and the HIGH item path is exempt from
the topic budget the spec cites as its backstop.** (adversarial A2, lessons
F5) §4.1/§4.3. The P19 brakes exist WITHIN one episode (confirm ticks, resolve
ticks, single escalation) but nothing caps episodes-per-day: a flapping skew
cycles open→close→NEW-episode roughly every 2.5 minutes at defaults. And the
"Bounded Notification Surface" engagement is incomplete: HIGH attention items
are created with `origin: 'system'` (`src/messaging/TelegramAdapter.ts:3862`),
and the universal topic-creation budget counts only `origin: 'auto'`
(`:1432-1446`) — the flood ceiling does not actually bound this path. Add a
recurrence damper (re-divergence within N minutes re-opens the SAME item) and
a per-day episode cap that gives up loudly.

**M3 — Advert emission gating is ambiguous, and the dev-gated reading makes
the guard misclassify its own founding incident.** (integration I-2, lessons
F4, pi MAJOR#3, decision-completeness DC-3) §3.2/§7. The spec says the advert
"ships with the sentinel's code but is emission-harmless" but never states
whether emission rides the sentinel's dev-gate. If it does: on the exact F4
pair (Laptop dev → live, Mini fleet → dark) the Mini never advertises, and
§3.3 classifies it "version-class skew — the peer predates the guard" — a
false diagnosis of the incident this spec exists to name correctly, and a
standing false-positive that poisons the §7 "zero false-positive would-raises"
soak criterion by construction. Decide: emission is UNCONDITIONAL (ships live
like 5a/5b, the additive-advert path), stated normatively in §3.2 AND §7 with
a unit test; and give online-but-advert-less (`unknown`) peers the
`versionSkewGraceMs` treatment (they are mid-update-wave until proven
otherwise) instead of a ~60s version-class alarm.

**M4 — The receive-side clamp the spec cites as an existing rule does not
exist; it is new build work, and clamp-rejection semantics fail in the
dangerous direction.** (security SEC-1, adversarial A4) §3.2. The cited
"posture-ingestion rule" (`src/core/types.ts:2075-2078`) documents only
identity-binding + receipt-age; the real receive path is a pure pass-through —
`narrowSessionStatusToPeerCapacity` (`src/core/PeerPresencePuller.ts:122-150`)
and `MachinePoolRegistry.recordHeartbeat` store peer objects verbatim
(`src/core/MachinePoolRegistry.ts:209-278`). The §3.1 bounds are sender-side
only. The spec must name the receive clamp as a NEW deliverable with explicit
semantics — and those semantics matter: (i) if a clamp-rejected advert looks
like an omitted field, carry-forward preserves the last good advert and the
peer sits permanently misrepresented as coherent; (ii) "clamp rejection → no
emit this tick" means persistent malformation = permanent silence on a
genuinely skewed pool — a peer evades the guard by violating the clamp.
Rejected must be distinguished from absent: a clamp-rejected advert marks the
peer `unknown` (already routed to version-class surfacing) + error counter.

**M5 — Advert staleness is unhandled: carry-forward + coarse-beat liveness
lets an "online" machine be compared on an arbitrarily old advert.**
(security SEC-2, gemini LOW) §3.2/§3.3. Coarse git-synced heartbeats refresh
`routerReceivedAtMs` liveness WITHOUT carrying an advert
(`src/commands/server.ts:17225-17236`;
`src/core/MachinePoolRegistry.ts:212-227`), and the carry-forward the spec
adopts preserves the last advert indefinitely. A peer whose HTTP
`session-status` path is down while git sync flows stays `online` with a
frozen advert — the evaluator reports its OLD flag posture as current, masking
a real skew or sustaining a stale one. The advert needs its own generation
timestamp/beat sequence, and an advert older than K ticks must degrade to
`unknown`/stale — never read as current truth.

**M6 — Rolling updates: intersection flag skew alarms in 60–90s while the
45-min version grace is still suppressing the version alarm.** (adversarial
A3, pi MAJOR#7) §3.3. An update that changes a flag's RESOLVED default (a
dev-gate graduation, a new ConfigDefault, a stage bump) produces, mid-wave, a
key in BOTH manifests with different effective values — genuine flag-class
skew confirmed at `flagConfirmTicks: 2` regardless of the open version grace.
Every such update alarms HIGH mid-wave then auto-resolves — the cry-wolf the
grace exists to prevent, on the louder dimension. Suppress/grace-match
flag-skew confirmation between machines whose advertised versions differ (or
while a version-skew grace window is open for the pair), and make the §10 Q7
soak criterion require witnessing one update wave with zero flag would-raises.

**M7 — manifestHash mismatch with IDENTICAL version strings is unhandled.**
(adversarial A5, pi MINOR#3) §3.1/§3.2. A dirty/locally-built dist (a dev
machine mid-dogfood — this agent's normal state) yields differing
`manifestHash` with equal `instarVersion`: the version dimension sees no skew,
the intersection silently shrinks, and the divergence is alarmed by NOTHING.
The advert carries `manifestHash` "so the evaluator knows" — but no behavior
is specified for hash≠ ∧ version=. Make it its own confirmed skew dimension
(or fold it into version-class explicitly). Also under-defined: the hash
covers the sorted key list only — two builds can share keys but differ in
resolution mode/normalization; consider hashing entries, not keys.

**M8 — Boot-config vs. liveConfig read-source divergence: at least one
manifest entry applies WITHOUT restart, breaking both advert honesty and the
anti-flap premise.** (scalability SC-3) §3.1/§3.3. `sessionPool.stage` is
consumed live — `_sessionPoolStage()` reads
`liveConfig.get('multiMachine.sessionPool', …)`
(`src/commands/server.ts:20177-20186`) — so a `PATCH /config` changes real
behavior with no restart, while an advert resolved from the boot-time config
object would misadvertise until restart (alarm on skew that no longer exists,
or silence on a real live skew). This also falsifies §3.3's justification for
`flagConfirmTicks: 2` ("a flag flip requires a restart") for every
liveConfig-read entry. The manifest schema needs a per-entry read-source
declaration (boot vs. live), and the resolver must read each entry the way its
real consumer does.

**M9 — The alarm body is config surgery presented to a human, and its fix
lever walks the operator into a documented data-loss hazard.** (lessons F2+F3,
adversarial A6, security SEC-3, decision-completeness DC-5, conformance gate
×2, gemini CRITICAL in part) §4.2. Both gate flags land here: the body leads
with dotted config keys and a `PATCH /config` recipe ("Agent Proposes,
Operator Approves" + "Operator-Surface Quality" / taps-not-text). Worse than
tone: the suggested patch of one nested `multiMachine.seamlessness.*` key is
exactly the partial-block shape the deployed CLAUDE.md hazard warns "erases
sibling tuning" under the one-level-deep config merge — the skew fix can
CREATE new skew on the patched machine. The spec's own "the alarm names the
one-tap fix; it never performs it" is internally contradictory: a raw PATCH
recipe is not one-tap. Frontload the body template: plain-language impact
first ("my two machines have drifted apart — cross-machine moves will silently
fail"), a pre-filled COMPLETE fix the operator approves and the agent
performs, config detail in a secondary block.

**M10 — `awakeMachineCount: number → number|null` is a breaking change to a
published surface, contradicts two in-code never-null contracts, and breaks
named existing tests — while §5 ships live for everyone with the compat
decision (Q5) still open.** (pi MAJOR#8, gemini MAJOR, decision-completeness
DC-4, lessons F9, integration I-5+I-7) §5b/§10 Q5. The surface is published:
every deployed agent's CLAUDE.md documents the field
(`src/scaffold/templates.ts:507`, `src/core/PostUpdateMigrator.ts:4974`),
`instar doctor` surfaces it, and
`tests/unit/multimachine-syncstatus.test.ts:46` asserts
`typeof === 'number'`; `tests/e2e/multi-machine-lease-split-brain.test.ts:64,147`
proves partition detection via registry-role counting and needs redesign, not
a tweak; `tests/integration/pool-routes.test.ts:60` needs the new shape. Two
in-code contracts must be reconciled: the `getSyncStatus()` docstring "Always
returns valid fields (never null/throws)"
(`src/core/MultiMachineCoordinator.ts:960-964`) and the `/health` serializer
comment (`src/server/routes.ts:2575-2577`). Decide in-spec (proposed: ship
`number|null` + source tag — the compat alternative preserves the exact lie
the fix removes — updating all internal consumers, the two template texts, and
the named tests in the same PR, with the shape change in the upgrade guide).

**M11 — The comparison universe comes from the registry the spec itself
distrusts: absence is read as coherence.** (lessons F6) §3.3. `getCapacities()`
maps over the machine-registry listing (`src/core/MachinePoolRegistry.ts:298-300`)
— the same store whose merge/staleness pathologies §2.4 documents. A peer
missing or stale in the registry rows is silently absent from the comparison
set: no skew computed, `machinesCompared` quietly smaller, no alarm. The spec
engages Verify-the-State for `awakeMachineCount` but not for its own
sentinel's input inventory. State where the machine list comes from and flag a
shrunken universe (compared < registered) as `unknown`, never as clean.

**M12 — `instar doctor` and `instar machine list` keep independent
registry-role awake counts; §5b's invariant is violated by a surface the
spec's own quoted material names.** (integration I-3) §5. `doctor` counts
`role === 'awake'` directly from registry rows (`src/commands/machine.ts:648`,
"N machines claim awake (split-brain?)" at ~670-682) and `machine list`
renders the same rows (`:65`, `:169`) — neither goes through `getSyncStatus()`.
5b fixes `/health` + `GET /pool` while doctor keeps reporting from the exact
stale symbols §2.4 indicts, and the shipped CLAUDE.md text says "`instar
doctor` shows the same". P0-1 stays half-open: route doctor through the fixed
source (or replicate the source-tag honesty), or scope it out explicitly with
the divergence named.

## MINOR

**N1 — Skew-confirmation identity is uncanonicalized.** (pi MAJOR#5, graded
MINOR here after dedupe with M1) §3.3. "Same divergence across ticks" is
undefined under peer-set churn, nickname changes, and manifest-intersection
drift. Pin the persistence key: stable machine ids + dimension + key + value
classes — never nicknames or raw table rows.

**N2 — The guard's own posture is not in the manifest.** (adversarial A7)
§3.1/§7. `monitoring.machineCoherence.enabled`/`dryRun` are per-machine raw
config compared by nothing — a dev pair with one side `dryRun:true` silently
halves alarm redundancy (and under C1's raiser election, the designated
machine being the dry-run one = no alarm). Add the guard's own resolved
posture to the manifest or the status route's pool view.

**N3 — Corrupt-episode re-baseline contradicts the §4.1 restart guarantee.**
(adversarial A8, security SEC-6) §4.1 claims "a server restart mid-episode
neither re-alarms nor forgets", but the corrupt-file path re-baselines → new
episodeId → duplicate HIGH item while the old topic is still open
(`TelegramAdapter.ts:3800-3802` id-idempotency can't dedupe a new id). On
re-baseline, adopt/resolve any open `machine-coherence:*` item before raising.

**N4 — Small unstated decisions bundle.** (decision-completeness DC-7/8/9,
integration I-8) episodeId format (pin e.g. `mc-<openedAtEpochMs>`);
disable-mid-episode disposal (the route 503s but the open HIGH item never
auto-resolves and the state file persists — state: retained + manual ack, or
resolve-with-marker on next enabled boot); who flips `dryRun:false` and who
executes the fleet flip (name the actor per rung).

**N5 — Manifest growth is a self-DoS tripwire and manifest maintenance has no
drift guard.** (adversarial A4-tail, gemini MINOR) §3.1. Organic growth past
the 64-entry clamp makes EVERY machine's advert clamp-reject → the guard goes
silently dead pool-wide, visible only as an error counter. Add a build-time
manifest-size ratchet test, and a lint/annotation mechanism so a new
coherence-critical flag can't be added without a manifest decision (the F4
class re-created for future flags).

**N6 — P7 supervision tier undeclared.** (lessons F8) The sentinel is
deterministic (no LLM calls — Token-Audit trivially satisfied), a legitimate
Tier-0 posture, but the Tier-0 choice must be explicitly justified in one
sentence.

**N7 — Multi-agent/multi-profile state path.** (pi MINOR#2)
`state/machine-coherence-episode.json` should be explicitly rooted in the
agent-scoped state directory so test instances/multiple agents on one host
can't collide latches.

**N8 — Post-restart advert amnesia window unnamed.** (scalability SC-5)
`MachinePoolRegistry` is in-memory; a local restart wipes every peer's advert
until the next 30s pull, briefly manufacturing version-class `unknown` signals
on ALL peers. State the warm-up rule (unknown passes count toward nothing).

**N9 — §7's migration-parity line is a no-op as written.** (integration I-6)
For an omitted-`enabled` dev-gated feature with code-side `??` fallbacks there
is nothing for `migrateConfig()` to add. Replace with the real artifacts:
ConfigDefaults OMITS the block; the both-sides wiring test
(`tests/unit/devGatedFeatures-wiring.test.ts`); CLAUDE.md additions via
`generateClaudeMd()` + `migrateClaudeMd()`, including updating the two
existing `awakeMachineCount` template mentions for the new shape.

## LOW

**L1 — `captureHardware(… ?? config.version)` fallback semantics.** (pi LOW)
§5a. Two version sources with different meanings; if ProcessIntegrity is
unavailable, prefer omitting/marking unknown over stamping a possibly-stale
`config.version` as durable telemetry.

**L2 — State the alarm-body exposure invariant.** (security SEC-5; gemini
graded this CRITICAL — recorded honestly, panel grades LOW given the
operator-only attention surface and existing practice) §4.2. The alarm renders
which safety flags are dark/dry-run on which machine into Telegram. Bound it
with one invariant sentence: rows render only local-manifest-intersection keys
and clamp-passed enum values — never a peer's free text.

**L3 — 503-when-dark posture note.** (pi LOW) House convention (the standard
dark-route posture) — keep, but the report records the external's point that
generic health tooling may misread 503; the status body's `enabled:false`
alternative was considered and the house pattern wins.

**L4 — §5b advisory-count sentence.** (security SEC-4) State in §5b what the
spec states elsewhere: peer lease claims are self-asserted advisory data; a
`contested` verdict routes to a human decision, never an automatic demotion.

**L5 — Q3 rationale is precedent-eroded + cosmetic line drift.** (integration
I-9 + verification) The `seamlessnessFlags` "fixed-size booleans only"
contract is already breached by `stateSyncReceive?: Record<string, boolean>`
living inside it (`src/core/types.ts:2062-2074`) — the load-bearing-consumers
half of the Q3 argument still stands; cite that half. Fix the three drifted
line numbers in §11 (17255, :54, :26-37).

---

## §10 proposed resolutions (decision-completeness lens — for the round-2 fold)

- **Q1** — Compare RESOLVED values; a `developmentAgent` asymmetry inside one
  agent's pool is ALWAYS alarmed (mixed-dev pools are not a supported
  topology). Keep the drafted list including `meshTransport.enabled`; the
  manifest is code-shipped, additions are follow-up-cheap. Add per-entry
  read-source (M8) and the guard's own posture (N2).
- **Q2** — `flagConfirmTicks: 2` (house pattern; 30s extra buys pull-jitter
  immunity); RESTATE the roadmap acceptance clause as "≤ 2 presence-pull
  cycles (≤ 90s)" — honesty over literalism. Keep `versionSkewGraceMs: 45min`,
  extended to unknown-advert peers (M3) and to intersection flag skew during
  an open version grace (M6).
- **Q3** — New `coherenceAdvert` block (load-bearing consumers argument; note
  L5's erosion of the bounded-contract half).
- **Q4** — HIGH attention item, body rewritten per M9.
- **Q5** — `number|null` + source tag, with the full consumer/test/template
  sweep of M10 in the same PR.
- **Q6** — NOT loadBearing in v1 (signal-only, no critical path consumes it
  yet; loadBearing would raise G3 gap alarms on every fleet agent where it is
  deliberately dark). Revisit when Phase 2 consumes the advert.
- **Q7** — Keep ≥5 days AND require the soak to have observed ≥1 natural
  update wave with zero would-raises plus one injected-skew detection.

## Grounding verified TRUE (spot-checked by ≥2 lenses, kept for round 2)

- §2.1/§2.4 evidence: silent-0 catch (`MultiMachineCoordinator.ts:973`),
  splitBrain derivation (`:977-981`), `captureHardware()` argument-less
  callsite (`server.ts:17094`), dead peer-version consumer
  (`routes.ts:6645/:6671`), git-less blindness admission (`:198-208`).
- Transport: signed/replay-guarded `session-status` MeshRpc; registry-keyed
  observation identity; `SESSION_STATUS_ADVERT_FIELDS` ratchet; field-specific
  carry-forward — all as cited.
- Cost story sound: evaluator O(machines × flags) trivial; no per-beat file
  rewrite; rider precedent real (`server.ts:20114-20168`); episode writes
  transition-only.
- `GUARD_MANIFEST` supports dev-gated omitted-enabled entries with
  `dryRunConfigPath` (ws13 precedents at `guardManifest.ts:93/:119`) — §6
  registration implementable as-is; 5a works independently of the advert; no
  dashboard HTML consumer of `awakeMachineCount` exists.

## Verdict

**NOT CONVERGED.** Round 1 closed with 3 CRITICAL, 12 MAJOR, 9 MINOR, 5 LOW
across 6 internal lenses + 2 externals + the conformance gate (2 flags). The
evidence base (§1-§2) and the grounding index survived adversarial
re-verification essentially intact; the required round-2 work is: elect the
alarmer + declare pool-scope surface posture (C1), re-ground §5b on the real
lease-observation seam (C2), fold all §10 questions into Frontloaded Decisions
(C3), and address the twelve MAJORs — most of which are episode/alarm
lifecycle semantics and advert trust/staleness rules, not architecture
changes. The detection-rides-existing-heartbeat architecture itself drew no
structural objection from any reviewer.
