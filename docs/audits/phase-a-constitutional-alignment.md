---
audit: "phase-a-constitutional-alignment"
target-pattern: "Whether the guards our constitutional standards name are actually EFFECTIVE — a deliberately introduced violation is caught on current code — rather than merely present (exists) or reachable (wired). Phase A of the ratified Instar Constitutional Alignment plan; three-rung verdicts where only rung 3 counts."
search-surface: "The 90-guard runtime inventory at GET /guards on both machines; all 30 scripts/lint-*.js; all 18 tests/unit/*ratchet*.test.ts plus lint-chain-completeness; the 81-entry NOT_A_GUARD exclusion list in guardManifest.ts; 27 further guard-shaped non-lint enforcement scripts; the internal LLM provider path; cross-machine guard posture via the machine registry."
standing-guard: "tests/unit/lint-chain-completeness.test.ts"
blind-spot-class: "population-scoped-by-naming-convention-mistaken-for-a-functional-tier"
rounds: "2"
---

# Phase A — constitutional alignment: are the guards effective?

**Measured 2026-08-04 03:12Z–10:31Z on the live echo agent (Mac Mini), against
`origin/main` @ 1.3.1124. Every script tested was first diffed UNCHANGED vs `origin/main`.**

**This report is NOT converged and carries no `converged:` stamp.** One proper round has run. Per
`scripts/write-audit-convergence.mjs`, a convergence claim requires ≥2 rounds whose final ledger parses
to zero rows. **An honestly-incomplete audit is fine to commit; it just cannot claim convergence.**

## Verdict: the standards are not aspirational — the failures are at their perimeters

Across **48 guards in two complete enforcement tiers, not one was found broken.** Every alarm raised
against them was the auditor's own method error (12 self-inflicted false results, zero genuine guard
failures). The method demonstrably works: **44 of the 48 caught a deliberately planted violation, named
the file and line, and then accepted the compliant form.**

Where the standards fail is at edges: a scope boundary that stops at the source tree, a register that
validates a reason's PRESENCE rather than its TRUTH, and a component classified but never constructed.

## Round 1

Search angles: Three-rung verdicts on the 90-guard runtime inventory; a counter-method sweep (would-act vs did-act) over per-feature status routes; deliberate two-sided injection against every `scripts/lint-*.js` and every `tests/unit/*ratchet*.test.ts`; liveness testing of the `NOT_A_GUARD` exclusion list by construction-site search with controls; cross-machine posture comparison via the machine registry; direct reproduction of the internal LLM provider failure against a throwaway tmux session.

Surface delta: The inherited surface was "90 guards, 20 on-confirmed". The empirical surface grew to three distinct populations — 90 runtime guards, 30 lint-class scripts, 18 ratchet-class tests — plus an 81-entry exclusion list that no tranche covered, and a per-machine dimension the fleet-wide reading had hidden.

| location | behavior | bucket | disposition |
|----------|----------|--------|-------------|
| `src/monitoring/CrashLoopPauser.ts` | Never constructed anywhere in the running build (control passed: SessionReaper/CompactionSentinel/SessionWatchdog each =1, this =0) while 21 jobs run away, top 477 consecutive failures. Excluded from the guard inventory by a rationale asserting an observability that does not hold. | dead-safety-component | deferred:ATT-ECHO-PHASEA-POOL-PROMPT-TOO-LONG-sibling-tracked |
| `.instar/scripts/convergence-check.sh` | A six-phrase natural-language regex matched against outbound message text to BLOCK the send — the exact anti-pattern `keyword-intent-decision-ratchet` enforces against, but agent-side and therefore outside that ratchet's `src/` scan scope. 14 blocks, 2 true, 12 false, precision falling at every re-measurement. | standard-enforced-repo-side-violated-agent-side | deferred:reported-to-architect-2026-08-04 |
| `providers/adapters/anthropic-interactive-pool/promptRunner.js:77` | Sends each prompt as a command-line argument to `tmux send-keys -l`. Measured ceiling ~16,256B; the tone-gate static skeleton alone is 40,049B — 2.5x over. 23 attempts, 23 failures, 100%. Causes total internal-LLM failure (0 successes/6h) while quota sits at 0–56%. | root-cause-proven | fixed:remedy-verified-load-buffer-paste-buffer-40KB-and-200KB |
| `monitoring.resumeQueue.enabled` on the LAPTOP | Reported `off-runtime-divergent` — disabled at runtime against config. An autonomous run interrupted there is not revived. Guard self-reports correctly; nobody had read it. | cross-machine-divergence | deferred:ATT-ECHO-PHASEA-LAPTOP-RESUME-QUEUE-OFF |
| `monitoring.orphanedWorkSentinel` + `monitoring.agentWorktreeReaper` | Both tick and both return `verdictUnknown` every tick — worktree enumeration fails because the agent home is not a git repository. 34 worktrees / 17GB unseen. The reaper's blindness is masked because `on-dry-run` takes label precedence over `on-blind`. | absorbing-label-hides-blindness | deferred:reported-2026-08-04 |
| `GET /guards` runtime block, all 20 on-confirmed guards | Heartbeat-only (`enabled`/`lastTickAt`/`stale`/`dryRun`). Zero of 20 expose an effectiveness counter, so `on-confirmed` is structurally incapable of meaning more than "has a pulse". Effectiveness data exists but only on scattered per-feature routes. | inventory-schema-cannot-express-effectiveness | accepted:recommended-looked-wouldAct-didAct-triple-to-architect |
| `intelligence.selfActionGovernor` | 1,616 would-deny against 0 denies across four live classes — computes correct verdicts, holds no authority. Observe-only by design; flip cost now measured. | effective-false-by-design | accepted:graduated-rollout-stage-with-measured-flip-cost |

New findings this round: 7

## Round 2

Search angles: Asked what round 1's scoping MISSED rather than re-running round 1's checks — enumerated every non-`lint-*` script in `scripts/` carrying a failure exit path, separated tools from guard-shaped enforcement, and tested whether each was wired into CI, husky, tests, or package.json; re-diffed every previously-tested script against `origin/main` to confirm no verdict had decayed.

Surface delta: The enforcement-script population grew from the 30 swept in round 1 to approximately 57. Twenty-seven further guard-shaped scripts were found, all wired and none orphaned, none of them rung-3 verified. No previously-recorded verdict decayed: 0 scripts changed vs `origin/main`, 30/30 lints still green, 19 ratchet files / 215 tests still passing.

| location | behavior | bucket | disposition |
|----------|----------|--------|-------------|
| `scripts/*.{js,mjs}` outside the `lint-` prefix | 27 guard-shaped enforcement scripts (repo invariants, contract evidence, spec-review link, docs coverage, ELI16 PR description, decision-audit presence, worktree precommit gate, retro-harvest validation) were never swept. Round 1 scoped a population by FILENAME PREFIX and reported it as a completed functional tier. All 27 are wired; 16 run green standalone, 11 require CI/PR context; none broken. | population-scoped-by-naming-convention | deferred:round-3-required-to-sweep-the-27 |

New findings this round: 1

## Why this audit cannot yet claim convergence

Round 2 produced a new finding, so the round-2 ledger is non-empty. A third round is required, and it
must sweep the 27 newly-surfaced enforcement scripts. **The blind-spot class this audit escaped is named
in the frontmatter: scoping a population by naming convention and mistaking it for a functional tier.**
That class was found three times in one session — keyword-bucketed exclusion rationales, a keyword survey
of ratchet negative-cases, and the `lint-` prefix — and only the third instance survived into a
published completion claim.

## The auditor's own error rate is the dominant risk to this audit

Twelve times a result looked like a broken guard. All twelve were the auditor's method. Recurring causes,
each now written down: full-repo scan modes skip untracked files; PATH-ALLOWLIST lints enforce on an
enumerated file set; a compile-breaking injection reports "no tests" rather than a failure; an untrusted
workspace silently skips the hook set; a keyword classifier detects a vocabulary rather than a property.

**Had first results been reported, this document would list twelve working guards as broken.**
