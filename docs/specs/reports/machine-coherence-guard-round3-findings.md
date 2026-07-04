# Round 3 Findings — machine-coherence-guard

Reviewed: `docs/specs/machine-coherence-guard.md` (round-3 revision, commit
7b8c99b5d, worktree branch `echo/machine-coherence-guard` at v1.3.728).
Round-3 charter: verify every round-2 fold genuinely landed (RE-EXECUTING the
walks, not re-reading the prose — round 2 verified citations; round 3 verified
BEHAVIOR), then fresh-eyes over the material the round-3 folds introduced
(§3.2 `alarm` marker, §3.4 fallback + reconciliation, §4.2.1 fix flow, §4.5
latch + persistence).

Panel: 6 internal lenses (security, scalability, adversarial, integration,
decision-completeness, lessons-aware — each grounded against the real
pool/heartbeat/lease/attention/ratifier code) + 2 external cross-model passes
(GPT-tier `gpt-5.5` via the `pi` CLI's openai-codex provider — the codex CLI
is not installed on this machine, noted honestly, same as rounds 1–2;
`gemini-2.5-pro` via the gemini CLI — clean single-shot runs this round) +
the Standards-Conformance Gate.

Session note, recorded honestly: the orchestrating session died at the
2026-07-03 credit wall mid-verification; three lens reports (integration,
lessons-aware, adversarial) landed after its death and were transcribed by the
session orchestrator (`docs/specs/reviews/machine-coherence-guard-r3-lens-reports.md`);
the resumed session verified the remaining three lenses + both externals + the
conformance gate had produced artifacts before the wall (they had — no re-runs
needed) and synthesized this report.

Standards-Conformance Gate: **ran (0 flags)** — 51 standards checked, zero
findings. Parent-principle fit check: **fit** ("directly targets cross-machine
agent coherence …").

External verdicts: pi/gpt-5.5 **NOT-CONVERGED (0 CRITICAL, 1 MAJOR, 1 MINOR,
0 LOW)** — fails the R2-M3(iv) fold (mechanism not concrete for the
divergent≠raiser case) and flags `rowsTruncated` universal-coverage;
gemini-2.5-pro **CONVERGED (0/0/0/0)** — all 15 folds verified OK, zero
findings. Recorded honestly: gemini's clean pass is contradicted by the
adversarial lens's re-executed WALKS, which fail three of the same folds on
degraded-view seams; the walks are the authority, so the panel verdict follows
them, and gemini's pass is weighted as "the prose reads as resolving the
findings" (which round 4 must preserve) rather than "the mechanisms survive
adversarial execution."

**VERDICT: NOT CONVERGED — 0 CRITICAL, 6 MAJOR, 12 MINOR, 5 LOW.**
(Round 2 closed 0/3/6/6. All fifteen round-2 findings are TEXTUALLY folded —
every reviewer confirms the revision addresses what round 2 asked — but three
folds FAIL under walk re-execution (R2-M1, R2-M2, R2-N4: adversarial lens) and
one fails under build-it-now scrutiny (R2-M3(iv): decision-completeness +
pi): the round-3 mechanisms carry their own degraded-view and lifecycle seams.
Every MAJOR is confined to the material the round-3 folds introduced —
§3.2/§3.4/§4.2.1/§4.3/§4.5. The detection architecture, manifest/advert
design, §5b redesign, episode close-reason taxonomy, and election core again
drew no objection from any reviewer.)

## Fold verification (walks re-executed)

| Round-2 finding | Verdict | Notes |
|---|---|---|
| R2-M1 (raise-liveness fallback) | **FOLD-FAIL** (adversarial; security/pi/gemini graded OK on the fault-model) | the marker + fallback close the wedged-raiser fault, BUT the "candidate set MINUS raise-silent machines" subtraction is ambiguous between two readings — one yields NOBODY steps up, the other dual-raise (→ R3-M2) |
| R2-M2 (duplicate reconciliation) | **FOLD-FAIL** (adversarial; integration/lessons/pi/gemini OK on the rule itself) | the rule is sound under mutual observation; unresolvable on the blind side of the spec's own one-directional-degradation dual-open (→ R3-M3) |
| R2-M3 (fix flow §4.2.1) | **FOLD-FAIL** (decision-completeness CRITICAL-grade, pi MAJOR; security OK on i/iii, integration OK on iv's no-mesh-write claim, gemini OK) | (i)(ii)(iii)(v) genuinely pinned; (iv) has no pinned execution path for the FOUNDING F4 topology (online divergent machine ≠ raiser) and §4.2's body contradicts §4.2.1's local-only scope (→ R3-M1) |
| R2-N1 (pullOnce spread + roundtrip test) | FOLD-OK (integration, lessons, pi, gemini) | test scope needs narrowing to the registry-bound field subset (→ R3-N11) |
| R2-N2 (brake persistence home) | FOLD-OK (scalability, pi, gemini) | |
| R2-N3 (write cadence) | FOLD-OK (scalability, pi, gemini) | |
| R2-N4 (flap bounding + cap target) | **FOLD-FAIL** (adversarial; scalability/pi/gemini OK for its named path) | the latch bounds close→reopen churn; intra-episode row-join churn and suspend/resume churn remain per-flap unbounded on a budget-exempt HIGH topic (→ R3-M5) |
| R2-N5 (clock assumption) | FOLD-OK (pi, gemini; mitigation citations ground true — integration) | |
| R2-N6 (single-machine wording) | FOLD-OK (integration, pi, gemini) | |
| R2-L1 (beatSeq) | FOLD-OK (security, scalability, pi, gemini) | |
| R2-L2 (jsonl retention) | FOLD-OK (scalability — rotateLog citation verified real, pi, gemini) | |
| R2-L3 (consecutive counters) | FOLD-OK (pi, gemini) | |
| R2-L4 (no rollback lever, declared) | FOLD-OK (integration, pi, gemini) | |
| R2-L5 (manifest-changed marker) | FOLD-OK (decision-completeness, pi, gemini) | |
| R2-L6 (P17 tracked note) | FOLD-OK (lessons — marker present, pi, gemini) | |

Grounding: ALL new §11 citations verified true with zero drift (integration
lens; 7 older spot-checks also clean). The ScopeAccretionRatifier /
TopicOperatorStore precedent works exactly as §4.2.1(i) claims (security lens
walked the uid-match and message-id chain in source). `PATCH /config` is
confirmed local-only (routes.ts:21323) — §4.2.1(iv)'s "no mesh config-write
exists" is TRUE; the failure is the unpinned trigger, not a false claim.
C3-regression: `## Open questions` verifiably empty; D19–D23 exist and match
the mechanisms; Frontloaded Decisions internally consistent.

---

## CRITICAL

*(none — but see the panel regrade note: decision-completeness graded R3-M1
CRITICAL; the panel reconciles it to MAJOR with the reasoning recorded)*

## MAJOR

**R3-M1 — The build's ONE actuation has no pinned execution path for the
founding F4 topology, and §4.2's body contradicts §4.2.1(iv).**
(decision-completeness F1 CRITICAL; pi FOLD-FAIL MAJOR; lessons R3-2 MINOR;
integration LOW; security LOW — 5/8 reviewers, the round's strongest
convergence) §4.2/§4.2.1(iv). In F4 the divergent machine (Mini) has a DARK
guard → never an election candidate → the raiser is the Laptop; the Mini is
ONLINE with a live agent session — neither "divergent==raiser → direct local
action" nor "no reachable agent session → hold" applies. The middle clause
("the agent's session ON that machine performs the write … coordinated
conversationally") names no structural trigger — Structure>Willpower fails on
the sole action in the build — while §4.2's body simultaneously promises
"restart that machine's server (a ~30-second blip there)", a remote actuation
§4.2.1(iv) forbids. Also unpinned: restarting a lease-HOLDING divergent
machine is a failover, not a "blip"; and the sentinel↔conversational-agent
handoff (who detects the approval, who writes back fixesApplied/fixesFailed).
Fix direction (agreed by 4 lenses): scope v1's AUTOMATIC fix to
divergent==raiser (fully local); every other case → the approved pendingFix
HOLDS honestly ("approved — I'll apply it from my own session on <nickname>;
no remote config-write exists in v1") with the loud fixVerifyTicks failure
bounding a hold that never executes; rewrite §4.2's body proposal text to
match; name the lease-holder-restart consequence; pin the sentinel↔agent
handoff + outcome write-back; the structural cross-machine execution channel
is Phase 2's authority work (same class as the updater).

**R3-M2 — The fallback's "raise-silent" subtraction set is undefined between
two readings — one yields permanent silence, the other dual-raise.**
(adversarial R3-1 — R2-M1 FOLD-FAIL) §3.4. On a 3-machine pool (A elected +
wedged, B/C standbys), "candidates MINUS raise-silent machines" read as "all
machines with no covering marker" subtracts everyone (B and C hold no marker —
correctly, they never raised) → empty set → NOBODY steps up; read as
"self-excluding" → B and C both step up. Fix: define raise-silent =
the PRIORITY-ORDERED ELECTED raiser(s) that advertise `guard:'live'` yet have
emitted no covering marker past the deadline — only those are subtracted
(iteratively, for a cascade of silent raisers); the fallback raiser is the
deterministic election over the remainder; a standby steps up IFF it is that
result (C defers to B by machineId order without needing B's marker).

**R3-M3 — Reconciliation is unresolvable on the blind side of the spec's own
one-directional-degradation dual-open.** (adversarial R3-2 — R2-M2 FOLD-FAIL)
§3.4/§0(b)/§4.3. §3.4 itself names one-directional HTTP degradation (git
beats keep both online) as a dual-open path — but there the blind holder NEVER
freshly observes the survivor's marker, so its duplicate persists for the
degradation's life, contradicting §0(b)'s "converging" promise. Fix: extend
§4.3 suspension to the can't-verify case — an open item one of whose skew
participants is `advert-stale`/`unknown` (not merely offline) SUSPENDS
(quiet, honest append once, clocks paused) until fresh adverts return; on
return the reconciliation rule fires. The duplicate then exists only as a
suspended-quiet item bounded by the degradation, and §0(b)'s honesty clause
is restated to name it.

**R3-M4 — `rowsTruncated` = "covers ALL rows" is the wrong conservative
direction: it fails toward SILENCE.** (adversarial R3-3 MAJOR; pi MINOR;
security MINOR sub-part — 3/8) §3.2/§3.4. A legitimately-large (or, within
the accepted Byzantine residual, trivially forged 1-row+flag) truncated marker
suppresses every standby's step-up pool-wide for rows it does not actually
cover — a false raise-silence, the §0(a) cardinal sin; the zero-knowledge
forgery `{rowIdentityHashes:[], rowsTruncated:true}` suppresses ALL coherence
alarms. Fix: for step-up suppression an UNLISTED row is NOT covered (fail
toward raising — a bounded duplicate converges via reconciliation; silence
does not); raise the per-row-hash clamp to the manifest maximum so truncation
is structurally unreachable for any ratchet-passing manifest (adjust the
block/marker budgets accordingly — see R3-N1); keep `rowsTruncated` only as
receive-clamp honesty that classifies the peer `advert-rejected`-adjacent
(pathology, loud), never as universal coverage.

**R3-M5 — Two per-flap-unbounded append paths remain on the budget-exempt
HIGH topic: intra-episode row-join churn and suspend/resume churn.** (lessons
R3-1 MAJOR + adversarial R3-4 MAJOR + adversarial R3-9 MINOR — same root;
3/8) §4.1/§4.3/§4.5. The flap latch keys on episode RE-OPENS only: a row
flapping confirm/clear/re-confirm INSIDE a still-open episode emits one "row
joined" append per re-join (~20-40/hr), and a suspend/resume boundary
(exactly the spec's own M5 scenario: HTTP session-status flapping while git
beats hold the peer online) emits per-transition appends — hundreds overnight,
with NO platform budget behind them (M2 honesty). P17 requires the bound + a
burst test. Fix: generalize §4.5's latch to a per-episode APPEND budget over
all intra-episode transition classes (row join/re-join, suspend/resume) in a
rolling window — after N, one "flapping — recording silently" note and
jsonl-only until stable; add the burst-invariant test driving a flapping
participant.

**R3-M6 — `pendingFix` lifecycle is incomplete: not single-flight pool-wide,
and not invalidated by episode close/supersession/suspension.** (adversarial
R3-5 MAJOR + decision-completeness F2 MAJOR — same contract; 2/8 on the
family) §4.2.1(i). Duplicate/takeover items each carry their own
machine-local pendingFix; nothing invalidates the non-survivor's on
`superseded-by-takeover` — an operator tapping "fix it" on both topics
produces two config writes + two restarts of the same machine. And the
invalidation set lists only skew-set changes: an approval landing on a
resolved/suspended/superseded/expired item is neither executed-with-consent
nor refused. Fix: pendingFix is bound to its episode's lifecycle — ANY close
reason, suspension, or supersession invalidates it (the §4.6 corrupt-file
re-baseline too — integration L3); a reply bound to an invalidated proposal
is REFUSED with one honest note (re-proposed fresh under the survivor when
the skew persists); fix execution is idempotent + single-flight per
(divergent machineId, key), enforced at the raiser holding the surviving
item.

## MINOR

**R3-N1 — The 64-entry manifest bound and a full alarm marker are not
co-satisfiable inside the 2 KB whole-block clamp.** (scalability) §3.1/§3.2.
Worst-case marker ≈ 707 B at 32 hashes (≈ 1.2 KB at the manifest max R3-M4
wants) + fixed fields ≈ 167 B leaves room for ~25 realistic flag entries —
the binding limit is the 2 KB, not the 64-entry count. Fix: state 2 KB (or a
raised block bound) as binding; give the marker its own named sub-budget; the
N5 ratchet reference advert (already marker-inclusive) enforces it at build
time.

**R3-N2 — The alarm marker's content-freshness is unpinned: a fresh advert
can assert coverage of rows the holder no longer confirms.** (adversarial
R3-6) §3.2/§3.4. Pin: the marker enumerates the item's CURRENTLY-CONFIRMED
rows; a row that individually clears leaves the marker on the next beat.

**R3-N3 — Whether a DARK machine with a retained open episode keeps emitting
its marker is unpinned; if dropped, its item is coverage-invisible and
un-reconcilable until re-enable.** (adversarial R3-7) §3.2/§4.6. Pin:
marker emission is part of UNCONDITIONAL advert emission and reads the
retained episode file — a disabled guard's open item stays pool-visible.

**R3-N4 — The takeover latch (once per row-set + lost owner, forever) never
re-arms: a flapping owner's SECOND departure gets no takeover.** (adversarial
R3-8) §3.4. Pin: the latch resets when the owner returns and its item
reconciles; re-arm frequency is bounded by the R3-M5 append budget.

**R3-N5 — Approval-reply recognition is unpinned between literal token match
and intent classification.** (decision-completeness F3) §4.2/§4.2.1(i). Pin:
recognition lives in the conversational agent (the sentinel stays Tier-0
no-LLM); the message-id chain + recorded proposal hash is the AUTHORITY;
"fix it"/"leave it" are the documented convention, not the gate.

**R3-N6 — The translation from target EFFECTIVE value to concrete config
bytes is unpinned and collides with the developmentAgent exclusion.**
(decision-completeness F4) §4.2.1(ii)/(iii). In F4 both configs OMIT the key;
equalizing without touching the excluded root requires writing an EXPLICIT
per-flag override. Pin: the fix writes the explicit config override that
YIELDS the target effective value — never the resolved enum, never the
excluded gate.

**R3-N7 — "leave it … without further nagging" vs §4.4's unconditional 24 h
escalation append is unresolved.** (decision-completeness F5) Pin: "leave it"
records an operator-acknowledged state that suppresses the §4.4 escalation
(the item stays open, jsonl continues).

**R3-N8 — Multi-row episode fix cardinality unspecified.**
(decision-completeness F6) §4.2.1(i). Pin: ONE pendingFix at a time per
episode; each "fix it" binds exactly one proposal; further rows are proposed
after the first resolves.

**R3-N9 — `alarm.episodeId` is peer-supplied text rendered onto the operator
surface with a length-only clamp — an L2 exposure-invariant violation.**
(security R3-2) §3.2/§4.2. Fix: clamp to the N4 format (`/^mc-\d{1,29}$/`,
reject/degrade otherwise) and render only clamp-passed ids in appends.

**R3-N10 — The reconciliation bullet does not restate the Byzantine residual
it enlarges: a forged covering marker can ACTIVELY extinguish a real, raised
item (not merely suppress a future one).** (security R3-1) §3.4. Fix: one
honesty sentence cross-referencing the R2-M1 residual and naming the
active-supersede case; optionally corroborate via the existing
`GET /attention?scope=pool` merge before a non-survivor extinguishes a raised
item (marker = hint, not sole extinguish authority).

**R3-N11 — The R2-N1 roundtrip test is over-scoped: only 4 of 7
`SESSION_STATUS_ADVERT_FIELDS` reach registry storage via `recordHeartbeat`.**
(integration R3-1) §3.2/§9. Scope the assertion to the registry-bound subset
(quotaState/guardPosture/seamlessnessFlags/servesChannels + coherenceAdvert);
the other three flow through drive*Sync paths.

**R3-N12 — The fix handles the sibling-clobber hazard but not the
concurrent-writer/atomicity seam of the real config funnel.** (lessons R3-3)
§4.2.1(iv). The deployed `PATCH /config` write is raw
readFileSync→merge→writeFileSync (no tmp+rename, no lock). Fix: route the fix
write through `writeConfigAtomic` (or take a lock); state the
last-writer-wins residual; note PostUpdateMigrator interaction is
add-missing-only (verified).

## LOW

**R3-L1 — Silence-clock and takeover/fallback latch records have no stated
prune lifecycle.** (scalability) Pin: dropped when the row leaves the
confirmed set or on episode close (the R2-L3 lifecycle).

**R3-L2 — Rolling-24h window eviction could induce spurious state-file
writes.** (scalability) Pin: eviction is computed lazily at evaluation time
and never itself triggers a write.

**R3-L3 — pendingFix non-survival across the §4.6 corrupt-file re-baseline is
implicit.** (integration) One sentence: a re-baselined episode carries no
pendingFix; a pending approval requires re-proposal. (Folds into R3-M6's
lifecycle rule.)

**R3-L4 — The frontmatter's "2026-06-05 partial-config-PATCH clobber hazard"
citation resolves to no catalogued lesson.** (lessons) Cite the one-level-merge
warning at its real home (GUARD-POSTURE-ENDPOINT-SPEC.md:104) or the correct
incident.

**R3-L5 — The survivor pick depends on each holder's own lease view; during a
lease transition both can compute "I am survivor".** (adversarial R3-10) Fix:
drop the lease input from the pick — survivor = lowest machineId among
holders, computed from marker data alone (lease-view-independent, converges
in one mutual observation).

---

## Panel regrade notes (recorded honestly)

- decision-completeness graded the R3-M1 family **CRITICAL** ("a building
  agent stops cold at the sole actuation; §4.2 contradicts §4.2.1"). The
  panel reconciles to MAJOR: the round-1 CRITICAL bar was reserved for
  architecture-breaking falsehoods (C2's nonexistent mechanism cited as
  existing); here §4.2.1(iv)'s no-mesh-write claim is TRUE (integration
  verified it in source), the gap is ONE unpinned sub-decision plus a
  two-sentence body contradiction, and four lenses independently converged on
  the same cheap fix direction (scope v1 to divergent==raiser + honest hold).
  The verdict is NOT CONVERGED either way; nothing rides on the label.
- gemini-2.5-pro passed all 15 folds and returned zero findings; the
  adversarial lens's re-executed walks fail three of those folds. The walks
  are the authority (they exhibit concrete failing executions); the panel
  adopts them. This is the ceremony's first clean-external round that the
  internal panel overrides — recorded so round 4 re-runs gemini against the
  round-4 text rather than treating its round-3 pass as standing.
- pi's MAJOR and MINOR both confirmed by internal lenses (R3-M1, R3-M4).
- The lessons MAJOR and adversarial R3-4/R3-9 share one root (unbounded
  intra-episode appends) — deduped into R3-M5.
- adversarial R3-5 and decision-completeness F2 share one contract
  (pendingFix lifecycle) — deduped into R3-M6.

## What held (credit where due)

Fresh-advert requirements present at both coverage points; the clean
partial-overlap walk is loop-free (~3 appends); takeover appends latched;
per-day new-item cap bounds reconcile churn; fix-failure appends
operator-gated; "raiser recovers mid-fallback" converges; the episode-reopen
flap latch works for its named path; §4.2.1(i)'s principal binding walked
clean in source (uid match + message-id chain + skew-set invalidation);
(ii)/(iii)/(v) buildable-without-asking; all §11 grounding EXACT (zero drift
across new + sampled-old citations); the detection architecture, manifest
design, §5b, close-reason taxonomy, and election core drew no objection from
any of the 8 reviewers for the third consecutive round.

## Verdict

**NOT CONVERGED.** Round 3 closes with 0 CRITICAL, 6 MAJOR, 12 MINOR, 5 LOW
across 6 internal lenses + 2 externals + the conformance gate (0 flags).
Twelve of fifteen round-2 folds held under walk re-execution; three failed on
seams the folds themselves introduced (the fallback's subtraction-set
ambiguity, the blind-side dual-open, the intra-episode append gap) and the
fix-flow fold failed build-it-now scrutiny on its (iv) mechanism. All six
MAJORs have concrete, panel-agreed fix directions recorded in-line and are
confined to §3.2/§3.4/§4.2.1/§4.3/§4.5. Round 4 folds R3-M1..M6 + the twelve
MINORs and re-executes the SAME walks against the round-4 text.
