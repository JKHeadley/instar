# Convergence Report — Per-Topic Reap Notification + Mid-Work Resume Queue

**Spec:** `docs/specs/reap-notify-per-topic-and-midwork-resume-queue.md`
**Converged:** 2026-06-12 (iteration 7 of 10)
**Reviewers per round:** 5 internal (security, scalability, adversarial, integration,
lessons-aware) + 2 external cross-model (codex-cli:gpt-5.5, gemini-cli:gemini-2.5-pro).
Grok-tier external: no installed framework — recorded as a disclosed degradation, not skipped
silently.

## ELI10 Overview

When the machine gets overloaded, the system kills agent sessions to protect itself. Tonight's
incident (2026-06-11, load 20+ on a 16-core box) showed two gaps: the people whose
conversations lost sessions were barely told, and sessions killed mid-task stayed dead until
someone happened to message them. This spec fixes both. Every conversation that loses a
session gets its own plain-English notice through a delivery path that retries and records
the outcome. And sessions killed mid-work go into a durable, ordered queue: once the machine
has been calm for several minutes, a drainer brings them back one per minute, checking first
that reality still matches (right machine, right folder, nothing else already restarted it),
and giving up loudly when it can't.

The main tradeoffs: recovery is deliberately slow (one resume per minute — that ordering was
the explicit ask, so a recovering machine isn't re-flooded), entries expire after 24 hours
(a day-old "resume" is more likely wrong than right), and the resume queue ships observe-only
everywhere except the dev agent until a soak proves the mid-work detection fires on real
overload kills.

## Original vs Converged

The review process materially changed this design — the headline catches:

1. **The "always notifies" guarantee was originally built on sand.** The first draft routed
   notices through the existing notification gateway and claimed the durable relay layer
   would retry failures. Review verified the actual code: that gateway swallows send errors
   with no retry, and the durable layer's drain engine is OFF by default fleet-wide — plus
   its startup purge had a documented bug that silently deletes delayed messages across a
   restart. The converged design ships its own small always-on delivery loop over the durable
   store and fixes the purge bug for every consumer of that store.

2. **Mid-work detection was originally blind to the exact incident it was built for.** The
   first draft computed "was this session working?" at the kill chokepoint. Review traced the
   real kill paths: a guard-cleared kill only reaches that point when the work checks just
   returned nothing, and quota-shed kills send Ctrl+C and wait BEFORE the chokepoint — so the
   evidence would be empty precisely for overload kills. The converged design has each killer
   capture evidence at its own decision moment and pass it through; the soak must prove a
   true-positive before any fleet flip.

3. **The resurrection cap was originally dead code for jobs.** It was keyed on tmux session
   names, which regenerate on every respawn. Re-keyed on stable identity (topic or job).

4. **Job resumes flipped from default-on to opt-in.** Jobs already recur on cron; auto
   re-running a killed job risks duplicate side effects for marginal benefit.

5. **Everything that can give up now does so loudly and in one place** — overflow, expiry,
   failed attempts, resurrection caps, breaker trips all fold into a single rolling attention
   item instead of per-entry alerts (the notification-flood lesson, enforced at the emitter).

## Iteration Summary

| Round | Material findings | Headline |
|---|---|---|
| 1 | 2 critical, 3 high, ~20 med/low | Notify path not durable (verified in code); chokepoint evidence empty by construction; no supervision declaration; attention-flood risk; missing frontmatter/lessons engagement |
| 2 | 1 critical, 2 high, ~10 med/low | The replacement delivery engine is default-OFF fleet-wide; its restore-purge eats held rows (documented incident class); resurrection ledger dead for jobs (tmux names regenerate) |
| 3 | ~8 medium/low | Origin-tag carrier unnamed (no schema column exists); stale-lock recovery; requeue clamps; unpause lever; drain cadence/off-switch |
| 4 | 4 low | Requeue×TTL dead-on-arrival; pause-state semantics; "resumed" overclaims; config-default doc precision |
| 5 | 2 low (+3 held-position repeats) | TTL semantics under day-long pressure; LLM-check example claimed inputs it doesn't receive |
| 6 | 4 low (+repeats) | fsync discipline; foreign-lock recovery path; cap-semantics statement; storm release throttle |
| 7 | 1 low (folded same round) | Reap-log boot reconciliation closes the lost-enqueue crash window. Internal panel: clean across all five perspectives |

Internal reviewers were CLEAN from round 4 onward. The convergence comparator (Haiku-class)
emitted `converged: true` at round 7: the only new item was folded immediately; every
remaining external finding is a repeat of a position the spec documents with explicit
rationale.

## Held positions (externals' standing disagreements, documented not hidden)

- **JSON file vs SQLite for the queue** (gemini/codex, rounds 2–7): kept as a flat JSON file.
  Rationale in R2.3: ≤50 entries, single-writer enforced by a self-healing lock, fsync-rename
  discipline, per-machine state deliberately excluded from backup, human-inspectable in
  incidents, decoupled from the relay store's purge lifecycle (the exact collision class the
  R1.6 bug demonstrated). Plus reap-log boot reconciliation as the corruption backstop.
- **PK-prefix origin tag vs a new column** (rounds 4–7): kept the `delivery_id` prefix.
  Zero DDL, rollback-safe, one typed helper builds/parses it, contract tests pin every store
  path, index-compatible range predicate required.
- **The observe-only Tier-1 LLM check** (rounds 3–7, externals split): kept, observe-only,
  with its own off-lever and an honest promotion criterion. The project's P7 standard
  requires a declared supervision tier for a session-spawning recovery loop; observe-only is
  the minimal compliant posture, and gemini's final round conceded it is "safe."

## Full Findings Catalog

The complete per-round findings with resolutions live in the worktree git history
(`echo/reap-notify-resume-queue`, commits "spec: convergence round 1" through "round 7") —
each commit message names the findings folded, and each round's reviewer reports are quoted
in the transcript. Headline items are summarized above; every finding was either folded into
the spec or recorded as a held position with rationale (no finding was dropped silently).

## Convergence verdict

Converged at iteration 7. No material findings in the final round (internal panel clean;
the single new external item was folded in the same round; remainder are documented held
positions). Spec is ready for user review and approval (`approved: true`).
