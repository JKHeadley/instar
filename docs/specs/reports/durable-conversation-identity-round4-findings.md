# Round-4 convergence findings — durable-conversation-identity

**Spec reviewed:** `docs/specs/durable-conversation-identity.md` @ commit `25c486304`
("round-4 revision — resolve round-3 convergence findings (4 CRITICAL + 16 MAJOR)").
**Report commit:** this file.
**Round-4 status: NOT CONVERGED.** 1 CRITICAL + 3 MAJOR + 5 MINOR.

Round 4 verified that **all 20 Round-3 CRITICAL/MAJOR findings (and the ~25 MINOR batch) are
genuinely resolved in the body** — every claimed mechanism is present in the spec text, and
every code claim the resolutions rest on was re-verified against this worktree's real source
(the C4 `expandGlob` behavior, the PromiseBeacon cadence/gate/hot-state lines, the
`POST /commitments` body-read + shared-Bearer reality behind M5, the `shared-state.jsonl*`
precedent, the stateDir-relative path convention). The headline round-3 fixes are sound:

- The **§3.5.2 bind-pin overlay** genuinely restores "merge is a pure function of R" — the
  sticky marker is removed outright (all remaining `sticky` mentions in the spec are
  historical or wire-stripping references), the composition order is pinned, and the C3
  partition walk reconciles cleanly.
- The **relocated journal + top-level glob** (`conversation-registry.jsonl*` at the stateDir
  root) is exactly the shape the deployed resolver expands — verified line-by-line against
  `src/core/BackupManager.ts` in this worktree.

But this round's fresh adversarial pass — independently corroborated by the external
Gemini-tier reviewer on every load-bearing point — found **one new CRITICAL in the merge
algebra itself** (a cross-collision-class displacement hole that predates the sticky cluster:
it was introduced by the round-3 fix for R2-adversarial-2 and survived because every prior
walk-through exercised only ONE collision class), plus **three MAJORs that are sibling flaws
of round-3 resolutions** (the bind-pin's machine-locality vs the §5 beacon-pickup path; the
retirement-based E1 entry's unpinned durability; the bind-token map's lifetime vs the
tmux-sessions-outlive-the-server deployment reality). That is the expected shape of a
convergence process still working: the fixes are real, and their seams are where the new
findings live.

---

## Reviewers who ran this round

**Six internal lenses (all ran, independent passes):** security, scalability, adversarial,
integration (grounded against this worktree's real code — every file:line the round-3
resolutions cite was re-read, ~25 checks, zero contradictions found), decision-completeness,
lessons-aware.

**Standards conformance:** the round-3 flag (`LLM-Supervised Execution: possible-violation`)
is closed — the declarative `supervision:` frontmatter key the round-3 report prescribed is
present (spec line 9) with the Tier-0 rationale + named supervisor-equivalent. The gate
tooling itself was not re-run this round; no new standard-interaction surface was added by
the round-4 revision.

**External cross-model passes:**
- **gemini-cli / gemini-2.5-pro** — RAN (completed inside the 10-minute bound). Verdict
  **SERIOUS ISSUES**, 5 findings: 3 CRITICAL-classed, 1 MAJOR, 1 MINOR. Every one of its
  CRITICAL/MAJOR findings independently matches an internal-lens finding below (deduplicated;
  severity reconciled per this ceremony's own criteria, noted inline).
- **codex-cli** — **NOT RUN: `codex` is not installed on this machine** (`which codex` →
  not found; same honest state as prior rounds noted). The GPT-tier family is therefore not
  represented this round. Recorded honestly rather than fabricated.

A finding hit by multiple independent reviewers is flagged `[N reviewers]`.

---

## Round-3 resolution verification (protocol step 1)

Every Round-3 finding traced to its claimed resolution in the round-4 body, verified against
BOTH the revised spec text AND the worktree's real code:

| R3 finding | R4 resolution verdict |
|---|---|
| **C1** (sticky breaks pure-function-of-R) | **RESOLVED.** `sticky(t)` removed from §3.5.1 (no lifecycle input exists to read); sub-step composition pinned (reservation → displacement → alias, one ordered pass per class); unique-fixpoint statement present; §10 fuzz runs ≥3 machines WITH live bind-pins and asserts pins never move an assignment. **BUT the restated displacement rules expose a latent cross-class hole → R4-C1** (not caused by the sticky removal — see below). |
| **C2** (sticky expiry vs monotonic replication) | **RESOLVED.** Dissolved by removal: the §3.5.2 pin is machine-local, never replicated (property 1/4); wire-arriving binding fields STRIPPED at the §3.5 clamp (spec :884-887); no set-vs-clear partition state exists to converge. |
| **C3** (two-sticky partition unreconcilable) | **RESOLVED.** The pin binds an id to its bind-time TUPLE; delivery follows `resolve(pin.tuple)`; consumer `topicId` never mutated; the §3.5.2 partition walk (spec :1232-1245) reconciles both machines with byte-identical registries. **Sibling flaw → R4-M1** (the pin does not travel with the §5 beacon-pickup path). |
| **C4** (backup glob dead against deployed `expandGlob`) | **RESOLVED, code-verified.** Journal relocated to the stateDir ROOT with top-level glob `conversation-registry.jsonl*`. Verified in this worktree: `expandGlob` (`src/core/BackupManager.ts:97-112`) returns the literal for any `/`-containing prefix/suffix and expands top-level trailing-star via `readdirSync(stateDir)` — the new glob expands; the working precedent `shared-state.jsonl*` is at `:84`; `createSnapshot` (`:255-315`) handles the literal subdirectory FILE `state/conversation-registry.json` (join → existsSync → `mkdirSync(dirname)` → copy) so "only GLOBS are top-level-constrained" is code-true; the stateDir IS `<project>/.instar` (the `PostUpdateMigrator.ts:8915-8919` "PATH SHAPE IS PINNED" comment). The §10 Tier-2 assertion was correctly refined to expanded-set-non-empty + present-in-snapshot. `conversation-registry.jsonl` does not collide with `BLOCKED_FILES`/`BLOCKED_PATH_PREFIXES` (`BackupManager.ts:30-36` — secrets + inbound-queue custody prefixes only). |
| **M1** (E1 window < real 6h re-fire) | **RESOLVED in mechanism** — retirement-based suppression, no fixed window; §10 tests at the 6-hour cap AND 40-min atRisk cadence. Code re-verified: `maxCadenceMs` default `21_600_000` (`PromiseBeacon.ts:422`), atRisk doubling (`:562-564`). **Sibling flaw → R4-M2** (the long-lived entry now needs a durability story the spec doesn't pin). |
| **M2** (sendSeq durability/increment semantics) | **RESOLVED.** Pinned durable + monotonic, advanced only on delivered, held constant across ambiguous; §10 restart-between-heartbeats test. Grounded: the beacon HAS per-commitment on-disk hot state (`PromiseBeacon.saveHotState` — `fs.writeFileSync` of `<stateDir>/<id>.json`), and `lastHeartbeatAt` advancing every check (`:790-796`) is exactly as the spec describes. Residual: the "journaled with it" wording overstates the deployed medium → MINOR-1. |
| **M3** (merge O(N²) at ingest) | **RESOLVED.** §3.5.1 complexity-bound paragraph: incremental per touched class via the cand→claimants locator (§3.4 index 5), batch-resolve-once; §10 bounded-ops ingest assertion. **Caveat: R4-C1 breaks the "an ingested record touches exactly ONE collision class" independence premise** — adjacent classes' walks couple; the fix for R4-C1 must restate the incrementality bound (bounded cascade, not strict one-class). |
| **M4** (index inventory undercount) | **RESOLVED.** §3.4 full 5-index inventory (2 synchronous + 3 derived, rebuilt-at-boot/never-persisted); resident-heap honesty (5–10× fileSizeBytes); health endpoint reports `entryCount` as the heap axis. |
| **M5** (B7 had no enforcement primitive) | **RESOLVED in design.** The per-session bind token + server-side `token → {sessionName, bootstrapConversationIds}` map is a real primitive; code claims re-verified (`routes.ts:21786+` reads `topicId` from the body; `middleware.ts:120+` one shared Bearer). **Sibling flaw → R4-M3** (the in-memory map's lifetime vs sessions that outlive the server process). |
| **M6** (back-dating threat undisclosed) | **RESOLVED.** §3.5 back-dating honesty paragraph states registry shape IS peer-perturbable within the window; blast radius correctly scoped to shape/churn (delivery stays local-origin + bind-pinned); displacement-anomaly tripwire (`8`/10-min) pinned. |
| **M7** (collision-class stuffing DoS) | **RESOLVED.** `uncorroboratedClassCap = 16`, `≺`-least deterministic retention (pure function of the received set); local/corroborated never capped; 16 + genuine ≪ 64; §10 stuffing test. (R4-C1 shows the ADJACENT-class composition of constructed collisions was still missed — the cap bounds one class, not the cross-class walk overlap.) |
| **M8** (sticky boolean strands second binding) | **RESOLVED.** §3.5.2 property 4: refcounted pin, `bind-pin`/`bind-release` journal ops, released at zero, boot replay restores; §10 refcount suite. |
| **M9** (workspace enforcement self-contradictory) | **RESOLVED.** §3.1 restated at real strength (per-machine hard-refuse always; fleet-wide only WITH a config pin); `workspacePin` mandatory in multi-machine mode with the emitter HOLD + boot attention item; within-workspace channel-id uniqueness assumption stated explicitly, global uniqueness explicitly NOT assumed. (Gemini flags the "replicated single-writer fleet value" naming as confusing → MINOR-5.) |
| **M10** (HLC constants unpinned) | **RESOLVED.** `physical` = ms-since-epoch; `HLC_ABS_MIN = 1767225600000` (verified = 2026-01-01T00:00:00Z), `HLC_ABS_MAX = 4102444800000` (verified = 2100-01-01T00:00:00Z); versioned-migration-only; horizon documented; all three in the §10 golden-parity suite. |
| **M11** (P17 global ceiling missing) | **RESOLVED.** §5.2 `globalPerWindow = 60` at the `id<0` arm + coalesced overflow notice; per-conversation `12`/10-min pinned; §10 dodge-shape burst test present. |
| **M12** (ingest refusals not aggregated) | **RESOLVED.** All six ingest-refusal classes route through ONE aggregating emitter (60 s window, per-origin dedup, per-class counts + bounded key sample); per-episode wording scoped THROUGH it; §10 burst test. |
| **M13** (retry rule was a head-of-line wedge) | **RESOLVED.** Quarantine split: absolute-window = TERMINAL drop (cursor advances, identical everywhere); pool-relative = per-origin side-queue, backoff 60 s ×2 capped 1 h, `quarantineRetryMax = 20`, loud park-aside + one attention item; §10 sustained-failure no-wedge test. Residual: side-queue cardinality unbounded → MINOR-2. |
| **M14** (WAL seq per-file vs global) | **RESOLVED.** `seq` is ONE global monotonic counter spanning rotations AND restarts; boot resumes from max seen; rotation carries the checkpoint anchor; §10 rotation-boundary replay test. |
| **M15** (test-critical defaults unpinned) | **RESOLVED.** `deadLetterAfterConsecutiveFailures = 3` (distinct from `deadLetterAttentionAfter = 1`); §5.2 budget values pinned; the E1 margin term correctly superseded by the retirement design. |
| **M16** (lease/owner reconciliation deferred while replication ships) | **RESOLVED.** Non-owning STAND-DOWN defined (no re-fire scheduling, bounded ownership recheck per sweep); active-active double-delivery named a CORRECTNESS blocker; structural tripwire (>1 live Slack adapter + store enabled → emitter HOLDS + one attention item). Residuals: the stand-down "sweep" cadence unnamed → MINOR-4; and the pickup half of stand-down is what exposes R4-M1. |
| ~25 MINORs (batch) | **ALL RESOLVED** — spot-verified in the body: chi-square parameters (≥10k/≤4096/p<0.01), 60 s coalescing window, rotation caps + retention floor, `pendingMintMax = 1000`, health threshold 80% (40k/8 MB), off-loop flush trigger (>20k/>2 MB), MessageStore named as the adoption-gate source, null-`threadTs` sorts-first pin, alias-repoint O(k²) bound, flap dampening (3/24 h), beacon `allowDuplicate` CI assertion, neither-tuple-registered flood read = transport sessionKey, seq-ordered replay idempotency for alias/bind ops, fire()-gate citation corrected (verified: `PromiseBeacon.ts:590-605` IS the speakerElection delivery gate; `:518-527` is the external-block sweep), `GET /conversations/:id` label sanitization, single adoption-trigger wording, working-set acceptance criterion, gate-exempt scope pin, `getWorkspaceId()` honesty note (verified: `SlackAdapter.ts:386` is a config read), adoption-flood credit corrected, breaker budget-map bounding, coalesce=batching, macOS fsync footnote, `supervision` frontmatter, spec-local lesson names marked, Slack degenerate-registry sentence, §3.7 projection comparison, §3.0 normative core, broadened SQLite tripwire, statistical-test-drives-§11.9. |

**Net:** zero round-3 findings regressed; three of their *resolutions* introduced sibling
flaws (R4-M1/M2/M3), and the round-3 R2-adversarial-2 fix (per-class clause (c)) carried a
latent cross-class hole now visible as R4-C1. Same shape as round 3's own summary: the
expected signature of a convergence process working.

---

## CRITICAL findings (must change the spec)

### R4-C1 — cross-collision-class displacement overlap: two tuples can be assigned the SAME id
**§3.3 clause (c), §3.4 index 4, §3.5.1 step 2(b), §3.5.1 complexity bound** ·
`[adversarial; gemini-ext #1 — 2 reviewers, independently identical scenario]`

The displacement rules are stated TWO different ways, and the way the implementation guidance
mandates is unsound:

- **§3.5.1 step 2(b)** (the normative algebra): a displaced tuple's walk skips an offset
  "already taken by a `≺`-earlier displaced tuple" — **unqualified** (any displaced tuple
  in `R`).
- **§3.3 `candidateCollides` clause (c)** and **§3.4 index 4** (the implementation the merge
  MUST share, per the spec's own one-shared-implementation requirement): the taken-offsets
  set is tracked **"per collision class (per shared `cand` value)"** — and the §3.3 prose
  explicitly narrows the walk filter to "the `≺`-ordered taken-offset set **of its own
  collision class**."

Under the per-class reading, adjacent collision classes whose probe walks overlap assign the
SAME id to two different tuples. Concrete walk (both machines compute it identically — a
**convergent-but-wrong** state, worse than divergence):

1. Class A: tuples T1, T2 with `cand = C` (T1 ≺ T2). Class B: tuples U1, U2 with
   `cand = C−1` (U1 ≺ U2).
2. Step 1 reserves canonicals: `C → T1`, `C−1 → U1`.
3. T2 walks down from `C`: skips `C` (reserved, own class), skips `C−1` (reserved canonical
   of ANOTHER tuple — clause (a)), lands on `C−2` (class A's taken set is empty) → **T2
   takes C−2**.
4. U2 walks down from `C−1`: skips `C−1`, lands on `C−2` — it is nobody's reserved
   canonical, and class B's per-class taken set does not contain it (T2 is a DIFFERENT
   class) → **U2 also takes C−2**.

Result: `resolve(C−2)` maps to two tuples; the id→key reverse index is silently
overwritten — **cross-conversation mis-resolution**, the exact failure class §3.3's clause
(c) says it exists to prevent ("the local reverse index would be silently overwritten"), and
a direct violation of §3.5.1 step 3's asserted invariant "No id resolves to more than one
tuple," which no mechanism enforces across classes.

Reachability is not hypothetical-only: accidentally it needs two genuine collisions at
candidates within `MAX_PROBE_DISTANCE` of each other (negligible), but **adversarially it is
constructible inside the spec's own accepted threat model** — §3.5/M7 already concedes
"candidate collisions are constructible on demand" (non-cryptographic 32-bit sum-shift,
shape-clamped channelIds). A compromised peer replicates one crafted tuple colliding at a
victim tuple's candidate `C` with a back-dated HLC (wins ≺, displacing the victim) plus a
crafted two-record class at `C−1`: the victim's REAL conversation and an attacker record
both resolve to `C−2`. The `uncorroboratedClassCap = 16` does not help — it bounds ONE
class; this attack uses 3 records across two classes. The §10 suite never catches it: every
collision test in the spec ("two tuples colliding at ONE candidate", "three ids for one
tuple") exercises a single collision class.

**Also breaks R3-M3's incrementality premise:** "an ingested record touches exactly ONE
collision class … ONLY that class is re-resolved" assumes class independence, which fails
exactly when walks overlap — a re-resolved class can invalidate a neighbor class's
displacement (within 64 below it), so the incremental recompute as specified can settle on a
state the full pure function would not produce (a second, subtler non-convergence).

**Fix:** the walk filter in step 2(b)/clause (c) must consult the **global** assigned-id set
under steps 1–2, not a per-class set — e.g. process ALL displaced tuples in one global `≺`
order against one taken set (deterministic, still a pure function of `R`); align §3.3
clause (c) and §3.4 index 4 to the global structure (the per-class sets can remain as the
locator, but the occupancy check must be global); restate the M3 incremental bound as a
bounded cascade over classes within `MAX_PROBE_DISTANCE` of the touched class (still O(1)
amortized — the cascade is bounded by 64); and add the two-adjacent-classes permutation (and
the adversarial 3-record construction) to the §10 fuzz + stuffing suites, asserting the
no-duplicate-assignment invariant explicitly.

---

## MAJOR findings (should change the spec)

### R4-M1 — the bind-pin does not travel with the beacon: §3.5.2's locality residual contradicts §5's ownership-pickup path
**§3.5.2 residual, §5 non-owning stand-down, §3.5 adoption** · `[adversarial + integration; gemini-ext #4 — 2 reviewers]`

§3.5.2's honesty residual claims "a pin lives only on the machine that holds the binding —
which is exactly right, because delivery authority is local and **only that machine's beacon
fires for it**." But §5 (the R3-M16 stand-down fix) says the opposite is a designed path:
with increment 9 live, a replicated commitment sits on a non-owning machine whose beacon
stands down and **"a machine that BECOMES the owner (adoption on first authenticated inbound,
§3.5) picks the beacon up within one sweep."** The machine that picks the beacon up did NOT
bind, holds NO pin, and delivers via bare `resolve(id)` — so if the merge has demoted or
reassigned the bound id (the exact case the pin exists for), machine B's beacon delivers the
commitment into the WRONG conversation. CommitmentsSync replicating the commitment while the
pin stays machine-local is precisely the C3-class misdelivery reopened on the ownership-
migration path. Bounded (requires a genuine collision demotion + an ownership move +
increment 9 live), but it is a silent misdelivery — the failure class this spec ranks
highest.

**Fix:** record the bind-time TUPLE on the durable binding record itself (e.g. a
`boundTuple` field on the commitment, denormalized at bind time), so ANY machine delivering
that binding reconstructs the pin locally at delivery time (`resolve(boundTuple)`), keeping
the overlay delivery-time-only and never a merge input; correct the §3.5.2 residual sentence
to name the pickup path; add a §10 test — commitment bound on A, ownership adopted by B,
merge demotes the bound id → B's beacon still lands in the bound tuple's thread.

### R4-M2 — the E1 dedup entry's durability is unpinned and contradicts its own bounded/evicting store
**§5.0(a)** · `[adversarial + integration; gemini-ext #2 + #3 (classed CRITICAL there) — 2 reviewers]`

The retirement-based fix (R3-M1) makes the dedup entry **long-lived by design** ("persists
until that logical send is RETIRED … hard TTL backstop of 7 days"), but the store it lives
in is specified as "the §5.2 `AttentionTopicGuard` bounded/evicting structure" — an
**in-memory windowed map** — and the spec never states the entry survives a process restart.
Two concrete double-post holes follow, both the exact failure E1 exists to close:

1. **Restart wipe:** ambiguous outcome (Slack posted, ack lost) → entry recorded, beacon
   holds `sendSeq` constant, next tick is 40 min–6 h out → the server restarts in between
   (instar restarts on every auto-update — the spec's own flagship scenario is "restart the
   server mid-commitment") → the map is empty → the re-fire of the SAME `logicalSendId`
   passes the guard → **double-post**. Note the durable `sendSeq` (R3-M2's fix) makes this
   WORSE, not better: it correctly re-fires the same logical send, and only the guard was
   supposed to suppress it.
2. **Eviction under load:** the bounded map's hard cap + `evictStaleSources` can evict an
   UNRETIRED entry hours before its 6-hour re-fire arrives → same double-post.

The §10 suite tests only the false-suppression direction ("post-restart heartbeat is NOT
suppressed") — the double-post-after-restart direction is untested, so the gap ships
invisibly. Severity note: gemini classes both arms CRITICAL; this report holds them at MAJOR
by the ceremony's own precedent (round-3 M1 — the same "double-post the guard was built to
prevent" consequence — was MAJOR: the blast radius is a duplicate message to the operator's
own channel, never misdelivery or corruption).

**Fix (one decision):** pin the dedup entry as durable — the natural home is the journal the
funnel increment already ships (an `op:"ambiguous-send"`/retire pair riding §3.4's WAL
discipline) or the beacon's per-commitment hot state (it is per-`(commitmentId, sendSeq)` —
exactly the hot state's granularity); pin that an unretired entry is NEVER evicted below the
TTL (the bound applies to retired/expired entries; if the hard cap is hit with all entries
live, shed with a LOUD attention item, never silently); add the §10 restart-double-post test
(ambiguous → restart → re-fire at the backed-off cadence → still ONE post).

### R4-M3 — the bind-token map dies with the server process while sessions don't: every server restart fail-closes all live sessions' minted-id binds
**§7 (the R3-M5 primitive)** · `[security + lessons-aware]`

The enforcement primitive stores `bindToken → {sessionName, bootstrapConversationIds}`
**"server-side (in-memory, re-minted on respawn)."** But in the deployed architecture,
sessions are tmux processes that **outlive the server process** — instar's own documentation
of exactly this class ("a running session keeps the config it was spawned with"; sessions
survive server restarts and resume via the bridge), and the server restarts on every
auto-update, often multiple times a day. After any server restart: every live session still
holds its spawn-time token, the new server process has an empty map, and §7 pins the
fail-closed behavior — "a missing/**unknown** token on a minted-id bind is the same typed
`conversation-bind-not-authorized` refusal." Net: **all Slack-conversation commitment/
working-set opens from every live session are refused from the restart until that session is
respawned** — a standing availability hole in the flagship proof-consumer path, structurally
guaranteed by the update cadence. It is loud (typed error + attention item), never silent,
which is why this is MAJOR not CRITICAL — but "the follow-through feature breaks after every
auto-update until sessions bounce" fails the feature's own purpose.

**Fix (any one):** derive tokens statelessly — `HMAC(serverSecret, sessionName ‖
bootstrapConversationIds)` with the secret persisted in state — so a restarted server
re-validates without a map; OR persist the token map in the state dir (the token authorizes
only its own session's bootstrap set — low theft value, same at-rest posture as the session
registry); OR rebuild the map at boot from the session registry's recorded bootstrap
contexts. Add a §10 test: bind token minted → server restarts (session persists) → the
session's next minted-id bind still succeeds.

---

## MINOR findings (polish — batch)

1. **`sendSeq` "journaled with it" overstates the deployed medium (§5.0(a)):** the beacon's
   per-commitment hot state is a plain non-atomic `fs.writeFileSync`
   (`PromiseBeacon.saveHotState`), not a journal — a crash mid-write can corrupt the file and
   reset the seq. One sentence: pin the hot-state write atomic (tmp→rename, the house
   pattern) for the seq-bearing file, or reword "journaled" to "persisted" and accept the
   torn-write residual honestly. (Composes with R4-M2: if the dedup entry becomes durable
   while the seq can reset, the reset seq re-collides with the durable entry.)
2. **Pool-relative side-queue cardinality unbounded (§3.5.1 quarantine discipline):**
   per-record retries are bounded (backoff + `quarantineRetryMax = 20`), but the NUMBER of
   held records per origin is not — a peer emitting a stream of pool-relative-quarantined
   records grows the side-queue without limit for ~24 h. Pin a per-origin side-queue cap with
   overflow-to-park-aside (+ the aggregated item).
3. **Server-internal (non-session) callers of minted-id binds have no bind token (§7):**
   internal features that open commitments programmatically (the action-claim observer,
   scheduled jobs) would be refused on minted ids under the fail-closed rule if they call the
   route. One sentence pinning the internal principal path (in-process opens bypass the
   route-level token gate, or internal callers hold a server-self token).
4. **Stand-down "re-evaluated on a bounded ownership recheck each sweep pass" (§5):** which
   sweep (the beacon's hourly external-block sweep? a new one?) and its cadence are unnamed —
   the pickup-latency claim ("within one sweep") is unfalsifiable until pinned.
5. **`workspacePin` "replicated single-writer fleet value" naming (§3.1)** `[gemini-ext #5]`:
   the mechanism is correct (corroboration-gated, local-precedence, quarantine-on-divergence)
   but the name over-promises — the fleet does not necessarily USE one value; each machine
   may keep minting locally under conflict. An honesty rename ("replicated pin
   *candidate*, corroboration-gated") avoids an implementer building it as an actual
   single-writer register.

---

## Convergence recommendation

**NOT CONVERGED.**

Blocking (must change the spec):

- **R4-C1** — the per-collision-class taken-offsets rule lets two displaced tuples from
  adjacent collision classes take the SAME id (convergent-but-wrong on every machine;
  adversarially constructible with 3 crafted records inside the spec's accepted M7 threat
  model), contradicting §3.5.1's own "no id resolves to more than one tuple" invariant and
  the one-shared-implementation mandate (§3.3(c) per-class vs §3.5.1 2(b) unqualified). The
  external Gemini-tier reviewer independently produced the identical adjacent-class walk.
  This is the round's one genuine algebra-soundness hole; the fix (global taken set,
  deterministic global `≺` walk order, bounded-cascade incrementality restatement, two new
  §10 shapes) is a single contained design pass.

Plus 3 MAJORs — all sibling flaws of round-3 resolutions, all with cheap fixes: the bind-pin
must ride the binding record so it survives ownership migration (R4-M1); the E1 entry needs a
pinned durability + no-evict-below-TTL story (R4-M2); the bind-token needs a
restart-surviving validation path (R4-M3).

What is genuinely settled and should NOT be re-litigated next round: all 20 round-3
CRITICAL/MAJOR resolutions verified present and code-grounded (zero false code claims found
this round — the C4 relocation, the PromiseBeacon cadence/gate/hot-state citations, the M5
grounding, and the corrected fire()-gate citation all check out against this worktree); the
sticky removal is complete and the §3.5.2 overlay's single-machine semantics are sound; the
WAL/backup/recovery contract is now consistent end-to-end against the deployed
`BackupManager`; `## Open questions` remains verifiably empty; and the delivery-integrity
spine (local-origin delivery, `id<0` clamp, B4 envelope pinning, B3 label-sink exclusion,
B2 template constraints, the B7 token concept) has no surviving CRITICAL delivery-hijack
path.

Recommended next step: a Phase-2c revision addressing R4-C1 + the three MAJORs (each is a
small, localized edit — no architecture change), then Round 5. Note the trend: 4 CRITICAL +
16 MAJOR (R3) → 1 CRITICAL + 3 MAJOR (R4), with every R4 finding sitting on a seam a round-3
fix created or exposed — the process is converging.

**Verdict: NOT CONVERGED** (1 CRITICAL + 3 MAJOR remaining; converged requires zero of both).
