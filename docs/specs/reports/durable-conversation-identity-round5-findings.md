# Round-5 convergence findings — durable-conversation-identity

**Spec reviewed:** `docs/specs/durable-conversation-identity.md` @ commit `35ef55f4e`
("round-5 revision — resolve round-4 findings (1 CRITICAL + 3 MAJOR + 5 MINOR)").
**Report commit:** this file.
**Round-5 status: NOT CONVERGED.** 1 CRITICAL + 4 MAJOR + 5 MINOR.

Round 5 verified that **all 9 Round-4 findings are genuinely resolved in the body as
designed** — every claimed mechanism is present in the spec text, the R4-C1 3-record
adversarial construction was re-executed against the revised global algebra (it now yields
four distinct ids under either `≺` order), and every code claim the resolutions rest on was
re-verified against this worktree's real source (`clampReplicatedRow` at
`CommitmentsSync.ts:149-155`; the hourly lease-gated external-block sweep at
`PromiseBeacon.ts:518-527` and the plain non-atomic `saveHotState` at `:1408-1411`; the
`StateManager.ts:521-530` tmp→rename house pattern; the tmux `-e` spawn env block in
`SessionManager.ts:2169+`). Two of the four headline fixes stand clean (R4-C1's global
displacement pass; R4-M3's stateless bind token); two are present-but-incomplete — their
verification rows below say RESOLVED-AS-DESIGNED but each carries a new sibling finding
(R4-M1 → R5-M2; R4-M2 → R5-M3).

The round's blocking findings come from the widest reviewer set this ceremony has had since
round 3: **the GPT-tier external family ran again this round** (via the `pi` CLI; `codex`
remains uninstalled) and contributed or co-discovered four of the five blockers. Two of the
five (R5-C1, R5-M4) are latent algebra gaps that PRE-DATE round 5 and were invisible to the
prior rounds' reviewer set; the other three sit on seams the round-5 fixes themselves
created — the expected signature of a convergence process still working. Trend:
4C+16M (R3) → 1C+3M (R4) → 1C+4M (R5, with a doubled external reviewer set) — the algebra's
remaining holes are all one-line-to-one-paragraph pins, no architecture change.

---

## Reviewers who ran this round

**Internal pass (one consolidated multi-lens review by the folding agent, run AFTER the fold
against the committed revision):** adversarial, integration (code-grounded — every file:line
the round-5 resolutions cite was read in this worktree), security, scalability,
decision-completeness, lessons-aware perspectives. Two seams found during this pass
(snapshot-schema omission of the newly-persisted state; cascade termination unargued) were
folded INTO the round-5 revision before external review — recorded here for honesty about
sequencing; both externals reviewed the post-fix text.

**External cross-model passes:**
- **gemini-cli / gemini-2.5-pro** — RAN (completed inside the 600 s bound). Verdict
  "2 MAJOR + 1 MINOR". Its headline finding (cross-class stuffing bypasses the per-class
  cap) is confirmed by internal re-derivation and is R5-M1 below; its layering finding is
  reconciled to MINOR per this ceremony's severity criteria (reasoning inline).
- **pi / gpt-5.5 (openai-codex provider)** — RAN (completed inside the 900 s bound; a first
  attempt via the github-copilot provider failed with a model-not-supported 400 and was
  retried — recorded honestly). Verdict "3 CRITICAL + 2 MAJOR". Every finding was
  independently re-derived against the spec text before acceptance; two of its CRITICALs are
  reconciled to MAJOR by this ceremony's own precedent (reasoning inline at each finding).
  **The GPT-tier family is represented this round for the first time since round 3.**
- **codex-cli** — NOT RUN: `codex` is not installed on this machine (`which codex` → not
  found; same honest state as rounds 3–4).

A finding hit by multiple independent reviewers is flagged `[N reviewers]`.

---

## Round-4 resolution verification (protocol step 1)

Every Round-4 finding traced to its claimed resolution in the round-5 body, verified against
BOTH the revised spec text AND the worktree's real code:

| R4 finding | R5 resolution verdict |
|---|---|
| **C1** (cross-collision-class displacement overlap — per-class taken-offsets let two displaced tuples from adjacent classes take the SAME id) | **RESOLVED.** §3.5.1 step 2 restated: ALL displaced tuples across ALL classes processed in ONE GLOBAL `≺` order against ONE global taken set (spec :1124-1141) — an offset enters the taken set exactly once, so "no id resolves to more than one tuple" holds by construction across classes for the ASSIGNMENT step. §3.3 clause (c) aligned (global displaced-assignment set, :364-386); §3.4 index 4 restructured (ordered global set; per-class survives only as the ordered locator, :548-556); the fixpoint paragraph's per-class evaluation order corrected; FD-2 updated. Incrementality restated as a region-restricted bounded cascade with a termination-by-construction argument (:1196+). §10 additions verified present: adjacent-class local-mint shape, cross-class no-duplicate invariant in the ≥3-machine fuzz, the 3-record adversarial construction, cascade-vs-full-recompute byte-equivalence. Re-walking the round-4 scenario: reserved `C→T1`, `C−1→U1`; global order T2 then U2 → T2 takes `C−2`, U2 walks `C−1` (taken), `C−2` (taken GLOBALLY) → `C−3`; symmetric under the other order. Four distinct ids. **Sibling flaws → R5-M1 (the per-class cap now guards the wrong granularity) and R5-M4 exposure; and the ALIAS step of the same algebra carries R5-C1.** |
| **M1** (bind-pin machine-local vs the §5 pickup path) | **RESOLVED as designed.** §3.5.2 property 5 (:1300-1330): bind-time tuple denormalized onto the binding record (`boundTuple`), shape-clamped at the CommitmentsSync receive chokepoint (code-verified: `clampReplicatedRow`, `CommitmentsSync.ts:149-155`, exactly where a field clamp slots); the false residual sentence corrected to name the pickup path (:1338-1344); §5 stand-down pickup delivers `resolve(boundTuple)` (:1640-1643); §3.0 contract 4 and §3.5.2 property 1 made mutually precise (registry wire vs commitments wire); §10 ownership-migration pickup test present (:1352-1356). **Sibling flaw → R5-M2:** the trust-posture sentence "grants no authority `topicId` does not already grant" is not mechanically true as written — a delivery-time id↔tuple coherence check is missing. |
| **M2** (E1 dedup entry in-memory/evictable → restart double-post) | **RESOLVED as designed.** §5.0(a): durable `op:"ambiguous-send"`/`"send-retire"` journal lines riding the §3.4 WAL (:1540-1560); unretired entries never evicted below TTL, cap-with-all-live sheds loudly (:1561-1568); §3.4 op enum extended (:698-701); snapshot-completeness corollary + schema fields (:592-600, :730-737); journal retention floor ≥ TTL noted; §10 restart-double-post test present (:2327-2333); FD-18 updated. **Sibling flaw → R5-M3:** the crash-ORDERING between `send-retire` (registry WAL) and `sendSeq` advancement (beacon hot state — a different durable store) is unpinned, and one ordering re-opens a double-post. |
| **M3** (bind-token map dies with the server; tmux sessions outlive it) | **RESOLVED.** §7 primitive rebuilt stateless (:1975-2007): self-authenticating `base64url(payload).base64url(HMAC-SHA256(bindTokenSecret, payload))`, secret persisted in the stateDir at first boot; validation verifies the MAC and reads the bootstrap set FROM the token — no per-session server state to lose; honest residuals stated (stale-token validity scoped to its own bootstrap set; secret rotation = the loud revocation lever); §10 restart-survival + tamper/rotation tests present (:2299-2308). Code grounding verified: sessions spawn via tmux `-e` env blocks (`SessionManager.ts:2169-2210` region) — the delivery channel exists; HMAC/randomBytes house precedents exist. Both external reviewers verify this fix clean. |
| minor-1 (`sendSeq` "journaled with it" overstated) | **RESOLVED.** Retracted + re-pinned atomic tmp→rename for the seq-bearing hot-state write (:1567-1577 region), grounded against the real non-atomic `saveHotState` (`PromiseBeacon.ts:1408-1411`) and the house pattern (`StateManager.ts:521-530`); §10 torn-write assertion added. |
| minor-2 (side-queue cardinality unbounded) | **RESOLVED.** `quarantineSideQueueMax = 256` per origin, overflow parks-aside immediately into the same loud terminal (:1239-1247). |
| minor-3 (internal callers have no bind token) | **RESOLVED.** In-process server-self opens bypass the route-level gate with `boundBy: "server:<component>"`; route-arriving callers need a token regardless of self-description (:2000-2007). Gemini asks for the trust boundary stated more plainly → folded into MINOR-2 below. |
| minor-4 (stand-down sweep unnamed) | **RESOLVED.** The recheck rides the beacon's existing external-block sweep, named with its real default (`externalBlockSweepMs`, 3,600,000 ms, lease-gated — verified `PromiseBeacon.ts:518-527`); pickup latency ≤ one sweep interval (:1630-1640). |
| minor-5 (`workspacePin` naming over-promises) | **RESOLVED.** Renamed "replicated pin CANDIDATE, corroboration-gated" with the explicit anti-instruction (:268-273). |

**Net:** zero round-4 findings regressed; all nine landed as designed. Two resolutions carry
sibling flaws (R4-M1 → R5-M2, R4-M2 → R5-M3), one fix shifted an existing defense onto the
wrong granularity (R4-C1 → R5-M1), and the wider reviewer set surfaced two latent pre-round-5
algebra gaps (R5-C1, R5-M4).

---

## CRITICAL findings (must change the spec)

### R5-C1 — a stale claimed id can become an ALIAS that shadows another tuple's canonical assignment
**§3.5.1 step 3, §3.3 clause (b), §3.5 same-tuple rule** · `[pi-gpt-ext #5; internally re-derived and confirmed]`

The assignment steps (1–2) are now duplicate-free by construction (R4-C1's fix), but the
ALIAS-derivation step is not closed under the same invariant. §3.5.1 step 3 says: "Any OTHER
id present in `R` for that same tuple (a machine's provisional local mint that disagreed)
becomes a **one-hop alias → winner id**" — **unconditionally**. Construction (legitimate
out-of-order replication, no attacker needed):

1. T1, T2 collide at `cand = C+1`; T1 (`≺`-least) keeps `C+1`, T2's minting machine locally
   displaced it to `C` — so T2's record in `R` CLAIMS `C`. The merge currently assigns
   T2 → `C` (no claimant at `C` yet).
2. A late/offline record for tuple `U` arrives with `cand(U) = C`. Step 1 reserves `C` for
   `U` (canonical reservation is unconditional); T2 re-resolves: walks `C+1` (reserved, T1),
   `C` (reserved, U), lands `C−1`.
3. Step 3 now derives an alias for T2's stale claimed id: `C → C−1`. But `C` is
   simultaneously `U`'s canonical ASSIGNMENT. `resolve(C)` is ambiguous — assignment says U,
   alias says T2 — violating the headline invariant "no id resolves to more than one tuple"
   in the DERIVED state, with implementation-precedence divergence (or outright
   cross-conversation misresolution) as the consequence. Compounding: §3.3 clause (b) makes
   any alias-table id collide for FRESH mints — so `U`'s own later local mint at its own
   canonical would spuriously displace itself, and the two derived structures (alias table,
   reserved-canonical map) disagree about `C` forever.

This hole PRE-DATES round 5 (step 3's wording and unconditional canonical reservation are
round-3/4 text; every prior walk-through exercised alias sources that were never another
tuple's canonical) — but the round-5 global rewrite is what makes it visible, and the §10
suite never constructs it (all alias tests use "three ids for ONE tuple").

**Fix (one paragraph):** pin alias-derivation precedence — a loser/stale claimed id becomes
an alias ONLY if, under the FINAL assignment of `R`, it is neither a reserved canonical nor
an assigned displacement offset of ANOTHER tuple; a stale claim on an id another tuple now
owns is simply DROPPED (the claiming tuple resolves via its winner id; a durable binding on
the stale id keeps delivering through the §3.5.2 pin / record-carried `boundTuple`, which is
exactly what the overlay exists for — and this drop path should be named in §3.5.2 so the
binding-on-a-dropped-claim case is explicit). Alias-table maintenance must re-run this
precedence when a LATE canonical claimant arrives (the U case above evicts the `C → C−1`
alias in the same atomic op that reserves `C` for U). Add the U-construction to the §10
fuzz + alias suites, asserting `resolve(C) = U` on every machine and no alias entry ever
shadows an assignment.

---

## MAJOR findings (should change the spec)

### R5-M1 — the per-class uncorroborated cap guards the wrong granularity under GLOBAL occupancy: cross-class stuffing reaches the pending-mint cliff and inflates the cascade
**§3.5 class-cap (M7), §3.5.1 step 2 + complexity bound, §3.3** · `[gemini-ext #1 + pi-gpt-ext #8 — 2 reviewers, convergent from the DoS and cost directions; internally confirmed]`

R4-C1 made displacement occupancy GLOBAL, but `uncorroboratedClassCap = 16` still bounds
records PER collision class — and the §3.5 sizing sentence "16 + genuine collisions ≪
`MAX_PROBE_DISTANCE` = 64, so the displacement walk stays bounded away from the pending-mint
cliff" is now FALSE as a global-walk claim. Two convergent consequences:

- **Targeted mint-DoS (gemini):** an attacker back-dates one crafted record to displace a
  victim at `C`, then fills the victim's 64-offset walk window with displaced tuples from
  SEVERAL adjacent classes — ≤16 per class, ~4–5 classes, ~64–80 records total, none
  violating any per-class cap, each passing the id↔key coherence bound within its own class.
  The victim's legitimate LOCAL mint (never capped — but its WALK consults the same global
  set) exceeds `MAX_PROBE_DISTANCE` → §3.6 pending-mint degradation → durable follow-through
  on the targeted conversation is refused. The store is never-delete, so a patient attacker
  seeds this over hours below the displacement-anomaly tripwire's 10-minute window rate.
  Same consequence class R3-M7 was ranked MAJOR for; the cap that fixed M7 no longer bounds
  the attack.
- **Cascade cost (pi):** the §3.5.1 "amortized O(1) per ingested record" claim is not
  established — an adversary seeding one claimant per 64-wide window builds a chained region
  where each later back-dated record's cascade re-resolves O(chain) classes; a stream of K
  such records costs O(K·chain) → quadratic in the adversarial regime. The freeze-risk shape
  (CommitmentTracker 2026-06-21) relocated to the cascade, in exactly the regime the class
  cap was supposed to preclude.

**Fix (one decision closes both arms):** add a WINDOWED uncorroborated cap alongside the
per-class one — retain the `≺`-least `uncorroboratedWindowCap` (e.g. 24) uncorroborated
replicated records per any `MAX_PROBE_DISTANCE`-wide candidate window (a pure, deterministic
function of the received set, evaluated on the same ordered structures §3.4 already
requires — convergence preserved by the same argument as the class cap). This re-establishes
walk-boundedness (window cap + genuine < 64) AND bounds adversarial cascade-chain density,
so the amortized-cost claim can be restated honestly (cascade work per ingest bounded by
window cap × windows touched). Restate the §3.5 sizing sentence against the WINDOW; add §10
shapes: the 4-class spread attack (victim mint still lands within 64) and the chained-region
cost assertion.

### R5-M2 — `boundTuple`'s "no new authority" claim is not mechanically true: it bypasses the id↔tuple coherence that `resolve(id)` enforces
**§3.5.2 property 5, §5 pickup** · `[pi-gpt-ext #6 (classed CRITICAL there) — reconciled to MAJOR; internally confirmed with the reconciliation reasoning below]`

Property 5's trust posture argues a forged replicated commitment "could already point its
`topicId` anywhere," so `boundTuple` adds nothing. Under FULL record forgery that is
approximately true (the attacker can forge `topicId` to a computable victim id — the
candidate hash is deterministic). But it is not mechanically true as stated: delivery via
`resolve(boundTuple)` consults NO registry-side coherence between the tuple and the
commitment's stored `topicId`, whereas the plain `resolve(id)` path only lands where the
REGISTRY (with its ingest id↔key coherence, seize-refusal, and origin rules) says that id
means. A corrupted-but-not-malicious `boundTuple` (an implementation bug, a partial
overwrite, a mis-clamped migration) silently redirects a beacon into whatever conversation
the field names, with `topicId` pointing elsewhere — no invariant catches the mismatch.
Reconciled to MAJOR, not CRITICAL: exploiting it as an ATTACK requires a peer already inside
the CommitmentsSync trust boundary, where an equivalent forged `topicId` achieves comparable
misdelivery; the defect is that the spec's own safety claim overstates, and that the
non-adversarial corruption case has no tripwire.

**Fix (one delivery-time check):** deliver via `boundTuple` ONLY when it is COHERENT with
the binding's stored id — `cand(routingKey(boundTuple))` equals or is within
`MAX_PROBE_DISTANCE` below... precisely: the commitment's `topicId` must be reachable as
that tuple's canonical or a within-bound displacement offset (the SAME predicate the §3.5
ingest coherence check already defines — reuse it, one shared implementation). An incoherent
pair falls back to `resolve(id)` + ONE deduped attention item (never silent). This makes the
no-new-authority sentence mechanically true and gives the corruption case a tripwire. Add
the incoherent-pair branch to the §10 pickup test.

### R5-M3 — `send-retire` (registry WAL) and `sendSeq` (beacon hot state) are two durable stores with NO crash-ordering contract — one ordering re-opens the double-post
**§5.0(a), §3.4** · `[pi-gpt-ext #7 (classed CRITICAL there) — reconciled to MAJOR by this ceremony's round-4 precedent: the blast radius is a duplicate message to the user's own thread, never misdelivery]`

R4-M2's fix makes the dedup entry durable, and R3-M2 makes `sendSeq` durable — in DIFFERENT
files with independent write moments. On a delivered outcome the implementation must both
(a) advance+persist `sendSeq` (hot state, atomic tmp→rename) and (b) journal `send-retire`
(registry WAL, fsync). If (b) lands and the process crashes before (a): reboot restores
`sendSeq = 7` with the seq-7 ambiguous entry RETIRED → the next fire re-sends logical send 7
with no guard → double-post. The §10 suite tests restart durability of each store alone,
never the inter-store crash window.

**Fix (one ordering pin):** persist `sendSeq` advancement BEFORE journaling `send-retire`
(the safe direction: a crash between the two leaves the entry unretired and the seq
advanced — the new seq never matches the stale entry, which then ages out at TTL; a
harmless leak, never a double-post). State it as a normative ordering contract in §5.0(a)
and add the crash-between-stores case to the §10 E1 suite (kill between the two writes in
both orders; assert single post either way under the pinned order).

### R5-M4 — `≺`'s tuple-representative record is unpinned when a tuple has MULTIPLE records in `R`
**§3.5.1 `≺` definition, field merge** · `[pi-gpt-ext #9; internally confirmed, with an aggravator]`

`≺` compares "(hlc.physical, hlc.logical, hlc.node) of the tuple's MINTING RECORD" — but the
same-tuple/different-id case guarantees a tuple can have SEVERAL records in `R` (that is the
whole alias mechanism), and the spec never says which record's HLC represents the tuple in
`≺`. An implementation reading "first ingested" is arrival-order-dependent →
non-convergent; worse (the internal aggravator), the §3.5.1 field-merge table lists the
entry's `hlc` as MUTABLE metadata ("last-writer-wins") — an implementation reading the
ENTRY's current hlc would have `≺` inputs that drift under metadata merges, silently
re-ordering collision classes over time. The intended reading (the `≺`-least/lowest-HLC
same-tuple record, consistent with the same-tuple winner rule) is recoverable but NOT
pinned — and this algebra has already produced two CRITICALs from exactly this kind of
recoverable-but-unpinned reading.

**Fix (one sentence + one clarification):** pin the tuple's representative for `≺` as the
`≺`-least record of that tuple in `R` (deterministic, content-only); state explicitly that
the entry's MUTABLE `hlc` metadata field is NEVER an input to `≺` (only immutable
record-carried HLCs are); add a fuzz shape where a tuple holds 3 records with distinct HLCs
arriving in every order and assert class ordering is byte-identical.

---

## MINOR findings (polish — batch)

1. **E1 dual-structure muddle (internal):** §5.0(a) now describes BOTH a durable store-held
   `ambiguousSends` map (snapshot + journal) AND a §5.2-style bounded/evicting in-memory
   "cache" — but the store map IS in-memory once loaded, so the cache is a second copy of a
   subset with its own eviction rules, and "shed loudly at cap-with-all-live" does not say
   whether the NEW entry is still recorded durably (it should be — the journal append has no
   cap; only the windowed lookup structure sheds). One paragraph collapsing this to ONE
   structure (the store map, naturally bounded by open commitments × unretired sends + TTL
   expiry) — or pinning that shed affects the lookup cache only, never the durable record —
   removes an implementer trap.
2. **Internal-trust boundary phrasing (§7)** `[gemini-ext #3]`: the server-self bypass is
   correct, but add the one plain sentence: B7 protects against confused/buggy SESSIONS;
   the server's own in-process components are inside the trust boundary and a bug there is
   not mitigated by this gate (it is mitigated by review/tests, like any server code).
3. **Delivery-state ops in the identity journal (layering)** `[gemini-ext #2 — classed MAJOR
   there; reconciled to MINOR: no correctness/data-loss consequence, the coupling is
   deliberate (reuse of the WAL discipline + retention floor alignment), and the §11.10
   SQLite migration carries both op families mechanically]`: add one honest sentence in §3.4
   naming the trade (the identity journal carries two op families; the §11.10 migration
   inherits both) so the coupling is a documented decision, not an accident.
4. **`bindTokenSecret` lifecycle vs backup (internal):** §7 pins generation + persistence
   but not whether the secret enters the backup manifest. Recommend explicitly NOT (secrets
   do not belong in snapshots shipped off-machine); name the consequence (a disaster restore
   regenerates the secret → all outstanding tokens invalid → the same loud typed-refusal
   path as rotation). One sentence.
5. **Cosmetic batch (internal):** §3.5.2 property 5's "written at bind time by the same
   §3.3 WAL-fsynced open" reads as if `boundTuple` lives in the registry WAL (it lives on
   the commitment record; the WAL line written at the same moment is `op:"bind-pin"`) —
   reword; the §3.4 `ambiguousSends` schema example key concatenates conversationId and
   logicalSendId with no separator — show the real composite-key delimiter.

---

## Convergence recommendation

**NOT CONVERGED.**

Blocking:

- **R5-C1** — the alias-derivation step can shadow another tuple's canonical assignment
  (`resolve(C)` ambiguous between an assignment and an alias), violating the spec's headline
  invariant in the derived state via legitimate out-of-order replication. Pre-dates round 5;
  surfaced by the first GPT-tier pass since round 3. The fix is a one-paragraph precedence
  pin (assignment always beats alias; stale claims on another tuple's id are dropped, with
  the binding-protection overlay named as the safety net) + two §10 shapes.
- Plus 4 MAJORs, each with a small, localized fix: the windowed uncorroborated cap that
  re-establishes both walk-boundedness and cascade cost under GLOBAL occupancy (R5-M1); the
  delivery-time id↔tuple coherence check that makes `boundTuple`'s no-new-authority claim
  mechanically true (R5-M2); the `sendSeq`-before-`send-retire` crash-ordering contract
  (R5-M3); the `≺` tuple-representative pin (R5-M4).

What is genuinely settled and should NOT be re-litigated next round: all 9 round-4
resolutions verified present and code-grounded (zero false code claims found this round);
the global displacement ASSIGNMENT algebra (steps 1–2) is duplicate-free by construction and
survived the re-executed round-4 adversarial walk; the stateless bind token (R4-M3) is clean
per both external reviewers; the WAL/backup/recovery spine, the §3.5.2 overlay's
single-machine semantics, and the delivery-integrity spine all stand unchanged from round
4's verification; `## Open questions` remains verifiably empty.

Recommended next step: a Phase-2d revision addressing R5-C1 + the four MAJORs (all are
pin-level edits to §3.5.1/§3.5/§5.0(a)/§3.5.2 — no architecture change), then Round 6. Note
on the trend: the round-over-round finding count (1C+3M → 1C+4M) did NOT worsen on a
like-for-like reviewer basis — round 4 had no GPT-tier pass, and that family contributed or
co-discovered 4 of this round's 5 blockers, including both latent pre-round-5 gaps. The
per-family trend is converging; the coverage widened.

**Verdict: NOT CONVERGED** (1 CRITICAL + 4 MAJOR remaining; converged requires zero of both).
