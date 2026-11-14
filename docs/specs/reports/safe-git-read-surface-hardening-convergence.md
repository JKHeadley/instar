# Convergence Report — SafeGitExecutor: route past pre-verb flags, and make the read surfaces mean read

## Cross-model review: codex-cli:gpt-6-astra

A real GPT-tier external pass ran through the agent's codex CLI in all six rounds (each round's spec body differed, so none was delta-skipped). The Anthropic clean-door reviewer (`claude-code:claude-opus-5-5`) also ran in every round; it is a second read on the same model family, recorded separately and not counted as cross-model. Gemini was not authed on this machine (`gemini-not-authed`).

## ELI10 Overview

Instar only runs git through one safety funnel. The funnel has a door for commands that change things and a door for commands that only read. This change is about the read door. Before it, several commands that went through the read door could still write files or start other programs, through an option most people never use: save output to a file, add a remote, set a config value, open search results in a program named on the command line, run a program while listing a remote. The read door judged mostly by the command's name.

After this change, each risky command has a short list of the reading forms that are known to be safe, and anything else is treated as a write (sent to the write door, which has its own protections) or refused everywhere if it would start a program. Settings and environment variables passed with a read are limited the same way. The helper that picks a door now looks at the real command word, not the first word, which also fixes a hidden bug: one step of forcing a machine to take over has never run, while the screen said it had.

That step is removed rather than switched on, because reviewers showed that running it now would leave a broken file in exactly the race it is for. Nothing changes in practice, and the message now says what really happens. Two older weaknesses in how the server shares such a takeover were found and reported separately.

## Original vs Converged

- **From deny-lists to admit-lists.** The first draft listed the bad options for each command. Every review round found a way around a list like that: a hidden alias (`ls-remote --exec`), git reading `--` as an option's value (`grep -e -- -O<cmd>`), shortened option names (`--in-pl`, `--fil`, `--unset-up`), a short option with its value attached (`branch -uzz9`), and a "this is a read" marker that was really another option's value (`branch --format --list x`, `format-patch --subject-prefix --stdout`). The converged spec admits only known reading forms through one scanner that parses options the way git does and reports which options it really saw.
- **Environment variables.** The first draft did not look at them. Reviewers showed a caller-supplied `GIT_EXTERNAL_DIFF`, `PATH` or `GIT_TRACE` runs a program or writes a file. The converged spec admits only a short list of variables a caller adds or changes, and leaves the inherited environment alone, so an existing caller that passes a full copy of the environment keeps working.
- **The source-folder opt-out.** Review found that a few reading commands could skip the protection for Instar's own source folder by name alone, so a writing form of them would get past it. The converged spec limits the opt-out to reads (and the one download command it was written for).
- **The takeover step.** The first draft switched it on. Round 1 showed it would commit on stale data; round 2 showed that even routing it through the server's own careful code corrupts the registry file. The converged spec removes it, picks the printed line from what the server will actually do (four cases), and reports the two older weaknesses as feedback `fb-c5958717-00b`.
- **Smaller corrections.** Relative `-C` paths now resolve the way git resolves them; `config -ze` (editor in a short cluster) is refused; `-l` is no longer read as "list" for `branch`; the read guarantee is stated exactly, with its boundaries.

## Iteration Summary

Internal reviewers ran on the authoring session's model (Opus 5.5) throughout. Scalability was folded into the integration reviewer every round, and in rounds 3 to 6 several lenses were combined into fewer agents, with each lens named in its brief.

| Iteration | Reviewers who flagged | Design findings | Left behind | Spec changes |
|-----------|-----------------------|-----------------|-------------|--------------|
| 1 | security, adversarial, integration, decision, lessons, codex, clean-door | 14 | 9 | admit-lists, env channel, source-tree opt-out, lease via casWrite, guarantee wording |
| 2 | security, adversarial, integration, decision, lessons, codex, clean-door | 9 | 6 | env admit-list, branch/config grammars, lease removed, PrHandLease env case |
| 3 | security, integration+adversarial, codex | 4 | 6 | scanner reports seen flags, format-patch grammar, local-medium line, -l |
| 4 | integration+adversarial, codex | 2 | 5 | observe-only outlook, hedged git line, -l removed |
| 5 | codex | 1 | 6 | config `-ze` refused, wording |
| 6 | (none) | 0 | 7 | precision only: path resolution order, guarantee qualifier |

Standards-Conformance Gate: ran every round. Round 1: 2 flags (Signal vs. Authority; Verify the State). Rounds 2-3, 5-6: 1 flag (Signal vs. Authority). Round 4: 2 flags (Signal vs. Authority; a `branch -l` Verify-the-State flag, measured and fixed).

## Proportion

Tier 2 (security-sensitive): about 600 lines across `SafeGitExecutor.ts`, `machine.ts`, the shell lint and tests; 6 of 6 rounds used. The rounds were spent on real bypasses found by measurement, not wording.

## Left behind

- Standards-Conformance Gate, Signal vs. Authority, flagged every round: deterministic refusal outside the registry's emergency-stop exception. Accepted: the spec grounds it in the registry's closed-schema clause (`STANDARDS-REGISTRY.md:230`, `:296`) and `signal-vs-authority.md:75-76`, states each refusal's wrong-block cost, and notes the documents' disagreement already reported as `fb-69615365-30f`. Every internal lessons reviewer judged this adequate.
- `leaseKeptInGit` / `leaseObserveOnly` repeat the server's boot logic rather than share it; tests pin the cases. A shared pure function is a later refactor of the server's boot path.
- Seven verbs with no funnel caller keep reviewed grammars rather than becoming `unclassified`: the approved proposal asked for shape checks; removing verbs is a separate table-policy decision.
- `parseVerb`'s accepted pre-verb grammar is the existing closed set (`PRE_VERB_FLAGS_*`), unchanged; not re-listed in the spec.
- `DESTRUCTIVE_GIT_VERBS` keeps its name although it now holds `grep`, `ls-remote` and `help`; only tests import it.
- No-value options written as `--name=value` and pre-2.46 meanings of `config get`/`list` and `ls-remote --branches` fall outside the grammars or fail in git; both fail closed.
- `GIT_OPTIONAL_LOCKS=0`, a partial `HARDENED_GIT_CONFIG` prefix, `GIT_ALLOW_PROTOCOL` and `GIT_EDITOR=false` pins were considered and declined with reasons in section 4.
- The canary watches the test machine's git, not the fleet's (stated in the spec).
- Pre-existing lease-sharing gaps: filed as `fb-c5958717-00b`.

## Full Findings Catalog

**Round 1.** Security: `ls-remote --exec` alias bypass (design, fixed by admit-list); `--` as an option value (`grep -e --`, `ls-remote -o --`) (design, fixed); `branch` abbreviations (design, fixed); caller env (design, fixed); `HARDENED_GIT_CONFIG` does not neutralise repo filters (design, wording corrected). Adversarial: CLI lease commit on stale base without CAS (design, redesigned); detached HEAD loses the claim (design, moot after removal); false CLI line for commit failures (design, fixed). Integration: source-tree opt-out by verb name (design, fixed); lease medium check not the server's (design, fixed); existing tests not named (precision, listed); ecosystem `-c` pair (precision, dropped); `run` double realpath (precision, `parseVerb` is pure). Decision: lint-hit rule for agent-installed files (design, decision 12); push scope (design, moot). Lessons: guarantee wording (design, fixed); env channel (design, fixed); git-version drift unmeasured (design, canary); CLI line false for some failures (design, fixed). Codex: untrusted-repo guidance contradicts boundary (design, rewritten); closed-grammar claim exceeds deny-list checks (design, admit-lists). Clean-door: `--` value bypass (design, fixed); deny-list vs fail-closed (design, fixed).

**Round 2.** Security: env deny-list bypassed by `HOME`/`PATH`/`GIT_TRACE` (design, admit-list); `config --fil --get` (precision→fixed with admit grammar); `branch -u<x>` (fixed). Adversarial and integration: role edits + `pull --rebase --autostash` corrupt `registry.json` (design, lease propagation removed); rejected push leaves a stuck rebase (design, filed); `PrHandLease` passes `{...process.env}` on a read (design, env rule judges changed keys only). Lessons: wrong exemption cited (precision, re-grounded); running server race (design, moot). Decision: role/pull order undecided (design, moot). Codex: `config --edit` vs `branch --edit-description` inconsistency (design, both refused); lost-race role restore (design, moot). Clean-door: env deny-list (design, fixed).

**Round 3.** Security: `branch --format --list newb` and `format-patch --subject-prefix --stdout` classified read (design, scanner reports seen flags; format-patch admit grammar). Integration+adversarial: local medium never carries the claim (design, line chosen by medium, filed); git medium shares through weak pull (design, filed, wording); hung-stream test passes a changed `PATH` (precision, test changed). Decision+lessons: `HOME` claim untestable (precision, removed); canary-failure rule (precision, decision 14). Codex: `branch -l` meant `--create-reflog` on old git (design, fixed). Clean-door: zero-caller verbs (precision, reason stated); untested server-carry claim (design, line corrected).

**Round 4.** Integration+adversarial: observe-only machines never acquire (design, fourth outlook); `sync()` is the first carrier (precision, wording). Security: nothing material. Decision+lessons: unknown outlook printed as definite (precision, third line). Codex: `-l` in grammar (design, removed); git line promises handover (precision, hedged). Clean-door: env pins, shared boot logic, threat model (precision).

**Round 5.** Security+adversarial: nothing material. Integration+decision+lessons: nothing material; three wording fixes. Codex: `config -ze` runs the editor (design, measured and refused). Clean-door: `diff.external=` wording, env removal, local path as remote, partial HARDENED prefix (precision, all addressed).

**Round 6.** All-lens reviewer: relative `--git-dir` resolved before later `-C` (precision, fixed and tested). Codex: guarantee qualifier, "immune" wording, pre-verb grammar (precision). Clean-door: env threat model, shared boot logic, `--name=value` (precision).

## Convergence verdict

Converged at round 6 of 6 (Tier 2 cap). The final round found nothing that changes what gets built; seven items are left behind with reasons. Every round included a real GPT-tier external pass. The spec is ready for approval and build.
