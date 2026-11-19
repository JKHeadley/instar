# Convergence Report: instar nuke no longer stops sessions started in another agent's home

Spec B-min, cut from the unconverged draft `nuke-teardown-by-ownership` (6 rounds) under the split the Chief of Staff approved (msg 718c4317).

## Iteration Summary

| Round | Reviewers | Material findings | Outcome |
|---|---|---|---|
| Standards-Conformance Gate | ran (6 flags) | start folder ≠ writes; lexical fallback; check/delete race; the dev-run count; reproduction on the real path | All addressed: false claim removed; ambiguous refuses; the delete re-guards; session-id sets; real-tmux run on old code |
| 1 | codex, cc, internal | nested home; loaded job vs file; side-effect-free check; unregister in the result; out-of-home writer; second listing; test sandboxing | Fixed |
| 2 | codex, cc, internal | carve-out order; nested home under `--here`; server replacement; contradictory entry; failed list or stop; ancestor or stale registry; `--also-stop` | Fixed (unregistered `echo-wt-*` homes measured; sibling homes count) |
| 3 | codex, cc, internal NO MATERIAL | exclusive allowance; offline tmux; partial entry states; which list authorises; delimiter | Fixed |
| 4 | codex, cc | persistent worker; symlinked `~/.instar`; unreadable registry; entry with neither field | Fixed |
| 5 | codex, cc (minor) | empty name; unregistered nested home; has-session errors; conflicting entry fields; Linux running unit; unstable `print` format | Fixed, not re-reviewed |

From round 3 on, every finding was a further case where nuke now refuses or does less. No round found a case where the design stops or deletes more than today's command. The internal reviewer, who checked against the code each round, returned NO MATERIAL at round 3 on that question.

## Convergence verdict

Brought to the Chief of Staff after 5 rounds:
- The design is stable.
- Late findings are edge-case refusals.
- The round-5 fixes are unreviewed.

## Approval

Approved by the Chief of Staff at 01:44 PT on 2026-11-19 (msg a9037bba), at commit 4c9a117ba. Approval conditions:
- The round-5 fixes are covered by the build's second pass, which looks at these five specifically:
  - the empty name;
  - an unregistered nested home;
  - `has-session` errors;
  - the Linux running unit;
  - `launchctl list` in place of parsing `print`.
- All tests stay sandboxed.
