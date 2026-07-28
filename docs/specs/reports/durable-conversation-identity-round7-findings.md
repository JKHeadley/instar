# Round-7 convergence findings — durable-conversation-identity

**Spec reviewed:** `docs/specs/durable-conversation-identity.md` @ commit `9151b8035`
("round-7 revision — resolve round-6 findings (0 CRITICAL + 4 MAJOR + 5 MINOR + 4 LOW)").
**Report commit:** this file.
**Round-7 status: NOT CONVERGED.** 0 CRITICAL + 3 MAJOR + 3 MINOR + 2 LOW.

Round 7 verified that **all 13 Round-6 findings (4 MAJOR + 5 MINOR + 4 LOW) are genuinely
resolved in the body as designed** — every claimed mechanism was traced to EVERY normative
site it touches, against the spec text, never the commit message: the R6-M1 send-intent pair
(§3.4 op enum + §5.0(a) bullet + snapshot-completeness + FD-18 + both §10 crash shapes); the
R6-M2 tuple-as-sole-identity-authority pin (§3.5 clamp + coherence bullet + §7 summary with
within-bound probe acceptance + the §10 accepted-NOWHERE shape); the R6-M3 boot/restore
composition (§3.4 two-pin bullet + snapshot-completeness extension + both §10 boot-composition
shapes + the lessons-engaged frontmatter); the R6-M4 fail-direction flip (§3.5.2 property 5 +
the §5 pickup sentence + FD-19 + the flipped §10 incoherent-pair assertion, legacy
no-`boundTuple` carve-out intact). Three of the round-6 fixes were re-executed rather than
merely read:

- **The R6-M1 send-intent crash windows were re-walked in all three outcome branches**:
  kill-between-accept-and-append → boot converts the last-word intent to an ambiguous entry →
  re-fire suppressed → one post (holds); kill-after-`send-intent-resolved` → retry NOT
  suppressed (holds, R2-security-NEW-3 preserved); kill-between-intent-fsync-and-transport →
  boot converts → the never-posted heartbeat's re-fire is suppressed — exactly the disclosed
  "at most one suppressed heartbeat" worst case (honest). The walk also confirmed pi's R7-M1
  below: the "next cadence tick supersedes" claim in this same bullet contradicts the pinned
  seq rule.
- **The R6-M3 boot composition was re-walked on both §10 shapes**: alias journaled past the
  high-water → U ingested (reservation + same-atomic-op eviction) → crash → reboot: the
  snapshot-consistent cursor re-consumes U idempotently AND the post-replay filter drops the
  replayed shadowing alias — either pin alone restores `resolve(C) = U`; defense-in-depth
  holds. The cursor-behind-snapshot re-consume composes with the idempotent §3.5.1 ingest and
  the deduped/coalesced episode emitters (no notification amplification on re-consume).
- **The R6-minor-5 CONFIRMED transition table was re-walked for all three machines' states**
  — first-machine self-corroboration, second-machine-matching, second-machine-divergent all
  resolve deterministically; the walk additionally showed rule 3's fail-closed branch is now
  VACUOUS (every path that observes a concrete teamId proceeds), which is the internal
  re-derivation of pi's finding reconciled at MINOR-1.

Code claims new to the round-7 revision were re-verified against this worktree's real source:
`maxActiveBeacons ?? 20` (`PromiseBeacon.ts:425`) and the boot-cap overflow slicing
(`PromiseBeacon.ts:476-477`) — both exact. All other citations are carried from prior rounds'
verification (round 6 re-verified the full set; nothing they cite changed in this revision).
Zero false code claims found this round.

The round's blocking findings all sit on ONE section — the §5.0(a) E1 ambiguous-send
machinery: two are seams of the R6-M1 send-intent fix itself (the boot rule's keying, and the
supersession claim the fix makes against the pinned seq rule), and one is latent since
R3-M1/M2 (the content-hash fallback lane never had retirement semantics) surfaced by this
round's focused external pass. The merge algebra, the boot composition, the ingest
normalization, and the binding overlay took ZERO findings — the first round in this ceremony
where the registry core is finding-free.

---

## Reviewers who ran this round

**Internal pass (one consolidated multi-lens review by the folding agent, run against the
committed revision; nothing was folded pre-external — both externals reviewed exactly the
committed `9151b8035` text):** adversarial, integration (code-grounded — the new
`PromiseBeacon.ts:425`/`:476-477` citations verified in this worktree), security,
crash/replay-composition, decision-completeness, fail-direction, lessons-aware perspectives.
Confirmed/reconciled every external finding by independent re-derivation and contributed the
two LOWs.

**External cross-model passes (one bounded pass each). Provenance honesty:** both external
passes were EXECUTED by this round's session shortly before a session bounce, at 22:08–22:10
on 2026-07-02 — AFTER the 22:00:37 revision commit, against the committed spec file in a
clean worktree. The resumed session recovered and verified the exact invocations from the
session transcript (both read the same round-7 prompt file + the committed spec; exit 0
both) and carries their outputs as this round's external passes rather than burning a second
run — recorded here so the provenance is auditable, never implied to be a same-process run.
- **pi / openai-codex provider, `--model gpt-5.5`, `--no-session --no-tools`** — RAN
  (completed inside the 900 s bound; exit 0; the spec attached via `@file`). Verdict line:
  `VERDICT: 0 CRITICAL + 5 MAJOR + 0 MINOR + 0 LOW`. Three of its five MAJORs are confirmed
  by internal re-derivation (R7-M1, R7-M2, R7-M3 — all on the §5.0(a) machinery its prompt
  focused on); the other two are reconciled to MINOR with reasoning inline (MINOR-1,
  MINOR-2) — never a silent downgrade.
- **gemini-cli v0.25.2, `-o json`** — RAN (completed inside the 600 s bound; exit 0; spec on
  stdin). Serving models captured from the run's own stats block (the round-6 lesson — model
  self-reports are unreliable, the stats block is authoritative): **gemini-2.5-pro**
  (primary, 92k input tokens) + `gemini-3.1-flash-lite` (auxiliary routing). Verdict line:
  `VERDICT: 0 CRITICAL + 0 MAJOR + 1 MINOR + 0 LOW`. Its one MINOR is confirmed as MINOR-3.
  Notably it found the round-7 revision's focus areas sound ("the resolutions … have closed
  significant and subtle correctness gaps") — a useful independent signal on the R6 fixes,
  though the pi pass shows a single-model clean bill is not sufficient (the two externals'
  findings were again fully disjoint, the same single-pass-variance datum round 6 recorded).
- **codex-cli** — NOT RUN: `codex` is not installed on this machine (`which codex` → not
  found; same honest state as rounds 3–6).

A finding hit by multiple independent reviewers is flagged `[N reviewers]`.

---

## Round-6 resolution verification (protocol step 1)

Every Round-6 finding traced to its claimed resolution in the round-7 body, verified against
the revised spec text:

| R6 finding | R7 resolution verdict |
|---|---|
| **M1** (crash-DURING-send window double-posts — the E1 entry is recorded only at OUTCOME time) | **RESOLVED as designed.** `op:"send-intent"` append+fsync BEFORE the transport send (§5.0(a) :1812-1835); resolution by any later same-`logicalSendId` record; `op:"send-intent-resolved"` on a clean transient failure preserves R2-security-NEW-3; boot conversion of a last-word intent to an ambiguous entry; §3.4 op enum (:721-722) + snapshot completeness (:766-768) extended; FD-18 updated (:2911-2915); both §10 crash shapes present (:2687-2692). The crash windows were re-walked (above) — the mechanism is sound. **Two sibling flaws on the new machinery → R7-M3 (the boot rule keys on `logicalSendId` alone, contradicting the guard's composite key) and R7-M1 (the "next cadence tick supersedes" claim contradicts the pinned held-constant seq rule).** |
| **M2** (id↔key coherence check vs seize predicate read DIFFERENT key sources) | **RESOLVED.** The TUPLE is the sole ingest identity authority (§3.5 clamp :970-981): wire `key` never read for any predicate, canonical key RECOMPUTED from the clamped tuple + accepted workspace metadata, mismatch → typed `key-tuple-mismatch` quarantine into the aggregated refusal item, the conversations map keyed on the RECOMPUTED string only, the shape regex demoted to a pre-filter; the coherence bullet restated over `cand(routingKey(tuple))` (:1010-1013); §7 summary aligned WITH the within-bound probe acceptance (:2219-2222); §10 mismatch shape accepted NOWHERE (:2466-2469). Version-skew checked: a faithful old-version emitter's key matches the recompute (the key scheme is unchanged), so no false quarantine wave during a skew window. **Cosmetic sibling → LOW-2** (the §3.5 aggregator's enumerated refusal-class list predates the new class and does not name it, though the clamp text routes it through the aggregator explicitly). |
| **M3** (alias EVICTION unjournaled + boot composition of the three durable sources unpinned) | **RESOLVED.** Both pins present (§3.4 :772-794): (1) the per-origin ingest cursor persists SNAPSHOT-CONSISTENTLY; (2) the assignment-beats-alias filter RE-RUNS as a post-replay invariant pass; snapshot completeness extended to the cursor + unresolved intents (:766-771); both §10 boot-composition shapes pinned (:2705-2713); the frontmatter's Convergent-Merge-Algebra entry names the boot-fixpoint extension. Re-walked (above) — defense-in-depth holds; either pin alone closes the resurrection. Clean — no sibling. |
| **M4** (incoherent-`boundTuple` fallback delivered via `resolve(id)` — the C3-class misdelivery) | **RESOLVED.** Typed `conversation-binding-incoherent` NON-delivery through the §5.1 contract + ONE deduped attention item, never a delivery on either field (§3.5.2 property 5 :1506-1520), grounded in the coherence-STABILITY argument; the legacy no-`boundTuple` carve-out kept; §5 pickup aligned (:1920-1921); FD-19 aligned (:2917-2929); the §10 incoherent-pair branch flipped to assert ZERO deliveries + the refusal path with beacon re-arm + N-fail dead-letter (:1566-1572). **Cosmetic sibling → LOW-1** (one §10 suite-summary line still labels the branch "INCOHERENT-pair fallback"). |
| minor-1 (E1 growth bound uncited) | **RESOLVED.** `maxActiveBeacons` cited as the mechanical upstream bound with both code cites (§5.0(a) :1782-1793 — verified in this worktree: `PromiseBeacon.ts:425` default 20, `:476-477` overflow slice); "no cap" rescoped to "needs no cap of its own". |
| minor-2 (origin-relative caps → machine-relative equal-`R` under attack) | **RESOLVED.** The convergence-scope honesty paragraph present (§3.5 :1064-1077): unequal effective `R` under active stuffing named, bounded/loud/self-healing, delivery untouched, convergence claims scoped to the non-attack regime. |
| minor-3 (drop/eviction silent; id-keyed row re-attribution) | **RESOLVED.** Drop/eviction episodes route through the SAME aggregated ingest/alias emitter (§3.5.1 step 3 :1282-1293); the id-keyed-row re-attribution residual named honestly with its reachability bound. |
| minor-4 (positive-`topicId` branch enforcement-ambiguous) | **RESOLVED.** Mechanism + timing pinned (§7 :2278-2287): token-bearing sessions validate positive-id binds against `bootstrapConversationIds` from the proof-consumer increment on; legacy token-less sessions bounded to "one session generation"; §10 positive-branch tests run token-bearing. **Sibling honesty gap → MINOR-2** (nothing structurally bounds "one session generation" — pi). |
| minor-5 ("confirmed" undefined; first-machine deadlock) | **RESOLVED.** CONFIRMED defined (§3.1 rule 3 :292-306) — ≥1 LOCAL authenticated observation, writer's own observation counts; all three machine transitions spelled out; conservative-reading cost bounded. **Sibling honesty gap → MINOR-1** (with self-confirmation, rule 3's fail-closed is vacuous and its "can never independently pin two different workspaces" claim is false in a concurrent first-boot race — pi; internally re-derived). |
| low-1 (stale E1-symmetry claim in the breaker bullet) | **RESOLVED.** Re-pointed at the P17 maps only, with the E1-not-in-this-family note (§3.3 :524-526). |
| low-2 (§8 "adopt" op absent from the enum) | **RESOLVED.** Adoption pinned as `op:"mint"` with `origin: adopted-*` (§3.4 :724-727). |
| low-3 (cardinality overstated) | **RESOLVED.** "At most one LIVE entry … plus TTL-bounded crash stragglers" (§5.0(a) :1777-1781). |
| low-4 (orphaned bind-pin residual unstated) | **RESOLVED.** The crash residual named with the harmlessness argument + the pin↔binding-store consistency sweep as the GC follow-up, never auto-release on ambiguity (§3.5.2 property 4 :1468-1477). |

**Net:** zero round-6 findings regressed; all thirteen landed as designed. The R6-M1
resolution carries two sibling flaws on its own new machinery (→ R7-M1, R7-M3), and two of
the minor resolutions carry honesty gaps on their new text (minor-5 → MINOR-1, minor-4 →
MINOR-2) — the expected signature of a convergence process digesting its own repairs. R7-M2
is the one finding this round that PRE-dates round 7 (latent since the R3-M1/M2
retirement-based design; every prior round reviewed the beacon lane and missed the
content-hash lane beside it).

---

## CRITICAL findings

**None.** The second consecutive zero-CRITICAL round.

---

## MAJOR findings (should change the spec)

### R7-M1 — the suppressed-outcome seq rule contradicts R6-M1's own "the next cadence tick supersedes" claim: by the letter of the spec, ONE ambiguous ack silently mutes ALL of a commitment's beacon output until commitment close or the 7-day TTL
**§5.0(a) (suppression bullet + sendSeq bullet + send-intent bullet), §10** ·
`[pi-gpt-ext #2; internally confirmed]`

Two normative sentences cannot both be true. The suppression bullet: a repeat of an
unretired logical send "returns a distinct `already-delivered-recently` typed result the
beacon treats as delivered, so it does NOT re-escalate." The seq bullet: `sendSeq` is
"advanced ONLY on a DELIVERED outcome, held constant across `not-delivered`/ambiguous/
**suppressed** outcomes." Walk it: ambiguous outcome at seq 7 → entry recorded for
`cmt-42:7` → the next scheduled tick re-fires logical send 7 → suppressed → the seq bullet
holds the seq at 7 → the tick after that fires 7 again → suppressed → … Every subsequent
beacon send for that commitment shares `logicalSendId = cmt-42:7` and is suppressed
regardless of content (interpolated-text-differs → still suppressed, BY DESIGN), until the
commitment closes or the entry's 7-day TTL expires. Because suppression is
treated-as-delivered, the N-fail dead-letter never arms and no attention item fires — the
mute is SILENT. The R6-M1 bullet's own worst-case claim — "at most ONE suppressed heartbeat
that the next cadence tick supersedes" — is false under this reading: nothing supersedes,
because the seq never advances. An implementer must violate one of the two sentences; the
one who follows the seq bullet ships a beacon that a single lost ack silences for up to a
week (the silent-loss class R2-security-NEW-3 exists to prevent, arrived at from the
opposite direction).

**Fix (one outcome-classification sentence + the §10 shape):** define
`already-delivered-recently` as a DELIVERED-EQUIVALENT outcome for sequencing — the
suppressed fire advances+persists `sendSeq` and journals `send-retire` under the exact
R5-M3 pinned order (seq before retire; the crash window between them is the already-analyzed
TTL-bounded leak). The seq bullet's held-constant list drops "suppressed" (held constant
across `not-delivered`/ambiguous only — which is all its original rationale ever needed:
the ambiguous RE-FIRE must match the guard, and it fires BEFORE the suppression verdict
exists). Then "at most one suppressed heartbeat, superseded by the next cadence tick"
becomes mechanically true. Exactly-once is preserved in both directions: send 7 posted at
most once (the suppression did its job), and the next tick's send 8 is a genuinely new
heartbeat. Add the §10 shape: ambiguous at seq 7 → suppressed re-fire → the NEXT tick posts
(seq 8), asserting the beacon is NOT muted past one cadence.

### R7-M2 — the content-hash fallback lane has NO retirement semantics: a single successful (or ambiguous) send suppresses every same-text send to that conversation for the full 7-day TTL
**§5.0(a) (logical-identity bullet + retirement definition), §6.1 steps 5–6, §10** ·
`[pi-gpt-ext #3; internally confirmed]`

Retirement is defined exclusively in beacon terms: "a delivered outcome advances the send
sequence, or the commitment closes — with a hard TTL backstop of 7 days (safety bound only,
never the suppression mechanism)." But the guard covers EVERY `id<0` funnel send, and
callers with no logical identity fall back to the content-hash as their `logicalSendId` —
with no send sequence to advance and no commitment to close. For that lane the 7-day TTL IS
the suppression mechanism, and the entry is recorded on SUCCESS too ("populated on success
OR on an ambiguous/ack-lost outcome"). Consequence: an attention item, reap notice, or any
templated notice (§6.1 migrates them all onto the funnel) that legitimately repeats the
same text to the same conversation within 7 days is silently swallowed as
`already-delivered-recently` — e.g. the same "session X was shut down — <reason>" notice a
day apart, or a recurring job's identical failure notice. The Telegram analog this guard
mirrors uses a ~15-MINUTE window for exactly this reason. The length-gate exempts only
brief acks; long templated notices are precisely the suppression victims. This is silent
non-delivery of user-facing messages on the flagship funnel — latent since the R3-M1/M2
retirement design (every prior round reviewed the beacon lane and missed that the fallback
lane inherited retirement semantics that cannot apply to it).

**Fix (one lane split):** retirement-based suppression is scoped to callers WITH a logical
send identity (the beacon); the content-hash fallback lane gets a SHORT fixed window
(mirror the Telegram ~15-min exact-duplicate window — the deployed precedent), never the
7-day retirement TTL. State it at the logical-identity bullet ("the fallback is
window-based, not retirement-based — a windowless caller has nothing to retire") and pin
the §10 shape: two identical long-text notices to the same conversation 1 h apart → BOTH
deliver; the same notice re-sent within the short window → suppressed. (R7-M3's composite
boot keying below applies to this lane's entries identically.)

### R7-M3 — the send-intent boot rule keys on `logicalSendId` alone while the guard keys on `(conversationId, logicalSendId)`: cross-conversation supersession for content-hash callers, in both failure directions
**§5.0(a) (send-intent bullet boot rule), §3.4, §10** · `[pi-gpt-ext #1; internally confirmed]`

The dedup key is pinned composite — "(conversationId, logicalSendId)", persisted as
`"<conversationId>|<logicalSendId>"` (§3.4 example), and the send-intent op carries both
fields. But the R6-M1 boot rule reads: "for each **`logicalSendId`**, the highest-`seq`
record wins; an intent that is the LAST word … converts". For beacon sends this is
accidentally harmless (`commitmentId:sendSeq` is globally unique), but for content-hash
fallback callers the same text sent to TWO conversations yields the SAME `logicalSendId`
under two different composite keys — and the boot rule conflates them. Construction:
conversation A's send-intent (crash — genuinely unresolved) precedes conversation B's later
`ambiguous-send`/`send-intent-resolved` for the same content-hash; at boot B's record is
"the last word" for the shared `logicalSendId`, so A's intent is NOT converted → A's
re-fire (notice drains DO retry) is unguarded → the double-post R6-M1 exists to prevent.
The mirror direction falsely converts/suppresses. Live behavior (composite map) and boot
behavior (single-field rule) diverge — the same two-normative-rules-contradict class as
R6-M2, on the machinery R6-M1 just built.

**Fix (four words):** the boot rule quantifies over the COMPOSITE key — "for each
`(conversationId, logicalSendId)` pair, the highest-`seq` record wins" — everywhere the
send-intent resolution is stated (the §5.0(a) bullet, the §10 "an intent superseded by any
later same-`logicalSendId` record" clause becomes same-PAIR). Add the §10 shape: two
conversations sharing a content-hash `logicalSendId`, A's intent unresolved + B's resolved,
reboot → A converts (suppressed re-fire), B does not.

---

## MINOR findings (polish — batch)

1. **Rule 3's fail-closed is vacuous under self-confirmation, and its "two machines can
   never independently pin two different workspaces" claim is false in a concurrent
   first-boot race** `[pi-gpt-ext #4 — classed MAJOR there; reconciled to MINOR: no
   invariant breaks and no silent cross-machine damage is reachable — the spec's OWN
   fleet-wide layer already states the honest posture (absent a config pin, two machines
   authed to different workspaces DO each keep minting locally, R2-security-NEW-2), and the
   §3.1 multi-machine emitter HOLD keeps concrete-workspace entries out of replication
   entirely while no config pin exists, so divergent self-confirmed pins can never merge two
   workspaces' identities; the harm is one over-claiming sentence]`. Internally re-derived:
   with the writer's own observation counting as confirmation, EVERY path that observes a
   concrete teamId proceeds (no-candidate → write+self-confirm; matching candidate →
   confirmed; divergent → the source-2 quarantine + keep-minting-locally) — there is no
   reachable state in which rule 3 refuses a concrete mint, so the rule survives only as the
   trivial "no concrete mint before any concrete observation". Fix: delete/rescope the
   false consequence clause — the guarantee is "no machine adopts a REPLICATED pin without
   local corroboration, and divergence is loud + held out of replication", not mutual
   exclusion of first writers; point the sentence at the fleet-wide layer + emitter hold as
   the actual containment.
2. **"One session generation" is asserted as the token-less migration bound, but nothing
   structurally bounds it** `[pi-gpt-ext #5 — classed MAJOR there; reconciled to MINOR: a
   legacy token-less session keeps TODAY'S pre-spec behavior — an existing, currently-live
   permissiveness closing slower than claimed, not a new hole; minted-id binds are already
   hard-gated fail-closed regardless]`. tmux sessions outlive server restarts by design
   (the exact fact R4-M3 was built on), protected sessions are reaper-exempt, and no
   deadline/attention backstop is named — so a long-lived session's ungated positive-id
   bind window is unbounded in the worst case while the spec claims "one session
   generation, not an open-ended deferral". Fix: one honesty sentence naming the real bound
   (the session reaper's age-cap respawn cycle where it applies) plus a named backstop for
   the exempt tail — e.g. after the increment has been deployed `N` days, a token-less
   positive-id bind still succeeds but raises ONE deduped attention item naming the
   stragglers, so the migration window is observable rather than assumed.
3. **Non-tail journal corruption behavior is unpinned — replay could silently skip an
   unparseable committed record** `[gemini-ext #1; confirmed]`. §3.4 pins the torn TAIL
   (discard) and argues earlier records can't be corrupted by crashes (append-only) — but
   silent disk corruption/bit-rot sits below that argument, and §6.2's corrupt-file
   quarantine covers the snapshot, not a mid-file journal parse failure during replay. A
   faithful implementer choosing "skip and continue" silently loses a committed record (a
   probed mint, a bind-pin, an ambiguous-send entry — each individually load-bearing). Fix:
   pin the fail-closed direction — a newline-terminated line that fails JSON parse during
   replay HALTS the replay into the §3.6 corrupt-file quarantine-aside path + ONE deduped
   attention item, and counts as a "durability incident" for the §3.7 broadened SQLite
   trigger (the honest classification: the WAL's own storage lied).

---

## LOW findings (cosmetic — batch)

1. The §10 bind-pin overlay suite's summary line still labels the coherence branch
   "INCOHERENT-pair **fallback** (shared-predicate-asserted)" — stale against the R6-M4
   flip it defers to (the full §3.5.2 suite paragraph it cites asserts the refusal
   correctly); relabel "incoherent-pair REFUSAL".
2. The §3.5 ingest-refusal aggregation bullet enumerates its refusal classes
   ("seize-refusal, id↔key coherence quarantine, alias episode, workspace-pin conflict,
   HLC-absolute-window quarantine, class-cap quarantine") but predates and omits
   `key-tuple-mismatch` (R6-M2) — the clamp text already routes it through the aggregator,
   so behavior is unambiguous; add it to the enumeration so the list stays the complete
   inventory it reads as.

---

## Convergence recommendation

**NOT CONVERGED.**

Blocking: 3 MAJORs, all on §5.0(a)'s E1 machinery, each with a small localized fix — the
delivered-equivalent suppression outcome that unmutes the beacon (R7-M1); the short-window
lane split for content-hash callers (R7-M2); and the composite-key boot rule (R7-M3). Zero
CRITICAL for the second consecutive round; and for the first time in this ceremony the
registry core — the merge algebra, ingest normalization, boot/restore composition, binding
overlay, workspace-pin machinery — took no MAJOR at all: every blocker sits in the delivery
idempotency guard, and two of the three are seams of the round-7 R6-M1 fix itself (the
convergence process digesting its own repairs), while the third (R7-M2) is the last latent
lane of the R3-era retirement design.

What is genuinely settled and should NOT be re-litigated next round: all 13 round-6
resolutions verified present and — for R6-M1, R6-M3, and R6-minor-5 — re-executed (the
send-intent crash walk, the boot-composition walk, and the CONFIRMED transition walk); the
R6-M2 tuple-authority ingest pin including its version-skew behavior; the R6-M4 refusal
direction; the assignment algebra + boot fixpoint; the windowed-cap DoS bound; the
`≺` representative; the stateless bind token; `## Open questions` remains verifiably empty;
and the two round-6 reconciled non-findings (the `boundTuple` hash-proximity construction;
the dangling-bind-pin reassignment) plus round 7's two reconciliations at MINOR-1/MINOR-2 —
re-raising any of these without a new authority delta should be treated as settled.

Recommended next step: a Phase-2f revision addressing the three MAJORs (+ the three MINORs
and two LOWs — all pin-level edits to §5.0(a)/§3.1/§7/§3.4/§3.5/§10), then Round 8. Trend
note: 4C+16M → 1C+3M → 1C+4M → 0C+4M → 0C+3M on a stable two-external reviewer set; the
finding surface has collapsed from the whole design to one subsection of one section, and
every remaining blocker has a one-sentence-to-one-bullet fix with no architecture change.

**Verdict: NOT CONVERGED** (0 CRITICAL + 3 MAJOR remaining; converged requires zero MAJOR).
