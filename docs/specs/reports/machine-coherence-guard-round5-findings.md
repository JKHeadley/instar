# Round 5 Findings — machine-coherence-guard

Reviewed: `docs/specs/machine-coherence-guard.md` (round-5 revision, commit
eb023c22b, worktree branch `echo/machine-coherence-guard` at v1.3.728).
Round-5 charter: RE-EXECUTE the R4-M1 dead-adapter walk and the R4-M2
mid-verify-suspension walk against the round-5 text; verify all 17 round-4
folds; SPOT-REGRESS every previously-failed walk (R3-M1..M6).

Panel: 6 internal lenses (security, scalability, adversarial, integration,
decision-completeness, lessons-aware) + 2 externals (`gpt-5.5` via the `pi`
CLI's openai-codex provider — codex CLI not installed, noted honestly, same
as rounds 1–4; `gemini-2.5-pro` via the gemini CLI — clean single-shot) +
the Standards-Conformance Gate.

Standards-Conformance Gate: **ran (0 flags)** — 51 standards, zero findings;
fit verdict: **fit**.

External verdicts: pi/gpt-5.5 **NOT-CONVERGED (0 CRITICAL, 1 MAJOR)** — it
fails the R4-M2 fold on the §4.2.1(i)↔(iv) offline-hold contradiction;
gemini-2.5-pro **CONVERGED (0/0/0/0)**, all 17 folds + all 6 regressions OK.
Notable and recorded: for the FIRST time in the ceremony an external's
material finding was independently reproduced by the internal walk
re-execution (the adversarial lens surfaced the identical contradiction,
same sections, same fix direction) — the external door caught a real
mechanism defect this round, not just prose intent.

**VERDICT: NOT CONVERGED — 0 CRITICAL, 1 MAJOR, 3 MINOR, 7 LOW.**
(Trajectory: 3C+12M → 0C+3M → 0C+6M → 0C+2M → 0C+1M. 16 of 17 round-4
folds held under walk re-execution — the dead-adapter walk (R4-M1) verified
closed by adversarial + both externals, and the R4-M2 core walks
(executing-verifying × suspension → clocks pause; approved-holding ×
suspension → invalidated with named note) verified consistent across
§4.2.1(i)/(v)/§4.3 by decision-completeness, adversarial, and gemini. ALL
SIX previously-failed walks (R3-M1..M6) stay OK on spot-regression. The one
MAJOR is a round-5 CHURN REGRESSION in the classic pattern: the fold updated
(i) and (v) but left ONE legacy paragraph in (iv) un-reconciled.)

## Fold verification (17 walks re-executed)

| Round-4 finding | Verdict | Notes |
|---|---|---|
| R4-M1 (marker keys on item-RAISED) | FOLD-OK (adversarial dead-adapter walk: failed raise → no `itemRaisedAt` → no marker → fallback fires; success/dark-guard/reconciliation interplay all consistent; security: no new attack surface; pi, gemini) | stamp-crash self-heal needs one pin (→ R5-N1) |
| R4-M2 (three-state pendingFix) | **FOLD-FAIL** (pi; adversarial found the same seam during its cross-check walk; DC graded the label half MINOR; gemini/lessons/security passed it) | the CORE walks hold — the failure is the un-reconciled §4.2.1(iv) legacy paragraph (→ R5-M1) |
| R4-N1..N7 | FOLD-OK (7/7) | assigned lenses + both externals |
| R4-L1..L8 | FOLD-OK (8/8; R4-L3's decline judged DECLINE-HONEST by lessons) | integration verified the §11 dedup + the :21323 cite + both restart-primitive citations in source (`restartServer` self-bootout confirmed at server.ts:21630-21641; `writeLifelineRestartSignal` at version-skew.ts:82) |

Spot-regression: R3-M1 build-it-now OK · R3-M2 3-machine walk OK · R3-M3
blind-side OK · R3-M4 truncation OK · R3-M5 append arithmetic OK (recounted:
7 appends per 6 h window worst-case, then flat) · R3-M6 dueling walk OK
(post-reconciliation 1 write + 1 restart; blind-side no-conflict +
no-redundant-restart) — pi flagged R3-M6's held-offline EDGE as regressed,
which the panel folds into R5-M1 (same root).

## CRITICAL

*(none)*

## MAJOR

**R5-M1 — §4.2.1(iv)'s legacy offline-hold paragraph contradicts the R4-M2
rule in §4.2.1(i), leaving the held-fix offline disposition ambiguous
between re-approve and auto-apply — and the held-case verify window is not
suspension-aware.** (pi MAJOR — R4-M2 FOLD-FAIL; adversarial R5-1 MAJOR —
independently, same sections, same fix; decision-completeness F1 MINOR is
the label half of the same seam; 3/8 reviewers, externally+internally
reproduced) §4.2.1(i)/(iv)/(v). The round-5 fold added the three-state rule
to (i) — approved-holding + suspension (an offline divergent machine IS a
suspension trigger) → INVALIDATED with the named "paused — I'll re-propose
when it returns" note (operator must re-approve) — but left (iv)'s tail
paragraph un-updated: "When the divergent machine is offline/asleep the
same HOLD applies … it applies when that machine returns" (auto-apply, no
re-approval). Two both-plausible, materially different operator semantics
on the sole actuation path. Compounding: (v)'s clock-pause is scoped to
executing-verifying, so the held case's `2 × fixVerifyTicks` window is NOT
suspension-aware — a nightly-sleeping held-fix machine could trip the (v)
false-failure append R4-M2 exists to prevent, unless (i)'s invalidation
preempts it, and precedence is unstated. DC's adjacent F1: the (i)
AH-invalidate and (v) EV-pause bounds share the "2 × fixVerifyTicks" label —
a builder attributing (v)'s pause to the held bound would auto-execute a
stale approval after an arbitrary sleep. Fix direction (panel-agreed,
2-3 sentences): reconcile (iv) to (i) — delete "it applies when that
machine returns"; the offline/asleep divergent case follows the SAME
suspension rule (approved-holding invalidated with the named note;
re-proposed fresh on return, fresh approval required — honest, since the
pool state may have changed); scope (v)'s pause explicitly to the
executing-verifying/mechanized case and state the held AH bound is governed
by (i)'s invalidate-and-re-propose, never (v)'s pause.

## MINOR

**R5-N1 — The `itemRaisedAt` stamp needs the idempotent re-stamp pin: a
crash between raise-success and the stamp write (or a transiently failed
raise) must self-heal.** (decision-completeness F3 — graded material;
adversarial R5-2 LOW; lessons L3 — same root, deduped) §3.2/§3.4/§4.1. A
one-shot-raise implementation leaves the item permanently marker-less →
the fallback duplicate never reconciles (two permanent items — a property
(b) breach beyond the bounded residual). Pin: the raiser re-attempts
`createAttentionItem` each tick while it owns a confirmed-skew episode with
`itemRaisedAt` unset — the chokepoint is idempotent (no-op success when the
item exists), and the stamp is (re)written on ANY success return including
an idempotent re-raise; the §3.4 fallback owns the never-succeeds terminal
case, the idempotent re-attempt owns transient self-heal.

**R5-N2 — §4.2.1(i)'s "the two NOT-YET-EXECUTED states only" reads as if an
executing-verifying pendingFix SURVIVES supersession and re-baseline.**
(decision-completeness F2) §4.2.1(i) vs §3.4/§4.6. The disposal is real
(§3.4's non-survivor invalidates ANY pendingFix; §4.6's re-baseline carries
none) but (i)'s "only" invites orphaning an EV pendingFix on a closed
episode. Pin: EV pendingFixes are DISPOSED on episode close (including
`superseded-by-takeover`) and §4.6 re-baseline; the suspension exemption
exists specifically because suspension keeps the episode OPEN. Plus DC F5:
one sentence pinning EV as reachable ONLY in the mechanized
(divergent==raiser) case.

**R5-N3 — The round-5 L2 sentence overclaims "the one free-text field …
is the NICKNAME": `instarVersion`, `manifestHash`, and flag effective
values are also peer-influenced strings rendered in the technical block
with length-only clamps.** (security R5-1 — graded LOW by the lens; panel
raises to MINOR as an exposure-invariant accuracy defect introduced by the
round-5 edit itself) §4.2/§3.2. Fix: format-clamp on receive
(`instarVersion` → version alphabet, `manifestHash` → hex, flag values →
the §3.1 enum/clamped-scalar alphabet) OR extend the R4-L1
escape-at-boundary + inherited-trust sentence to name these siblings.

## LOW

**R5-L1 — The held-case outer bound's suspended-time exclusion needs a
durable anchor statement** (scalability R5-1): a restart during an active
suspension of a verifying fix has unstated outer-bound behavior; one
sentence — the anchor is durable and suspended-time exclusion is
re-derived from the durable `suspended` state / advert-driven resume.
(Folds naturally into the R5-M1 rewrite.)

**R5-L2 — The latch-exit durable write should state it RECONCILES
`suspended` (and bookkeeping) to live-derived state** (decision-completeness
F4 + lessons L2 — deduped) §4.5/§6; plus one clause that
`openEpisode.suspended` on the status route reflects the live evaluator
view, not the intentionally-stale durable field.

**R5-L3 — Dark-guard × owner-loss takeover leaves a bounded, unnamed
duplicate** (adversarial R5-3): a dark machine's retained item cannot run
reconciliation until re-enable, so its item + the takeover item coexist for
the disable's duration. Name it in §4.6 (converges on re-enable) or
suppress owner-loss takeover while the lost owner still advertises a
covering marker.

**R5-L4 — The approve-line's `<flag>` = `<value>` equals-join reads
technical now that `<flag>` is a plain-language phrase** (lessons L1):
render as prose ("I'll turn on <feature> on <nickname>").

**R5-L5 — The whole-advert clamp rejection at §3.2 says "an error counter"
without naming it** (integration INFO): say `clampRejections` there too.

**R5-L6 — Raise-retry ownership is implicit** (adversarial R5-4 — subsumed
by R5-N1's pin; counted here for the lens record).

**R5-L7 — Reserved-slot second-suspension semantics** (decision-completeness
F6 — judged adequately determined; recorded, no fix owed).

## Panel notes (recorded honestly)

- pi's MAJOR and the adversarial lens's MAJOR are the SAME finding, found
  independently (external prose-read vs internal walk re-execution) — the
  first two-door material overlap of the ceremony. DC's F1 is the label
  half of the same seam (graded MINOR because (v)'s heading scopes the
  pause); the panel grades the deduped family MAJOR: an unresolved
  precedence ambiguity between auto-apply and re-approve on the sole
  actuation path is a spec change, and two reviewers independently rated
  it blocking.
- gemini passed all 17 folds + 6 regressions clean; its R4-M2 FOLD-OK read
  (i)/(v)/§4.3 — the three sections the round-4 fix named — and did not
  sweep (iv)'s tail. Consistent with the standing pattern: externals verify
  the asked-for fold; walk re-execution (and this round, pi's full-text
  read) catches the un-asked-for seam.
- All six previously-failed walks stayed OK — no regression in any
  previously-folded mechanism. The finding surface has narrowed to ONE
  un-updated legacy paragraph + labeling/pin seams.

## What held (credit where due)

The dead-adapter walk closes cleanly end-to-end (failed raise → no stamp →
no marker → deterministic step-up through a live adapter; dark-guard
retained-marker preserved; reconciliation holder-definition consistent);
the R4-M2 CORE walks hold across (i)/(v)/§4.3; every round-5 citation
grounds exactly (restartServer's self-bootout confirmed in source at
:21641; writeLifelineRestartSignal at :82; the :21323 cite; §11 fully
deduplicated); the R4-L3 decline judged honest; the shared append budget's
worst case recounted at 7 appends/6 h; the eli16 companion accurate at
11.8k chars; and the detection architecture, manifest/advert design, §5b,
election, and close-reason taxonomy have drawn zero objections for five
consecutive rounds.

## Verdict

**NOT CONVERGED.** Round 5 closes with 0 CRITICAL, 1 MAJOR, 3 MINOR, 7 LOW
across 6 internal lenses + 2 externals + the conformance gate (0 flags).
16/17 round-4 folds held; both round-4 MAJORs' mechanisms verified closed
under walk re-execution; all six historical failed walks stayed closed. The
single blocker is a churn regression with a panel-agreed 2-3 sentence fix:
§4.2.1(iv)'s legacy offline-hold paragraph must be reconciled to the (i)
suspension-invalidation rule, with (v)'s pause explicitly scoped to the
executing case. Round 6 folds R5-M1 + R5-N1..N3 (+ LOWs where genuine) and
re-executes the held-offline walk plus the R4-M1/M2 walks for regression.
