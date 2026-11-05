---
title: "SafeGitExecutor: one verb classification for every surface"
slug: safe-git-one-verb-classifier
date: 2026-10-13
author: echo
tracking: EVO-028
parent-principle: "Structure > Willpower"
parent-principle-fit: "The git funnel is a safety control whose value is that there is no legitimate way around it. A verb that neither surface will run pushes callers to bypass the funnel or pick a weaker instrument. One table that every surface reads removes the contradiction by construction, and a test keeps it removed."
binding-standards: ["Structure > Willpower", "Signal vs. Authority", "Verify the State, Not Its Symbol", "No Silent Degradation"]
lessons-engaged: "P2 Signal-vs-Authority (funnel authority is pre-existing; this change adds none); Verify the State (a read answer is the funnel's classification, not proof); Fail closed on the unknown; Migration Parity (declined: no agent-installed file); Agent Awareness (declined: internal, no capability or route)"
eli16-overview: safe-git-one-verb-classifier.eli16.md
approved: true
approved-by: "Evolution proposal EVO-028 carries status approved in the evolution queue. Spec-level approval recorded by Echo under Justin's standing statement of 2026-10-01 17:49 (Telegram topic 102965) that non-critical process approvals are decided at the desk and reported afterwards. The run lands through the normal instar-dev pull request path."
review-convergence: "2026-11-05T03:26:01.354Z"
review-iterations: 3
review-completed-at: "2026-11-05T03:26:01.354Z"
review-report: "docs/specs/reports/safe-git-one-verb-classifier-convergence.md"
cross-model-review: "codex-cli:gpt-6-astra"
single-run-completable: true
frontloaded-decisions: 9
cheap-to-change-tags: 0
contested-then-cleared: 4
---

# SafeGitExecutor: one verb classification for every surface

## Problem statement

`SafeGitExecutor` (`src/core/SafeGitExecutor.ts`) is the only permitted way to run git from instar code. `scripts/lint-no-direct-destructive.js` forbids direct `execFileSync('git', ...)`.

It has five entry points. Two are for writes (`execSync`, `spawn`), two are for reads (`readSync`, `readStream`), and `run` picks between them.

The write surfaces and the read surfaces classify a verb with two separate lists:

- A write surface refuses any verb that is not in `DESTRUCTIVE_GIT_VERBS`, and says "read-only verb, use `readSync`".
- A read surface refuses any verb that is not in `READONLY_GIT_VERBS`, and says "destructive verb, use `execSync`".

A verb in neither list is refused by both, and each refusal names the other surface. `git check-ignore` is such a verb. Both messages were observed in a real test run while writing `tests/unit/repo-gitignore-machine-local-paths.test.ts` (PR #2118).

Measured on `main` at `ba4215cbc`: the write list has 36 verbs, the read list has 37, and 6 are in both (`branch`, `config`, `format-patch`, `remote`, `stash`, `worktree`). `git --list-cmds=main` reports 170 commands on this machine (git 2.50.1), and 104 of them are in neither list. Most of those should stay unreachable. The defect is that the refusal is contradictory, and that `check-ignore`, a verb a caller reached for, is among them.

That caller was a test. It worked around the refusal by staging files instead, and its header now explains why staging is the better check for that purpose. No code in `src/` or `scripts/` calls `check-ignore` today; a few tests call git directly with a `safe-git-allow` marker. The value of this change is a funnel that gives one honest answer, and a verb that is reachable the next time someone needs it, in the repository where it was first needed.

A seventh verb, `reflog`, is shape-checked (`reflog expire` is a write, `reflog show` is a read) but is listed only as read-only. The write surfaces accept `reflog expire` anyway, because the shape check answers before the list is consulted. So the lists already do not describe what the code does.

## What exists (verified on `main` = `ba4215cbc`)

- `DESTRUCTIVE_GIT_VERBS` at `SafeGitExecutor.ts:57` and `READONLY_GIT_VERBS` at `:101`. Both are exported. Outside the file they are imported only by `tests/unit/SafeGitExecutor.test.ts` and `tests/unit/SafeGitExecutor-sourceTreeReadOk.test.ts`.
- `isReadOnlyShape(verb, verbArgs)` at `:664` returns `true` or `false` for the seven shape-checked verbs and `null` for every other verb.
- `execSync` (`:1101`) and `spawn` (`:1158`) refuse when the shape is read-only, or when the shape is `null` and the verb is not in the write list.
- `readSync` (`:1237`) and `readStream` (`:1197`) refuse when the shape is a write, or when the shape is `null` and the verb is not in the read list.
- `run` (`:1294`) reads `args[0]` as the verb and routes on the two lists.
- `scripts/run-migration.js:150` and `scripts/lint-no-direct-destructive.js:739` each carry their own verb list for a different job (a one-shot codemod, and a scan of shell strings). Neither is consulted at run time.
- No caller in `src/` passes `reflog` to any surface.

## Proposed design

### 1. One table

Add one exported table in `SafeGitExecutor.ts`:

```ts
export type GitVerbClass = 'read' | 'write' | 'shape';
export const GIT_VERB_CLASSES: ReadonlyMap<string, GitVerbClass>;
```

- `read`: every form of the verb is treated as a read.
- `write`: every form of the verb is treated as a write.
- `shape`: the verb has both forms, and `isReadOnlyShape` decides per call.

Every verb appears once. The table holds exactly the verbs in today's two lists, with these classes:

- `shape`: the six verbs in both lists today, plus `reflog`.
- `write`: every other verb in today's write list.
- `read`: every other verb in today's read list, plus `check-ignore`.

`DESTRUCTIVE_GIT_VERBS` and `READONLY_GIT_VERBS` stay exported and are derived from the table: write list = `write` + `shape`, read list = `read` + `shape`. Their membership is unchanged except that the read list gains `check-ignore` and the write list gains `reflog`.

`isReadOnlyShape` keeps its seven cases unchanged. A unit test asserts that it returns non-`null` for exactly the verbs the table marks `shape`, so the table and the switch cannot drift apart.

### 2. One classifier

Add one exported pure function:

```ts
export type GitInvocationClass = 'read' | 'write' | 'unclassified';
export function classifyGitInvocation(verb: string, verbArgs: readonly string[]): GitInvocationClass;
```

It looks the verb up in the table. `read` and `write` answer directly. `shape` asks `isReadOnlyShape`. A verb not in the table is `unclassified`.

All four direct surfaces use it as the only answer to "may this run here". To keep today's wording and audit reasons, a surface that refuses a classified verb then looks the verb up in `GIT_VERB_CLASSES`: a `shape` verb gets today's "shape" message and reason, any other verb gets today's "verb" message and reason.

`classifyGitInvocation` answers what the funnel classifies an invocation as. A `read` answer is not proof that git will write nothing; see "Verify the State".

| Classifier says | `execSync`, `spawn` | `readSync`, `readStream` |
|---|---|---|
| `write` | run | refuse: `readSync` says "use `execSync`", `readStream` says "use `spawn`" (today's messages) |
| `read` | refuse: today's messages, which name the read surface | run |
| `unclassified` | refuse, one shared message | refuse, the same message |

The shared message is:

> `SafeGitExecutor: git verb '<verb>' is not classified. It is not in GIT_VERB_CLASSES, so no surface will run it. Adding a verb is a reviewed change to that table.`

The refusal is a `SafeGitExecutorError`, because `leaseMediumSelection.ts:67` branches on that type. The audit row carries the reason `unclassified-verb`. The existing reasons for a classified verb sent to the wrong surface are unchanged.

**The unclassified check comes first on every surface.** `execSync` and `spawn` run the source-tree guard before they classify; `readSync` and `readStream` classify first. Left alone, an unclassified verb on the source tree would get `SourceTreeGuardError` from two surfaces and the shared message from the other two. So once the verb and targets are extracted, all four surfaces refuse an unclassified verb before anything else, through one shared helper, and the `execSync` doc comment is updated to say so. The call was refused anyway, so nothing newly refuses, and only the error it reports changes. For a classified verb the order of guard and classification on each surface stays as it is today.

For a classified verb, every surface accepts and refuses exactly what it accepts and refuses today. The two changes in outcome are in section 4.

### 3. `run`

`run` keeps reading `args[0]` as the verb. Its routing is rewritten on the classifier: `write` goes to `execSync`, everything else goes to `readSync`. `readSync` then does its own verb extraction, so `run`'s answer only routes the call and the receiving surface decides. A verb that really is unclassified gets the shared message, where today it got "destructive verb, use `execSync`". The classifier's doc comment and the comment on the read list are corrected to say what `read` means.

Reading `args[0]` when a pre-verb flag such as `-c` comes first is a known defect (EVO-029 item 1). Fixing it turns on a commit and a push in `src/commands/machine.ts` that have never run. That is EVO-029 item 1 <!-- tracked: CMT-1124 --> and this change does not alter it: with a pre-verb flag first, `args[0]` is the flag, the classifier says `unclassified`, and `run` goes to `readSync` exactly as it does today.

### 4. The changes in what git commands can run

1. `check-ignore` runs through `readSync` and `readStream`, and it joins `SOURCE_TREE_READ_TIER_VERBS`, so a caller that passes `sourceTreeReadOk: true` can run it on the instar source tree. Without that second part the verb would stay refused in the repository where it was first needed, and on any agent home that is an instar source checkout. It reads ignore rules and writes nothing; measured on git 2.50.1, the index was unchanged. It has no option that writes a file or names a program.

   It does not escape repository config. A repository-local `core.fsmonitor` runs its program under `check-ignore`, measured, unless `--no-index` is passed. `status`, `ls-files` and `diff`, all already reachable and already in the read tier, do the same, so this adds no new class of risk. That exposure is tracked as EVO-029 item 5.

   Its exit code is its answer: 0 means a rule matched (with `-v`, a `!` negated rule also exits 0), 1 means no rule matched or the file is tracked, and 128 means git failed, including when no path is given. `readSync` rethrows the original child-process error, so `err.status` survives and a caller must branch on it. Treating every throw as "not ignored" would turn a broken repository into a false answer. A test pins the three outcomes. The answer is not purely the repository's. Through the funnel, `check-ignore` still reads `.git/info/exclude` and the per-user ignore file (`$XDG_CONFIG_HOME/git/ignore`, by default `~/.config/git/ignore`, unless a repo-local `core.excludesFile` overrides it; the funnel's scrubbed environment keeps `HOME`), all measured, so the same repository can answer differently on two machines. A caller that needs the tracked `.gitignore` alone must build a sandbox as `tests/unit/repo-gitignore-machine-local-paths.test.ts` does. An exit 1 writes an audit row with outcome `denied` and a reason starting `subprocess-error:`, as `merge-base --is-ancestor` and other exit-code probes already do. No code reads that row, so this is left as it is.
2. Every `reflog` form that `isReadOnlyReflogInvocation` does not call a read now routes through `run` to `execSync`. That is `expire` and `delete`, and also anything else other than bare `reflog`, `show` and `exists`, such as `reflog HEAD`, `reflog -n 5` and `reflog list`. `execSync` already accepts all of these when called directly; today `run` sends them to `readSync`, which refuses. Those read-looking forms run through the write surface, which is the safe direction. No caller in `src/` passes `reflog` to any surface, so no running code changes behaviour.

No other verb is added. Each one needs its own check, and only `check-ignore` is an approved request. The diff plumbing verbs (`diff-tree`, `diff-index`, `diff-files`, `range-diff`, `whatchanged`) accept `--output=<file>`, which is a write form `check-ignore` does not have. `verify-commit` and `verify-tag` always run the program named by `gpg.program` as their main job, where `check-ignore` only inherits the general `core.fsmonitor` exposure. They stay unclassified. Read-list verbs with a write or program-running form are EVO-029 items 4 and 5 and are not changed here.

## What it does not do

- It does not add a forbidden list. A verb outside the table is unclassified, and that is already a refusal. A second list of "known and forbidden" verbs would have to be kept in step with git releases for no change in behaviour.
- It does not change the source-tree guard, its order for a classified verb on any surface, the environment scrubbing, or the audit log format. `SOURCE_TREE_READ_TIER_VERBS` gains `check-ignore` and nothing else.
- It does not change `scripts/run-migration.js` or the lint's own verb list.
- It does not fix any EVO-029 item except, as a consequence of the single table, item 2 (`reflog` through `run`).

## Decision points touched

| Decision point | Classification | Justification |
|---|---|---|
| Which surface may run a given git verb (the funnel's verb gate) | `invariant` | A closed table lookup plus the existing per-verb shape checks over a fixed grammar. There are no competing signals to weigh. The gate must give the same answer every time and must fail closed for anything unknown, so a judgment step would only add a way to be wrong. |

This change does not add a decision point, and it does not add blocking authority. Every verb it refuses is refused today, and the only verbs it newly lets through are `check-ignore` and the `reflog` forms above. The funnel's authority predates this spec. `docs/signal-vs-authority.md` names hard-invariant validators as outside the principle and a deterministic policy evaluator as a valid authority where all inputs can be enumerated, and the funnel is that kind of control: it does not judge meaning, it bounds what instar code may do to a repository. The registry article's wording names only the emergency-stop floor as an exception and does not mention this class. That disagreement between the two documents is reported through the feedback queue. This spec does not rely on the registry granting a new exception.

## Verify the State, Not Its Symbol

The change introduces one check and one guard test.

- **Symbol:** the verb string found after the pre-verb flags, and its arguments.
- **State claimed:** "this git invocation only reads" or "this git invocation may write".
- **Corroboration:** none at run time. The table is a reviewed, closed enumeration, and section 4 records for the one added verb why it has no write form. The claim for existing verbs is inherited unchanged, including the known gaps listed under EVO-029 item 4.
- **Symbol present, state absent:** an invocation answered `read` that writes or runs a program. This exists today and is measured, not theoretical. `readSync(['remote','-v','add','x','url'])` adds a remote and `readSync(['config','k.k','--list'])` writes a value, because the shape checks look at one argument or stop at the first read flag. `remote` is also in the source-tree read tier, so with `sourceTreeReadOk` the `remote` case gets past the source-tree guard too. Every `remote` caller found in `src/` uses a read form. `format-patch -1` writes a patch file, `hash-object -w`, `write-tree` and `symbolic-ref` write, `interpret-trailers --in-place` writes, and `ls-remote --upload-pack=<cmd>` and `diff.external` run a program. So `read` means "the funnel classifies this as a read", not "this writes nothing". The cases are recorded in EVO-029 items 4 and 5 <!-- tracked: CMT-1124 -->. This change keeps every one of those answers, because changing them refuses things that run today, and it adds no new one.
- **State present, symbol absent:** a harmless verb that is not in the table. It is refused. That is the intended fail-closed side.
- **Unmeasurable:** a verb not in the table is reported as `unclassified`. It is never treated as read or as write.

## Multi-machine posture

No state, file, notice, URL or network call is added. The change is in-process classification code that ships identically to every machine in the package. There is no machine-local surface to justify.

## EVO-029 disposition

EVO-029 lists six related items. Each was re-read on `main` at `ba4215cbc`.

> **CMT-1124** — "I will build these through /instar-dev outside the 10-minute scheduled job, one spec at a time, starting with EVO-028 + EVO-029 (one spec, SafeGitExecutor) and EVO-022 (spec already drafted)."

| Item | State on `main` | Disposition |
|---|---|---|
| 1. `run` misroutes on a pre-verb flag | Still present: `src/commands/machine.ts:174` is the only caller, inside a catch-all, so the commit and the push after it never run | Follows. Fixing it turns on a push of machine-registry state to the shared remote. |
| 2. `run(['reflog','expire'...])` refused | Still present; no caller in `src/` | Joins. Section 4, change 2. |
| 3. `update-index --refresh` always refused | Still present: `src/core/GitStateManager.ts:345` calls it through `run`, swallowed by a catch. After this change the swallowed message says "not classified" | Follows. `update-index` has many writing forms, so it needs a shape check before it joins the table. |
| 4. Read-list verbs that can write | Still present, and wider than recorded: `hash-object`, `write-tree`, `symbolic-ref`, `--output` on `diff`/`log`/`show`, `grep -O`, `interpret-trailers --in-place`, `format-patch` output files, and the shape-check gaps in `remote` and `config` (see "Verify the State"). Callers use `symbolic-ref` read forms only (`GitSync.ts:284,449,610`, `InstarWorktreeManager.ts:747,763`) | Follows. It changes what is refused today and needs its own evidence per verb. The EVO-029 record is widened to carry the new cases. |
| 5. Repository config and `-c key=value` running programs under read verbs | Still present: `-c` is skipped as a pre-verb flag with no key check, and repo-local `core.fsmonitor`, `diff.external` and `ls-remote --upload-pack=` ran a program when measured. The only `-c` that reaches a read surface in `src/` is `machine.ts:174`, through the `run` misroute of item 1, and that is a `commit` that is refused. `HARDENED_GIT_CONFIG` (`executorPorts.ts:27`) already neutralises these keys for one path | Follows. It is a new policy decision, not a classification. Any key check must admit the `HARDENED_GIT_CONFIG` keys. |
| 6. Verb lists kept outside the funnel | Still present and stale: `scripts/run-migration.js` lacks `merge-tree` and `commit-tree`, and the shell-string list in `scripts/lint-no-direct-destructive.js:739` lacks `config`, `remote`, `reflog`, `merge-tree` and `commit-tree` | Follows. Neither is read at run time. `run-migration.js` is a one-shot codemod and deletion is the likely end. |

The test for "joins" is whether the item comes with the one table for the four direct surfaces. Only item 2 does. `run` still reads `args[0]`, so with a pre-verb flag first it classifies the flag rather than the verb; that is item 1. Every other item changes which git commands run or adds a policy, and those are the changes that need separate evidence. EVO-029 stays approved and open for items 1, 3, 4, 5 and 6, under CMT-1124.

## Frontloaded Decisions

1. **One table with three classes, and the two exported sets derived from it.** Chosen over making one set authoritative and deriving the other, because `shape` verbs belong to both and `reflog` shows that a two-list form already misdescribes the code.
2. **No forbidden list.** See "What it does not do".
3. **Only `check-ignore` is added.** It is the one verb EVO-028 approved, and a caller did reach for it. Each further verb needs its own check for write forms and program execution, and none has been requested.
3a. **`check-ignore` joins `SOURCE_TREE_READ_TIER_VERBS`.** It is a read that writes nothing and is opt-in per call. Without it the verb stays refused on the instar source tree. The size cap in `tests/unit/SafeGitExecutor-sourceTreeReadOk.test.ts` rises from 13 to 14 as that test's comment requires, and this spec and the side-effects review are the required step.
3b. **An unclassified verb is refused before the source-tree guard on every surface.** See section 2. The guard order for classified verbs is unchanged.
4. **`reflog` becomes `shape` in the table**, which makes `run` route every non-read `reflog` form to `execSync`. Accepted because `execSync` already runs them directly and nothing calls them.
5. **`run` keeps reading `args[0]`.** The pre-verb-flag fix is EVO-029 item 1 and needs its own decision.
6. **Wrong-surface messages keep their current wording.** Only the unclassified case gets a new message.
7. **No config flag, no dry-run stage.** The change is a pure function over a constant table with no stored state. Rollback is reverting the commit.

## Open questions

*(none)*

## Rollback

Revert the commit. There is no stored state, config or migration. After a revert `check-ignore` is unreachable again and the contradictory messages return.

## Agent awareness and migration parity

`SafeGitExecutor` is internal to instar's source. It is not an agent-facing capability, has no route, and installs nothing into an agent's home. The CLAUDE.md template and `PostUpdateMigrator` need no change.

## Tests

Unit (`tests/unit/SafeGitExecutor-verb-classifier.test.ts`):

1. Every verb in the table has exactly one class, and the two exported sets equal the derivation in section 1.
2. `isReadOnlyShape` returns non-`null` for exactly the `shape` verbs.
3. For every `read` verb the classifier answers `read`; for every `write` verb it answers `write`.
4. For every `shape` verb the test holds one read-shaped and one write-shaped argument list and asserts both answers. A `shape` verb with no example fails the test.
5. For every command in `git --list-cmds=main` that is not in the table, the classifier answers `unclassified`. If git is missing the test fails; it does not pass empty.
6. Through the real surfaces, in a sandbox repository and on a source-tree fixture: an unclassified verb (`daemon`) is refused by `execSync`, `spawn`, `readSync`, `readStream` and `run` with the same message, which is a `SafeGitExecutorError` and does not name another surface.
7. `readSync(['check-ignore', '-q', <ignored path>])` succeeds in a sandbox repository whose `.gitignore` ignores that path, and `execSync(['check-ignore', ...])` is refused with "use `readSync`".
8. `run(['reflog', 'expire', '--expire=now', '--all'])` executes in a sandbox repository; `run(['reflog'])` reads; `run(['reflog', 'HEAD'])` runs through `execSync`, shown by spying on it.
9. Regression: with a pre-verb flag first, `run` behaves as it does today. `run(['-c', 'x.y=z', 'status'])` reaches `readSync` and runs; `run(['-c', 'x.y=z', 'commit', ...])` reaches `readSync` and is refused with "use `execSync`".
10. `check-ignore` exit codes through `readSync`: 0 returns the path, a path no rule matches throws with `status` 1, and a directory that is not a repository throws with `status` 128.
11. `check-ignore` on a source-tree fixture is refused by `readSync` without `sourceTreeReadOk` and runs with it, and `SOURCE_TREE_READ_TIER_VERBS` holds it.
12. Membership is pinned against a frozen literal copy of today's verbs, written out in the test and not read from the table: the read and write sets equal that copy plus `check-ignore` and `reflog` as section 1 says. Tests 1, 3 and 5 read the table they check, so this is what catches a verb dropped or moved.

Disconfirmation, run before the fix is written and recorded in the pull request: tests 6, 7, 8, 10 and 11 fail on `main`.

The existing test `DESTRUCTIVE_GIT_VERBS and READONLY_GIT_VERBS overlap only on shape-checked verbs` is updated to include `reflog`. The size cap on `SOURCE_TREE_READ_TIER_VERBS` in `tests/unit/SafeGitExecutor-sourceTreeReadOk.test.ts` rises to 14 and gains an assertion that it holds `check-ignore`.

Integration and end-to-end tiers: the change adds no route, no injected dependency and no feature that can be alive or dead in a running server. The real-surface tests in a sandbox repository (6 to 9) are the highest tier that exists for this code. The full existing suite must stay green.

## Maturation plan

- **test-agent-live:** the unit tests drive the real surfaces against real git in sandbox repositories and a source-tree fixture. The change has no route, server state or agent-installed file, so that is the highest live tier it has.
- **dev-agent-live:** live on the development agent from the release that carries it. Read the audit log for any `unclassified-verb` row that does not come from `GitStateManager.ts:345`.
- **fleet:** the same release, with no switch. It is in-process classification with one refused-today message changed and one verb added.
- **graduation criterion:** the merged tests pass on `main`, and in the first week on the development agent every `unclassified-verb` audit row is either the known `update-index` call or a verb that was refused before this change.
- **dark-window:** none. There is nothing to run dark: the behaviour is a table lookup and rollback is a revert.
- **ladder:** not applicable: internal classification code with no switch or staged rollout.

EVO-029 stays open with its remaining items, as set out under "EVO-029 disposition".
