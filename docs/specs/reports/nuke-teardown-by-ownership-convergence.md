# Convergence Report: instar nuke tears down only what the agent home owns

**Status: NOT converged at the round cap (6).** Every round found design-level items, and each round's fixes widened the design: session tagging across about a dozen spawners, three locks, a process scan, push escape hatches. The round-6 findings concern safety:
- the ownership rules contradict each other;
- the process scan matches paths by substring and would catch the nuke command itself;
- the tag list misses six or seven session creators;
- the lock order can conflict with install's.

Brought to the Chief of Staff with a recommendation to narrow (see below).

## Iteration Summary

| Round | Findings | Outcome |
|---|---|---|
| 1 | codex 3, cc 2, internal (live data) | Ownership by registry, or by name and folder; plan, then check each delete; exact launch entry; teardown order; `=name` targets |
| 2 | codex 5, cc 4, internal | All supervisors; verified bootout and unlink; teardown lock; most specific home; session-id stops; nested-home refusal; push kept |
| 3 | codex 4, cc 3, internal | `--here` never pushes; H kept as a candidate; Linux KillMode; plist unlink in pre-check; unnamed sessions ambiguous; locks |
| 4 | codex 4, cc 2 | Narrowed: `nukeHere`'s file restore split out (fb-c05cedd1-82b); per-home lock; loaded job and file both checked; `--skip-backup`; audit written outside H |
| 5 | codex 3, cc 2 | Session tagging; process scan; label lock; partial states |
| 6 (cap) | codex 4, cc 3, internal material | Not applied: contradictory ownership rules, substring process scan, missing spawners, lock order |

## Recommendation

**Split again.** Spec B-min would be the narrowing fix only. It must strictly narrow what today's nuke does, never widen it:
- a session is stopped only if today's rule would stop it (its name starts with `<projectName>-`) AND its start folder is the canonical home or inside it, compared component-wise;
- sessions in another agent's home survive, which is the fb-7e502374-a36 fix;
- exact `=name` and session-id targets;
- the auto-start entry is removed first, and only when its `WorkingDirectory` and `--dir` equal the home;
- every delete is checked before teardown through `checkScope`, with the `nukeAgentHomeScope` allowance;
- the result is honest.

Since every change only removes cases from today's behaviour, it cannot introduce a new wrong kill.

**Spec C** would take the hardening: session tags at every spawner (with a lint), locks, the writer process scan, and push escape hatches.

## Convergence verdict

Not converged. Awaiting the Chief of Staff's decision on the split.
