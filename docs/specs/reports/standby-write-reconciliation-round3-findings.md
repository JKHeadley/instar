# Round 3 Findings — standby-write-reconciliation

Reviewed: `docs/specs/standby-write-reconciliation.md` (commit a02291300,
round-3 revision — all round-2 findings claimed folded).
Panel: 6 internal lenses (security, scalability, adversarial, integration,
decision-completeness, lessons-aware) + 1 external cross-model pass
(gemini-2.5-pro via gemini CLI; codex CLI re-checked this round — `which
codex` → not found — GPT-tier pass honestly unavailable, same as rounds 1-2).

Round-3 method: (1) every round-2 finding's claimed resolution verified
against BOTH the revised spec text AND the real v1.3.722 code in this worktree
(read/grep, not memory); (2) fresh adversarial + integration passes on the
revised design; (3) external pass over the full revised spec with the round-2
findings named, tasked specifically with hunting remaining or newly-introduced
contradictions.

**Process disclosure (in-round folds, honestly accounted):** the external pass
ran against the fold text as first committed (bf024b0ed content). Internal
verification then found two LOW-class editorial residuals, and the external
pass raised one LOW; all three were bounded one-paragraph textual touches and
were folded by amending the (unpushed) revision commit to its final sha
a02291300 BEFORE this report. Every row of the verification table below was
re-verified against a02291300. The delta between what gemini reviewed and
a02291300 is exactly those three touches (one of which directly implements
its own finding); none alters any admission rule, invariant, or decision.
Housekeeping: the round-2 findings report itself had been left uncommitted by
the round-2 session; it was committed verbatim this round (7e249a706) so the
ceremony trail is complete in history.

**Verdict: CONVERGED — 0 MUST-FIX, 0 SHOULD-FIX, 0 outstanding LOW.** All 10
round-2 findings are genuinely resolved (verified per-finding below). The
round-3 passes raised 3 LOW-class items in total (2 internal editorial, 1
external), all folded in-round as disclosed above; nothing is outstanding.
The C1 resolution is a real reconciliation, not a patch-over: the admission
rule is now ONE decision table whose two scoped columns are each proven
against their OWN today-baseline, and the I4 argument holds per-domain by
construction. The architecture (domain taxonomy, ownership index,
typed-refusal contract, ladder) survived a third adversarial pass with no
structural findings.

---

## Round-2 resolution verification (per finding, against spec text AND real code)

| R2 finding | verified? | evidence |
|---|---|---|
| **C1** (topic-scoped absent⇒admit contradicts I4) | **✓ RESOLVED** | §3.2 is now a single decision table split by domain. `topic-scoped` no-record/released ⇒ the legacy lease boolean — verified byte-equivalent to today: every topic-keyed kv write routes through `guardWrite` and refuses on every non-holder (`StateManager.ts:135-139`), so I4 holds by construction; the only exception is an explicit, default-off, I9-audited absent-window-story opt-in (§9.18), which is a `dryRun:false`-gated relaxation under I4(c). `session-scoped` keeps admit-on-absent, correctly grounded on ITS today-baseline (the `sessionScoped && _sessionPoolActive` carve-out already admits every session write on a pool-active standby — `StateManager.ts:135-139`). Internal-consistency sweep: §3.1 table rows, §3.3 delegation, I4(b) (restated per-domain), I5, §5 (new topic-scoped-absent row), §8 Tier-1 tests (absent/released split by domain), §9.10 (narrowed to session-scoped), §9.18, and the eli16 bucket-2 rewrite ALL agree — no section still states the round-2 uniform arm. The "why the arms differ" paragraph states the reconciliation once, explicitly |
| **S1** (I9 logical-vs-file-level conflation; git-synced wave-1 paths) | **✓ RESOLVED** | §3.1 convergence-story requirement now has TWO axes; I9 retitled "on BOTH axes"; a shared-git-synced-path entry missing the file-level arm is refused classification, with a §8 Tier-1 test for exactly that. Concrete wave-1 build item added: `.instar/state/attention-items.json` + `.instar/state/evolution/` into `FileClassifier` sync exclusions — verified still absent today (`FileClassifier.ts:122-151` contains no `.instar/state/` pattern). Table honesty landed: attention path resolution cited to real code (`botStateDir === stateDir` on the primary bot, `TelegramAdapter.ts:809`; `attentionFilePath` `:816`); WS2.5 story correctly narrowed to `action-queue.json` only (emitter injected in `saveActions`, `EvolutionManager.ts:1212` — verified) and named config-gated dark on the fleet ("none yet" honesty); `corrections` DROPPED from the table until it has a real story; the "schema makes it unrepresentable" overstatement softened to refusable+lint-checkable; pre-existing-exposure honesty stated |
| **S2** (§1.2 store identification wrong) | **✓ RESOLVED** | §1.2 now cites the real chain, every hop verified this round: `addAction` (`EvolutionManager.ts:1245`) → `loadActions`/`saveActions` (`:1167/:1174`) → `readFile`/`writeFile('action-queue')` (`:1168/:1201`) = `state/evolution/action-queue.json`; the proposals store named as distinct (`loadEvolution`/`saveEvolution` `:781/:788`, write `:813` — verified). §11's round-1 S1 row re-marked **mis-diagnosed** (not "adopted"); §8 store-snapshot probes explicitly pointed at `action-queue.json` |
| **S3** (`releasedEvictionMs` cited as active but dead) | **✓ RESOLVED** | Re-verified this round: `grep -rn releasedEvictionMs src/` → exactly one hit, the deps declaration (`SessionOwnershipRegistry.ts:91`); no consumer; `LocalSessionOwnershipStore` has no delete/unlink path (full file read). §3.2's "released-arm grounding correction" names it a known dead knob with an explicit do-not-re-cite; session-scoped released⇒admit re-grounded on today-equivalence alone; topic-scoped released⇒legacy-boolean needs no eviction argument (released ≡ absent by the table itself, so a future eviction changes nothing). §9.19 records the decision |
| **S4** (`onCommit` at the store INTERFACE) | **✓ RESOLVED** | §3.2 point 2 now specifies `onCommit` as ADDED to the `SessionOwnershipStore` contract (`SessionOwnershipRegistry.ts:65-81`), each substrate firing at its own mutation point — Local in `persist()` (`LocalSessionOwnershipStore.ts:81-95`), InMemory in `casWrite()` at `recs.set` (`SessionOwnershipRegistry.ts:53-57` — verified: that substrate has no `persist()` funnel). The near-benign InMemory combination is named EMERGENT (via `shouldActivateDurableOwnership`, `src/commands/server.ts:17426-17441` — verified), not a guarantee. §8 parity test runs against BOTH substrates; §9.9 updated; the §5 index-divergence row updated to the interface-level phrasing (in-round fold, see disclosure) |
| **L1** (validation asymmetry poisons the warm scan) | **✓** | §3.2 point 4: ingest validation (string `ownerMachineId` + known status) regardless of store path; asymmetry re-verified (`loadOne` `:67` vs `all()` `:127`); malformed ⇒ `ownership-unresolved`, never `not-owner` with `owner: null`; I5 + §8 test cover it |
| **L2** (pre-construction window) | **✓** | §3.2 pre-construction-window clause: legacy blanket verdict until the ONE-WAY attach, which lands before routes are wired; §5 row + §8 test added |
| **L3** (re-key machine-id source + fallback) | **✓** | §3.3: id from the coordinator/mesh identity (`server.ts:6228` — verified as the real identity hand-off pattern), explicitly NOT `StateManager.setMachineId` (`:93` — re-verified caller-less in src/); fallback literal `local` with the no-peers-no-fork argument; `session-build-context-null` improvisation forbidden by name |
| **L4** (admission-error joins the §6 aggregate) | **✓** | §6: named (route, code=`admission-error`, direction) aggregate rows covering BOTH the fail-open machine-local proceeds and the fail-closed refusals, riding the same ≥N-in-window one-deduped-item discipline |
| **L5** (untracked follow-ups) | **✓** | §7 "Close the Loop" block: the four named follow-ups (write-forward-on-refusal; P1-A7 escalation + live-proof re-run; FileClassifier exclusion item; corrections re-classification) each registered as evolution actions/commitments at approval, and approval is defined as incomplete without the registrations |

**Round-2 resolutions: 10/10 verified.** (Contrast round 2, where one round-1
"resolution" turned out to be a faithfully-applied mis-diagnosis — this round
each resolution was checked against the tree, and none rests on a false code
claim.)

## Fresh internal passes (adversarial + integration) — findings

**A1 — LOW (internal, FOLDED in-round).** The §5 "ownership index diverges"
row still described the transition hook as "the store's single mutation
funnel (`persist` onCommit …)" — stale after the S4 interface-level fix
(InMemory has no `persist()`). One-sentence rewrite to the interface-level
phrasing; folded into a02291300.

**A2 — LOW (internal, FOLDED in-round).** §3.3 cited
`FileClassifier.ts:121-151` while §3.1 (and the code — the pattern array
opens at `:122`) says `:122-151`. Cite normalized; folded into a02291300.

Adversarial probes that did NOT become findings (recorded so round 4 doesn't
re-litigate them): (a) topic-scoped writes on a pool-owning standby with no
custody record refuse `read-only-standby` under the new table — checked as a
possible NEW reachability regression; it is not one: it is byte-identical to
today's behavior, wave 1 activates zero topic-scoped entries, and the wave-2
inventory + I9 opt-in is the designed path for any store that genuinely needs
the absent-window admit. (b) The I9 opt-in as a loosening loophole — checked;
it is default-off, schema-audited, and gated behind `dryRun:false` under
I4(c), so it cannot activate silently. (c) The session-scoped UNBOUND arm
admitting a write for a topic actually owned elsewhere when the binding map
misses — checked; per-session files are keyed by per-spawn session ids (no
shared path to fork) and today's carve-out admits the same write, so the arm
is today-equivalent, as the spec states.

Integration pass: every code citation INTRODUCED by the round-3 fold was
verified against the tree this session — `EvolutionManager.ts`
:1245/:1167/:1174/:1168/:1201/:781/:788/:813/:1212; `TelegramAdapter.ts`
:809/:816; `FileClassifier.ts` :122-151 (no `.instar/state/` exclusion);
`SessionOwnershipRegistry.ts` :53-57/:65-81/:91/:133-138/:144-150/:172;
`LocalSessionOwnershipStore.ts` :35-39/:61-79/:67/:81-95/:119-139/:127;
`OwnershipApplier.ts` :211; `StateManager.ts` :93/:135-139/:162-171;
`src/commands/server.ts` :6228/:17415+/:17426-17441/:19525. No false code
claims found.

## External pass (gemini-2.5-pro via gemini CLI) — verbatim tags + dispositions

codex CLI: **not installed** (re-checked this round) — GPT-tier unavailable;
Gemini-tier ran clean (single bounded pass, no timeout). Overall external
verdict: **CONVERGE**.

1. **LOW — a brief availability-regression window for session-scoped writes
   during the constructor's synchronous warm scan (§3.2 clause 5)** →
   CONTESTED-WITH-EVIDENCE, clarification FOLDED anyway: the state is
   unreachable for any caller — the warm runs synchronously INSIDE the
   constructor on a single-threaded runtime and the one-way attach happens
   after construction, so no `admitWrite` call can interleave with the scan;
   the clause is defensive-only (for a future substrate with a deferred
   warm) and can never produce a refusal today. Because the misreading was
   invited by the text, the defensive-only/unreachable statement was folded
   into §3.2 clause 5 (in a02291300) rather than left to argument.
2. Affirmation (no finding): the §3.2 decision table resolves the C1/I4
   contradiction; S1-S4 and L1-L5 verified as genuinely (not cosmetically)
   resolved; no newly-introduced contradiction found across
   §3.1/§3.2/§3.3/I4/I5/§5/§8/§9.

## Round-3 tally

MUST-FIX: **0** · SHOULD-FIX: **0** · LOW: **3 raised, 3 folded in-round
(A1, A2, ext #1), 0 outstanding**.

Verdict: **CONVERGED.** All three review rounds' findings (round 1: 20;
round 2: 10; round 3: 3 in-round editorial) are resolved in the a02291300
text with zero rejected and every resolution grounded in verified code. The
spec is ready for the convergence tag + approval step (flipping
`review-convergence` from `null` is the approval ceremony's move, not this
report's), after which the §7 Close-the-Loop registrations become due.
