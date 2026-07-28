# Round 6 Findings — machine-coherence-guard

Reviewed: `docs/specs/machine-coherence-guard.md` (round-6 revision, commit
ef9699933, worktree branch `echo/machine-coherence-guard` at v1.3.728).
Round-6 charter: RE-EXECUTE the R5-M1 held-offline walk (offline divergent
machine holding an approved fix → suspension → invalidation → named
re-propose note → return → NO auto-apply, fresh approval required); verify
all 11 round-5 folds; regress the R4-M1 dead-adapter and R4-M2
mid-verify-suspension walks; whole-§4.2.1 cross-reference sweep.

Panel: 6 internal lens perspectives (run as three combined walk/grounding
agents: adversarial+decision-completeness, security+lessons-aware,
integration+scalability) + 2 externals (`gpt-5.5` via the `pi` CLI's
openai-codex provider — codex CLI not installed, noted honestly, same as
rounds 1–5; `gemini-2.5-pro` via the gemini CLI — clean single-shot) + the
Standards-Conformance Gate.

Standards-Conformance Gate: **ran (1 advisory flag)** — 51 standards; fit
verdict **fit**. The flag: "No Manual Work" `possible-violation` against the
held-fix path (divergent≠raiser has no structural cross-machine execution
trigger in v1). Disposition, recorded honestly: this is the DELIBERATE,
D21-frontloaded v1 scope — named plainly in §4.2.1(iv) since round 4
(replacing the round-3 draft's hidden "coordinated conversationally"), judged
Structure>Willpower-conformant by the lessons lens in rounds 4–5 (durable
pendingFix + bounded window + loud failure = structure, not willpower), with
the structural cross-machine execution channel tracked as Phase 2's authority
work (§8, same class as the updater). The gate flagged it in round 6 and not
in rounds 1–5 precisely BECAUSE the rounds made the held path's honesty more
explicit — the flag is the honest naming being seen, not a regression; the
gate is signal-only and the panel holds the frontloaded decision.

External verdicts: pi/gpt-5.5 **CONVERGED (0/0/0/0)** — all 11 folds OK, all
regressions OK; gemini-2.5-pro **CONVERGED (0/0/0/0)** — all 11 folds OK,
all regressions OK. For the first time in the ceremony, BOTH externals AND
every internal lens converge in the same round.

**VERDICT: CONVERGED — 0 CRITICAL, 0 MAJOR, 0 MINOR, 2 LOW.**
(Trajectory: 3C+12M → 0C+3M → 0C+6M → 0C+2M → 0C+1M → **0C+0M**. All 11
round-5 folds held under walk re-execution; both round-4 MAJOR walks stayed
closed on regression; the whole-§4.2.1 cross-reference sweep found every
(i)↔(iv)↔(v)↔§4.3 reference landing on text that says what the reference
claims; grep confirms the only surviving auto-apply-on-return language is
the fenced historical quote inside the R5-M1 parenthetical. The two LOW
residuals are optional one-clause pins, folded editorially in the tag
commit per the aa5086eb8 house precedent.)

## Fold verification (11 walks re-executed)

| Round-5 finding | Verdict | Notes |
|---|---|---|
| R5-M1 (offline-hold reconciled to (i)) | FOLD-OK (adversarial+DC held-offline walk; security+lessons authority/honesty regression: the reconciliation STRENGTHENS the posture — no stale approval ever executes; pi; gemini) | the one plausible NEW collision (a held fix's own restart tripping "offline→invalidate") dissolved by the mesh's own thresholds: a ~30s restart never crosses the 15-min offline / 5-min advert-stale bounds — verified against `failoverThresholdMs` in source |
| R5-N1 (idempotent re-stamp) | FOLD-OK (walk + §9 one-shot-raise failure assertion; duplicate-item check: a re-raise is a no-op success, never a new topic; cost check: bounded, self-terminating, recovery-path) | |
| R5-N2 (EV disposal scoping) | FOLD-OK | |
| R5-N3 (format clamps + honest L2 enumeration) | FOLD-OK (real instar version strings verified inside the alphabet — no false advert-rejected for any real version; pre-guard peers classify `unknown`, never `advert-rejected`) | |
| R5-L1..L5 | FOLD-OK (5/5; L1's write-amplification judged bounded — suspend-start/resume-end are the only writers; L2/L3/L4/L5 verbatim present) | |
| R5-L6 / R5-L7 | subsumed by N1 / no fix owed — both confirmed | |

Regression: R4-M1 dead-adapter walk OK · R4-M2 mid-verify-suspension walk OK
· whole-§4.2.1 sweep OK (no new contradiction — the ceremony's standing
failure mode did not recur). §11 grounding index unchanged round-5→round-6
(zero citations added/removed — the round-6 material is design prose);
§7 config block and §6 route shape byte-for-byte unchanged.

## CRITICAL / MAJOR / MINOR

*(none)*

## LOW (both folded editorially in the tag commit)

**R6-low-1 — The re-propose-on-return trigger is passive-voice ("the fix is
RE-PROPOSED fresh") without restating the actor/tick.** (adversarial+DC)
§4.2.1(iv). Adequately determined (only the sticky episode owner can perform
the in-place item edit; the only observation point is the §4.3 resume tick)
— pinned anyway: "the item-holding owner re-proposes in-place on the §4.3
resume tick."

**R6-low-2 — R5-L1's durable suspended-interval accumulator is not
explicitly reconciled against R4-N5's latched-mode durable-write
suppression.** (integration+scalability) §4.2.1(v)/§4.5. Fail-safe already
holds (the resume verdict is advert-driven, not clock-driven; latch-exit
reconciles) — pinned anyway: the EV suspended-interval accumulator is
reconciled at latch-exit like the durable `suspended` field, and the
advert-driven resume verdict — never the clock — is authoritative for the
failure append.

Cleared-on-investigation (recorded, no fix owed): the version-string
format-miss false-alarm candidate (real versions inside the alphabet); the
"leave it" × invalidated-fix interaction (mutually-exclusive responses, no
interaction defect); the raiser's persistent-failure retry loop (bounded,
one idempotent call/tick, IS the recovery path).

## Verdict

**CONVERGED at round 6 — 0 CRITICAL, 0 MAJOR, 0 MINOR, 2 LOW (both folded
editorially in the tag commit).** Six rounds, 8 reviewers per round
(6 internal lens perspectives + 2 real external cross-model doors), every
fold of every round eventually verified by walk re-execution, all §11 code
citations re-verified across rounds with zero substantive errors, and the
Standards-Conformance Gate run every round (0 flags rounds 1–5; 1 advisory
flag round 6, dispositioned above as the D21-frontloaded v1 scope). The
detection architecture, manifest/advert design, §5b telemetry fix, election
core, and close-reason taxonomy drew zero objections for six consecutive
rounds. The spec is ready for the convergence tag and, per the standing
Session-A operator preapproval (topic 29836), approval.
