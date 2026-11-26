# Convergence report — Watchdog test-runner floor (ACT-069)

## ELI10

The watchdog was stopping test runs because an AI judge mistook "slow because
the computer is busy" for "frozen". The fix puts test runs on a short safe
list for an hour. Review mostly made sure the safe list could not be used to
hide something else that really is frozen.

## Rounds

Four rounds. Each round ran the Standards-Conformance gate and one codex-cli
(gpt-6-astra) external pass; round 1 also ran one combined internal reviewer
(security, adversarial, integration, decision-completeness).

| Round | Source | Finding | Changed the build? |
|---|---|---|---|
| 1 | Conformance gate | Every `git push` was protected on its argv alone (a symbol, not state) | Yes — `git push` protected only while a matched runner runs below it |
| 1 | Conformance gate | Posture text implied machine-local config | Spec wording only |
| 1 | Codex + internal reviewer (independently) | A shell wrapper (`zsh -lc 'cd repo && npm test'`) is older than its runner, so it would be picked and killed first | Yes — generalised: any process with a matched runner below it is protected (`test-runner-ancestor`) |
| 1 | Codex | Post-bound tests did not separate judge outcomes; live thresholds can make interrupts earlier | Tests added (stuck / legitimate / erroring); spec wording |
| 2 | Codex | Stopping at the first protected process lets a test run hide an unrelated stuck command | Yes — protection moved into the selection loop; search continues |
| 2 | Codex | Ancestor age vs young runner; signal-propagation claims | Test added; spec states behaviour, speculative text removed |
| 3 | Codex | A shared parent shell was pruned, hiding a stuck sibling | Yes — only a runner's own subtree is pruned; ancestors are left alone but their other children are checked; test added |
| 3 | Codex | Display-string matching limits; per-run vs per-process bound | Spec wording only |
| 4 | Codex | Snapshot race; finite-number contract for live values; separate "withhold" from "selection change" | Spec wording; live-value edge tests added. No logic change |
| 4 | Conformance gate | Vitest title can be spoofed; judge-failure → hard ceiling | Spec wording only (bounded 60-min cost; pre-existing ceiling path unchanged) |

Round 4 produced no logic change, so review stopped there (80/20 convergence:
findings stopped changing the build).

## Final design

See `docs/specs/watchdog-test-runner-floor.md`. A deterministic, 60-minute
bounded floor for matched test runners and their ancestors, applied inside the
stuck-child search; live reads of `stuckCommandSec` / `hardCeilingSec`.

## Residual, accepted

- A hung process inside a runner's own subtree is shielded up to 60 minutes.
- Late-starting tests under a long-lived wrapper get less than 60 minutes.
- Paths with spaces are not matched (falls back to today's judge).
- One-judge-call snapshot race for a wrapper that starts tests mid-poll.
