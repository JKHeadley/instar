# Round-3 convergence findings — durable-conversation-identity

**Spec reviewed:** `docs/specs/durable-conversation-identity.md` @ commit `fca5abe48`
("round-3 revision — resolve R2 convergence findings").
**Report commit:** this file.
**Round-3 status: NOT CONVERGED.** 4 CRITICAL + 16 MAJOR + ~25 MINOR.

Round 3 verified that **all 24 Round-2 findings + 5 codex-R2 items are genuinely resolved
in the body** (mechanisms, defaults, §10 test pins present — not just Appendix-B rows). But
the two headline Round-2 fixes — the **`sticky` durable-binding marker** (R2-adversarial-1)
and the **backup-manifest journal glob** (R2-integration-1) — each introduced a fresh flaw
that changes the spec:

- The `sticky` marker, added to stop a durable binding being demoted, is **not a sound
  convergent primitive**: it breaks the "merge is a pure function of the record set R" claim
  that the whole cross-machine correctness argument rests on (three independent reviewers,
  plus the external GPT-tier pass, converged on this).
- The backup-manifest entry the WAL-in-backup disaster-recovery closure depends on is a
  **subdirectory glob the deployed `BackupManager.expandGlob` silently refuses** — verified
  against code at v1.3.722 — so the journal never enters a snapshot and the CRITICAL DR hole
  the WAL exists to close is reopened.

A round that surfaces a critical is a SUCCESS of the ceremony: these are pre-code catches on
the highest-criticality new machinery (the merge algebra and the recovery path). None blocks
the shipping single-machine Phase-1 path outright, but C1–C3 invalidate the load-bearing
§3.5.1 correctness argument as written, and C4 sits directly on the disaster-recovery path.

---

## Reviewers who ran this round

**Six internal lenses (all ran, independent passes):** security, scalability, adversarial,
integration (grounded against the worktree's real v1.3.722 code, ~60 file:line checks),
decision-completeness, lessons-aware.

**Standards-Conformance Gate:** ran (1 flag) — `LLM-Supervised Execution: possible-violation`
(the §6.2 Tier-0 exception vs the Tier-1 minimum). 51 standards checked, not degraded,
registry canary ok, fit-verdict "fit" (parent principle resolved). The lessons-aware reviewer
judged the flag **engaged-adequately** (Tier 0 is correct for a byte-deterministic merge/
rebuild pipeline; the fix is to make the declaration first-class frontmatter — see MINOR).

**External cross-model passes (BOTH ran successfully this round):**
- **codex-cli / gpt-5.5** — RAN. Verdict **SERIOUS ISSUES**, 5 findings.
- **gemini-cli / gemini-2.5-pro** — RAN. Verdict **MINOR ISSUES**, 3 findings. (Note: a
  prior Gemini pass timed out earlier in the session; THIS round's Gemini pass completed
  inside the 10-minute bound. Both families are represented.)

Deduplicated below; a finding hit by multiple independent reviewers is flagged
`[N reviewers]` as a confidence signal.

---

## Round-2 resolution verification (protocol step 1)

Every Round-2 finding traced to its claimed resolution in the round-3 body:

- **All MUST-FIX (adversarial-2, integration-1, lessons-1, scalability-1, security-NEW-3):**
  resolved in-body — BUT integration-1's *glob half* breaks the deployed resolver (→ **C4**),
  and lessons-1's window/key fix carries two arithmetic/semantics residuals against the real
  PromiseBeacon (→ **M1, M2**).
- **Merge-algebra HIGHs (adversarial-1, adversarial-3, security-NEW-2):** the prescribed
  mechanisms landed — BUT the adversarial-1 `sticky` fix is only **partially resolved**
  (one-sticky case fixed; the fix introduced C1/C2/C3/M8), and adversarial-3's
  "retried-never-cursor-skipped" is **partially resolved** (equal-R premise addressed; the
  retry mechanism introduced M13).
- **SHOULD-FIX + all LOW + all codex-R2 items:** genuinely resolved (see the appended
  verification matrix at the end of this report). Full detail per finding preserved there.

**Net:** the Round-2 findings did not regress; two of their *resolutions* introduced sibling
flaws. That is the expected shape of a convergence process working correctly.

---

## CRITICAL findings (must change the spec)

### C1 — `sticky` breaks "pure function of R": same id can resolve to two conversations across machines
**§3.5.1 steps 1(i)/3, §3.3 "provisional-but-convergent"** · `[adversarial; codex-ext #2; security S1 adjacent]`

`sticky(t)` is defined as "R carries a durable-binding marker for tuple `t`'s **assigned
id**" — but the assigned id is what the merge computes, and the marker was written on
whichever id the **local provisional mint** happened to choose, which is arrival-order-
dependent. Concrete break (active-active, the state §9's `stateSync.conversations` targets):

1. Tuples T1, T2 genuinely collide at candidate `C` (`T1 ≺ T2`).
2. Machine A mints T1 first → `T1→C`, then T2 → `T2→C-1`. Machine B mints T2 first → `T2→C`,
   then T1 → `T1→C-1`.
3. A durable commitment opens on **T2's conversation** on both machines: on A it binds
   `topicId=C-1` (sticky on T2's record claiming C-1); on B it binds `topicId=C` (sticky on
   T2's record claiming C).
4. Partition heals; both hold `R = {T1(C), T2-fromA(C-1,sticky), T2-fromB(C,sticky)}`. Final
   `resolve(C)` now depends on the **unpinned composition order** of two independently-defined
   rules (same-tuple-different-id resolution vs sticky-canonical reservation) — one order
   gives C to T1 (machine B's commitment misdelivers into T1's conversation), the other keeps
   C for T2.

The spec pins neither the sub-step order nor a proof of a unique fixpoint, and the §10 sticky
test only exercises the one-sided case, never the provisional-id-mismatch permutation.
**Fix:** the sticky record must carry the explicit bound-id (not "the assigned id"); pin the
composition order of same-tuple-resolution vs sticky-canonical-reservation; add a §10 fuzz
test across ≥3 machines **with sticky in R** asserting a unique fixpoint.

### C2 — `sticky` expiry vs monotonic replication is self-contradictory → permanent divergence or unbounded sticky-leak
**§3.4 sticky field, §3.5.1 `sticky(t)`, §3.5 clamp** · `[adversarial; codex-ext #2]`

Three stated properties of `sticky` cannot all hold: (1) it is a **merge input** → must be a
deterministic function of R for convergence; (2) it is **monotonic on replication** — "a
replicated `false` never clears a local `true`"; (3) it **"expires with the binding
lifecycle,"** a local-authoritative change. Walk it: a commitment closes → the owner clears
sticky locally and emits `sticky:false` → every peer that ingested `sticky:true` **refuses
the clear** (property 2) → the owner's R has it cleared, peers' R still set → the merge reads
divergent sticky → **permanent divergence on `resolve(C)`**. The only self-consistent
alternative (never clears) is also broken: at scale every id eventually carries a transient
binding → every id becomes permanently sticky → the `≺` canonical rule (the actual collision-
convergence guarantee) is dead → arrival-order "who bound first" wins → non-convergence.
**Fix:** either sticky is fully replicated in BOTH directions with an HLC-ordered resolution
of a partition-era set-vs-clear (a real pure function of R), or sticky is **not a merge input
at all** and demotion protection is achieved another way. It cannot be simultaneously
local-authoritative and a convergent merge input. The external GPT-tier reviewer hit this
independently: *"sticky depends on live durable-binding lifecycle and can 'expire' … two
machines with different binding lifecycle visibility can compute different canonical owners."*

### C3 — two-sticky partition: heal-forward cannot reuse one id for two conversations → a durable binding is necessarily stranded
**§3.5.1 step 1(ii)+step 2, §3.5 atomic winner-flip** · `[adversarial]`

The sticky fix removes the Round-2 adversarial-1 inconsistency only for the **one-sticky**
case; the **two-sticky** case is punted to "fall back to `≺` + heal-forward repoint," which
re-opens the exact A5-vs-A3 contradiction. Scenario: T1, T2 collide at `C`; during a
partition machine A binds **T1** (`T1→C`, sticky), machine B binds **T2** (`T2→C`, sticky).
Both consumers hold `topicId=C` verbatim, but C means T1 on A and T2 on B. Merge over
`R={T1(C,sticky), T2(C,sticky)}` → `≺`-least T1 owns C, T2 heal-forward to C-1. Machine B's
replicated commitment holds `topicId=C` for T2, and `resolve(C)` is now **T1's**
conversation. Heal-forward must then either **mutate the commitment's `topicId` C→C-1** —
which directly violates the §2 decision-1 rationale ("168 files hold `topicId` verbatim,
CANNOT rebind" — the entire reason minted-id was chosen over typed-union) and races
CommitmentsSync — **or** leave C aliased to two targets (impossible). There is **no consistent
resolution**; "never a silent strand" is asserted but the mechanism cannot deliver it.
**Fix:** define this case concretely as a **loud operator escalation + explicit non-silent
refusal**, not a heal-forward that pretends to reconcile an unreconcilable id reuse.

> **C1–C3 root (state once, plainly).** The merge must be a pure function of R for
> convergence, so R — populated by peers whose durable-binding lifecycle is not globally
> ordered — is authoritative for id-assignment/registry-**shape**. "Replicated is advisory,
> never authority" holds only for **delivery** (local-origin-gated). The spec should add a
> subsection scoping that claim to delivery and either (a) prove the sticky-augmented merge is
> still a pure convergent function, or (b) remove sticky from the merge input and protect
> durable bindings by a mechanism that does not perturb canonical assignment. These block the
> `stateSync.conversations` graduation (increment 9), not the single-machine Phase-1 ship —
> but they invalidate §3.5.1's load-bearing correctness argument as written.

### C4 — the WAL backup-manifest glob is a dead entry against the deployed `BackupManager` → disaster-recovery hole reopens
**§3.4 "Backup manifest — the SNAPSHOT AND THE JOURNAL, both", §6.2(a), §10 Tier-2** · `[integration, code-grounded @ v1.3.722]`

The spec pins the backup entry as the stateDir-relative **glob
`logs/conversation-registry.jsonl*`**. The deployed `BackupManager.expandGlob`
(`src/core/BackupManager.ts:97-112`, consumed at `:284-315`) supports **only top-level
trailing-star globs** — it explicitly returns the literal string for any pattern whose prefix
contains `/`: `if (prefix.includes('/') || suffix.includes('/') || suffix.includes('*')) {
return [entry]; }`. `createSnapshot` then does
`fs.existsSync(path.join(stateDir, 'logs/conversation-registry.jsonl*'))` → false → the
journal is **silently skipped**. The only working glob precedent is the top-level
`shared-state.jsonl*` (`:84`), and there is a deployed dead-entry precedent of exactly this
class (the migrator's own subdirectory `pr-pipeline.jsonl*`). Consequence: the WAL never
enters a snapshot → a disk-loss restore loses **every probed and thread-level id since the
last flush**, reopening the CRITICAL DR hole (gemini-C1) the WAL was added to close — AND
invalidating the R2-integration-2 justification for dropping the pre-backup flush.
The spec says §6.2(d) "nothing else" and never declares the required **`BackupManager`
`expandGlob` extension as a named shared-code increment** — the exact standard Round-2 applied
when it demanded the flush hook be scoped as an explicit BackupManager increment, not a
migrator line. **Fix:** declare that increment (subdirectory-aware trailing-star expansion +
path-traversal safety) OR change the manifest entry to a shape the deployed resolver already
supports; and refine the §10 Tier-2 assertion — a glob entry does NOT "resolve via the
stateDir-join"; the test must assert the **expanded set is non-empty and each expanded file
is present in the snapshot**.

---

## MAJOR findings (should change the spec)

### The E1 idempotency guard does not compose with the real PromiseBeacon (two findings)

**M1 — E1 dedup window < the real max beacon re-fire interval.**
**§5.0(a)** · `[adversarial + integration + lessons — 3 reviewers]`
The invariant `ambiguousDedupWindowMs ≥ max beacon re-fire + margin` (default 30 min, derived
from "the 20-min base") does not match the deployed cadence: `PromiseBeacon.ts:562-564` doubles
the base when `atRisk` (→ 40 min, already > 30 min), and `:421-422` caps at
`maxCadenceMs = 21_600_000` (**6 hours**); CLAUDE.md documents the autonomous-heartbeat backoff
25→40→60→90 min. An ambiguous re-fire of the same `logicalSendId` lands **outside** the 30-min
window → double-post — the exact failure R2-lessons-1 thought it closed. A literal startup
assertion against the real 6h max would clamp the window up past 6 hours on every install.
**Fix:** bind the invariant to the **effective per-commitment cadence including the atRisk ×2
and the backoff cap** (or persist the dedup entry until the specific logical send is retired,
not a fixed window); re-derive the default from the real `min/maxCadenceMs`; run the §10 test
at the backed-off cadence, not the base.

**M2 — `logicalSendId` sendSeq has no durability/increment semantics against the real beacon.**
**§5.0(a), §10** · `[adversarial + integration — 2 reviewers]`
The deployed beacon has no send-sequence concept and advances `lastHeartbeatAt` on **every**
check "sent or not" (`PromiseBeacon.ts:784-800`), so once §5.1's re-arm fix lands, the
ambiguous "retry" IS the next scheduled tick. Under the natural implementation (increment
sendSeq per `fire()`), the ambiguous re-fire carries a **new** seq → the guard **never
matches** → E1 is a no-op. And if sendSeq is in-memory and resets on restart, the post-restart
seq-0 heartbeat collides with the pre-restart seq-0 entry still in-window → **the first
post-restart heartbeat is silently suppressed** — directly undermining the flagship
restart-durability proof. **Fix:** pin sendSeq as durable + monotonic per commitment
(persisted/journaled), held constant across `not-delivered`/ambiguous outcomes and advanced
only on a delivered outcome; add a §10 restart-between-heartbeats test (post-restart heartbeat
NOT suppressed).

### The merge / registry-shape is authoritative-from-R but treated as advisory (security cluster)

**M3 — §3.5.1 merge has no complexity bound / incrementality statement → O(N²) freeze risk at ingest.**
**§3.5, §3.5.1, §6.1 step 9, §10** · `[scalability]`
Round 3 pinned the *local mint* hot path to genuine O(1) but placed no cost pin on the merge
**as applied at ingest**. "Pure function of the record set R" invites the naive full-recompute-
per-record implementation → **O(N²) on the shared event loop** during initial replication sync
or an offline-returning machine's catch-up — the CommitmentTracker 2026-06-21 freeze shape
relocated to the ingest path, biting the dev agent exactly when increment-9 soaks. **Fix:**
state that the pure function is the specification of the *result*, not the execution strategy;
application MUST be incremental per touched collision class/tuple (locate via a cand→claimants
index, recompute only that class); batch-resolve-once for bulk arrival; extend §10's
bounded-ops assertion to the ingest/merge path against a large seeded R.

**M4 — index inventory undercount: §3.4 declares 2 indexes; round-3 machinery needs 4–5.**
**§3.4 vs §3.3/§3.5.1** · `[scalability]`
§3.4 says "**Two** in-memory indexes are maintained synchronously," but `candidateCollides`'s
round-3 clauses require at least a **reserved-canonical map** (cand→owning tuple, clause a) and
the **per-collision-class `≺`-ordered taken-offsets sets** (clause c), and the merge needs a
**cand→claimants multimap** — none inventoried, none given a boot-rebuild story (they are
derivable from snapshot+journal — say so, never persisted), and the resident-heap accounting
predates the growth from 2 to ~4–5 O(N) maps (heap plausibly 5–10× `fileSizeBytes` at 100k).
A faithful implementer following the two-index list produces a probe path that scans or misses
clause (a)/(c). **Fix:** one paragraph aligning §3.4's inventory with §3.3/§3.5.1, marking the
derived indexes rebuild-at-boot / never-persisted, and updating the health-endpoint heap note.

**M5 — B7 bind-time authority is unenforceable as specified (no request→session binding exists).**
**§7, §10** · `[security, code-grounded]`
The policy ("a session may open durable state ONLY on a conversationId in its OWN authenticated
bootstrap context") is well-defined but has **no enforcement primitive**. Grounded:
`POST /commitments` (`routes.ts:21786`) reads `topicId` from the request body; the API is
Bearer-gated with a **single shared `authToken` across all sessions** (`middleware.ts:120+`);
the request carries no authenticated session identity, and `source`/`boundBy` are
caller-supplied/forgeable. The server cannot determine WHICH session is calling → cannot check
`topicId ∈ that session's bootstrap context` — exactly the "confused session posts another
conversation's minted id" threat B7 names. The §10 cross-conversation-bind-refusal test cannot
pass without a mechanism the spec never specifies. **Fix:** define the trusted request→session
binding (a per-session credential/header injected at spawn, or a server-side session-context
lookup keyed on something the request authentically carries) before B7 is real.

**M6 — forged low HLC wins: the skew-quarantine exemption + a wide absolute window let a peer back-date to seize canonical ids.**
**§3.5.1 (the "same R" clause), §3.5, §7** · `[security + lessons + codex-ext #2 adjacent — 3 reviewers]`
The conversations algebra is **lowest-HLC-wins** (`≺`), which inverts the forgery threat to
**back-dating**. Making the ingest exempt from the foundation's pool-relative skew quarantine
removes the only bound on HLC plausibility; the remaining gate is the **fixed absolute window**,
which MUST be wide (it has to admit years-old records from an offline-returning machine). A
compromised peer forges `physical = 1`, passes acceptance, and **wins `≺` in every
collision/same-tuple-different-id merge**, forcing honest tuples into aliases. B4 only prevents
`mintedBy`/`hlc.node` (the tiebreak) forgery — it does **not** cover `hlc.physical` (the primary
winner). Bounded (churn + attention, not cross-delivery, since delivery is local-origin) → MAJOR
not CRITICAL — but the spec advertises the absolute window as "the acceptance check that matters"
while its real anti-forgery posture is sticky + advisory-until-corroborated + local-origin
delivery. **Fix:** add a back-dating threat-honesty paragraph (mirror the §3.3 birthday-honesty
pattern) scoping "advisory, never authority" explicitly to delivery and acknowledging
id-assignment is peer-perturbable; consider requiring a sticky/low-HLC claimant that displaces a
LOCAL binding to be corroborated.

**M7 — collision-class stuffing: a peer can construct ≤64 colliding tuples to force a targeted pending-mint DoS.**
**§3.3 clause (c), §3.5.1 step 2** · `[security]`
The frozen candidate is a non-cryptographic 32-bit sum-shift and `channelId` is only
shape-clamped (`^[CDG][A-Z0-9]+$`, never validated against real Slack), so candidate collisions
are **constructible on demand**. The round-3 taken-offsets walk is a function of *all* of R,
including uncorroborated `replicated`-origin entries (accepted within `MAX_PROBE_DISTANCE`
without local occupancy, by design). A compromised peer replicates ≤64 fabricated tuples all
colliding at a victim's candidate C, fills the collision-class taken-offsets set, and forces the
victim's legitimate local mint at C into the §3.6 pending-mint degradation. The seize-refusal
does not fire (crafted collisions are "provable collisions" → merge, not seize). The §3.3
birthday table treats "provably colliding" as an accidental event; it is adversarially
manufacturable. **Fix:** local-mint displacement reserves only against locally-corroborated /
local-origin offsets, OR cap uncorroborated replicated tuples admitted per collision class.

**M8 — `sticky` is a single boolean, not a refcount → clearing on first bind-close strands a still-live binding.**
**§3.4 sticky field, §3.5.1** · `[adversarial]` (part of the C1–C3 sticky cluster)
An id can carry multiple durable bindings at once (a commitment AND a working-set carry AND an
attention item). `sticky` is a single boolean cleared "with **the** binding lifecycle"
(singular); clearing on the first bind-close while others are live lets a later lower-HLC
colliding record demote the id → the still-live binding is stranded. **Fix:** sticky must be a
refcount / live-binding set, cleared only when the last durable binding closes — and that clear
must itself be convergent (which loops back into C2).

**M9 — multi-workspace enforcement is self-contradictory; global channel-id uniqueness is an unstated load-bearing assumption.**
**§3.1** · `[adversarial + codex-ext #1 — 2 reviewers]`
§3.1 claims the single-workspace assumption is "**STRUCTURALLY ENFORCED**" by a fleet-wide
hard-refuse of a second concrete workspaceId — but the R2-security-NEW-2 fix says a machine
seeing a replicated-pin conflict "**keeps minting under its LOCAL authenticated teamId**" + one
attention item. Two machines authed to different workspaces with no config pin therefore mint
**both workspaces concurrently** — the precise state §3.1 says is impossible; enforcement
silently degraded from "fleet refuses" to "each machine mints its own + logs." Whether that is
safe hinges entirely on **global Slack channel-id uniqueness** (the tuple has no workspaceId),
which the spec never states as the invariant it relies on. The external GPT-tier reviewer hit
this independently and recommends either making `workspacePin` mandatory in multi-machine mode
or putting `workspaceId` in the tuple from v1. **Fix:** reconcile the two claims — genuine
fleet-refuse (needs the coordination the round-2 fix removed) OR accept per-machine minting and
**state the global-channel-id-uniqueness assumption explicitly**, noting the Enterprise-Grid /
shared-channel exception (§11.8).

**M10 — HLC `physical` unit/epoch + the absolute-window constants are convergence-critical but unpinned.**
**§3.4, §3.5, §3.5.1** · `[adversarial + decision-completeness — 2 reviewers]`
The convergent tiebreak reads `hlc.physical` raw across machines and the anti-forgery gate
checks it against `HLC_ABS_MIN…HLC_ABS_MAX` — given only as "e.g." (the sole unpinned
frozen-forever value in the spec). Both silently assume every machine and every *version* emits
`physical` in the same unit and epoch. A future foundation HLC representation change (µs, or a
different epoch) would produce incomparable raw values across a mixed fleet → wrong winners →
divergence, and legit records falling outside the frozen window. **Fix:** pin the HLC physical
unit + epoch AND `HLC_ABS_MIN`/`HLC_ABS_MAX` as concrete frozen versioned constants (same
treatment as `MAX_PROBE_DISTANCE` / probe direction), tested in the golden-parity suite;
document the `HLC_ABS_MAX` horizon year + the required pre-horizon migration.

**M11 — P17 global ceiling missing at the delivery funnel (the dodgeable half).**
**§5.2, §10** · `[lessons]`
§5.2 places a **per-conversation** budget at the funnel and §10's burst test is "1,000 items on
**one** minted id → bounded." P17's own text says per-source budgets alone are dodgeable (the
2026-06-05 flood gave every item a unique source), and the deployed Telegram analog carries both
`maxTopicsPerSource` AND `maxTopicsGlobal`. A buggy emitter raising one item per element across N
**distinct** minted conversations passes every per-conversation budget and floods the workspace.
**Fix:** add a global cross-conversation window ceiling at the `id<0` arm; extend §10 with the
dodge shape (1,000 items each to a distinct minted conversation → bounded total + one coalesced
overflow notice).

**M12 — ingest-side refusal attention is not emitter-aggregated → peer-driven topic flood.**
**§3.5/§3.6 vs §5.1** · `[security]`
§5.1 added emitter-level aggregation only for the mass-unreachable *delivery* path. The
**ingest** refusals — seize-refusal, id↔key-coherence quarantine, alias episode, workspace-pin
conflict, HLC-window quarantine — each emit "ONE deduped attention item" *per episode* with no
cross-episode aggregation and no §5.2-style budget (that budget is delivery-funnel-scoped). A
compromised peer replicating N distinct malformed/seize/colliding records → N episodes → N
attention items = the 2026-05-22/06-05 topic-flood class on the ingest boundary. **Fix:** reuse
the §5.1 emitter-aggregation pattern the spec already adopted, on the ingest refusal path.

**M13 — "retried, never cursor-skipped" has no P19 brakes and is a head-of-line wedge.**
**§3.5.1 "same R" clause, §10** · `[lessons + adversarial — 2 reviewers]`
The R2-adversarial-3 defense-in-depth rule ("a transport-quarantined conversations record is
RETRIED never cursor-skipped; the cursor does not advance past it as consumed") ships with **no
backoff, no breaker, no cap, and no terminal path** — a genuinely-broken-clock peer parks the
per-origin ingest cursor **forever** (a liveness failure; every later record from that origin
never ingests), the #867 compounding-spiral shape. The spec also conflates two quarantine
reasons: the **absolute-HLC-window** quarantine (anti-forgery) MUST be a terminal drop (pure
function, cursor advances), while the **pool-relative** one is the retryable case. **Fix:** make
absolute-window quarantine terminal-drop; give pool-relative retry a backoff + per-record cap +
a side-queue so it never head-of-line-blocks the origin's stream + a LOUD terminal (park-aside +
ONE deduped attention naming the equal-R divergence, honest since R genuinely is unequal at that
point); §10 sustained-failure test (a permanently-held record does not wedge the origin's other
records).

**M14 — WAL `seq` scope (per-file vs global) + counter durability are contradictory on the recovery path.**
**§3.4 WAL contract** · `[adversarial]`
`seq` is specified "**per-file** monotonically-increasing," but recovery replays
`seq > snapshotHighWaterSeq` (a single global number) and pruning keeps "every record ≤ a
persisted snapshot's high-water" — both require `seq` to be **globally comparable across files**.
Per-file reset either skips (new-file low seqs < old high-water) or double-applies. Nothing pins
where the counter lives across a process restart (in-memory resume at 0/1 breaks replay). This is
the recovery-critical path (the WAL is the sole durable record of probed + thread-level ids).
**Fix:** pin `seq` as a single global monotonic counter persisted across restarts and rotations
(resume from max-seen at boot); state it in the crash-consistency contract; add a §10 test
spanning a rotation boundary.

**M15 — convergence-critical / test-critical defaults left unpinned (builder would have to guess).**
**§5.1, §5.2, §5.0(a), §10** · `[decision-completeness]`
Beyond M10's HLC constants: the **dead-letter N** ("after N consecutive not-delivered" — distinct
from `deadLetterAttentionAfter=1`; the §10 "N-fail" test is otherwise unimplementable), the
**per-conversation P17 budget value + window + hard cap** (structure cited, numbers absent; the
§10 burst test has no bound to assert), and the **E1 "margin" term** of the clamp-up floor are
all unpinned. **Fix:** pin each to a concrete default (recommend dead-letter N=3; adopt the
`AttentionTopicGuard` defaults for the budget/cap; pin the E1 margin, e.g. 600000 ms — but see M1,
which supersedes the whole E1 window derivation).

**M16 — lease-holder ↔ conversation-owner reconciliation is deferred while registry replication is in Phase 1.**
**§5/§5.1 multi-machine cliff, §6.1 step 9, §11.2** · `[codex-ext #4; adversarial MINOR; integration cliff]`
The external GPT-tier reviewer flags the structural tension: increment 9 puts **registry
replication in Phase 1**, but active-active owner/lease reconciliation is deferred to §11.2 —
"replicated commitments exist before a machine can safely deliver them; the boot attention item
is observability, not architecture." The spec's mitigations (owning-machine-authoritative
delivery, the loud boot cliff item, single-Slack-machine coincidence today) are real and scope
the risk to the dark increment-9 window — but the non-owning machine's beacon still re-arms and
retries **forever** on a replicated commitment it can't deliver (a silent wasted loop), and two
machines both holding a Slack socket both satisfy `ownsConversation` → double-post. **Fix:**
either keep replicated conversations out of Phase 1 until §11.2 lands, OR define the
non-owning-beacon **stand-down** (not just "skip the dead-letter") and name active-active
double-delivery as a **correctness** blocker for §11.2, not an efficiency note.

---

## MINOR findings (polish — batch)

**Decision-completeness / unpinned knobs (all author-pinnable one-liners):** coalescing-window
(§5.1, recommend 60 s); journal line cap + retention multiplier (§3.4/§8); pending-mint bound
(§3.6, recommend 1000); health-threshold fraction (§3.3/§8, recommend 80%);
upper-envelope-flush trigger threshold (§3.4 — pin e.g. entryCount>20k or serialized size>2 MB,
else a compliant impl never ships the off-loop write before 49,999 entries); adoption-gate "on
record" source store unnamed (§6.2); chi-square option (b) bucket-count/corpus-size/significance
unpinned (§3.3/§10 — pin ≥10k ids into ≤4096 buckets with a stated p-threshold, or mandate
option (a)).

**Adversarial residuals:** `HLC_ABS_MAX` far-future horizon time-bomb (§3.5 — document the year +
require a versioned migration well before it); **null-`threadTs` ordering** in the `≺` byte-form
tiebreak undefined (§3.5.1 — pin where null sorts; adversarial-4 residual); alias re-point
O(k²) journal amplification in a worst-case-ordered deep collision class (§3.5.1 — bound note +
§10 assertion); reachability **flap** → repeated cross-window dead-letter attentions (§5.1 — add
per-conversation flap dampening); `allowDuplicate` has **no structural guard** (§5.0(a) — add a
CI assertion the beacon path never sets it, symmetric with the `deterministicKind` allowlist);
flood-path B6 read undefined when **neither** colliding tuple is registered (§3.3/§3.6 — clarify
that flood-path delivery uses the transport sessionKey, not the minted id); replay idempotency
for `op:"alias"` repoints needs an explicit **seq-ordered** statement (§3.4).

**Integration:** the §5 "owning-machine vs lease-holder" argument cites the wrong gate —
`PromiseBeacon.ts:522-523` is the external-block *sweep* gate; the gate that decides which
machine **delivers** is `fire()`'s ownership gate at `:590-605` (WS3 `speakerElection.decide`,
"failing toward speech") — cite the fire()-path gate and state the minted-id composition;
`GET /conversations/:id` (§8) serves the full entry incl. `label` while §3.5 B3 calls
`GET /conversations` "the ONLY render surface" — pin escaping on `:id` too or exclude `label`
(+ §10); the `adopted-replicated` upgrade trigger has **two wordings** ("first authenticated
inbound" vs "first local resolve/mint-hit") — collapse to ONE (a delivery-time `resolve()` must
NOT confer local origin, else non-owning double-post breaks the KYP/one-voice invariant);
working-set seam key-space untraced (§6.0 #12 — trace that placement/nomination records exist
under the minted id for a Slack conversation, or scope the "joins Goal-2 transfer machinery"
claim).

**Security:** the gate-exempt `deterministicKind` arm is an early return — pin that it skips
**only** the tone gate, never the §5.2 budget, and that no substitution field is ever sourced
from a replicated/peer field like `label` (cross-ref B3); "authenticated `getWorkspaceId()`"
overstates a config read (`SlackAdapter.getWorkspaceId()` returns `this.config.workspaceId`) —
honesty edit + note where a concrete teamId actually materializes at runtime (if it is only ever
config, source-2 corroboration collapses into source-1 and the `_`-upgrade machinery is largely
dormant).

**Scalability:** the §6.2 "breaker prevents adoption flood" claim is misattributed (the breaker
is per-channel; adoption mints one entry per channel — the real protection is the authorized-
sender gate); the mint-breaker's own per-channel budget-state map has no bounding/eviction
sentence (asymmetric with the now-bounded E1/P17 maps); "per-entry emits COALESCE" wording is
ambiguous (must mean one transport push carrying all changed records, never dropped siblings);
`fs.fsync` on macOS does not guarantee platter durability — if the impl reaches for
`F_FULLFSYNC` the "cheap append+fsync" claim silently assumes the cheap variant (footnote).

**Lessons:** add a first-class **`supervision:` frontmatter key** scoping tiers per-pipeline
(matches the foundation-spec precedent; makes the conformance gate resolve the Tier-0 declaration
instead of flagging prose — this is the fix for the one conformance flag, judged
engaged-adequately); the `lessons-engaged` frontmatter **invents standard names** that resolve to
neither the registry nor the lessons index ("Convergent Merge Algebra," "Disaster-Recovery
Completeness," "Ambiguous-Outcome Idempotency," "Reuse over Re-implementation," "Runtime
Kill-Switch") — map each to a canonical entry or mark it spec-local; the SlackAdapter
authorized-sender gate's **degenerate-registry state** (the 2026-07-01 silent-loss lesson: a
fail-closed gate over a never-populated/corrupt registry walls the operator out) has no stated
Slack counterpart — one honesty sentence scoping the §6.1-3 floor + pointing at the Phase-2.2/3.1
lane that owns it.

**External (codex/gemini) residuals not already folded above:** codex #3 — add a concrete
comparison against "SQLite local store + JSON **replication projection**" (emit JSON change
records from a SQLite source of truth) and state why projection cannot satisfy the existing
replication substrate, rather than resting on the JSON-house-style + coupling argument alone;
codex #5 / gemini #1 — the invariants are scattered across provenance tags, exceptions, and
cross-references (large audit surface); extract a short **normative core** (identity model, mint
algorithm, merge algorithm, delivery contract, recovery contract) with provenance kept separate,
and commit fully to the §10 merge fuzz plan as the only practical defense against the merge's
implementation-complexity surface; gemini #2/#3 — endorse the §11.10 SQLite migration as a
high-priority follow-up triggered by any observed durability issue (not just size), and treat the
§10 statistical hash test as critical-path (its result should concretely drive §11.9 timing).

---

## Convergence recommendation

**NOT CONVERGED.**

Blocking (must change the spec):

- **C1 / C2 / C3** — the `sticky` durable-binding marker is not a sound convergent primitive:
  it breaks "the merge is a pure function of R" (C1 provisional-id divergence), self-contradicts
  monotonic-vs-expiry (C2), and cannot reconcile the two-sticky partition without stranding a
  binding (C3). The external GPT-tier reviewer independently reached the C1/C2 conclusion. These
  invalidate §3.5.1's load-bearing correctness argument for the increment-9 replicated store.
- **C4** — the WAL backup-manifest glob (`logs/conversation-registry.jsonl*`) is silently
  refused by the deployed `BackupManager.expandGlob` (verified @ v1.3.722), so the journal never
  enters a snapshot and the disaster-recovery hole the WAL closes is reopened. Requires either a
  declared `BackupManager` code increment or a manifest-entry shape the resolver supports.

Plus 16 MAJORs — most consequentially: the E1 idempotency guard does not compose with the real
PromiseBeacon (M1/M2, 3-reviewer + 2-reviewer confidence), B7 bind-time authority has no
enforcement primitive (M5, code-grounded), and the merge/registry-shape is peer-authoritative
while advertised as advisory (M6/M7/M9, cross-reviewer).

What is genuinely settled and should NOT be re-litigated next round: all 24 Round-2 findings and
5 codex-R2 items are resolved in-body; `## Open questions` is verifiably clean (zero live
user-decisions — decision-completeness confirmed); the file:line grounding is exceptionally
accurate (~60 checks, one contradiction = C4); the single conformance-gate flag (Tier-0
supervision) is engaged-adequately and needs only a declarative-frontmatter polish; and the
delivery-integrity spine (local-origin-only delivery, `id<0` clamp, B4 Ed25519 envelope-origin,
B3 label-sink exclusion) is sound with no surviving CRITICAL delivery-hijack path.

Recommended next step: a Phase-2b revision addressing C1–C4 and the MAJORs, then Round 4.
The sticky cluster (C1/C2/C3/M8) is one decision — resolve whether durable-binding protection
belongs in the merge input at all — so it is a single design pass, not four.

---

## Appendix — Round-2 finding resolution matrix (protocol step 1, full detail)

| R2 finding | R3 resolution verdict |
|---|---|
| HIGH adversarial-2 (local mint omits step 2(b)) | RESOLVED (clause (c) + shared displacement impl + §10 equivalence test). |
| HIGH integration-1 (journal path two log roots) | PARTIAL — path pin genuine + correct; **glob half breaks the deployed resolver → C4**; Tier-2 wording doesn't fit globs. |
| HIGH lessons-1 (E1 window/key) | RESOLVED in structure; **arithmetic/semantics residuals vs real beacon → M1, M2**. |
| MEDIUM scalability-1 (candidateCollides O(1)) | RESOLVED; residual = index inventory (**M4**). |
| MEDIUM security-NEW-3 (dedup on attempt) | RESOLVED (record only on likely-posted; §10 pins transient-vs-ambiguous). |
| HIGH adversarial-1 / security-NEW-1 (collision-demotion strands binding) | PARTIAL — one-sticky fixed; **sticky introduced C1/C2/C3/M8**. |
| MEDIUM adversarial-3 (pool-relative skew) | PARTIAL — equal-R premise addressed; **retry mechanism introduced M13**. |
| MEDIUM security-NEW-2 (replicated workspacePin DoS) | RESOLVED (corroboration-before-fail-close + local precedence); **but exposes the §3.1 enforcement contradiction M9**. |
| MEDIUM lessons-2 (mass dead-letters not aggregated) | RESOLVED for the delivery path; **ingest-refusal path still un-aggregated → M12**. |
| MEDIUM integration-2 (pre-backup flush) | RESOLVED (dropped); justification **contingent on C4**. |
| MEDIUM lessons-3 (unscoped "always reachable") | RESOLVED (§6.1-3 transport-up scoping; §11.2 cadence anchor). |
| LOW security-NEW-4 / scalability-2 (dedup map unbounded) | RESOLVED (AttentionTopicGuard structure + burst test). |
| LOW security-NEW-5 (positive-id bind branch) | PARTIAL — policy symmetric; **enforcement primitive missing → M5**. |
| LOW security-NEW-6 (workspaceId clamp) | RESOLVED (`^T[A-Z0-9]+$`\|`_`). |
| LOW adversarial-4 (≺ tiebreak on mutable key) | RESOLVED (immutable tuple byte-form); residual = null-threadTs ordering (MINOR). |
| LOW adversarial-5 (totality unbounded) | RESOLVED (bounded by MAX_PROBE_DISTANCE, honestly scoped). |
| LOW scalability-3 (F3 underpowered) | RESOLVED in structure; option-(b) parameters unpinned (MINOR). |
| LOW scalability-4 (flush on event loop) | RESOLVED-AS-SCOPED; upper-envelope threshold unpinned (MINOR). |
| LOW lessons-4 (lint can't verify absence) | RESOLVED (single normalizeConversationsIngest entry fn; second entry = CI failure). |
| LOW lessons-5 (WAL under-verifiable) | RESOLVED (§3.7 residual note + SQLite-sooner trigger). |
| LOW lessons-6 (§11.8/§11.11 cadence) | RESOLVED (both anchored to roadmap topic-29836). |
| LOW integration-§9 (recording:false orphans a bind) | RESOLVED (durable minted-id binds refused while recording off; §10 test). |
| codex-R2-1 (replication key conflict) | RESOLVED ((origin,id) per-origin envelopes, precise). |
| codex-R2-2 (`_` mints breach pre-pin) | RESOLVED (replicated `_` held out of the merge until pin confirms). |
| codex-R2-3 (claimed vs resolved ownership) | RESOLVED (claim inputs vs derived resolve() output split). |
| codex-R2-4 (WAL bespoke-database drift) | RESOLVED as a scoping/honesty item (§3.7); **but see M3/M14 for the cost/recovery residuals the WAL still carries**. |
| codex-R2-5 (gate-exempt templates privileged) | RESOLVED (compile-time template ids + schema-validated substitution + §10 injection test). |
