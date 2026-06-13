# Convergence Report — Green-PR Auto-Merge Enforcement (Phase 7 becomes machinery, not memory)

## Cross-model review: codex-cli:gpt-5.5

A real GPT-tier external pass ran through the agent's codex CLI in **every round** (1–7), and a
second external family — **gemini-cli:gemini-2.5-pro** — also ran in every round. Both families
returned successful (non-degraded) reviews in all rounds attempted, so the spec-level flag is the
clean RAN state. Family diversity mattered in practice: GPT-5.5 supplied the round-5
protected-paths consensus finding and the round-6 Layer-2 command finding; Gemini supplied a
standing architectural dissent (quoted in full below) that is recorded for the approval read.

## ELI10 Overview

When I (echo) finish a code change, it goes through a converged spec review, gated commits, and a
full CI run. By the time the pull request is green, every check the dev process defines has
passed — so the merge click is pure ceremony. Twice now I handed that click back to Justin
anyway, and the second time the PR went stale while it waited, costing a full conflict-fix round.
The June-9 "fix" was an instruction in my build skill ("merge it yourself"), and it failed for a
structural reason: the session that read the instruction died, and the sessions that resumed the
work never saw it. An instruction dies with the session that read it.

This spec replaces the instruction with machinery. A small background watcher checks every ~10
minutes for my own green, unheld PRs and merges the oldest one through a hardened verifier
script. A second layer nudges me at session exit if my branch has a green unmerged PR ("hold it
or let the watcher land it — don't merge by hand"). Deliberate holds (a `[HOLD]` title, a `hold`
label, draft status) always win; an emergency stop or a one-call rollback disarms the watcher
pool-wide; and everything it does or declines to do lands in an audit log and one aggregated
attention item — never a notification flood.

The main tradeoffs, honestly: the watcher exercises the operator's existing admin-merge
credential (no NEW privilege, but automated — a scoped GitHub App is a binding precondition
before any second agent ever gets this); and it deliberately merges without re-running CI against
the very latest main (that re-run treadmill is the thing that made PRs rot — textual conflicts
still always block, and main's own CI catches the rare semantic miss minutes later, with the
audit naming exactly which merge did it).

## Original vs Converged

The original draft trusted the existing merge script and treated the watcher as a simple loop.
Seven review rounds changed it substantially:

- **The merge script itself was the biggest hole.** Round 1 found `safe-merge.mjs` could merge a
  commit pushed AFTER checks passed, report success on a failed merge, and parse human-readable
  output with a regex that matched check *names*. The script is now hardened in the same PR: head
  pinning, JSON parsing, honest exits, a repo parameter, and a required-contexts cross-check.
- **"My PRs" had to be earned, not asserted.** The gh login on these machines is the operator's,
  so "authored by me" became: agent-namespace branch (a filter) + a code-pinned floor of
  gate-produced CI contexts whose *producers* (workflow path + app slug) must match — a lookalike
  check name from a tampered workflow does not count (rounds 2–3).
- **PRs that touch the merge machinery itself never auto-merge.** A same-repo PR branch runs its
  own workflow copy, so it could mint hollow "passing" checks — those PRs route to human eyes
  (round 3), the operator is told immediately (round 4), and — after three reviewers
  independently caught it in round 5 — the session-exit nudge no longer hands the agent a
  ready-to-run merge command for them. Round 6 went further: NO session-exit variant contains a
  runnable merge command at all; if the watcher is healthy, manual merging is exactly the manual
  work this build kills.
- **The kill switch follows the pool, not one machine.** Disabling the watcher anywhere disables
  it everywhere (replicated latches with fenced ordering, push-through writes, and
  arrive-disabled-when-unreadable); re-arming requires the operator's dashboard PIN from a phone
  (rounds 2–4). Round 6 gave the "this pool armed the watcher" breadcrumb a proper disarm
  lifecycle so a deliberate off can't alarm forever.
- **The watcher must survive its own success.** Its merges trigger releases, which restart the
  server — so round 5 made the in-flight merge attempt durable (own process group, shutdown
  kill, orphan reap at boot) and round 6 specified the two-phase record write and the
  dead-leader corner.
- **Self-checks got real reference targets.** The "are my pinned CI checks stale?" canary
  (round 4) was aimed at the latest main commit — which on this repo is usually a `[skip ci]`
  release commit with zero checks (round 5), and two of the three pinned check families only
  ever run on PRs, never on main (round 6). References are now per-family: merged-PR heads for
  PR-only checks, independently-qualified main commits for push-triggered ones.
- **Residuals are ratified, not buried.** `approved: true` explicitly ratifies three decisions:
  no observe-only soak (the operator directed this behavior twice), the hold contract (a
  conversational hold obligates one immediate marker call; the marker IS the hold), and the
  stale-base residual (Decision 9, added in round 5 after the external GPT-tier reviewer pushed
  on it).

## External dissent (recorded verbatim for the approval read)

Gemini 2.5 Pro returned SERIOUS ISSUES in rounds 6 and 7, contesting three operator-ratified
decisions rather than surfacing unaddressed gaps. Its position, so the approval is informed:

1. *"The use of an operator's personal token with `--admin` privileges for an automated process
   is a notable security risk… Implement the scoped GitHub App with least-privilege permissions
   as a prerequisite for shipping, not a 'fast follow.'"*
2. *"The design reinvents several solved industry patterns… Re-evaluate the GitHub Actions
   workflow alternative. A GitHub Actions workflow can call out to a secure, authenticated
   endpoint on the agent server to check for holds, identity, or other agent-side policies
   before merging."*
3. *"Instead of bypassing the [up-to-date] check, the machinery should be responsible for
   keeping the PR updated… merge `main` into the PR branch, wait for CI, then merge."*

The spec's engagement: the watcher mints no new privilege (the same credential performs the same
admin merge manually today, per the operator's standing Phase-7 directive); the GitHub App is a
**binding precondition** for arming any second agent; merge authority stays inside the agent's
audited, kill-switched monitoring layer by standing instar policy (Observable Intelligence /
emergency-stop reach); and the update-treadmill alternative is the documented cause of the rot
this spec exists to kill (Decision 9 bounds the residual and a strict-base-freshness mode is on
the fleet-promotion checklist). GPT-5.5's final verdict was MINOR ISSUES with "no serious
blocker."

## Iteration Summary

| Round | Reviewers who flagged | Material findings | Spec changes |
|-------|----------------------|-------------------|--------------|
| 1 | all 6 internal + GPT-5.5 + Gemini | 20+ | safe-merge hardening in-PR; identity contract; runtime rollback/enable; lease gating; settled-checks-only invocation; server-side stop-gate; fleet classification; alternatives section |
| 2 | security, adversarial, integration, lessons | ~10 | pool-replicated latches + warm-up; provenance floor (branch prefix demoted to filter); mode-independent Layer 2; liveness brakes + breaker canaries; /hold assist; §3.4 widened to all waiting:* |
| 3 | security, adversarial, integration | ~8 | producer-bound floor; protected-paths skip; partition-safe latches (push-through, guard-latch kind, fenced ordering, arrive-disabled); PIN-gated /enable; reporter cwd; contract probe |
| 4 | security, adversarial, integration | ~5 | floor-drift canary; absorbing disable; mobile-complete re-arm; widened protected paths (.github/** + gate scripts); protected-paths Attention line; disarmed-variant suppression |
| 5 | security, adversarial, integration, codex | 5 | protected-paths Layer-2 variant routes to operator (3-reviewer consensus); restart-surviving single-flight; floor-drift reference walk-back; pool-armed divergence grading; Decision 9 (stale-base residual); GitHub App fleet precondition |
| 6 | adversarial, integration, codex | 3 | per-family floor-drift references (PR-only gates → merged-PR heads); pool-armed disarm lifecycle; Layer 2 carries NO runnable command; latch rationale; chaos test; Gemini dissent recorded |
| 7 | (converged) | 0 | none — all round-7 findings non-material (build-phase notes below) |

Standards-Conformance Gate per round: rounds 5–7 — **ran degraded** each round (deterministic
registry canary: 22 standards checked, 0 findings, registry intact; the LLM fit-judge errored and
failed open — the post-restart server's LLM routing; the lessons-aware reviewer compensated with
a manual constitutional pass each round, documented in its findings). Rounds 1–4 — **unavailable:
records lost** (those rounds ran in the session reaped mid-work at 2026-06-12 16:49 PDT; their
folds survive as commits `5303803bb`/`bad52bde5`/`dce1c8638`/`e81efffbf`, but their per-round
gate invocations were not recoverable).

Externals delta-gating: the spec body changed in every round, so the external pass ran fresh each
round — no delta-skips.

## Full Findings Catalog

### Rounds 1–4 (recovered from the reaped session's commits)

Per-finding detail for rounds 1–4 did not survive the 2026-06-12 16:49 PDT session reap (the
exact failure mode the sibling reap-notify spec fixes). The folds are durably recorded in the
four convergence commits, summarized in the Iteration Summary above; the spec text annotates
each round's contributions inline (`round-1` … `round-4` markers throughout).

### Round 5 (8 reviewers)

| Severity | Reviewer | Finding | Resolution |
|---|---|---|---|
| high (material) | security + adversarial + codex (independent consensus) | Protected-paths Layer-2 variant handed the ending agent session a runnable pinned `--admin` merge command — defeating the human-eyes guard those PRs exist for (the ending session is typically the PR's author, the exact actor the door guards against) | §3.3 rewritten: protected-paths variant routes to the OPERATOR, mirrors the Attention line, carries no command |
| medium (material) | adversarial | Floor-drift canary reference unspecified; main's HEAD is usually `[skip ci]` with zero check runs → perpetual false alarms | Bounded walk-back to the most recent commit with completed runs; `floor-drift-unverifiable` distinct class; `floorDriftCheckTicks`/`floorDriftLookbackCommits` knobs |
| medium (material) | adversarial | Single-flight liveness dies with the server; the watcher's own merges cause restarts; orphaned safe-merge child unsupervised, double-attempt on reboot | Durable in-flight record + own process group + shutdown group-kill + warm-up orphan reap + re-verify before any new attempt |
| medium (material) | integration | Pool-divergent `enabled` config silently de-arms on lease move; guard posture grades it healthy dark-default | Ship-time flip applied pool-wide; replicated `pool-armed` marker; local-off + pool-armed grades `diverged-from-default` |
| material | codex | Stale-base merge safety under-argued ("head green" ≠ "current base + head green") | Decision 9: residual stated honestly with bounds, scoped "pre-approved by construction," ratified at the approval gate; strict-base-freshness named as a reversibility lever |
| non-material | codex + gemini | GitHub App / privilege model | Upgraded from "future hardening path" to binding fleet-promotion precondition |
| non-material (batch) | several | Floor-drift cadence knob; hold-title trim; probe-to-spawn hash re-verify; tunnel-URL dashboard link; journal-off note; lessons-engaged entries; real-gh CI smoke | All folded in the round-5 commit |

### Round 6 (8 reviewers)

| Severity | Reviewer | Finding | Resolution |
|---|---|---|---|
| medium (material) | adversarial | Round-5 floor-drift reference structurally unsatisfiable: two of three pinned floor families are `pull_request`-only — NO default-branch commit ever carries their runs (perpetual unverifiable or perpetual false drift) | Per-family references: PR-triggered contexts validate against recently MERGED agent-PR heads (`floorDriftLookbackPrs` 10); push-triggered against independently-qualified default-branch commits |
| medium (material) | integration | `pool-armed` marker had no disarm lifecycle — a deliberate fleet-wide off alarms forever (the same perpetual-false-alarm disease round 5 fixed elsewhere) | PIN-gated pool-disarm writes a superseding entry, same kind + ordering; grades back to healthy; independent of rollback latches; unit cases |
| material | codex | Layer 2's healthy-case runnable command turns the stop-gate into scripted manual merging — contradicting machinery-first | NO Layer-2 variant carries a runnable command; healthy message = "hold it or let the watcher land it; do NOT merge manually" |
| non-material | codex | R9 latch complexity needs a why-not-simpler rationale | One-paragraph rationale added (rides existing journal+lease primitives; no new store; GitHub-side gate lacks emergency-stop reach) |
| non-material | codex | Chaos coverage | Integration chaos scenario added (restart + rollback + lease transfer during in-flight merge) |
| non-material | adversarial | "Can never" overreach in orphan reap; two-phase in-flight write wording | Dead-leader/live-group handling + `orphan-reap-incomplete`; two-phase write + pid-less-record semantics specified |
| non-material (dissent) | gemini | App-before-ship; GitHub Actions; stale-base | Recorded verbatim in Alternatives + this report; contests ratified decisions |

### Round 7 (8 reviewers — convergence round)

| Severity | Reviewer | Finding | Resolution |
|---|---|---|---|
| low | security | Floor-drift reference poisoning requires an out-of-threat-scope actor; fail direction is noise, never a loosened floor | Recorded; no change |
| low | adversarial | PR-family reference aggregation should be pinned **newest-qualifying-wins** (an any-of-lookback reading could mask a rename) | **Build-phase note**: pin newest-wins + fixture "rename PR newest, older satisfying entries → drift fired" |
| low | adversarial | Fully out-of-band rename of a PR-only gate is canary-blind (mislabeled but loud + fail-safe) | **Build-phase note**: a floor-missing refusal additionally audits the floor-drift class naming the missing context |
| low | adversarial + decision-completeness | `floorDriftLookbackPrs` absent from §3.2 config inventory (named + defaulted in R8) | **Build-phase note**: fold into the config block during build |
| low | integration | pool-disarm route not in §3.2 route enumeration; inverse divergence grade unnamed | **Build-phase notes** |
| low | codex | Orphan identity contract: spawn with a unique attempt token in argv/env; signal only on pid/pgid + token match | **Build-phase note**: adopt the attempt-token contract (strictly sharpens the specified fail-safe behavior) |
| low | codex | Stop-gate/Attention text should also mention the deterministic GitHub title/label hold levers | **Build-phase note**: one-phrase addition to the message templates |
| repeat | codex | Decision-8 naming; Decision-9 blast radius; policy-mirror naming | Already addressed (Decisions 8, 9; floor-drift canary owns drift detection) |
| repeat (dissent) | gemini | Same three round-6 positions | Recorded verbatim above; ratified decisions |

## Convergence verdict

**Converged at iteration 7.** No material findings in the final round (comparator verdict:
converged, both criteria hold — zero new material issues; zero unresolved open questions, with
Decisions 1, 3, and 9 explicitly ratified by the `approved: true` gate). The seven round-7 low
findings are build-phase implementation notes recorded above; none requires a spec change. The
spec is ready for user review and approval.

Decision-completeness final counts: 9 frontloaded decisions, 8 cheap-to-change-after tags (all
contested), 4 contested-then-cleared.

Provenance note: rounds 1–4 ran in a session that was reaped mid-work (age-limit, 2026-06-12
16:49 PDT) before the per-round logs could be persisted; their spec folds are fully durable as
commits. Rounds 5–7 ran post-recovery with full records. This convergence was itself a live
demonstration of the failure mode the sibling reap-notify/resume-queue spec (PR #1084) closes.
