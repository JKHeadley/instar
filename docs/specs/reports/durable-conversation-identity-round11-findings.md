# Round-11 convergence findings — durable-conversation-identity

**Spec reviewed:** `docs/specs/durable-conversation-identity.md` @ commit `d2c5df6f0`
("round-11 revision — resolve round-10 findings (0 CRITICAL + 1 MAJOR + 2 MINOR + 1 LOW)").
**Report commit:** the tag commit (this file + the two sub-major editorial folds + the
converged/approved frontmatter land together, per the S2-ceremony precedent).
**Round-11 status: CONVERGED.** 0 CRITICAL + 0 MAJOR + 1 MINOR + 1 LOW — both sub-major,
both folded editorially in the tag commit and enumerated below.

Round 11 verified that **all round-10 findings are genuinely resolved in the body**: the
R10-M1 snapshot-flush SUSPENSION replacing the held-watermark mechanism (both externals
walked the full seq shape independently — skip-and-preserve at 100, live application of
101…120 with no flush, deterministic reboot cycles, re-upgrade applying 100 IN POSITION
under the order-dependence probe, flush resumption), its interaction matrix (rotation,
prune on the static pre-skew watermark, journal-only rebuild, backup manifest, the §3.4
append-serialization discipline — no concurrent writes outside the single-writer path),
the SUPERSEDED marker on Appendix I's M1, the staged-append fsync-before-serving class,
the §10 attention-content assertion, the multi-unknown progression shape, and the
unrecognized-lane extension.

**Convergence trajectory (Phase-2 rewrite):** 4C+16M → 1C+3M → 1C+4M → 0C+4M → 0C+3M →
0C+1M → 0C+1M → 0C+1M → **0C+0M**. Zero CRITICAL for the sixth consecutive round; the
registry core (merge algebra, ingest normalization, boot composition, binding overlay)
finding-free for the fifth consecutive round; and this round's external verdicts were the
ceremony's cleanest — gemini returned a fully clean pass (0/0/0/0, its first), and pi's
two findings are test-coverage and observability polish on the newest machinery, not
behavior.

---

## Reviewers who ran this round

**Internal pass (one consolidated multi-lens review by the folding agent, run against the
committed revision; nothing was folded pre-external):** crash/replay-composition,
fail-direction, decision-completeness perspectives. Independently walked the suspension's
seams before the externals returned — backup-during-suspension composition, the
suspension flag as DERIVED state (re-derived at every boot replay, never persisted), the
missing-pre-skew-snapshot degenerate case (journal-only rebuild every boot, consistent),
and growth bounds — and concurs: 0 CRITICAL + 0 MAJOR. Both externals' sub-major findings
confirmed.

**External cross-model passes (one bounded pass each), both EXECUTED by this session
against the committed spec file immediately after the d2c5df6f0 revision commit:**
- **gemini-cli, `-o json -m gemini-2.5-pro`, spec on stdin** — RAN (exit 0; 1 API
  request; serving model from the run's own stats block: **gemini-2.5-pro**). Verdict
  line: `VERDICT: 0 CRITICAL + 0 MAJOR + 0 MINOR + 0 LOW` — the ceremony's first fully
  clean external pass. It verified every round-10 fold, the suspension's interaction
  matrix, and found no new seams ("the suspension mechanism is a simplification that
  reduces potential failure modes").
- **pi / openai-codex provider, `--model openai-codex/gpt-5.5`, `--no-session --no-tools
  -p`, spec inlined** — RAN on the SECOND attempt (exit 0). The first attempt wedged at
  ~23 minutes with zero bytes on stdout/stderr (prior rounds: 2–4 min) and was killed +
  re-run identically; the wedged attempt produced no review output and is recorded here
  for honesty. Verdict line: `VERDICT: 0 CRITICAL + 0 MAJOR + 1 MINOR + 1 LOW`, with an
  explicit "CONVERGED: zero CRITICAL and zero MAJOR" statement. It verified the full
  round-10 fold table and the suspension walks independently.
- **codex-cli** — NOT RUN: not installed on this machine (unchanged since round 3).

---

## Sub-major findings — folded editorially in the tag commit

1. **MINOR (pi): backup-during-suspension restore was implied but not test-pinned.** The
   prose guarantees the manifest's snapshot + journal glob compose correctly under
   suspension, but no §10 shape ran a backup DURING suspension and restored it — a future
   implementation could pass the suspension shape and the generic manifest shape while a
   suspended-tail rotation silently fell out of the backup. **Fold:** the §10
   BACKUP-DURING-SUSPENSION restore shape (enter suspension → rotate → real-manifest
   backup → restore into a fresh stateDir → same composed state → re-upgrade on the
   restored copy passes the order-dependence probe → flush resumes).
2. **LOW (pi): "bounded operationally" for a long suspension was alert-only.** A rollback
   stay of weeks kept correctness but grew retention/replay with no named threshold or
   surface beyond the one deduped item. **Fold:** §3.4 makes the suspension first-class
   observable — `GET /conversations/health` carries `snapshotSuspended`,
   `firstUnappliedUnknownSeq`, `unappliedUnknownCount`, `retainedJournalBytes` — and a
   suspension persisting past `suspensionEscalationDays = 7` (or retained growth past 10×
   `journalRotateBytes`) re-raises the attention item at HIGH.

## Convergence verdict

**CONVERGED** (0 CRITICAL + 0 MAJOR; the two sub-major findings folded in the tag
commit). The spec is tagged `review-convergence` and `approved: true` under the standing
Session-A operator preapproval (topic 29836, 2026-07-02) — build authorization for the
Phase-1 increments per §11's phasing; every dark-ship/enforcement flip inside it keeps
its own gate.
