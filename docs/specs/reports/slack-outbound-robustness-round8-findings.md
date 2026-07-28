# Round-8 convergence findings — slack-outbound-robustness

**Spec reviewed:** `docs/specs/slack-outbound-robustness.md` @ commit `a244f7825`
(round-8 revision — pure precision edits, zero new mechanisms).
**Report commit:** this file.
**Round-8 status: NOT CONVERGED.** 0 CRITICAL + 1 MAJOR + 0 MINOR + 2 LOW.
**Protocol outcome: STOP — no round-9 fold.** A MAJOR landed INSIDE the pure
precision edits, exactly the condition the round-7 findings named as the
STOP trigger. Per that protocol this report does NOT fold a round-9 revision;
it commits the findings, delivers the plateau analysis (below), and
recommends.

---

## The blocking finding

**MAJOR — the reservation's new `409 delivery-in-flight` status (and the
in-reservation adapter-timeout outcome) do NOT compose with the DEPLOYED
recovery-policy / script classifiers; only ONE of the delivery paths handles
them, and the clean fix contradicts the spec-wide "recovery-policy stays
byte-untouched" invariant** `[gemini-ext #1 (rated CRITICAL) + pi-ext #1
(MAJOR) + internal grounding — independent three-way overlap]`.

The round-6/7 reservation returns a NEW HTTP status (`409
delivery-in-flight`) and a NEW ambiguous outcome (the in-reservation adapter
timeout). Round-8 pinned `409 → transient retry` in ONE place only: the §2.3
Slack **funnel typed-result mapping table**. But §2.4 states the reservation
is "shared by `/telegram/reply` AND `/slack/reply`", and the other delivery
paths classify differently. Grounded against deployed code:

- **Arm A — Telegram redrive lane (`evaluatePolicy`, no mapping table).**
  The Telegram sentinel redrive (`defaultPostReply` → `/telegram/reply`)
  feeds the raw HTTP status to `evaluatePolicy`, which classifies every
  unlisted 4xx via `if (httpCode >= 400 && httpCode < 500) → escalate`
  (`recovery-policy.ts:189`; 409 has NO special case — verified). Walk:
  `telegram-reply.sh` now pre-mints an id + uses `--max-time`; the initial
  POST leaves a live in-flight reservation while the client sees a
  conn-reset (recoverable) and enqueues the same id; the event kick redrives
  → `/telegram/reply` returns `409 delivery-in-flight` → `evaluatePolicy` →
  **`escalate` (TERMINAL)** → a routine transient race terminalizes a
  deliverable Telegram message and fires a spurious operator escalation.
  This is a REGRESSION on the lane the spec swears is byte-identical
  (property 7; "Telegram rows keep `defaultPostReply` byte-identically").
- **Arm B — the in-reservation adapter-timeout HTTP surface is unstated →
  deployed 500 → retry → double-post.** §2.4 pins the handler's INTERNAL
  treatment ("treats its OWN outcome as AMBIGUOUS: it must NOT record the
  id and must NOT claim success") but NOT the HTTP status it RESPONDS. The
  deployed `/slack/reply` catch-all is `res.status(500).json({error})`
  (`routes.ts:12250`) — and 500 classifies as transient retry on BOTH lanes.
  Walk: the in-reservation adapter call times out at 30s (Slack MAY have
  posted); the handler responds the deployed-default 500 without recording
  the id; the caller retries; if Slack posted, the retry double-posts — an
  exactly-once (property 1) violation. The correct surface is 408 (→
  `finalize-ambiguous`, never re-posted), but the fold never pins it.
- **Arm C (gemini, defensive) — the script initial-send classifiers don't
  recognize 409 either.** `slack-reply.sh`/`telegram-reply.sh` treat a
  non-specific 4xx as terminal exit-1-without-enqueue; a script that
  received a 409 would LOSE the message. (Real-but-rare: the initial send
  CREATES its id's reservation, and fresh-UUID + idempotent enqueue largely
  preclude a script receiving its own id's 409 — so this arm is the
  pathological same-id-concurrent case, not the live path. Named because the
  build fix must cover all callers of a SHARED status, not just the funnel.)

**The invariant contradiction (the sharpest part).** The clean fix for Arm A
is `recovery-policy.ts` learning `409 delivery-in-flight → retry`. But the
spec asserts, repeatedly and load-bearingly, that recovery-policy stays
**byte-untouched** — in the `supervision` frontmatter, in §2.0, in §2.3 ("the
pure `evaluatePolicy` stays byte-untouched"), in property 2 ("reused
BYTE-UNCHANGED"). The round-6/7 reservation silently created a requirement
that breaks that invariant. This is not a pin — it is a genuine design
decision (amend recovery-policy with a 409 branch, OR route the Telegram
lane through a translation shim before `evaluatePolicy`) that must be made
and TESTED, not asserted away.

**Severity call:** graded MAJOR (consolidated). gemini rated it CRITICAL on
the Arm-C message-loss framing; the LIVE path (Arm A) preserves the message
as a loud `escalated` row with an operator notice — "lost loudly rather than
retried" (pi), a regression + spurious-escalation, not silent loss — and
Arm C's true-loss variant is the rare same-id-concurrent case. MAJOR is the
honest consolidation. It triggers the STOP protocol regardless of the
C-vs-M line.

## LOW findings (stale cross-references I introduced in round 8; not folded)

1. **§8 decision 14 still says "a client-side curl timeout is classified
   AMBIGUOUS (408 parity)"** `[pi-ext #2]` — contradicts the round-8
   phase-aware split in §2.6 (empty/zero `time_connect` → recoverable). A
   stale summary line from my own round-8 edit.
2. **§2.3 still says the terminal sweep selector is "fully served by the
   existing `(state, next_attempt_at)` index"** `[pi-ext #3]` — contradicts
   the new partial `idx_notice_pending` index added in §2.2 the same round.

(Both are zero-risk documentation-consistency corrections of my own round-8
transcription; per the STOP protocol they are recorded, not folded into a
round 9. They fold trivially in the build-phase precision pass alongside the
MAJOR.)

---

## Reviewers who ran this round

**Internal pass** (six lenses + grounding): grounded the Arm-A/Arm-B seams
against deployed code BEFORE the externals returned (`recovery-policy.ts:189`
409→escalate; `routes.ts:12250` 500 catch-all; the reservation's "shared by
both routes" scope). All standing walks spot-regressed HELD.

**External cross-model passes (neutral grounding pack; the pack included the
verified deployed fact that `evaluatePolicy` escalates unlisted 4xx and that
the reservation is shared by both routes):**
- **pi / openai-codex, `gpt-5.5`, `--no-session --no-tools -p`** — RAN
  (exit 0). `0C + 1M + 0m + 2L`. Its #1 IS the blocking MAJOR (Arm A). Its
  #2/#3 are the two LOWs.
- **gemini-cli, `gemini-2.5-pro` (stats-confirmed)** — RAN (exit 0).
  `1C + 0M`. Its sole finding is the SAME reservation-409 seam, widened to
  all four paths (Arms A + C) and rated CRITICAL.
- **codex-cli** — NOT RUN (absent on this machine, all rounds).

The two externals + the internal grounding converged INDEPENDENTLY on one
root cause — the strongest single-finding consensus of the ceremony, and
notably a root the round-7 review (which scrutinized the reservation) missed
because the 409's cross-lane classification only becomes visible when you
trace it through the DEPLOYED `evaluatePolicy` rather than the spec's own
mapping table.

---

## Plateau analysis (the round-7 STOP-trigger deliverable)

**Trajectory of BLOCKING findings:** R1 3C+6M → R2 2C+3M → R3 2C+2M → R4
0C+1M → R5 1C+1M → R6 1C+1M → R7 0C+2M → **R8 0C+1M**. Severity has been
flat-low for five rounds (never above 2 blockers since R4), and CRITICALs
appear only sporadically and twice now have collapsed under grounding (R7
pi-CRITICAL refuted; R8 gemini-CRITICAL consolidated to MAJOR).

**Settled material (finding-free, re-walked every round):**
- The funnel-hop delivery authority (M1) — finding-free rounds 4-8 (5).
- The HOLD-as-durable-disposition + partition order (C1/C2, R2-R4) —
  finding-free rounds 5-8 (4).
- The hold lifecycle set→re-evaluate→release + `released_at`/`hold_started_at`
  — finding-free rounds 6-8 (3).
- The pre-POST delivery-id mint — finding-free rounds 5-8 (4).
- teamId coherence, dryRun shape, restore-purge scoping, E1 characterization,
  the never-classified staleness decision — all finding-free ≥3 rounds.

**Churning material (where every blocker since R4 has lived):** EXCLUSIVELY
the immediately-previous fold's newest MECHANICAL delta. R4-M1 was inside the
R3-m5 bypass; R5-C1/M1 inside the R4 hold-release + notice folds; R6-C1/M1
inside the R5 pre-POST/notice mechanics; R7-M1/M2 inside the R6 reservation;
**R8-M1 inside the R6/R7 reservation's HTTP-status composition.** The pattern
is exact and unbroken: **the architecture is settled; each new mechanical
part draws exactly one round of precision findings against the DEPLOYED
classifiers it must compose with, then settles.**

**Pin-class-risk characterization.** The remaining finding CLASS is now
uniform and narrow: *a newly-introduced HTTP status / timeout-ordering /
classification must compose correctly with the DEPLOYED recovery-policy
table, the two script classifiers, and both redrive lanes.* Every such
finding is:
- **Deterministic** — a fixed status maps to a fixed policy branch; there is
  a single correct answer, not a judgment call.
- **Enumerable** — finite (statuses × `evaluatePolicy` branches × 2 lanes ×
  the script classifiers); the whole space is a truth table.
- **Exactly what §7's Tier-1 + Tier-2 suite exercises** — the recovery-policy
  exhaustive table tests, the `/slack/reply` + `/telegram/reply` integration
  tests against the REAL `AgentServer` middleware stack ("middleware honesty"
  clause), and the full-pipeline enqueue→redrive tests. A status-composition
  gap like R8-M1 surfaces there as a FAILING TEST — concretely, at the seam
  where the deployed code actually runs — not as prose an abstract reviewer
  must foresee.

**Structural vs narrowing:** BOTH, and the distinction is the recommendation.
The architecture has genuinely converged (5 rounds of settled cores). What
has NOT converged, and structurally will not converge in prose review, is the
last mile of composing each new mechanical status against deployed
classifiers — because prose review keeps discovering these one fold behind,
and each fold to fix one introduces the next status to compose. This is the
signature of a spec that has reached the resolution limit of DOCUMENT review
and needs EXECUTION (a running test against the real recovery-policy) to
close the remaining pin-class risk.

---

## Recommendation

**Accept the remaining pin-class risk into the build phase; do not continue
prose rounds.** Concretely:

1. **The architecture is converged and safe to build against.** All
   load-bearing structural decisions (funnel authority, HOLD disposition,
   pre-POST mint, notice durability, per-channel breaker, fail directions)
   have survived 4-8 adversarial re-walk rounds unchanged. The spec is a
   sound build contract.
2. **The ONE substantive open item (R8-M1) is a design decision best made in
   code:** recovery-policy must classify structured `409 delivery-in-flight`
   → retry on BOTH lanes (or the Telegram lane routes through a translation
   shim), the adapter-timeout handler must respond **408** (not the default
   500), and both script classifiers must treat 409 as non-losing. This
   reconciles the "recovery-policy byte-untouched" claim honestly (it gains
   ONE 409 branch — a named, tested exception, not a silent one). Each arm is
   a truth-table entry with a §7 test already specified in shape.
3. **The build increment's §7 gates ARE the enforcement surface** the
   plateau needs: the Testing Integrity Standard mandates the recovery-policy
   table tests + the real-middleware route tests + the full-pipeline redrive
   tests, and the Zero-Failure Standard makes any residual status-composition
   gap a red suite, not a shipped defect. This is strictly STRONGER
   enforcement than another prose round (a failing test at the deployed seam
   > a reviewer foreseeing the seam).
4. **Operator decision requested:** ratify accepting the pin-class residual
   (R8-M1 + the 2 LOWs) into the build phase under the §7 gates, OR direct a
   round-9 prose fold if you prefer the seam closed in the document first.
   The build itself REMAINS GATED on the keystone increments landing (the
   `depends-on` note: the keystone is review-CONVERGED at `aa5086eb8` but its
   registry + `deliverToConversation` funnel increments must be MERGED before
   this spec's build starts) — so accepting into "the build phase" does not
   authorize immediate coding; it authorizes closing the review ceremony and
   carrying R8-M1 as the first build-increment task with its test.

**Verdict: NOT CONVERGED** (0 CRITICAL + 1 MAJOR + 0 MINOR + 2 LOW) — **STOP
per the round-7 protocol; plateau reached; recommend accepting pin-class
residual into the build phase under §7 Testing Integrity enforcement, operator
decision requested.**
