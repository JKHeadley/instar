# Round-6 convergence findings — durable-conversation-identity

**Spec reviewed:** `docs/specs/durable-conversation-identity.md` @ commit `69004a39c`
("round-6 revision — resolve round-5 findings (1 CRITICAL + 4 MAJOR)").
**Report commit:** this file.
**Round-6 status: NOT CONVERGED.** 0 CRITICAL + 4 MAJOR + 5 MINOR + 4 LOW.

Round 6 verified that **all 10 Round-5 findings (1 CRITICAL + 4 MAJOR + 5 MINOR) are genuinely
resolved in the body as designed** — every claimed mechanism is present at every normative site
it touches, with no fold-regression found (each fix was traced to ALL the sections that restate
it: §3.5.1 step 3 + the fixpoint paragraph + §3.3 clause (b) + FD-6 for R5-C1; §3.5 + §3.5.1
complexity + FD-6 for R5-M1; §3.5.2 property 5 + §5 pickup + FD-19 for R5-M2; §5.0(a) + FD-18
for R5-M3; the `≺` definition + the field-merge table for R5-M4). Two of the round-5 fixes were
re-executed rather than merely read:

- **The R5-C1 U-construction was re-walked** against the revised step 3: T1/T2 collide at
  `C+1`, T2 displaced to `C` (assigned, no alias — its claim equals its winner); late `U`
  arrives with `cand(U) = C` → step 1 reserves `C` for `U`, T2 re-resolves to `C−1`, and the
  filter DROPS T2's stale claim on `C` (a reserved canonical of another tuple) — `resolve(C) =
  U` exactly, no shadowing alias, symmetric under U-first arrival. The fix holds as designed.
- **The R5-M1 walk-span geometry was re-derived from scratch** and the `2×24+1 = 49 < 64`
  bound is SOUND (the initially-suspicious "+1" term survives scrutiny: the boundary class at
  `cand = C+64` can reach only the single span id `C`, and one id holds one tuple, so the
  boundary class contributes ≤1 to span occupancy regardless of its own record count). The
  windowed-cap retained-set definition is confirmed a pure function of the received set
  (quantified over the received population per window, monotone under record arrival).

Every code claim the round-6 resolutions rest on was re-verified against this worktree's real
source: `clampReplicatedRow` (`CommitmentsSync.ts:149-156`); the hourly lease-gated
external-block sweep (`PromiseBeacon.ts:518-527`, `externalBlockSweepMs ?? 60*60_000`); the
plain non-atomic `saveHotState` (`PromiseBeacon.ts:1408-1414`); `maxCadenceMs = 21_600_000`
(`:421-422`) and atRisk cadence-doubling (`:562-564`); the `StateManager` tmp→rename house
pattern (`StateManager.ts:519-531` `atomicWrite`); `BackupManager.expandGlob` top-level
trailing-star-only behavior (`BackupManager.ts:97-113`); `resolveRoutingKey`
(`SlackAdapter.ts:433-440`). Zero false code claims found this round.

The round's blocking findings are all NEW seams — three sit directly on machinery the round-5/6
fixes themselves created or sharpened (the expected signature of a convergence process still
working), one is a latent ingest-rule contradiction that pre-dates round 6 and was surfaced by
the GPT-tier external. **No CRITICAL this round — the first round in this ceremony's history
with zero.** Trend: 4C+16M (R3) → 1C+3M (R4) → 1C+4M (R5) → 0C+4M (R6); every remaining
blocker is a pin-level edit (one journal op, one derivation rule, one boot-composition
paragraph, one fail-direction flip), no architecture change.

---

## Reviewers who ran this round

**Internal pass (one consolidated multi-lens review by the folding agent, run against the
committed revision BEFORE external review — nothing was folded pre-external this round; both
externals reviewed exactly the committed `69004a39c` text):** adversarial, integration
(code-grounded — every file:line the round-6 resolutions cite was read in this worktree),
security, crash/replay-composition, decision-completeness, fail-direction, lessons-aware
perspectives. Contributed R6-M3 and MINORs 2–3.

**External cross-model passes (one bounded pass each):**
- **pi / openai-codex provider, `--model gpt-5.5`** — RAN (completed inside the 900 s bound;
  exit 0). Door honesty: the CLI resolved the `gpt-5.5` model pattern without error (an
  invalid pattern fails fast); a same-invocation identity probe self-reported `gpt-5`
  (model self-reports are version-unreliable; recorded as-is). Verdict line:
  `VERDICT: 0 CRITICAL + 3 MAJOR + 0 MINOR + 0 LOW`. Two of its three MAJORs are confirmed by
  internal re-derivation (R6-M1, R6-M2); the third is reconciled to MINOR against a deployed
  bound the spec fails to cite (reasoning at MINOR-1).
- **gemini-cli v0.25.2, default model routing** — RAN TWICE, recorded honestly: the first
  (text-mode) pass completed inside the 600 s bound but `-o text` does not expose the serving
  model, and gemini's self-report is unreliable (a probe self-reported
  `gemini-1.5-flash-latest`, which is not a model this CLI serves) — so the pass was re-run
  with `-o json` to capture the ACTUAL serving models from the run's own stats block:
  **gemini-2.5-pro** (primary) + `gemini-3.1-flash-lite` (auxiliary routing). Both passes
  reviewed the same committed text; BOTH passes' findings are carried and reconciled below
  (the two passes surfaced disjoint findings — a useful honesty datum about single-pass
  variance). Text-pass verdict line: `VERDICT: 1 CRITICAL + 1 MAJOR + 1 MINOR + 0 LOW`;
  JSON-pass verdict line: `VERDICT: 1 CRITICAL + 1 MAJOR + 0 MINOR + 0 LOW`. Of the four
  distinct gemini findings: one claimed CRITICAL is reconciled to a NON-finding (already
  covered by the spec's stated trust posture), the other claimed CRITICAL is reconciled to
  LOW-4 (its enabling premise is false against the WAL rule — reasoning inline, never a
  silent downgrade); one MAJOR is confirmed as R6-M4; the other MAJOR is reconciled to
  MINOR-5; the text-pass MINOR is confirmed as MINOR-4.
- **codex-cli** — NOT RUN: `codex` is not installed on this machine (`which codex` → not
  found; same honest state as rounds 3–5).

A finding hit by multiple independent reviewers is flagged `[N reviewers]`.

---

## Round-5 resolution verification (protocol step 1)

Every Round-5 finding traced to its claimed resolution in the round-6 body, verified against
BOTH the revised spec text AND the worktree's real code:

| R5 finding | R6 resolution verdict |
|---|---|
| **C1** (a stale claimed id can become an ALIAS that shadows another tuple's canonical assignment) | **RESOLVED.** Assignment-beats-alias precedence pinned at §3.5.1 step 3 (:1190-1211): an alias is derived ONLY over ids the final step-1/2 assignment left unowned; a stale claim on an owned id is DROPPED (no alias); a late canonical reservation EVICTS a shadowing alias in the same atomic op; disjointness (`alias keys ∩ assignments = ∅`) stated as by-construction. The fixpoint paragraph names the filter in the pinned composition order (:1213-1222); §3.3 clause (b) carries the disjointness consequence (:361-365); the dropped-claim delivery case is named in §3.5.2 (:1427-1433); FD-6 updated; §10 adds the U-construction in every arrival order + the standing disjointness fuzz invariant (:2421-2432). The U-construction re-walk above confirms the algebra. **Sibling flaw → R6-M3:** the EVICTION is an unjournaled mutation of journaled state (`op:"alias"` lines + snapshot), and the boot/restore composition can resurrect a shadowing alias. |
| **M1** (per-class cap guards the wrong granularity under GLOBAL occupancy) | **RESOLVED.** `uncorroboratedWindowCap = 24` per 64-wide sliding candidate window, alongside the per-class 16 (§3.5 :985-1007); retained-set defined as a pure function of the received set over the §3.4 index-5 ordered structures; walk-boundedness restated against the WINDOW with the `2×24+1 = 49 < 64` sizing (re-derived sound, above); the §3.5.1 cost claim restated honestly (accidental: amortized O(1); adversarial: bounded-linear in attacker-shipped records) (:1279-1297); §10 adds the cross-class spread shape + the operation-counted chained-region bound (:2439-2453); FD-6 updated. **Sibling honesty gap → MINOR-2:** the caps are origin-relative, so under an ACTIVE stuffing attack the equal-R convergence premise is machine-relative for the capped records — true of the round-3 class cap too, but the window cap widens the surface and the scope sentence is still unstated. |
| **M2** (`boundTuple`'s no-new-authority claim not mechanically true) | **RESOLVED as designed.** Delivery-time id↔tuple coherence check at §3.5.2 property 5 (:1407-1416) — the SAME predicate as the §3.5 ingest bound, shared-implementation-pinned; §5 pickup gated by it (:1780-1782); §10 incoherent-pair branch asserted through the shared predicate (:2463-2467); trust-posture sentence restated as mechanically true WITH the check; FD-19 updated. Coherence-stability was independently checked: a legitimately-bound pair can never BECOME incoherent (cand(tuple) and the verbatim `topicId` are both immutable), so incoherence truly implies corruption/bug — no false-positive path. **Sibling flaw → R6-M4:** the FALLBACK direction on an incoherent pair (`resolve(id)` + attention) fails toward possible misdelivery; the safe direction is a typed refusal. `[gemini]` |
| **M3** (`sendSeq` vs `send-retire` crash-ordering unpinned) | **RESOLVED.** Normative inter-store ordering at §5.0(a) (:1683-1696): seq persists BEFORE `send-retire`; the safe-direction crash analysis (TTL-bounded leak, never a double-post) and the reverse order's double-post shape stated; commitment-close retirement exempted; §10 kill-between-stores in BOTH orders (:2527-2533); FD-18 updated. Independently re-checked: the leaked stale entry can never false-suppress (the next fire carries a NEW `logicalSendId`). **Sibling flaw → R6-M1:** the ordering contract covers the post-outcome window only — the crash-DURING-send window (posted, died before the ambiguous-send journal append) still double-posts, and no residual discloses it. `[pi]` **Sibling cosmetic → LOW-3:** the "at most ONE unretired entry per commitment" cardinality sentence is overstated by exactly this contract's own leak path. |
| **M4** (`≺` tuple-representative unpinned for multi-record tuples) | **RESOLVED.** Representative pinned at the `≺` definition (:1136-1150): the LOWEST `(hlc.physical, hlc.logical, hlc.node)` triple among the tuple's records in `R`, content-only; the entry's MUTABLE merged `hlc` explicitly excluded as a `≺` input, restated at the field-merge table (:1236-1238); §10 multi-record representative fuzz shape (:2433-2438). Clean — no sibling. |
| minor-1 (E1 dual-structure muddle) | **RESOLVED.** Collapsed to ONE structure (§5.0(a) :1666-1682): the map IS the loaded image of the durable journal-applied state; eviction scoped to retired/expired only; the hard cap is a loud tripwire that drops nothing (entry still journaled AND retained); the §5.0(a) boundedness bullet re-derived from natural cardinality (:1730-1736). **Sibling cosmetic → LOW-1:** the §3.3 mint-breaker bullet still says its budget map is "symmetric with the E1/P17 maps" — stale against the collapsed E1 structure. |
| minor-2 (§7 internal-trust boundary phrasing) | **RESOLVED.** The plain trust-boundary sentence present at §7 (:2150-2154). |
| minor-3 (two op families in one journal — undocumented coupling) | **RESOLVED.** The deliberate-trade sentence present at §3.4 record-framing (:708-714), naming the WAL-discipline reuse, the retention-floor alignment, and the §11.10 migration inheritance. |
| minor-4 (`bindTokenSecret` vs backup manifest) | **RESOLVED.** Pinned EXCLUDED from the manifest with the disaster-restore consequence named (regenerated secret → all tokens invalidate → the same loud typed-refusal path as rotation) (§7 :2123-2128). |
| minor-5 (cosmetic batch) | **RESOLVED.** `boundTuple` bind-moment reworded (lives on the commitment record; the WAL line is `op:"bind-pin"`) (:1395-1399); the `ambiguousSends` example key pins the visible `\|` delimiter with the 0x1F trap called out (:602-606). |

**Net:** zero round-5 findings regressed; all ten landed as designed. Three resolutions carry
sibling flaws on their own new seams (R5-C1 → R6-M3; R5-M2 → R6-M4; R5-M3 → R6-M1), one
carries a sibling honesty gap (R5-M1 → MINOR-2), and the GPT-tier external surfaced one latent
pre-round-6 ingest contradiction (R6-M2).

---

## CRITICAL findings

**None.** The first zero-CRITICAL round of this ceremony.

**Reconciled non-finding, recorded so the downgrade is never silent — gemini's claimed
CRITICAL ("`boundTuple` coherence check allows a compromised peer to hijack durable-binding
delivery via hash proximity"):** the construction has a compromised CommitmentsSync peer forge
`boundTuple = T_attacker` with `topicId` inside T_attacker's coherence window, redirecting
delivery to `resolve(T_attacker)`. Re-derivation shows this grants NOTHING a forged `topicId`
does not already grant — the forger must already be able to write the replicated commitment
record, at which point setting `topicId = cand(T_attacker)` directly achieves the same
misdelivery through the plain `resolve(id)` path; and BOTH paths still traverse §5.0
`ownsConversation` + local-origin resolution of the TARGET on the delivering machine (§3.5.2
property 5 states this explicitly). This is byte-for-byte the reconciliation this ceremony
recorded for R5-M2 itself in round 5 ("a peer already inside the CommitmentsSync trust
boundary achieves comparable misdelivery with an equivalent forged `topicId`"). The proposed
HMAC fix would also mint a NEW cross-machine shared-secret surface for no authority delta.
Not carried as a finding; the spec's stated trust posture already covers it honestly.

**Second reconciled downgrade, recorded — gemini's JSON-pass CRITICAL ("dangling `bind-pin`
from a mid-creation crash can be reassigned, causing silent misdelivery"):** the construction
requires an id carrying an orphaned pin to be "validly minted and assigned to a new, unrelated
conversation" — which is impossible by two rules the construction skips: the §3.3 WAL rule
fsyncs the durable-binding mint's `op:"mint"` journal line BEFORE the id is ever handed to the
binding consumer (so a pin can never exist for an unregistered id — the mint line precedes the
`bind-pin` line in the same seq-ordered journal), and the registry is never-delete, so the
pinned id remains occupied by its own tuple forever and `candidateCollides` refuses it to any
other tuple. The surviving residual is only an orphaned-REFCOUNT leak (a crash between the
`bind-pin` journal fsync and the commitment-store persist leaves a pin whose refcount never
decrements — the pin then permanently, and CORRECTLY, routes that id's deliveries to its own
tuple: property 3's "while merge and bind agree the pin is invisible"). No invariant breaks;
reconciled to **LOW-4** (state the crash residual + name a pin↔binding-store consistency
sweep as the GC follow-up).

---

## MAJOR findings (should change the spec)

### R6-M1 — the crash-DURING-send window still double-posts: E1's guard records the dedup entry only at OUTCOME time, so a death between Slack accepting the post and the `ambiguous-send` journal append leaves no guard at reboot
**§5.0(a), §3.4, §10** · `[pi-gpt-ext #1; internally confirmed]`

E1's machinery is now durable (R4-M2) and crash-ordered (R5-M3) — but both protect windows
AFTER the outcome is classified. §5.0(a) pins "the dedup entry is recorded ONLY on a
likely-posted outcome" — i.e. after the Slack HTTP exchange resolves. Kill the process after
`chat.postMessage` is accepted but before the `op:"ambiguous-send"` append+fsync (an
auto-update SIGKILL can land exactly there): reboot restores `sendSeq = 7` with NO entry for
`cmt-42:7` → the beacon's next tick re-fires logical send 7 unguarded → double-post. The spec
frames E1 as closing the Slack double-post "WITHOUT waiting for the Phase-2.2 robustness
lane", and no residual discloses this window — the same blast radius R5-M3 was MAJOR for (a
duplicate into the user's own thread, never misdelivery), via the sibling crash window the
R5-M3 fix did not cover.

**Fix (one journal op on the machinery E1 already built):** journal a durable
`op:"send-intent" { conversationId, logicalSendId }` (fsynced — it is a
durable-binding-class write) BEFORE handing the request to Slack; a delivered/clean-failure
outcome resolves the intent through the existing paths (delivered → seq-advance +
`send-retire` under the R5-M3 order; clean transient failure → intent resolved-failed, no
entry, retry NOT suppressed — preserving R2-security-NEW-3 exactly, since the false-suppression
hazard only existed when the process SURVIVED to observe the clean failure); at boot, an
UNRESOLVED intent converts to an `ambiguous-send` entry (the honest classification — the
outcome is genuinely unknown), suppressing the re-fire of that seq. Worst case flips from a
visible double-post to at most one suppressed heartbeat that the next cadence tick supersedes
— the fail-direction the design already chose for ambiguous outcomes. Add the §10 shape: kill
between the Slack accept and the entry append → reboot → exactly ONE post.

### R6-M2 — the id↔key coherence check and the seize-refusal read DIFFERENT key sources, and nothing forces the wire `key` to match the wire `tuple`: a crafted mismatched record makes two normative ingest rules contradict
**§3.5 (coherence bullet + type-clamp), §3.5.1 (seize predicate), §7, §3.4** · `[pi-gpt-ext #2; internally confirmed]`

The replication record carries BOTH a shape-clamped `key` string AND the structured `tuple`,
and no clamp requires them to agree. The §3.5 coherence bullet recomputes
`candidate(routingKey(KEY))`; the §3.5.1 seize predicate fires on an id "unreachable under
steps 1–2 for its own TUPLE" (`cand(t)` is tuple-derived); §7 summarizes "an entry whose
`id ≠ candidate(key)` is refused". A compromised peer emits `{ tuple: T_victim, key:
canonicalKey(T_attacker), id: cand(T_attacker) }`: the key-based rule ACCEPTS (id equals the
key's candidate), the tuple-based rule QUARANTINES (id unreachable from `cand(T_victim)`) —
two normative ingest rules in direct contradiction for the same record. Convergence is
premised on identical ingest-acceptance everywhere; instar deliberately runs mixed-version
fleets during skew windows, so two faithful implementations (or two releases that "fix" the
ambiguity differently) hold divergent `R` for such records permanently. Compounding: the
conversations map is KEYED on the canonical key string (§3.4), so an accepted mismatched
record would file T_victim's tuple under T_attacker's key — tuple-index vs map-key
disagreement on a single machine.

**Fix (one authority):** the TUPLE is the sole identity input at ingest. The receiver
RECOMPUTES the canonical key from the clamped tuple + accepted workspace metadata; the wire
`key` field is display/corroboration only and MUST equal the recomputed value or the record is
quarantined-aside into the aggregated refusal item (typed `key-tuple-mismatch`). Every
coherence/seize predicate is restated over `cand(routingKey(tuple))`; §7's summary sentence is
aligned (within-bound probe acceptance included). §10 adds the mismatched key/tuple record
shape (accepted nowhere, quarantined identically on every machine).

### R6-M3 — the R5-C1 alias EVICTION is an unjournaled mutation of journaled state, and the boot/restore composition of the three durable sources is unpinned: a replayed `op:"alias"` line can resurrect a shadowing alias
**§3.4 (WAL contract, snapshot completeness, idempotent replay), §3.5.1 step 3, §6.2, §10** · `[internal]`

The alias table has TWO durable sources: `op:"alias"` journal lines (replay-APPLIED — the §3.4
idempotent-replay bullet names them explicitly) plus the snapshot's `aliases` map. Before
round 6 that redundancy was harmless: aliases were unconditional, so a replayed alias line
always agreed with what the merge would re-derive. The R5-C1 filter breaks that equivalence —
an alias can now be EVICTED by a late canonical claimant, and the eviction (a) has no journal
op and (b) is triggered by a replicated INGEST, which itself journals nothing locally (records
live in the foundation's per-origin files, tracked by a per-origin ingest cursor whose
durability relative to the snapshot is also unpinned). Construction: probe divergence journals
`op:"alias" {C → C−1}` at `seq > snapshotHighWaterSeq`; U's late canonical record ingests
(reservation of `C` + same-atomic-op eviction — all in memory + foundation files); crash
before the next snapshot. Reboot composes old-snapshot + journal tail: the alias op re-applies
`C → C−1`. Whether `U`'s reservation re-materializes depends entirely on the unpinned
cursor/snapshot composition: a cursor persisted independently and already past U's record
never re-consumes it → U's entry is LOST from the composed store while the shadowing alias
stands — the exact `resolve(C)` ambiguity R5-C1 was CRITICAL for, now reachable through an
ordinary auto-update restart, and the §10 standing disjointness invariant would fail on the
composed state. (MAJOR, not CRITICAL, by the R5-M3 precedent: a crash-window reopening with
delivery still gated by the overlay + local-origin rules, and the natural implementation —
re-derive-then-filter — avoids it; the defect is that the spec leaves that choice open.)

**Fix (one composition paragraph + one §10 shape):** pin the boot/restore composition. (1) The
per-origin replication ingest cursor is persisted SNAPSHOT-CONSISTENTLY (it rides the same
snapshot the store's applied state does), so a crash between ingest-apply and snapshot flush
re-consumes the records idempotently — a reservation can never be lost while its side effects
half-survive. (2) After snapshot + journal-tail replay compose, the assignment-beats-alias
filter RE-RUNS as an invariant pass over the composed alias table against the recomputed
assignment (the same pure rule as live ingest) — a replayed stale alias line that now shadows
an assignment is dropped exactly as it would be at ingest, making the disjointness invariant
hold at every BOOT fixpoint, not only every merge fixpoint. §10 adds: alias journaled → late
canonical ingested (eviction) → crash before snapshot → reboot → `resolve(C) = U`, alias
absent, disjointness invariant green; plus the cursor-behind-snapshot re-consume shape.

### R6-M4 — the incoherent-`boundTuple` FALLBACK direction is wrong: `resolve(id)` on a corrupt binding can be the exact C3-class misdelivery the overlay exists to prevent
**§3.5.2 property 5, §5, §5.1, §10** · `[gemini-ext #2 (classed MAJOR there); internally confirmed]`

R5-M2's coherence check correctly detects a corrupt pair — but the specified fallback is
`resolve(id)` + one attention item. When the binding's id was demoted/reassigned by a later
merge (precisely the case the overlay exists for), `resolve(id)` answers ANOTHER tuple — so
the fallback DELIVERS the beacon into a conversation that is provably not the one the promise
was made in, upgrading a detected corruption into a possible misdelivery. Incoherence has no
legitimate cause (coherence-stability holds for every valid flow — verified above), so there
is nothing to "fall back" to: the deliverer cannot know which field corrupted (a corrupt
`topicId` with a healthy `boundTuple` makes `resolve(id)` strictly worse). The spec's own
§3.5.2 degradation precedent already chose the safe direction for the pin-tuple-pending case:
typed non-delivery + attention, beacon retries.

**Fix (one fail-direction flip):** an incoherent pair returns a typed
`conversation-binding-incoherent` NON-delivery through the §5.1 contract (beacon re-arms;
N-fail dead-letter escalation) + ONE deduped attention item naming the binding — NEVER
`resolve(id)`, never any delivery. Align the §5 pickup sentence, the §3.5.2 trust-posture
sentence, FD-19, and flip the §10 incoherent-pair branch assertion from
"falls back to `resolve(id)`" to "typed refusal, zero deliveries, one deduped item". (The
legacy no-`boundTuple` binding keeps `resolve(id)` — that is today's behavior, not a detected
corruption.)

---

## MINOR findings (polish — batch)

1. **Unretired ambiguous-send growth is bounded by a deployed cap the spec never cites**
   `[pi-gpt-ext #3 — classed MAJOR there; reconciled to MINOR: the axis is mechanically
   bounded, the spec just fails to name the bound]`: pi constructed unbounded live-entry
   growth from "many commitments × forced-ambiguous outcomes" plus the spec's own "the journal
   append has no cap" wording. Re-derivation: an unretired entry is created only by a BEACON
   send; active beacons are boot-capped at `maxActiveBeacons` (deployed default 20 —
   `PromiseBeacon.ts:425`, overflow sliced at `:476-477`); each commitment holds ≤1 live entry
   (+ TTL-bounded crash stragglers); journal bytes are bounded by the §3.4 rotation. So the
   real bound is ~`maxActiveBeacons` live entries — small. Fix: cite `maxActiveBeacons` as the
   mechanical bound in §5.0(a)'s boundedness bullet, and scope "the journal append has no cap"
   to "no cap is NEEDED — the emitter is beacon-capped upstream".
2. **The uncorroborated caps are origin-relative, so the equal-`R` convergence premise is
   machine-relative under an ACTIVE stuffing attack (honesty sentence)** `[internal]`: a
   record is exempt from both caps on its LOCAL machine and cap-eligible on every peer, so an
   attacker stuffing a window can push a legitimate peer's uncorroborated record out of `R` on
   receivers while its minter retains it — machines then hold unequal effective `R` for the
   attacked records until corroboration/local mint heals it. Blast radius is bounded (attacked
   windows only, delivery unaffected via local-origin, loud via the aggregated refusal item +
   displacement-anomaly tripwire) and the property is inherited from the round-3 class cap —
   but the §3.5 "convergence preserved" sentences over-claim for exactly this regime. One
   honesty sentence in the caps paragraph (same class as the §3.5 back-dating paragraph)
   scoping convergence to the non-attack regime + naming the heal path.
3. **A dropped stale claim / evicted alias is a SILENT registry-shape change, and id-keyed
   NON-binding rows re-attribute silently** `[internal]`: every other divergence repair in
   this spec raises one deduped attention item (alias episodes, redirecting pins, quarantines)
   — but the R5-C1 drop/eviction raises nothing, and rows keyed on the dropped id in
   id-keyed stores (TopicMemory dual-write, attention history) silently re-attribute to the
   id's NEW owner (`resolve(C) = U`), since only durable BINDINGS ride the overlay. Reachable
   only via a composed double-collision (rare accidentally; constructible within the accepted
   M6 back-dating model), and the delivery side stays gated — but it is the one shape change
   in the algebra with no episode surface. Fix: route drop/eviction episodes through the §3.5
   aggregated ingest/alias attention surface, and add one honesty sentence naming the
   id-keyed-row re-attribution residual (durable bindings unaffected).
4. **The positive-`topicId` bind branch is enforcement-ambiguous** `[gemini-ext text-pass #3]`:
   §7 says positive ids "keep their existing behavior until their branch migrates" (no gate),
   while B7 + the §10 test demand "arbitrary foreign positive id → refused". An implementer
   cannot satisfy both readings at once. Fix: pin the mechanism and the timing — the bind
   token's `bootstrapConversationIds` already carries the spawn topic, so a token-bearing
   session's positive-id bind validates against the token from the proof-consumer increment
   on; a legacy token-less session keeps existing behavior only until the fleet's normal
   respawn cycle completes (named as the migration window), and the §10 positive-branch test
   runs against a token-bearing session.
5. **The no-config workspace-pin bootstrap never defines "confirmed", and two of its own
   clauses tension on the first machine** `[gemini-ext json-pass #2 — classed MAJOR there;
   reconciled to MINOR: no §0 invariant breaks — even the most conservative (deadlocked)
   reading keeps minting `_`-placeholder ids that upgrade in place once a pin confirms, so
   identity stays durable and delivery is untouched; the config pin is already the documented
   MANDATORY multi-machine path]`: §3.1 source-2 says the first machine to observe a concrete
   teamId WRITES the pin candidate; source-3 says a machine with no "confirmed" pin that
   observes a concrete teamId FAILS CLOSED on concrete mints — and "confirmed" is never
   defined, so a faithful implementer cannot tell whether the first machine's own local
   observation self-corroborates its own candidate (proceed) or whether it must wait for a
   corroboration that can never arrive (fail closed on concrete mints indefinitely).
   Fix: one definition + one transition sentence — a pin is CONFIRMED on a machine when the
   candidate value has ≥1 LOCAL authenticated `getWorkspaceId()` observation on that machine
   (the writer's own triggering observation counts — self-corroboration is the designed
   single-machine/first-machine path); once confirmed, source-3's fail-closed lifts and
   concrete mints matching the pin proceed.

---

## LOW findings (cosmetic — batch)

1. §3.3's mint-breaker budget-map bullet still reads "symmetric with the E1/P17 maps" — stale
   after R5-minor-1 collapsed the E1 evicting-cache framing; re-point it at the P17 maps only.
2. §8 lists "adopt" among the journal's audited ops but the §3.4 op enum has no adopt op —
   pin that adoption rides `op:"mint"` with `origin: adopted-*` (or add the op to the enum).
3. §5.0(a)'s "at most ONE unretired ambiguous entry per commitment" is overstated by the
   R5-M3 pinned-order crash leak (a stale unretired entry can coexist with the next live one
   until TTL) — reword to "at most one LIVE entry plus TTL-bounded crash stragglers".
4. §3.5.2 property 4's crash story has one unstated residual `[gemini-ext json-pass #1,
   reconciled from CRITICAL — reasoning at the CRITICAL section]`: a crash between the
   `bind-pin` journal fsync and the commitment-store persist leaves an orphaned pin whose
   refcount never decrements (permanent, harmless — it routes the id to its own tuple). Add
   one sentence naming the residual and a periodic pin↔binding-store consistency sweep as the
   GC follow-up (never an auto-release on ambiguity — a live binding must never lose its pin).

---

## Convergence recommendation

**NOT CONVERGED.**

Blocking: 4 MAJORs, each with a small, localized fix — the durable `send-intent` op that
closes the crash-during-send double-post window (R6-M1); the tuple-as-sole-key-authority
ingest pin that removes the coherence-vs-seize contradiction (R6-M2); the boot-composition pin
(snapshot-consistent ingest cursor + post-replay alias re-filter) that keeps the R5-C1
disjointness invariant true across restarts (R6-M3); and the fail-direction flip on the
incoherent-`boundTuple` fallback (R6-M4). Zero CRITICAL — the first such round; and for the
first time the merge algebra's NORMAL-OPERATION semantics took no finding at all: all four
blockers live on crash/restore windows, ingest normalization, or delivery fail-direction.

What is genuinely settled and should NOT be re-litigated next round: all 10 round-5
resolutions verified present, code-grounded, and — for R5-C1 and R5-M1 — re-executed (the
U-construction walk and the 49<64 span geometry both hold); the assignment algebra
(steps 1–3 with the filter) at every merge fixpoint; the windowed-cap DoS bound; the
`≺` representative pin; the R5-M3 ordering (its sibling R6-M1 is the adjacent window, not a
regression); the stateless bind token; the WAL/backup/recovery spine for LOCAL state (R6-M3
is about composing it with the REPLICATION sources, a seam none of the prior rounds pinned);
`## Open questions` remains verifiably empty; and gemini's hash-proximity CRITICAL is
reconciled a non-finding on the same trust-boundary reasoning round 5 already recorded —
re-raising it without a new authority delta should be treated as settled.

Recommended next step: a Phase-2e revision addressing the four MAJORs (+ the five MINORs and
four LOWs — all pin-level edits to §5.0(a)/§3.5/§3.5.1/§3.4/§3.5.2/§3.1/§7), then Round 7. Trend
note: 4C+16M → 1C+3M → 1C+4M → 0C+4M on a stable two-external reviewer set; three of this
round's four blockers are seams of the round-5/6 fixes themselves (the convergence process
digesting its own repairs), and the fourth (R6-M2) is the last latent ingest-normalization
gap any reviewer has found in the record set's trust boundary.

**Verdict: NOT CONVERGED** (0 CRITICAL + 4 MAJOR remaining; converged requires zero MAJOR).
