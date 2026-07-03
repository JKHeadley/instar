# Round 2 Findings — machine-coherence-guard

Reviewed: `docs/specs/machine-coherence-guard.md` (round-2 revision, commit
1c78fb29c, worktree branch `echo/machine-coherence-guard` at v1.3.728).
Round-2 charter: VERIFY every round-1 fold is genuinely resolved (re-grounding
code claims against the real source — the discipline that caught round 1's
fabricated clamp citation), fresh-eyes over the NEW material (§3.4 election,
§4.3-4.6 lifecycle, §5b counting rule, Frontloaded Decisions), plus externals.

Panel: 6 internal lenses (security, scalability, adversarial, integration,
decision-completeness, lessons-aware — each grounded against the real
pool/heartbeat/lease/attention code) + 2 external cross-model passes
(GPT-tier `gpt-5.5` via the `pi` CLI's openai-codex provider — the codex CLI
is not installed on this machine, noted honestly, same as round 1;
`gemini-2.5-pro` via the gemini CLI — first attempts degraded on 429
MODEL_CAPACITY_EXHAUSTED, succeeded after the CLI's own backoff retries;
recorded honestly, the pass that counted is a real gemini-2.5-pro read) + the
Standards-Conformance Gate.

Standards-Conformance Gate: **ran (0 flags)** — 51 standards checked, zero
findings (round 1's two flags, both against the old §4.2 alarm body, are
cleared by the M9 rewrite). Parent-principle fit check: **fit**.

External verdicts: pi/gpt-5.5 **NOT-CONVERGED (0 CRITICAL, 2 MAJOR, 2 MINOR,
0 LOW)**; gemini-2.5-pro **NOT-CONVERGED (0 CRITICAL, 1 MAJOR, 1 MINOR,
0 LOW)**. Both externals independently verified ALL headline folds
(C1/C2/C3, M1/M2, M3/M4, M9) as genuinely resolved; both converged with the
internal lenses on the same two new-material weak points (degraded-view
election behavior; the approve-to-execute fix mechanics).

**VERDICT: NOT CONVERGED — 0 CRITICAL, 3 MAJOR, 6 MINOR, 6 LOW.**
(Down from 3/12/9/5. Every round-1 finding held as FOLD-OK by every reviewer
assigned to it — zero fold failures across 33 fold verifications. All three
round-2 MAJORs are NEW findings against material the revision introduced:
two against the §3.4 raiser election's degraded-view seams, one against the
§4.2 approve-to-execute fix flow that the M9 fold itself created. The core
architecture, the episode lifecycle, the manifest/advert design, and the §5b
redesign drew no material objection.)

## Fold verification (the round-2 charter item)

Integration lens re-grounded the §11 index: **35 citations checked, 0
substantively wrong** (one 2-line cosmetic drift: the liveConfig
`sessionPool` read sits at server.ts:20175-20182 vs the cited :20177-20186).
All three round-1 line-number drifts are fixed and now EXACT
(`setInterval(refreshPool, 30_000)` server.ts:17251; `PERSISTENCE_TICKS`
GuardPostureProbe.ts:54; `captureHardware` MachinePoolRegistry.ts:27-38).
Independently re-verified true: the §5b single-slot ground truth
(`LeaseCoordinator.ts:477-478` → `HttpLeaseTransport.lastObserved`
`:368-370`; `pullPeer` third-machine doc `:415-434`; `pullAllPeers` discard
`:440-445`); the three `splitBrainState` consumers (server.ts:4959, :12383,
:20604); HIGH→`origin:'system'` (TelegramAdapter.ts:3860-3864) vs the
budget's `origin:'auto'`-only counting (:1432-1446); the verbatim
receive-side pass-through (PeerPresencePuller.ts:123-151 — the clamp is
genuinely NEW work); doctor's registry-role count (machine.ts:674/:681);
both deployed template texts; all three named tests; and "no dashboard HTML
consumer of awakeMachineCount" (re-confirmed by fresh search).

Fold verdicts across all lenses + both externals (33 checks):

| Round-1 finding | Verdict | Verified by |
|---|---|---|
| C1 (raiser election exists + healthy-pair one-item property) | FOLD-OK | adversarial, lessons, integration, security, pi, gemini |
| C2 (§5b re-grounded; per-peer map named as NEW state) | FOLD-OK | scalability, integration, pi, gemini |
| C3 (all 7 open questions → Frontloaded Decisions) | FOLD-OK (RESOLVED, Q1-Q7 each matched to the round-1 proposals; D8-D18 spot-checks land) | decision-completeness, pi, gemini |
| M1 (close-reason taxonomy, suspension, changed-set rule) | FOLD-OK | scalability, adversarial, lessons, pi, gemini |
| M2 (recurrence damper + per-day cap; budget-exemption honesty verified in code) | FOLD-OK | adversarial, lessons, pi, gemini |
| M3 (advert emission unconditional, normative, tested) | FOLD-OK | integration, lessons, pi, gemini |
| M4 (clamp = NEW work; rejected ≠ absent; loud) | FOLD-OK | security, adversarial, pi, gemini |
| M5 (staleness: gap re-verified real; advertStaleMs degradation) | FOLD-OK | security |
| M6 (update-wave flag-skew suppression + soak criterion) | FOLD-OK | adversarial |
| M7 (manifest-class dimension; hash over entries) | FOLD-OK | adversarial |
| M8 (readSource; liveConfig claim re-verified; rationale corrected) | FOLD-OK | scalability |
| M9 (alarm body: impact-first, agent-performed fix, full-block writes) | FOLD-OK | security, lessons, pi, gemini |
| M10 (number\|null + full same-PR sweep enumerated) | FOLD-OK | integration, lessons, decision-completeness |
| M11 (comparison-universe honesty) | FOLD-OK | lessons |
| M12 (doctor/machine-list in-scope, D15) | FOLD-OK | integration |
| N2/N3/N4/N5/N6/N7/N8/N9, L1/L2/L4/L5 | FOLD-OK | assigned lenses (see per-lens outputs) |

Contested cheap-to-change tags (decision-completeness): **D1's
"manifest membership changes are follow-up-cheap" — SURVIVED** (code-shipped
constant, intersection comparison, hash-detected semantics changes, N5
build-time guards; no taxonomy category touched). **D5 — SATISFIED as a
decided-in-spec published-interface change** with the consumer sweep
enumerated concretely ("the model of how a published-interface decision
should be frontloaded").

---

## CRITICAL

*(none)*

## MAJOR

**R2-M1 — A broken-but-live-advertising raiser silently suppresses the pool
alarm; there is no raise-liveness fallback.** (security R2-SEC-1 MAJOR; pi
RAISE-LOCAL-VIEW in part) §3.4. The election keys candidacy on the advert's
`guard:'live'` field, which is emitted unconditionally and INDEPENDENTLY of
evaluator/alarm-path health — so a machine whose evaluator is wedged or whose
attention/Telegram adapter is dead (or, adversarially, a compromised own
machine advertising `'live'`) captures the election and raises nothing,
forever. Owner-loss takeover cannot save this: it triggers only when an
ALREADY-OPEN episode's owner leaves the candidate set — a raiser that never
OPENS the item produces permanent silence while every standby has confirmed
the skew and stood down. One fault defeats property (a). Fix direction:
generalize takeover to "the elected raiser failed to open the expected item
within N ticks of LOCAL confirmation" — the item's existence is pool-visible
via the existing `GET /attention?scope=pool` merge (or carry a raised-marker
in the raiser's own advert), so a standby can detect the silence and step up
through the same latched-takeover machinery.

**R2-M2 — Duplicate-item convergence has no specified channel or rule: the
takeover body, the owner-return resolution, the split-brain heal, and the
simultaneous dual-open all require cross-machine episode knowledge that
nothing carries.** (adversarial R2-1 MAJOR + R2-2; integration R2-I2; lessons
R2-2; pi RAISE-LOCAL-VIEW in part — 5/8 reviewers) §3.4/§4.1. The takeover
item must name "episode <episodeId> from <nickname>", but episode state is
machine-local, the advert carries no episodeId, and an offline owner's items
are unreachable through the pool attention merge — the taker cannot know the
id it must cite (and §4.1's "exactly one machine opens" is in tension with
the posture table's "each machine latches its own view"). Symmetrically: the
returning owner's `superseded-by-takeover` self-resolution and the heal-path
"converge back to one item" have no specified trigger (the takeover latch
fires on owner-LOSS only, which never fires once both owners are healthy
post-heal) — dueling items persist for the skew's life. And dual-open is
reachable WITHOUT a partition: per-machine views can disagree for up to
`advertStaleMs` (5 min) around a guard-posture/lease transition (or under
one-directional HTTP degradation with git beats keeping both online), so two
machines each compute `raiser === self` in the same confirm window and mint
two items with distinct `mc-<ms>` ids. Fix direction: one reconciliation
rule keyed on skew-row identity (N1), not episodeId — e.g. an owner that
OBSERVES a peer's open machine-coherence item for the same skew-row identity
set (pool-scope attention read) while not being the currently-elected raiser
resolves its own item `superseded-by-takeover`; the takeover body cites the
skew rows (which the taker knows from its own evaluation) rather than the
lost owner's episodeId; and §0(b)'s guarantee is restated honestly ("exactly
one under a coherent pool view; bounded, honestly-marked duplicates under
degraded views, converging via <the rule>").

**R2-M3 — The §4.2 approve-to-execute fix is under-specified for an
action-bearing path: principal, binding, direction, mechanism, and failure
reporting are all unpinned.** (pi FIX-APPROVAL-UNSPECIFIED MAJOR; gemini
NEW-1 MAJOR; security R2-SEC-2 + R2-SEC-3; adversarial R2-4; integration
R2-I3; decision-completeness R2-DC-1 — 7/8 reviewers, the round's strongest
convergence) §4.2. Five gaps, each needing a pinned answer: (i) the "fix it"
reply is never bound to the topic's VERIFIED operator (Know Your Principal —
the scope-accretion ratification flow states this requirement explicitly for
the same reply-in-topic shape) nor to one specific episode; (ii) the
equalization DIRECTION is unstated — F4 is fixable by setting the Mini live
OR the Laptop dark, and a one-word approval could flip a deliberately
ships-dark feature LIVE on a fleet-posture machine; (iii) `developmentAgent`
(which flips EVERY dev-gated resolution at once) and the guard's own posture
row must be excluded from auto-proposed fixes, routed to a manual decision —
the current text would happily propose rewriting the F4 root flag itself;
(iv) no cross-machine mechanism exists for the raiser to write ANOTHER
machine's config and restart its server — `PATCH /config` is per-machine and
no mesh config-write relay exists (remote-close covers sessions only) — so
the promised fix is unimplementable as written or smuggles in a new
action-bearing mesh surface needing its own authority analysis; (v) failure
modes are unhandled — if the write or restart fails after approval, the spec
does not say the agent reports it or what state the episode enters (the
operator believes a fix landed that didn't). Fix direction: bind approval to
the verified operator + episode id; canonical direction = equalize toward
the POOL MAJORITY value, else toward the lease-holder's value, always named
explicitly in the proposal; exclude `developmentAgent` + guard-posture rows;
scope v1's agent-performed fix to the case where the DIVERGENT machine is
reachable (its own agent session performs the local write via its existing
config path, coordinated conversationally) and say so; on failure, ONE
honest append + the episode stays open.

## MINOR

**R2-N1 — The advert's "the receive path cannot silently drop it" claim is
overstated: `pullOnce`'s `recordHeartbeat` spread is a second hand-maintained
field enumeration the ratchet does not cover.** (lessons R2-1, integration
R2-I1) §3.2. The `SESSION_STATUS_ADVERT_FIELDS` ratchet test covers only
`narrowSessionStatusToPeerCapacity`; the advert must ALSO traverse the field
spread in `PeerPresencePuller.pullOnce` (`:254-255`) to reach registry
storage — forgetting it there passes the ratchet and silently drops the
field (the #930 class, potential 5th instance). Name the pullOnce spread
addition as build work + a roundtrip test asserting the full ratchet list
survives pull→registry.

**R2-N2 — The §4.5 damper/cap bookkeeping has no stated persistence home.**
(scalability SC2-1) The rolling-24h item timestamps and recently-closed
row-identity sets are the ONLY brakes on a budget-exempt HIGH path (M2), yet
§4.1's durability covers only the open episode — an in-memory implementation
resets the brake on every restart, and boot-read flag flaps inherently
involve restarts. Pin: cap + reopen bookkeeping live in the durable episode
state file (or a sibling).

**R2-N3 — Episode state-file write cadence and tick-counter persistence are
unstated.** (scalability SC2-2) The transition-only rule is stated for the
jsonl only. Pin one sentence: state-file writes are transition-only; confirm/
resolve tick counters are in-memory (a restart resetting them delays
confirmation by ≤ 90 s, absorbed by warm-up) — otherwise a natural
implementation rewrites the file every 30 s for the life of an unconfirmed
skew.

**R2-N4 — §4.5's messaging bounds have two gaps: reopen appends are unbounded
per topic, and the cap's give-up append targets an item that may be
resolved.** (adversarial R2-3; pi CAP-APPEND-RESOLVED) A skew flapping inside
`reopenWindowMs` emits a `restored` note + a "it's back" append per cycle
(~2 messages/2.5 min) indefinitely on one topic — the per-day cap bounds new
ITEMS only. And "one final append on the most recent item" is undefined when
that item is already resolved/expired/superseded. Add a latched flapping
mode after N re-opens ("flapping — recording silently") and pin the cap
append's target (re-open it, or a standing cap notice).

**R2-N5 — The §5b counting rule silently assumes reasonably-synchronized
clocks.** (gemini NEW-2) Lease liveness (`expiresAt` vs local now) is
evaluated on the OBSERVER's clock; a drifted machine misjudges peer-lease
expiry and skews `awakeMachineCount` (and thus `splitBrainState`'s count
half). State the assumption + the mitigation (the mesh already carries
clock-skew detection — cite the existing skew machinery — and the freshness
bound caps the damage window).

**R2-N6 — Single-machine terminology: §3.3 "empty verdict before any state is
touched" vs §7 "status route reports `machinesCompared: 1`".** (pi
SINGLE-MACHINE-COUNT) Both are true (self is always comparable; zero PEERS
short-circuits) but the two sentences read as contradictory. Align the
wording: comparison set = {self}, evaluator short-circuits at <2 members,
status reports `machinesCompared: 1`.

## LOW

**R2-L1 — `beatSeq` has no specified receiver semantics and resets on sender
restart.** (scalability SC2-4, security R2-SEC-4 in part) Staleness is
driven by the receipt stamp; state that `beatSeq` is forensic-only (never a
monotonicity/freshness check — a restart resets it to 0 and a naive check
would reject fresh adverts) or drop the field.

**R2-L2 — `logs/machine-coherence.jsonl` has no retention statement.**
(scalability SC2-3) Slow (~tens of KB/day worst case) but unbounded on every
evaluating machine; one line adopting the house jsonl retention posture
closes it.

**R2-L3 — Consecutive-tick confirmation semantics under peer-set churn are
implicit.** (adversarial R2-5) A skewed peer never online for
`flagConfirmTicks` consecutive ticks never confirms — acceptable (liveness
has other owners) but state the counter-reset-on-exclusion rule so a builder
doesn't implement non-consecutive accumulation.

**R2-L4 — 5b ships a live breaking shape change with no operator rollback
lever.** (integration R2-I4) The `'registry-roles'` path exists only as an
automatic degrade, not a knob. House precedent (`codexExecJson`,
`detectInWorker`) suggests naming one lever — or explicitly declaring why
none is owed (the old shape is the documented lie; reverting to it is not a
supported state). Either sentence closes it.

**R2-L5 — A manifest-membership REMOVAL landing mid-open-episode closes the
episode `restored` when the key merely stopped being compared.**
(decision-completeness R2-DC-2) D9's changed-SET rule covers machine-set
changes, not key-set changes; one §4.3 sentence (a close caused by
intersection shrinkage carries a distinct marker) closes it. Does not
overturn D1's cheap tag.

**R2-L6 — The platform-wide `origin:'system'` budget exemption is a standing
P17 gap worth a tracked note.** (lessons R2-4) The spec's normative
in-feature brakes are the right local fix, but NO ceiling exists at the
topic-birth chokepoint for HIGH/system topics pool-wide — a sentinel bug
elsewhere could still flood. Name it as a tracked platform follow-up (not
this spec's to fix).

---

## Panel regrade notes (recorded honestly)

- pi graded RAISE-LOCAL-VIEW and FIX-APPROVAL-UNSPECIFIED MAJOR; the panel
  concurs (folded into R2-M1/R2-M2 and R2-M3).
- Four internal lenses graded aspects of the fix-flow gap MINOR
  individually; the panel grades the DEDUPED family MAJOR (R2-M3) — the
  union of five unpinned decisions on an action-bearing path is a spec
  change, and both externals independently called it MAJOR.
- pi graded SINGLE-MACHINE-COUNT MINOR; panel keeps MINOR (R2-N6) despite
  being wording-only, deferring to the external's read that the two
  sentences genuinely mislead.
- gemini's clock-drift finding kept at MINOR (R2-N5), not LOW: it feeds
  `splitBrainState`, which gates behavior.

## Grounding verified TRUE in round 2 (kept for round 3)

- The full §11 index: 35 spot-checks, 0 substantive errors; the three
  round-1 drifts now exact.
- §5b's C2 ground truth (single slot, third-machine re-serve, pullAllPeers
  discard, supersede gate) — verified by two lenses independently.
- M2's budget-exemption code claims (`origin:'system'` at
  TelegramAdapter.ts:3862; `origin==='auto'`-only budget at :1432-1446).
- M5's gap (coarse git beat refreshes `routerReceivedAtMs` with no advert)
  and M8's liveConfig read — verified.
- Transport security re-confirmed: signed/replay-guarded/recipient-bound
  MeshRpc (`src/core/MeshRpc.ts:239-304`); registry-keyed observation
  identity (`src/core/PeerPresencePuller.ts:243-254`).
- Election edge verified safe by fresh-eyes: an advert-less or
  malformed-`guard` peer defaults to non-candidate (the safe direction);
  old-version peers cannot capture the election.

## Verdict

**NOT CONVERGED.** Round 2 closed with 0 CRITICAL, 3 MAJOR, 6 MINOR, 6 LOW
across 6 internal lenses + 2 externals + the conformance gate (0 flags).
Every round-1 finding survived fold verification (33/33 FOLD-OK, including
all three CRITICALs — C1's election exists and is correct on a healthy pair,
C2's §5b is honestly re-grounded, C3's questions are all decided); the
grounding index survived a 35-citation re-verification with zero substantive
errors. The three round-2 MAJORs are all NEW material introduced by the
round-1 folds themselves: the raiser election's two degraded-view seams
(raiser-liveness fallback R2-M1; duplicate-item reconciliation R2-M2) and
the approve-to-execute fix flow's missing authority/direction/mechanism/
failure story (R2-M3). All three have concrete fix directions recorded
in-line and touch §3.4/§4.2 only — the detection architecture, manifest/
advert design, episode lifecycle, and §5b redesign drew no material
objection from any reviewer. Round 3 folds R2-M1..M3 + the six MINORs and
re-verifies.
