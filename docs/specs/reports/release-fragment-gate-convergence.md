# Convergence Report — Release-Fragment Gate

## Cross-model review: codex-cli:gpt-5.5

A real GPT-tier external pass (codex CLI, `gpt-5.5`) ran successfully in every round;
a Gemini-tier pass (`gemini-2.5-pro`) ran in rounds 1 and 3 (round 2 degraded on a
transient timeout). The spec received genuine, repeated non-Claude external review.
Both external families converged from "MINOR ISSUES" with no critical/major findings
remaining.

## ELI10 Overview

instar ships new versions through a robot pipeline. That robot needs a short
"what changed" note (a small file) before it will cut a version — and if the note is
missing it does the safe thing and refuses to ship. The problem: it refused
**silently**. The release job went green and looked fine, but no version came out. On
June 27, three real bug fixes merged with no note, the robot quietly skipped shipping
them, and they sat unshipped for ~7 hours — and an earlier session even misread the
green checkmark as someone else's pipeline glitch.

This spec makes that impossible. The surprising thing the review uncovered: a guard
demanding the note **already existed** — but it only ran on a developer's own laptop
at `git push` time, and the way code actually lands now (the robot squash-merges an
approved pull request on the server) skips that laptop guard entirely. So the rule was
enforced in the one place merges don't happen. The fix moves the same rule to the
server, as a check on the pull request itself, where it can't be routed around — and
adds a loud alarm for anything that still slips through, so a skipped release is never
silent again.

The main tradeoffs, all resolved in review: the server check starts in "just warn"
mode and only becomes a hard block once it's proven it doesn't raise false alarms
(measured mechanically, not by gut feel); the "is a note present?" question is kept
deliberately simple (a yes/no a regex can answer) so it never makes a fuzzy judgment;
and the durable loud-alarm part ships first only on the developer agent (honestly
stated), with the universal protection being the un-skippable pull-request check.

## Original vs Converged

- **Originally** the spec diagnosed the root cause as "nothing structurally requires a
  fragment." **Review proved that wrong:** a *hard* pre-push gate already requires it
  (`pre-push-gate.js §3b`) — the real gap is that it runs in a local git hook that
  server-side squash/bot/auto-merges never execute. The whole framing was corrected:
  the fix is moving the existing requirement to the un-bypassable merge boundary, not
  inventing a new requirement.
- **Originally** the loud-skip backstop was "a step in the publish workflow that raises
  an Attention item via the watchdog." **Review showed this was architecturally
  broken** three ways: a GitHub Actions runner can't reach the agent's Attention
  store; the watchdog ships dark with a 2-day silent floor (so it wouldn't have caught
  the 7-hour incident); and a `[skip ci]` commit turns off the whole publish job
  including that step. Converged design: the durable surface is the **agent-side
  Sentinel** (a poller that reads `main` independently of CI, with a new fast trigger),
  honestly documented as dev-gated; the CI side is a loud-but-best-effort annotation
  that never claims to do more than it can.
- **Originally** the opt-out was a free-text PR-body marker. **Review flagged** that any
  fork author could self-assert it, re-creating a deliberate silent-skip at scale.
  Converged: the opt-out is the existing diff-verified `internal-only` fragment lane —
  durable, auditable, and it still cuts a version.
- **Security hardening added in review:** mandate `on: pull_request` (never
  `pull_request_target`), load the predicate from the **base ref** (never PR-head, or a
  PR could rewrite the gate to always-pass and run arbitrary CI code), key the bot
  exemption on **authenticated identity** not a spoofable `chore: release` title, and
  treat all git/commit data as opaque NUL-delimited argv (never shell-interpolated in
  the token-bearing publish job).
- **Correctness added in review:** the loud-skip window is bounded on the
  **release-bot-only annotated tag** (not a PR-mutable in-repo file, and not the
  release commit's ancestry — which the publish rebase-retry loop would bury a
  concurrently-merged fragment-less PR beneath).
- **Decision-completeness:** the original had ~6 decisions parked on the user. Converged
  has a `## Frontloaded Decisions` table (D1–D11) with concrete defaults and an empty
  `## Open questions`; the warn→block flip is a mechanical, log-derived criterion scoped
  to the population the gate can actually observe.

## Iteration Summary

| Iteration | Reviewers who flagged material findings | Material findings | Standards-Conformance Gate | Cross-model |
|-----------|------------------------------------------|-------------------|----------------------------|-------------|
| 1 | security, adversarial, integration, decision-completeness, lessons-aware, scalability (all six) + codex + gemini | ~17 (incl. 3 critical: misdiagnosed root cause, Layer-2-can't-signal-from-CI, wrong symbol names) | ran (1 flag: Testing Integrity) | codex-cli:gpt-5.5 (ran), gemini-2.5-pro (ran) |
| 2 | decision-completeness (D3 non-mechanical), security (N1–N4) | 5 (D3 + 4 security medium) | ran (1 flag: Cross-Machine Coherence) | codex-cli:gpt-5.5 (ran), gemini (degraded) |
| 3 | (converged — security CONVERGED, decision-completeness CONVERGED) | 0 material (externals: MINOR ISSUES only) | ran (clean: fit resolved) | codex-cli:gpt-5.5 (ran), gemini-2.5-pro (ran) |

## Full Findings Catalog

### Round 1 (material)
- **CRITICAL (lessons-aware):** spec misdiagnosed its foundation — a hard pre-push
  fragment gate already exists; real gap is the bypassable server-side merge path.
  → Problem section fully reframed.
- **CRITICAL (adversarial/integration/lessons):** Layer 2 as a publish-workflow step
  cannot raise an Attention item from GitHub Actions; the Sentinel ships dark + 2-day
  silent floor; `[skip ci]` disables the whole publish job. → D7: durable surface is
  the agent-side Sentinel (poller) with a fast trigger, honestly dev-gated; CI is
  best-effort annotation only.
- **CRITICAL (decision-completeness/lessons):** wrong symbol names
  (`ReleaseReadinessWatchdog`→`Sentinel`, `isInScope`→`inScope`). → corrected.
- **HIGH (lessons/conformance):** `parent-principle` "Structure > Willpower" won't
  resolve against the registry → "Structure beats Willpower". Mis-cited "Degradation Is
  an Event" → "No Silent Degradation to Brittle Fallback". → both fixed; Signal-vs-
  Authority section added.
- **HIGH (security C1/C2/M4):** trigger unspecified (`pull_request_target` = RCE);
  untrusted git/body data interpolated in the token-bearing publish job; workflow-
  command injection. → hard requirements added (pull_request, read-only perms, NUL-
  delimited argv, no `::`-echo of untrusted data).
- **HIGH (security M1/M2/M3, adversarial):** self-asserted body-marker opt-out;
  gate inert unless a required check; predicate misclassification = silent bypass;
  bot-exemption swallows the target population. → D8 (internal-only fragment opt-out),
  D9 (identity-keyed exemption), D6 (canonicalized single-source predicate +
  required-check deliverable).
- **HIGH (scalability):** "since last chore: release" boundary buries concurrent
  merges via the rebase-retry loop; shallow checkout starves history. → D11
  (tag-bounded published-SHA window + fetch-depth:0).
- **Conformance gate:** Testing Integrity — add wiring-integrity + both-sides semantic
  tests. → test tiers expanded.

### Round 2 (material)
- **Decision-completeness NOT-CONVERGED:** D3 flip criterion non-mechanical
  ("false-positive blocks" in a non-blocking phase; "fleet" unobservable). → D3
  rewritten: instar-repo scope, objective false-positive definition, FAIL-verdict
  language, log-derived count+duration.
- **Security NOT-CONVERGED (N1–N4):** load module from base ref (not PR-head); bot
  exemption keyed on identity not title string; remove the contradictory label
  opt-out; trust the release-bot-only tag over PR-mutable in-repo JSON. → all four
  folded.
- **Conformance gate:** Cross-Machine Coherence — note the single-owner/no-fenced-lease
  posture. → added (advisory dedup, re-raise-at-worst).

### Round 3 (non-material / minor — converged)
- codex/gemini MINOR: Layer 1 presence-not-validity tradeoff (→ explicit note: a junk
  fragment fails loudly downstream, never silently); "un-bypassable" overstated (→
  softened + periodic required-check drift audit added); durable backstop not universal
  (→ already honestly stated as dev-gated). No material findings.

## Convergence verdict

**Converged at iteration 3.** No material findings in the final round: the security
reviewer and the decision-completeness reviewer both returned CONVERGED, the
Standards-Conformance Gate's parent-principle fit resolved, and both external models
returned MINOR-ISSUES-only with every critical/major from earlier rounds folded. All
build-time decisions are frontloaded (D1–D11); `## Open questions` is empty. The spec
is ready for user review and approval.
