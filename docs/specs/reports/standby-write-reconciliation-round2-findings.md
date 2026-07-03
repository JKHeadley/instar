# Round 2 Findings — standby-write-reconciliation

Reviewed: `docs/specs/standby-write-reconciliation.md` (commit 6beb99302,
round-2 revision — all round-1 findings claimed folded).
Panel: 6 internal lenses (security, scalability, adversarial, integration,
decision-completeness, lessons-aware) + 1 external cross-model pass
(gemini-2.5-pro via gemini CLI; codex CLI re-checked and still **not
installed** on this machine — GPT-tier pass honestly unavailable, same as
round 1).

Round-2 method: (1) every round-1 finding's claimed resolution was verified
against BOTH the revised spec text AND the real v1.3.722 code in this worktree
(read/grep, not memory — a resolution grounded in a false code claim counts as
unresolved); (2) fresh adversarial/integration passes were run on the revised
design itself.

**Verdict: NOT CONVERGED — 1 MUST-FIX, 4 SHOULD-FIX, 5 LOW.** The round-1
MUST-FIX layer genuinely held under attack (M1-M5 all verified against real
code — the ownership-index funnel, the FSM grounding, the re-key, the emptied
§10 are all real and sound). The round is blocked by ONE new internal
contradiction the generalized admission rule introduced (C1: the
absent/released⇒admit arm applied to *topic-scoped* domains violates the
spec's own invariant I4), independently flagged by the external pass. Every
fix below is bounded and textual; round 3 should be a fold-and-verify.

---

## MUST-FIX

**C1 — The absent/released⇒admit arm applied to `topic-scoped` domains
contradicts invariant I4 ("fork-safety never weakens") — the spec cannot be
built as written without violating one of its own sections.** §3.2 rule 2
admits any scoped write whose ownership index shows *no record* or a
`released` record, for BOTH scoped domains uniformly. For `session-scoped`
that is genuinely today-equivalent (round-1 M2's case: today's
`sessionScoped && _sessionPoolActive` carve-out, `StateManager.ts:135-139`,
already admits every session write on a pool-active standby — the new rule
only tightens). For **`topic-scoped`** it is a LOOSENING: today every
topic-keyed kv write routes through `state.set` → `guardWrite('set')` and is
**refused on every non-lease-holder** (the blanket boolean). Under the new
rule, a topic with no custody record (pool cold-start before placements land;
a released/idle topic touched by background sweeps over stale bindings on two
machines) is admitted on EVERY pool machine simultaneously — two writers, one
shared per-topic path, exactly the dual-writer fork I4(a)/(b) and §2
Non-goals ("fork-safety … is never weaker than today") promise cannot happen.
I4(b)'s "keeps admitting unbound / no-record / released scopes" honesty
argument is scoped to the session carve-out and is TRUE there; the
topic-scoped arm silently rides the same rule with no fork-surface argument
of its own. The external pass flagged the same arm independently (ext r2 #1,
MUST-FIX). Mitigating context, honestly stated: wave 1 activates ZERO
topic-scoped entries; today's topic-keyed stores are mostly single shared kv
files that the exact-key / mixed-granularity rule (§3.3) refuses to classify
anyway, so the exposure requires wave-2 per-topic re-keyed stores and sits
behind the inventory + dryRun-soak + fork-incident ladder gates. But the rule
text ships in wave-1 code, the contradiction with I4/§2 is in the spec TODAY,
and a builder cannot satisfy both sections. **Fix (bounded):** split rule 2
by domain — `session-scoped` unbound/no-record/released ⇒ admit (unchanged,
M2's reachability case); `topic-scoped` no-record/released ⇒ **collapse to
the legacy lease boolean** (admit on the holder, typed-refuse
`read-only-standby` on a standby — byte-identical to today, so I4 holds by
construction), UNLESS the registry entry names an explicit absent-window
convergence story (in which case admit, story-audited under I9). Owned
records keep the §3.2 rule-3 owner check unchanged. Also re-ground the
`released ≡ absent` justification, which currently cites a mechanism that
does not exist (see S3) — under the fix, `released ⇒ legacy-boolean` no
longer needs the eviction-consistency argument at all.

## SHOULD-FIX

**S1 — I9's convergence-story taxonomy conflates LOGICAL-state convergence
with FILE-level git-sync convergence; the wave-1 machine-local entries sit on
git-synced shared paths with logical-only stories.** M3-b's core argument was
file-level: "a shared git-synced file admitted on every machine manufactures
recurring merge conflicts." The revision fixes that for
`session-build-context` (per-machine re-key — genuinely file-level) but the
other wave-1 `machine-local` entries have the same shape and only logical
stories: `state/attention-items.json` resolves to
`<stateDir>/state/attention-items.json` (primary bot: `botStateDir ===
stateDir`, `TelegramAdapter.ts:809/:813`) — under `.instar/state/`, which is
NOT in FileClassifier's sync exclusions (`FileClassifier.ts:122-151`) — with
story "pool-scope GET merge + WS4.1 ack" (a read-merge story; it does nothing
for two machines rewriting the same FILE under GitSyncManager auto-commit).
Same for `state/evolution/*`. This exposure is PRE-EXISTING (both routes
already bypass StateManager and write locally on every machine today — §1.2's
own point), so no regression is created — but §3.1's claim that "the registry
schema makes that unrepresentable" is overstated: the schema happily
represents it. Additional honesty gaps in the same table row: the WS2.5 story
covers ONLY the actions store (`saveActions` emitter,
`EvolutionManager.ts:1203-1210`) — not `evolution-queue.json`
(proposals) or the other `state/evolution/*` files the glob sweeps in; WS2.5
is config-gated dark on the fleet (`multiMachine.stateSync.evolutionActions`),
so the fleet's actual story is "none yet"; and the `corrections` entry names
NO story at all — a direct I9 violation inside I9's own exemplar table.
**Fix:** give I9 a second axis — for any machine-local entry on a git-synced
shared path, the story must ALSO name the file-level arm (`per-machine-path`
| `git-sync-excluded`), and add the concrete wave-1 build item: add
`.instar/state/attention-items.json` + `.instar/state/evolution/` (and any
other classified shared paths) to FileClassifier's sync exclusions, with the
logical stories carrying cross-machine convergence. Name a real story for
`corrections` (or drop it from the table until it has one).

**S2 — §1.2's store identification is WRONG: the round-1 S1 fold introduced a
new factual error (the round-1 finding itself was wrong, and the fold
faithfully applied it).** `POST /evolution/actions` → `addAction`
(`EvolutionManager.ts:1245`) → `loadActions`/`saveActions` (`:1167/:1174`) →
`readFile`/`writeFile('action-queue')` (`:1168/:1201`) = writes
**`state/evolution/action-queue.json`** — the original draft's filename was
correct. `evolution-queue.json` is the PROPOSALS store
(`loadEvolution`/`saveEvolution`, `:781/:788`) and is not in this route's
path at all. Consequence beyond the cite: the wave-1 classification's WS2.5
story happens to attach to the RIGHT file (action-queue IS the
WS2.5-replicated store), but §1.2 as written points the builder and the §8
acceptance probes at the wrong file for I3/store-snapshot assertions. Fix the
cite (and note the two stores are distinct); mark round-1 S1 as
mis-diagnosed in the disposition trail rather than "adopted".

**S3 — `releasedEvictionMs` eviction is cited as an active mechanism but is
DECLARED-AND-UNUSED: the `released ≡ absent by eviction-consistency` argument
rests on code that does not run.** `releasedEvictionMs` appears exactly once
in src/ — the deps declaration (`SessionOwnershipRegistry.ts:91`). No sweep
consumes it; `LocalSessionOwnershipStore` has no delete/unlink path at all;
released records currently persist indefinitely. A spec argument grounded in
a false code claim is unresolved by this ceremony's own standard. Under the
C1 fix the argument becomes unnecessary for `topic-scoped` (released ⇒
legacy-boolean); for `session-scoped` the released⇒admit outcome can stand on
today-equivalence alone (the current carve-out admits it). Fix the text
either way; optionally name the unimplemented eviction as a known dead knob
so a future builder doesn't re-cite it.

**S4 — The `onCommit` transition hook must be specified at the
`SessionOwnershipStore` INTERFACE, not "inside `LocalSessionOwnershipStore.persist()`".**
The `InMemorySessionOwnershipStore`'s `casWrite` mutates `recs` directly
(`SessionOwnershipRegistry.ts:53-57`) — there is no `persist()` funnel on
that substrate, so a hook placed only in the Local store leaves the index
warm-once-then-permanently-stale whenever the pool runs on InMemory. §3.2's
"trivially covered (its `all()` is already pure memory)" addresses the I2
warm-scan cost only, NOT transition updates. Today the combination is
near-benign by construction (`shouldActivateDurableOwnership` forces the
durable store on any machine consuming replicated placements,
`server.ts:17425-17442`, so InMemory only runs where cross-machine records
never arrive) — but that is an emergent property of a different feature's
activation logic, not a guarantee this spec owns. One-sentence fix: the hook
is part of the `SessionOwnershipStore` contract; both shipped substrates fire
it at their mutation point; the Tier-1 parity test runs against BOTH.

## LOW

**L1 — `all()` vs `loadOne()` validation asymmetry poisons the warm scan's
malformed-record handling.** `loadOne` requires `ownerMachineId` to be a
string (`LocalSessionOwnershipStore.ts:67`); `all()` validates only
`ownershipEpoch` + `sessionKey` (`:127`) and CACHES the weaker record — so a
malformed on-disk record (missing `ownerMachineId`) enters the index at warm
and would produce a `not-owner` refusal with `owner: null` instead of the §3.2
rule-4 `ownership-unresolved`. Name it: the index validates at ingest
(ownerMachineId string + known status) and classifies failures malformed ⇒
fail-closed, regardless of which store path surfaced the record.

**L2 — Pre-construction window: StateManager exists and takes writes long
before WriteAdmission is constructed (the pool block, `server.ts:17415+`).**
I8 morally covers it, but state it explicitly: `guardWrite` runs the legacy
blanket verdict until the admission layer attaches; attachment is one-way and
happens before routes are wired.

**L3 — The re-key's machine-id source and null fallback are unnamed.**
`StateManager.setMachineId` (`:93`) has no production caller found in src/;
single-machine installs may have no machine id at all. Name the source (the
coordinator/mesh identity, not `StateManager._machineId`) and the fallback
key when none exists (e.g. literal `local` — safe: no peers ⇒ no fork), so
the builder doesn't improvise `session-build-context-null`.

**L4 — Admission-layer-throw occurrences should explicitly join the §6
aggregate alert** (external r2 #2, adopted): both the fail-open
machine-local proceed AND the fail-closed `admission-error` refusals are
evidence of a broken guard; §6 lists refusal aggregation but the
admission-error class deserves a named (route, code) aggregate row + ONE
deduped attention item, same flood discipline.

**L5 — Close the Loop: the named follow-ups have no durable trackers.**
`write-forward-on-refusal` (§9.13), the P1-A7 starvation-window escalation
(§8), and (if S1 is adopted) the FileClassifier exclusion item should each be
registered (evolution action / commitment) when the spec is approved — a
named-but-untracked follow-up is the exact pattern the constitution calls
abandoned.

---

## External pass (gemini-2.5-pro via gemini CLI) — verbatim tags + dispositions

codex CLI: **not installed** (re-checked this round) — GPT-tier unavailable;
Gemini-tier ran clean (single bounded pass, no timeout). Overall external
verdict: **REVISE**.

1. **MUST-FIX — "admit-on-absent-record" for `topic-scoped` writes creates a
   dual-writer fork race (§3.2)** → ACCEPTED, folds into **C1** — and the
   internal integration pass upgraded its grounding: the arm doesn't just
   risk a fork, it contradicts the spec's own I4/§2 "fork-safety never
   weakens" claims (today a standby refuses all topic-keyed kv writes).
2. **SHOULD-FIX — admission-layer self-throw needs high-severity alerting,
   not just a log row (§5)** → ACCEPTED as **L4** (aggregate + deduped
   attention item, flood-disciplined).
3. Affirmations (no finding): OwnershipIndex construction (§3.2), the
   409+Retry-After contract (§3.4), the rollout ladder/dryRun semantics (§7).
   Noted: gemini also affirmed I9's story categories as "sufficient" — the
   internal pass CONTESTS that specific affirmation with repo evidence the
   external reviewer could not see (**S1**: git-synced shared paths need a
   file-level story axis).

## Round-1 resolution verification (per finding, against spec text AND real code)

| R1 finding | verified? | evidence |
|---|---|---|
| M1 (ownership index / I2) | **✓ RESOLVED** | `persist()` real, `cache.set` first (`LocalSessionOwnershipStore.ts:81-95`); BOTH writers funnel through it — `registry.cas()` → `store.casWrite` (`SessionOwnershipRegistry.ts:172`) → `persist` (`:111-113`), and `OwnershipApplier` → the SAME `store.casWrite` (`OwnershipApplier.ts:211`); single construction site (`server.ts:17434-17437`); `loadOne` miss = `existsSync`+`readFileSync`, no negative cache (`:61-79`) — the `registry.read()` ban is necessary and the boot-warm `all()` (`:119-139`, `scanned` flag) is real. Refinements: S4 (interface-level hook), L1 (validation asymmetry) |
| M2 (unowned-session regression) | **✓ RESOLVED** (for its subject: sessions) | `getTopicForSession` is a real in-memory map read (`TelegramAdapter.ts:2293-2295`); `resolveTopicForSessionFromDisk` (`:2317+`) is real and correctly forbidden; unbound⇒admit ≡ today's carve-out (`StateManager.ts:135-139`). The TOPIC-scoped generalization of the same arm is C1 — a NEW defect outside M2's scope, not an M2 regression |
| M3 + M3-b (kv key / git-synced fork) | **✓ RESOLVED** | `STATE_KEY = 'session-build-context'` (`SessionBuildContextStore.ts:6`), 6h age (`:7`), `record` `:52`, `writeAll`→`state.set` `:105`; `set()` writes `state/<key>.json` (`StateManager.ts:498-505`); `validateKey` `^[a-zA-Z0-9_-]+$` (`:174-178`) accepts the suffixed key; `.instar/state/` absent from FileClassifier exclusions (`:122-151`); GitSync both-roles (`server.ts:4548-4551`). Re-key + per-machine-path story is a genuine file-level fix. See L3 (machine-id source) |
| M4 (six open questions) | **✓ RESOLVED** | §10 = "None"; OQ2→§9.14, OQ3→§9.13, OQ4→§9.12, OQ5→§9.1, OQ6→§9.15 — each a real decision, not a re-deferral |
| M5 (placing fail-closed / F1 dependency) | **✓ RESOLVED** | `ownerOf` returns `ownerMachineId` for every non-released status (`SessionOwnershipRegistry.ts:134-138`); `placementTargetOf` (`:144-150`); FSM statuses are exactly `placing\|active\|transferring\|released` (`SessionOwnership.ts:23`) — NO `contested` anywhere; output-exclusion contract real (file header). No F1 dependency |
| S1 (evolution filename) | **✗ FAILED** | The fold applied round-1's own mis-diagnosis: `addAction` writes `action-queue.json` (`EvolutionManager.ts:1168/:1201`), not `evolution-queue.json` (the proposals store, `:781/:788`). → round-2 **S2** |
| S2 (gauge authed-only) | ✓ | §6: authed `/health` extension only, ropeHealth posture |
| S3 (parent-doc paths) | ✓ | frontmatter qualifies them as agent-home session-A docs |
| S4 (guard-manifest deliverable) | ✓ | §3.5 names key/kind/configPath/dryRunConfigPath/process/loadBearing; `GUARD_MANIFEST` real (`guardManifest.ts:67`) |
| S5 (pool-dark behavior) | ✓ | §3.2 pool-inactive collapse clause + §5 row + §9.17 |
| S6 (P19 retry brakes) | ✓ | §3.4: `Retry-After` on every retryable, no-busy-retry contract, aggregate tripwire |
| S7 (keying honesty) | ✓ | §3.1 keying note; `sessionKey = String(topicId)` real (`server.ts:20203-20204`) |
| L1 (Telegram abort) | ✓ | 15s / 60s getUpdates verified (`TelegramAdapter.ts:5361-5364`) |
| L2 (TOCTOU residual) | ✓ | §5 cross-machine-lag row, convergence named |
| L3 (journal jail) | ✓ | jail real (`StateManager.ts:162-171`), survives verbatim per §3.1/§3.6, §8 test |
| L4 (hint advisory) | ✓ | §3.4 hint clause names the consent gate |
| L5 (:52 vs :105) | ✓ | §1.1 cites both correctly now |
| ext #1-#7 (r1) | ✓ | dispositions all present and consistent with the folded text (§11 table spot-checked against §3.2/§3.3/§3.4/§7/§8) |

**Round-1 resolutions: 19/20 verified; 1 failed (S1 → round-2 S2).**

## Round-2 tally

MUST-FIX: **1** (C1 — internal I4 contradiction; folds external #1) ·
SHOULD-FIX: **4** (S1-S4) · LOW: **5** (L1-L5, incl. external #2).

Verdict: **NOT CONVERGED** — one bounded, textual revision round required
(C1 rule split + I4 reconciliation; S1-S4 folds; L1-L5 one-liners), then
round-3 verification. The architecture itself (domain taxonomy, ownership
index, typed-refusal contract, ladder) held under attack and needs no
structural change.
