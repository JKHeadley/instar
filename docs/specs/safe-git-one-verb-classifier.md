---
title: "SafeGitExecutor: one verb classification for every surface"
slug: safe-git-one-verb-classifier
date: 2026-10-13
author: echo
tracking: EVO-028
parent-principle: "Structure > Willpower"
parent-principle-fit: "The git funnel is a safety control whose value is that there is no legitimate way around it. A verb that neither surface will run pushes callers to bypass the funnel or pick a weaker instrument. One table that every surface reads removes the contradiction by construction, and a test keeps it removed."
binding-standards: ["Structure > Willpower", "Signal vs. Authority", "Verify the State, Not Its Symbol", "No Silent Degradation"]
eli16-overview: safe-git-one-verb-classifier.eli16.md
approved: true
approved-by: "Evolution proposal EVO-028 carries status approved in the evolution queue. Spec-level approval recorded by Echo under Justin's standing statement of 2026-10-01 17:49 (Telegram topic 102965) that non-critical process approvals are decided at the desk and reported afterwards. The run ends at an unmerged pull request."
---

# SafeGitExecutor: one verb classification for every surface

## Problem statement

`SafeGitExecutor` (`src/core/SafeGitExecutor.ts`) is the only permitted way to run git from instar code. `scripts/lint-no-direct-destructive.js` forbids direct `execFileSync('git', ...)`.

It has five entry points. Two are for writes (`execSync`, `spawn`), two are for reads (`readSync`, `readStream`), and `run` picks between them.

The write surfaces and the read surfaces classify a verb with two separate lists:

- A write surface refuses any verb that is not in `DESTRUCTIVE_GIT_VERBS`, and says "read-only verb, use `readSync`".
- A read surface refuses any verb that is not in `READONLY_GIT_VERBS`, and says "destructive verb, use `execSync`".

A verb in neither list is refused by both, and each refusal names the other surface. `git check-ignore` is such a verb. Both messages were observed in a real test run while writing `tests/unit/repo-gitignore-machine-local-paths.test.ts` (PR #2118).

Measured on `main` at `f534efdc6`: the write list has 34 verbs, the read list has 37, and 6 are in both (`branch`, `config`, `format-patch`, `remote`, `stash`, `worktree`). `git --list-cmds=main` reports 170 commands on this machine, so most git commands are in neither list. Most of those should stay unreachable. The defect is that the refusal is contradictory, and that one clearly read-only verb a caller needed is among them.

A seventh verb, `reflog`, is shape-checked (`reflog expire` is a write, `reflog show` is a read) but is listed only as read-only. The write surfaces accept `reflog expire` anyway, because the shape check answers before the list is consulted. So the lists already do not describe what the code does.

## What exists (verified on `main` = `f534efdc6`)

- `DESTRUCTIVE_GIT_VERBS` at `SafeGitExecutor.ts:56` and `READONLY_GIT_VERBS` at `:96`. Both are exported. Outside the file they are imported only by `tests/unit/SafeGitExecutor.test.ts` and `tests/unit/SafeGitExecutor-sourceTreeReadOk.test.ts`.
- `isReadOnlyShape(verb, verbArgs)` at `:658` returns `true` or `false` for the seven shape-checked verbs and `null` for every other verb.
- `execSync` (`:1069`) and `spawn` (`:1125`) refuse when the shape is read-only, or when the shape is `null` and the verb is not in the write list.
- `readSync` (`:1202`) and `readStream` (`:1163`) refuse when the shape is a write, or when the shape is `null` and the verb is not in the read list.
- `run` (`:1258`) reads `args[0]` as the verb and routes on the two lists.
- `scripts/run-migration.js:150` and `scripts/lint-no-direct-destructive.js:658` each carry their own verb list for a different job (a one-shot codemod, and a scan of shell strings). Neither is consulted at run time.
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

All four direct surfaces call it and nothing else to decide:

| Classifier says | `execSync`, `spawn` | `readSync`, `readStream` |
|---|---|---|
| `write` | run | refuse: "use `execSync`" (today's message) |
| `read` | refuse: "use `readSync`" (today's message) | run |
| `unclassified` | refuse, one shared message | refuse, the same message |

The shared message is:

> `SafeGitExecutor: git verb '<verb>' is not classified. It is not in GIT_VERB_CLASSES, so no surface will run it. Adding a verb is a reviewed change to that table.`

The audit row for this refusal carries the reason `unclassified-verb`. The existing reasons for a classified verb sent to the wrong surface are unchanged.

For a classified verb, every surface accepts and refuses exactly what it accepts and refuses today. The two changes in outcome are in section 4.

### 3. `run`

`run` keeps reading `args[0]` as the verb. Its routing is rewritten on the classifier: `write` goes to `execSync`, everything else goes to `readSync`. An unclassified verb therefore reaches `readSync` and gets the shared message, where today it got "destructive verb, use `execSync`".

Reading `args[0]` when a pre-verb flag such as `-c` comes first is a known defect (EVO-029 item 1). Fixing it turns on a commit and a push in `src/commands/machine.ts` that have never run. That is out of scope here and this change does not alter it: with a pre-verb flag first, `args[0]` is the flag, the classifier says `unclassified`, and `run` goes to `readSync` exactly as it does today.

### 4. The two changes in what git commands can run

1. `check-ignore` runs through `readSync` and `readStream`. It reads ignore rules and writes nothing. It has no option that writes a file or names a program to run.
2. `run(['reflog', 'expire', ...])` and `run(['reflog', 'delete', ...])` route to `execSync`, which already accepts them when called directly. Today `run` sends them to `readSync`, which refuses. No caller in `src/` passes `reflog` to any surface, so no running code changes behaviour.

No other verb is added. In particular the diff plumbing verbs (`diff-tree`, `diff-index`, `diff-files`, `range-diff`, `whatchanged`) accept `--output=<file>`, and `verify-commit` and `verify-tag` run the program named by `gpg.program`, which repository-local config can set. They stay unclassified. Verbs already in the read list with a write form (`hash-object -w`, `symbolic-ref`, `write-tree`, `--output` on `diff`, `log` and `show`) are EVO-029 item 4 and are not changed here.

## What it does not do

- It does not add a forbidden list. A verb outside the table is unclassified, and that is already a refusal. A second list of "known and forbidden" verbs would have to be kept in step with git releases for no change in behaviour.
- It does not change `SOURCE_TREE_READ_TIER_VERBS`, the source-tree guard, the environment scrubbing, or the audit log format.
- It does not change `scripts/run-migration.js` or the lint's own verb list.
- It does not fix any EVO-029 item except, as a consequence of the single table, item 2 (`reflog` through `run`).

## Decision points touched

| Decision point | Classification | Justification |
|---|---|---|
| Which surface may run a given git verb (the funnel's verb gate) | `invariant` | A closed table lookup plus the existing per-verb shape checks. There are no competing signals to weigh: a verb is in the table or it is not. The gate must give the same answer every time and must fail closed for anything unknown, so a judgment step would only add a way to be wrong. |

This change does not add a decision point. It makes one existing gate consistent across its surfaces. The gate already holds blocking authority by design (Signal vs. Authority: it is a deterministic authority over a closed enumeration, not a brittle detector of meaning).

## Verify the State, Not Its Symbol

The change introduces one check and one guard test.

- **Symbol:** the verb string found after the pre-verb flags, and its arguments.
- **State claimed:** "this git invocation only reads" or "this git invocation may write".
- **Corroboration:** none at run time. The table is a reviewed, closed enumeration, and section 4 records for the one added verb why it has no write form. The claim for existing verbs is inherited unchanged, including the known gaps listed under EVO-029 item 4.
- **Symbol present, state absent:** a verb classed `read` that can write. Known cases are named above and are out of scope. This change adds no new one.
- **State present, symbol absent:** a harmless verb that is not in the table. It is refused. That is the intended fail-closed side.
- **Unmeasurable:** a verb not in the table is reported as `unclassified`. It is never treated as read or as write.

## Multi-machine posture

No state, file, notice, URL or network call is added. The change is in-process classification code that ships identically to every machine in the package. There is no machine-local surface to justify.

## Frontloaded Decisions

1. **One table with three classes, and the two exported sets derived from it.** Chosen over making one set authoritative and deriving the other, because `shape` verbs belong to both and `reflog` shows that a two-list form already misdescribes the code.
2. **No forbidden list.** See "What it does not do".
3. **Only `check-ignore` is added.** It is the verb a caller needed. Each further verb needs its own check for write forms and program execution, and none has a caller.
4. **`reflog` becomes `shape` in the table**, which makes `run` route `reflog expire` to `execSync`. Accepted because `execSync` already runs it directly and nothing calls it.
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
6. Through the real surfaces, in a sandbox repository: an unclassified verb (`daemon`) is refused by `execSync`, `spawn`, `readSync`, `readStream` and `run` with the same message, and that message does not name another surface.
7. `readSync(['check-ignore', '-q', <ignored path>])` succeeds in a sandbox repository whose `.gitignore` ignores that path, and `execSync(['check-ignore', ...])` is refused with "use `readSync`".
8. `run(['reflog', 'expire', '--expire=now', '--all'])` executes in a sandbox repository; `run(['reflog'])` reads.
9. Regression: `run(['-c', 'x=y', 'status'])` is still refused, as it is today.

Disconfirmation, run before the fix is written and recorded in the pull request: tests 6 and 7 fail on `main`.

The existing test `DESTRUCTIVE_GIT_VERBS and READONLY_GIT_VERBS overlap only on shape-checked verbs` is updated to include `reflog`.

Integration and end-to-end tiers: the change adds no route, no injected dependency and no feature that can be alive or dead in a running server. The real-surface tests in a sandbox repository (6 to 9) are the highest tier that exists for this code. The full existing suite must stay green.

## Maturation plan

None. The change is complete when merged. EVO-029 remains open for its other five items.
