# Round-5 convergence findings — slack-outbound-robustness

**Spec reviewed:** `docs/specs/slack-outbound-robustness.md` @ commit `eb494871e`
(round-5 revision).
**Report commit:** this file.
**Round-5 status: NOT CONVERGED.** 1 CRITICAL + 1 MAJOR + 3 MINOR + 1 LOW.

Round 5 re-executed the round-4 fold walks and put highest scrutiny on the
round-5 additions (the `notice_pending` mechanism above all). All round-4
folds landed as INTENT — but the round's two blockers are both seams in or
around the newest material: the hold-RELEASE path composes with the boot
purge into a fresh loss window for the flagship dark-rollout flip (pi's
catch), and the `notice_pending` mechanism is mechanically under-specified
against the deployed selector (BOTH externals independently; the internal
panel had flagged the same gap pre-externals). The prior cores (funnel hop,
HOLD disposition, partition order, pre-POST mint) drew zero new findings.

---

## Fold verification (round-4 findings, walks re-executed)

| Round-4 finding | Fold | Walk re-executed | Verdict |
|---|---|---|---|
| R4-M1 (notice durability) | `notice_pending` + retry + re-raise | transient hiccup → later-tick re-raise ✓ INTENT; crash-between-stamp-and-raise → closed by same-transition stamp ✓; **but the mechanism's storage and scan path do not exist as specified** (no column in the §2.2 enumeration; the deployed selector excludes terminal rows) → R5-M1 | **HELD as intent, NOT implementable as written** |
| R4-m1 (purge-proof scoping) | once-CLASSIFIED scope + never-classified decision | scope internally consistent with the purge predicate ✓ — but the RELEASE path un-classifies a row (`hold_reason` → NULL) with its `attempted_at` still the original enqueue time → R5-C1 | **HELD as written; the release seam is new** |
| R4-m2 (atomicity + repair) | atomic set + repair-at-observation | atomic set ✓; the repair DIRECTION is unsound (resets the retention clock — gemini) → R5-m2 | **HELD, one direction fix** |
| R4-m3/m4 (test pins) | folded | — | **HELD** |
| R4-L1..L3 | folded | ISO pin ✓; 25h ledger pin ✓ in §2.4 (but §8 still says 24h — R5-L1); residual count ✓ | **HELD (one stale cross-ref)** |

**Spot-regressions:** R3-C1 lane-flip (25h ledger strictly widens the net) —
HELD; R3-C2 release predicates (all seven reasons re-traced) — HELD; R2
stampede partition / purge exemptions / teamId compare — HELD. The
offline-teamId rejection rationale remains consistent with the keystone
posture (the §2.1 compare stays a key-level corruption tripwire, never
identity authority).

**Code grounding this round:** `slack-reply.sh:96` (the initial curl has NO
`--max-time` — supports R5-m3's unbounded-gap premise);
`selectClaimable` state predicate re-confirmed (`queued`/`claimed` only —
load-bearing for R5-M1); the §5/§7 release semantics re-read against the
purge predicate (load-bearing for R5-C1).

---

## Reviewers who ran this round

**Internal pass** (six lenses + fold re-walks + grounding): independently
flagged the `notice_pending` storage/sweep gap BEFORE the externals ran
(merged into R5-M1); walked the crash-window shapes on the re-raise
(crash-before-raise closed; crash-after-accept identified — merged into
R5-M1's honesty arm).

**External cross-model passes (one bounded pass each, neutral grounding
pack):**
- **pi / openai-codex provider, `--model openai-codex/gpt-5.5`,
  `--no-session --no-tools -p`, spec inlined** — RAN (exit 0). Verdict:
  `2 CRITICAL + 2 MAJOR + 1 MINOR`. Its #2 (release-then-restart purge
  window) is the round's decisive catch — adopted as R5-C1 after internal
  verification widened the walk (no crash needed: any restart during a
  post-flip drain window purges the not-yet-drained backlog). Its #1 + #3
  merge into R5-M1; its #4 (TTL anchor gap) is downgraded to R5-m3 with a
  construction-level fix; its #5 (stale 24h line) is R5-L1.
- **gemini-cli, `-o json -m gemini-2.5-pro` (serving model confirmed),
  prompt on stdin** — RAN (exit 0). Verdict: `2 CRITICAL + 1 MAJOR +
  1 MINOR`. Its #2 (notice_pending non-functional against the deployed
  selector) independently confirms R5-M1 — the round's strongest overlap
  (both externals + internal). Its #4 (exactly-one overclaim) merges into
  R5-M1's honesty arm. Its #3 (repair direction) is adopted as R5-m2
  (downgraded: corruption-path premise, one-line direction fix). Its #1
  (never-classified boot purge "contradicts AT LEAST once") is DOWNGRADED
  to R5-m1: the walk is the deployed-Telegram staleness judgment, stated
  deliberately with rationale + residual in round 5 (R4-m1), every drop is
  LOUD (P18), and the Telegram lane is byte-identical by standing
  constraint — the actionable defect is that §0 property 1's at-least-once
  arm names NO carve-outs while three loud designed drop paths exist (an
  under-qualified summary whose qualifications live in properties 2-5, not
  an actively wrong description — distinct from the M5 precedent).
- **codex-cli** — NOT RUN: not installed on this machine (all rounds).

---

## CRITICAL findings (blocking)

1. **Releasing a hold un-classifies the row while its staleness anchor stays
   the ORIGINAL enqueue time — a restart during the post-release drain
   window purges the backlog the hold architecture spent three rounds
   protecting** `[pi-ext #2; internal verification widened the walk]`.
   On release the partition clears `hold_reason` (+ anchor) and the row
   enters normal flow — but `attempted_at` is immutable (TTL + audit
   anchor), so a released soak/dark-lane row is >60 min old BY CONSTRUCTION
   and indistinguishable from a "genuinely stale" row to the boot purge
   (live channel + `hold_reason IS NULL` + `attempted_at < cutoff`). Walks:
   (a) flip the lane live after a soak → the partition releases N rows →
   the rate-capped drain (maxConcurrent 4, per-topic 30s) takes ticks to
   clear them → an auto-update restart lands mid-drain → EVERY
   not-yet-drained released row is purged loudly at boot — the C2-class
   outcome, now via the release seam; (b) a `non-owning` hold heals at hour
   2 → release → crash before the delivery attempt → boot purge eats a
   within-TTL message. The "once CLASSIFIED, purge-proof" sentence (R4-m1)
   is violated at the moment of release. **Fix:** release must leave a
   durable breadcrumb the purge respects — a sixth additive column
   `released_at TEXT` (set on every hold release; NULL otherwise); the
   purge staleness base for a previously-held row becomes
   `max(attempted_at, released_at)` — a released backlog earns a fresh
   60-min drain window (ample for the rate-capped drain: 100-row LIMIT, 4
   per tick, event kicks), while the 24h TTL stays anchored on
   `attempted_at` (the §5 held-past-TTL decision is unchanged — release
   does not extend deliverability, only purge grace). §7 gains the
   flip-mid-drain-restart shape (released rows not yet drained survive the
   boot purge and finish draining) and the heal-crash shape.

## MAJOR findings (blocking)

1. **The `notice_pending` mechanism is under-specified to the point of
   non-function, and its "exactly ONE item" overclaims** `[pi-ext #1+#3 +
   gemini-ext #2+#4 + internal — the round's strongest overlap; both
   externals rated arms of this CRITICAL]`. Four arms, one fix: (a) the
   §2.2 schema enumeration adds NO `notice_pending` storage — the marker
   has nowhere durable to live (a spec-internal contradiction with §2.3);
   (b) the deployed drain selects `queued`/`claimed` only — a terminal
   `escalated` row is NEVER seen by "a later partition tick", so the
   re-raise cannot run as written; (c) "dedup key = the conversation"
   UNDER-keys — a second unreachable episode on the same conversation
   (a NEW row dying later) would be suppressed by a stale key, and the
   accepted-record rule (when does the marker clear?) is unstated; (d)
   crash-after-accept-before-clear duplicates the notice, so "exactly ONE
   item" is an overclaim (the same accepted-residual class as property
   1(b)). Severity consolidated to MAJOR (both externals said CRITICAL):
   no MESSAGE is at risk — the row is already terminal, the P18 ledger +
   §4.1 status record it — and the R4-M1 precedent graded this exact
   property (notice integrity) MAJOR. **Fix:** (a) seventh additive column
   `notice_pending INTEGER NOT NULL DEFAULT 0` (in the §2.2 enumeration);
   (b) a dedicated bounded selector (`state='escalated' AND
   notice_pending=1`, LIMIT-bounded, indexed by the existing state index)
   run once per tick beside the claimable drain; (c) the attention item id
   is STABLE PER EPISODE — derived from `(conversation, delivery_id)` — so
   a re-raise no-ops against the accepted item while a DISTINCT later
   episode raises fresh; the marker clears ONLY on a 2xx from the attention
   surface, in its own transition; (d) property text corrected: "never
   zero; at most one duplicate per crash-between-accept-and-clear window"
   (named residual, mirroring property 1(b)). §7 shapes updated to assert
   the terminal-sweep path and the distinct-episode key.

## MINOR findings (batch)

1. **§0 property 1's at-least-once arm names no carve-outs** `[gemini-ext
   #1, downgraded — reasoning in the reviewers section]`. Three loud
   designed drop paths bound the at-least-once claim (the boot staleness
   purge for never-classified/released-stale rows, stampede consolidation,
   TTL/long-stop escalation) — all P18-loud, all stated elsewhere
   (properties 2-5, §3, §5), none referenced from the summary sentence.
   Add the one-sentence qualification so property 1 is self-honest.
2. **The NULL-anchor repair direction is unsound** `[gemini-ext #3,
   downgraded]`. Repair-at-observation RESETS the retention clock — a
   corrupt 6-day-held row earns a fresh 7 days (repeatably, under recurring
   corruption). Fix the direction: the fallback anchor is `attempted_at`
   (never LATER than the truth — conservative, escalates early and loud); a
   row observed with a NULL anchor TWICE despite repair escalates
   immediately as unresolvable corruption.
3. **The 25h-vs-24h ledger margin silently assumes enqueue-time ≈
   send-time** `[pi-ext #4, downgraded]`. `attempted_at` is written at
   ENQUEUE (after the failed POST); an unbounded gap (the initial curl has
   NO `--max-time` — `slack-reply.sh:96`; a laptop sleeping mid-script is
   the realistic shape) lets the row's 24h TTL outrun the ledger's 25h.
   Construction-level fix: the script sets the enqueue's `attempted_at` to
   the PRE-POST MINT timestamp (it has it — round-4's own change),
   re-anchoring both clocks at the send instant; additionally pin
   `--max-time` on the reply curl (both scripts, same refresh).

## LOW findings (batch)

1. **§8 decision 4 still says "24h TTL" for the id-ledger** `[pi-ext #5]` —
   stale against the round-5 25h pin in §2.4. One-word fix.

---

## Convergence recommendation

**NOT CONVERGED.** 1 CRITICAL + 1 MAJOR block.

Trajectory: 3C+6M → 2C+3M → 2C+2M → 0C+1M → 1C+1M. The count ticked up but
the findings keep narrowing: R5-C1 is the last unprotected seam in the
hold lifecycle (set and re-evaluate were pinned in rounds 3-4; RELEASE was
not), and R5-M1 is the mechanical completion of round-5's own headline
mechanism. Neither touches the cores, which drew zero findings for the
third consecutive round. Both fixes are additive-column + selector + wording
work — the same shape as every fold since round 3.

**Verdict: NOT CONVERGED** (1 CRITICAL + 1 MAJOR + 3 MINOR + 1 LOW).
