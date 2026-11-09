---
title: "SafeGitExecutor: route past pre-verb flags, and make the read surfaces mean read"
slug: safe-git-read-surface-hardening
date: 2026-11-05
author: echo
tracking: EVO-029
parent-spec: safe-git-one-verb-classifier.md
parent-principle: "Structure beats Willpower"
parent-principle-fit: "The git funnel is a safety control whose value is that callers cannot get around it. A read surface that writes files or runs programs through an option makes 'read' a label rather than a property. This change makes the classifier admit the read forms it knows instead of denying the bad forms it happens to know, and makes the dispatcher see the verb a caller actually sent."
binding-standards: ["Structure beats Willpower", "Signal vs. Authority", "Verify the State, Not Its Symbol", "No Silent Degradation", "Fail Closed on the Unknown"]
lessons-engaged: "Signal-vs-Authority (deterministic refusal over a closed argument schema, the registry's below-threshold structure clause; one narrow new refusal class, stated with its wrong-block cost); Verify the State (the read guarantee is stated as exactly what the checks enforce, the residual boundaries are named, git-version drift is the declared unmeasurable case with a canary); No Silent Degradation (the force-wakeup line stops claiming a push that never happened); A Repair Implies an Unfound Producer (the swallowed catch-all is removed with the dead code it hid); Migration Parity (declined: no agent-installed file); Agent Awareness (declined: internal, no capability or route)"
eli16-overview: safe-git-read-surface-hardening.eli16.md
approved: true
approved-by: "Evolution proposal EVO-029 carries status approved in the evolution queue (owner commitment CMT-1124). Spec-level approval recorded by Echo at the desk under Justin's standing rule for this repository, 2026-10-22 08:58 PDT: \"I should ONLY have to approve constitution changes.\" This spec changes no constitution text (docs/STANDARDS-REGISTRY.md is cited, not edited). It lands through the normal instar-dev pull request, Local Verify and safe-merge path."
review-convergence: "2026-11-05T22:18:15.464Z"
review-iterations: 6
review-completed-at: "2026-11-05T22:18:15.464Z"
review-report: "docs/specs/reports/safe-git-read-surface-hardening-convergence.md"
cross-model-review: "codex-cli:gpt-6-astra"
single-run-completable: true
frontloaded-decisions: 16
cheap-to-change-tags: 0
contested-then-cleared: 3
---

# SafeGitExecutor: route past pre-verb flags, and make the read surfaces mean read

## Problem statement

`SafeGitExecutor` (`src/core/SafeGitExecutor.ts`) is the only permitted way for instar code to run git. Since EVO-028 (`docs/specs/safe-git-one-verb-classifier.md`, #2776) every surface reads one table, `GIT_VERB_CLASSES`, through one classifier, `classifyGitInvocation`. That spec recorded, and deliberately did not fix, the items of EVO-029. Item 2 closed with it. This spec covers items 1, 3, 4, 5 and 6.

Every item below was re-measured on `main` at `607933a0a` (v1.3.1681) with git 2.50.1, through the real `SafeGitExecutor` in a sandbox repository, or with git directly where marked. The probe and its output are kept with the pull request.

1. **`run` misroutes on a pre-verb flag.** `run` (`:1342`) reads `args[0]` as the verb. `src/commands/machine.ts:175` calls `run(['-c','commit.gpgsign=false','commit','-m',...])`. `args[0]` is `-c`, so the call goes to `readSync`, which refuses it. The call sits in a catch-all, so the force-wakeup lease commit, and the push after it, have never run (the `git add` of the registry before them did run, through `execSync`), and the CLI prints "Lease claimed + pushed" (`machine.ts:1010`), which is false. It is the only caller in `src/` that puts a pre-verb flag first into `run` (all 26 `run` call sites and the six dynamic wrappers were checked).
2. *(closed with EVO-028.)*
3. **`update-index --refresh -q` is always refused.** `src/core/GitStateManager.ts:345` calls it through `run`; `update-index` is not in the table, so it is refused and the catch swallows it.
4. **Read-classified invocations that write or run a program.** Each of these succeeded through `readSync`, or with git directly where marked:
   - `hash-object -w <file>` wrote a blob; `write-tree` wrote a tree; `symbolic-ref refs/heads/zz refs/heads/main` created a symbolic ref; `fsck --lost-found` created `.git/lost-found`.
   - `log -1 --output=<file>` wrote a file; `reflog show --output=<file>` also did (git directly); `diff`, `show`, `stash show` and `format-patch` take the same option.
   - `format-patch -1` wrote `0001-i.patch` into the working directory.
   - `interpret-trailers --in-place` rewrote the file; git accepts the abbreviation `--in-pl` (git directly).
   - `remote -v add evil http://x` added a remote, because the check reads only `verbArgs[0]`.
   - `config probe.key --list` set `probe.key` to `--list`, because the check returns read on the first read flag anywhere. `config --fil --get k v` wrote a file named `--get` (git directly): an abbreviated `--file` takes the next argument as its value.
   - `branch --unset-up` removed `branch.main.merge`, `branch -uzz9` set an upstream, and `branch --edit-desc` ran the editor (git directly): the `branch` check matches exact flags and a few letters.
   - Programs: `grep -O<cmd>` ran `<cmd>` with stdout not a terminal; `ls-remote --upload-pack=<cmd>` ran `<cmd>`, and so did its undocumented alias `--exec=<cmd>` and the abbreviation `--exe`; `help <topic>` runs `man`, `info` or a browser; `config --edit` runs an editor.
   - `--` as an option's value: `grep -e -- -O<cmd>` ran `<cmd>`, and `ls-remote -o -- --upload-pack=<cmd> .` ran it (git directly). A rule that stops scanning at `--` would miss both.
5. **`-c` and the environment.** `readSync(['-c','core.fsmonitor=<cmd>','status'])` ran `<cmd>`; `-c` is skipped with no check. A caller-supplied `opts.env` is a second channel: `GIT_EXTERNAL_DIFF=<cmd>` ran under `diff`; a caller-set `PATH` chose the `ssh` that `ls-remote ssh://…` ran; `GIT_TRACE=<file>` and `GIT_TRACE2_EVENT=<file>` wrote files (git directly). `sanitizeEnv` (`:348`) strips repository-location variables and every `GIT_CONFIG*` variable, then sets `GIT_CONFIG_GLOBAL=/dev/null` and `GIT_CONFIG_NOSYSTEM=1`, so a caller-set `HOME` or `XDG_CONFIG_HOME` does not bring in a config file (a reviewer confirmed this); other program-naming and file-writing variables pass through.
6. **Verb lists outside the funnel.** `scripts/run-migration.js` is a finished one-shot codemod carrying a stale copy of the old rule. The shell-string list in `scripts/lint-no-direct-destructive.js:739` lacks `config`, `remote`, `reflog`, `merge-tree` and `commit-tree`.

Review found two related gaps, in scope because this change would otherwise widen them:

7. **The source-tree opt-out goes by verb name.** `isSourceTreeCheckBypassed` (`:1371`) skips the source-tree guard whenever `opts.sourceTreeReadOk` is set and the verb is in `SOURCE_TREE_READ_TIER_VERBS` (`log`, `show`, `diff`, `remote`, `ls-remote`, `status`, …), whatever the arguments. Once `log --output=<file>` classifies `write`, `execSync` would accept it and skip the guard. `remote add` with `sourceTreeReadOk` through `execSync` already gets past it today. The worktree-manager opt-out (`isSourceTreeWorktreeManagerInvocation`) admits `symbolic-ref` in any form, so a write form gets past the guard there too.
8. **A CLI lease commit cannot be made safe cheaply.** Fixing item 1 would let `claimLeaseForSelf` commit on a standby's stale base, with no pull and no epoch check. Routing it through the server's `GitLeaseStore.casWrite` instead was designed and reviewed, and two reviewers measured that it breaks too: both `wakeup` paths edit roles in `registry.json` before the claim, so the pull's autostash conflicts, `git pull` exits 0 with conflict markers in the file, and `loadRegistry` throws `REGISTRY_CORRUPT`; and a rejected push leaves a rebase stuck in conflict, because `GitSyncManager.pullRebase` does not use the conflict handling `sync()` has.

## What exists (verified on `main` = `607933a0a`)

- `GIT_VERB_CLASS_ENTRIES` (`:68`), `GIT_VERB_CLASSES`, and the derived `DESTRUCTIVE_GIT_VERBS` / `READONLY_GIT_VERBS`. Outside the file, the derived sets are imported only by tests.
- `isReadOnlyShape` (`:684`) and `classifyGitInvocation` (`:715`, `read | write | unclassified`).
- `extractVerbAndTargets` (`:464`) walks the pre-verb flags, calls `realpathSync` on every target, and throws on an unknown leading flag; `--config-env` and `--exec-path=<dir>` throw. With no `cwd`, it takes the first `-C` anywhere in `args` as the working directory, including one after the verb (`grep -C 3`).
- `sliceAfterVerb` (`:723`) finds the verb with `args.indexOf(verb)`, so a `-C` directory or `-c` value spelled like the verb cuts at the wrong place.
- `HARDENED_GIT_CONFIG` (`src/feedback-factory/execute/executorPorts.ts:27`) is the `-c` list the feedback executor puts in front of its git commands on attempt clones. Today it reaches only `execSync` and direct `execFileAsync` calls in `src/ecosystem/`.
- No caller in `src/` passes `-c` to `readSync` or `readStream`. One read caller passes `env`: `PrHandLease.ts:168`, `{ ...process.env, GIT_TERMINAL_PROMPT: '0' }`.
- Every `sourceTreeReadOk` call site in `src/` is a read, except three `fetch` calls: `featureRolloutScan.ts:207`, `releaseReadinessWiring.ts:134`, and `executorPorts.ts:84` (which fetches into `refs/heads/feedback-execute/base`).
- Callers of the verbs whose checks change, checked by the author and three reviewers: `remote` (`remote`, `remote -v`, `remote get-url <name>`; `remote set-url`/`add` through `GitStateManager`'s `run` wrapper, which go to `execSync`); `config --get <key>`, `config --get-regexp <re>`, and writes `config [--local] <key> <value>`; `symbolic-ref` read forms in six places (`GitSync.ts:284,449,610` through `run`, `InstarWorktreeManager.ts:747,763` through `tryGit(..., 'read')`, and `WorktreeMonitor.ts:414` as a shell string outside the funnel); `ls-remote --exit-code <remote> refs/heads/main`, `ls-remote --tags <remote> 'refs/tags/v*'`; `stash list -1`; `branch --list <pattern>` (`BranchManager.ts:487`, `HandoffManager.ts:439`, through `run`, today routed to `execSync` because the old check calls it a write). No funnel caller uses `hash-object`, `write-tree`, `interpret-trailers`, `fsck`, `grep`, `help` or `format-patch`.
- `claimLeaseForSelf` (`machine.ts:134`) builds a signed +1-epoch lease from the local registry, saves it locally, then runs the never-working commit and push in a catch-all.

## Proposed design

### 1. `run` routes on the real verb (item 1)

A new pure function `parseVerb(args)` walks the pre-verb flags and returns `{ verb, verbIndex, configOverrides, pathFlags }`, with no path resolution. `extractVerbAndTargets` uses it and canonicalises the path flags into targets, resolved the way git resolves them: a relative `-C` against `opts.cwd` (today it is resolved against this process's working directory, so a relative `-C` could name a different directory to the source-tree guard than git uses), each later `-C` against the one before (`-C a -C b` is `a/b`), and `--git-dir` / `--work-tree` against the directory all pre-verb `-C` flags lead to, regardless of order (git applies every `-C` first; measured). With no `cwd` it now takes only a `-C` that comes before the verb. Every surface takes `verbArgs = args.slice(verbIndex + 1)`; `sliceAfterVerb` is deleted.

`run` calls `parseVerb`, classifies, sends `write` to `execSync` and everything else to `readSync`, which decides for real as today. `run` does no `realpathSync`. An unknown pre-verb flag throws as today.

`BranchManager` and `HandoffManager`'s `branch --list <pattern>` becomes a read under the new `branch` grammar, so `run` sends it to `readSync`; it runs either way.

### 2. Invocation classes

`GitInvocationClass` becomes `read | write | refused | unclassified`.

- `refused`: a classified verb in a form that runs a program (a pager, an editor, an upload-pack command, a help viewer), or an option of a no-write verb (`grep`, `ls-remote`, `help`) outside its read grammar. **No surface runs these forms, including the write surfaces**, which today would run `grep -O<cmd>`, `ls-remote --upload-pack=<cmd>`, `help <topic>` and `config --edit`. The class exists because no caller needs them, not to close the write surfaces in general: those still run hooks, accept any `-c`, and run write verbs that can name a program (`fetch --upload-pack`, `rebase --exec`), as today. The wrong-block cost is deliberate: there is no escape hatch, and a caller that needs one of these forms needs a reviewed grammar change. No caller in `src/` uses any of them.
- The per-verb checks return `'read' | 'write' | 'refused'`; `isReadOnlyShape` returns that or `null`.
- `refuseUnclassified` becomes `refuseUnrunnable`, called first on every surface as today. `unclassified` keeps its message and audit reason. `refused` throws a `SafeGitExecutorError` with audit reason `program-running-form`:

  > `SafeGitExecutor: 'git <verb>' in this form is refused on every surface: it runs a program or is outside the verb's known read form. Changing that is a reviewed change to its read grammar.`

  The message names the verb and not the arguments, which can hold a URL with a credential.

### 3. Per-verb read grammars (item 4)

**Who supplies the arguments.** Every caller is instar code, but arguments can carry data instar did not write: a ref or branch name, a path, a pattern or a URL from a remote, a user or a model. The grammars make sure such data in an argument position cannot become a writing or program-running option on a read surface. Data placed where git expects a positional can still name a transport (section 4); callers that pass data positionals may also put `--end-of-options` before them, which git 2.24+ honours and which this change does not require.

EVO-029 item 4 asked for shape checks in the existing `reflog` pattern, so the read forms of these verbs stay reachable and each gets a check. Removing the verbs that have no caller from the table instead (they would become `unclassified`) was considered: it is less code, but it is a table-policy change the approved proposal did not ask for.

**The rule changes from "deny the bad options we know" to "admit the read forms we know"** for every verb with a measured write or program form. Every review round found deny-list bypasses (an undocumented alias, `--` consumed as an option's value, abbreviations, an abbreviated option swallowing the read action as its value, a short option with an attached value, and a read marker such as `--list` or `--stdout` that was really another option's value). An admit-list fails closed against all of them and against options a future git adds.

**One option scanner** reads `verbArgs` the way git's option parser does:

- An argument that is exactly an admitted option taking a value consumes the next argument as its value, whatever it looks like, including `--`.
- `--name=value` is admitted when `--name` is an admitted value-taking option. A short value-taking option may carry its value attached (`-e<pattern>`, `-m5`, `-A3`), as git allows.
- `--` that is not consumed as a value ends the options; everything after it is a positional.
- Every other argument starting with `-` must be an admitted option, exactly. Abbreviations and short-option clusters are not admitted unless listed.
- An argument outside the grammar makes the invocation `write` for a verb that has a write form, and `refused` for a verb that has none.
- A value-taking option that is the last argument (git's "use the default" case for options such as `branch --merged`) is outside the grammar. That fails closed.
- The scanner reports which admitted flags appeared as options. A per-verb rule that depends on a marker (`branch`'s list mode, `format-patch`'s `--stdout`) uses that report and never the raw argument list, where the marker can be another option's value: `branch --format --list x` creates branch `x`, and `format-patch --subject-prefix --stdout HEAD~1` writes a patch file (a reviewer measured both).

| Verb | Today | After | Admitted read grammar (options; positionals) | Outside it |
|---|---|---|---|---|
| `write-tree` | read | write | — | always writes a tree object |
| `symbolic-ref` | read | shape | `-q`, `--quiet`, `--short`, `--recurse`, `--no-recurse`; at most one positional | write |
| `hash-object` | read | shape | `--stdin`, `--stdin-paths`, `--no-filters`, `--literally`, `-t <v>`, `--path <v>`; any positionals | write (`-w` writes a blob) |
| `interpret-trailers` | read | shape | `--trim-empty`, `--no-trim-empty`, `--only-trailers`, `--only-input`, `--unfold`, `--parse`, `--no-divider`, `--no-in-place`, `--where <v>`, `--if-exists <v>`, `--if-missing <v>`, `--trailer <v>`; any positionals | write (`--in-place` rewrites files) |
| `fsck` | read | shape | `--unreachable`, `--dangling`, `--no-dangling`, `--root`, `--tags`, `--cache`, `--no-reflogs`, `--full`, `--no-full`, `--connectivity-only`, `--strict`, `--verbose`, `-v`, `--name-objects`, `--progress`, `--no-progress`, `--references`, `--no-references`; any positionals | write (`--lost-found` writes) |
| `grep` | read | shape | `-i`, `--ignore-case`, `-I`, `-w`, `--word-regexp`, `-v`, `--invert-match`, `-n`, `--line-number`, `-l`, `--files-with-matches`, `-L`, `--files-without-match`, `-c`, `--count`, `-q`, `--quiet`, `-h`, `-H`, `-F`, `--fixed-strings`, `-E`, `--extended-regexp`, `-G`, `--basic-regexp`, `-P`, `--perl-regexp`, `-z`, `--null`, `--cached`, `--untracked`, `--no-index`, `--name-only`, `--full-name`, `-o`, `--only-matching`, `--column`, `--and`, `--or`, `--not`, `--all-match`, `--break`, `--heading`, `-e <v>`, `-f <v>`, `-m <v>`, `--max-count <v>`, `-A <v>`, `-B <v>`, `-C <v>`, `--max-depth <v>`, `--threads <v>`; any positionals | refused (`-O` runs a pager) |
| `ls-remote` | read | shape | `--exit-code`, `--tags`, `-t`, `--heads`, `--branches`, `-b`, `--refs`, `-q`, `--quiet`, `--symref`, `--get-url`, `--sort <v>`; any positionals | refused (`--upload-pack`, `--exec`, `-u` run a program) |
| `help` | read | shape | `-a`, `--all`, `-g`, `--guides`, `-c`, `--config`, `--user-interfaces`, `--developer-interfaces`, `--no-external-commands`, `--no-aliases`, `--verbose`; no positionals | refused (a topic runs man, info or a browser) |
| `branch` | shape | shape (admit grammar) | `--list`, `--show-current`, `-v`, `-vv`, `--verbose`, `-a`, `--all`, `-r`, `--remotes`, `--color`, `--no-color`, `--column`, `--no-column`, `--abbrev`, `--no-abbrev`, `-i`, `--ignore-case`, `--omit-empty`, `--sort <v>`, `--format <v>`, `--contains <v>`, `--no-contains <v>`, `--merged <v>`, `--no-merged <v>`, `--points-at <v>`; positionals (name patterns) only when the scan saw `--list` as an option. `-l` is not admitted: before git 2.19 it meant `--create-reflog` | write; `--edit-description` or an abbreviation of it is refused (it runs an editor) |
| `config` | shape | shape (admit grammar) | every option is one of `--get`, `--get-all`, `--get-regexp`, `--get-urlmatch`, `--get-color`, `--get-colorbool`, `--list`, `-l`, `--local`, `--global`, `--system`, `--worktree`, `-z`, `--null`, `--name-only`, `--show-origin`, `--show-scope`, `--includes`, `--no-includes`, `--bool`, `--int`, `--bool-or-int`, `--path`, `--expiry-date`, `--fixed-value`, `--all`, `--regexp`, `-f <v>`, `--file <v>`, `--blob <v>`, `--type <v>`, `--default <v>`, `--url <v>`, `--value <v>`; **and** there is positive evidence of a read: the first positional is `get` or `list`, or a read action comes before the first positional | write; `-e` (alone or inside a short cluster such as `-ze`, which ran the editor when measured), `--edit` or an abbreviation, or the `edit` subcommand, is refused (it runs an editor) |
| `remote` | shape | shape | any number of leading `-v`/`--verbose`, then nothing; or `show` with `-n` and positionals; or `get-url` with `--push`, `--all` and positionals | write |
| `format-patch` | shape | shape (admit grammar) | `--stdout`, `-p`, `--no-stat`, `--stat`, `--numstat`, `--shortstat`, `--summary`, `-k`, `--keep-subject`, `-n`, `--numbered`, `-N`, `--no-numbered`, `--no-signature`, `--signoff`, `-s`, `--thread`, `--no-thread`, `--cover-letter`, `--no-cover-letter`, `--binary`, `--no-binary`, `--full-index`, `--zero-commit`, `--minimal`, `--patience`, `--histogram`, `--no-renames`, `-M`, `-C`, `--root`, `--progress`, `--quiet`, `--ignore-if-in-upstream`, `--no-notes`, `--notes`, `-<n>`, `--subject-prefix <v>`, `--signature <v>`, `--start-number <v>`, `-v <v>`, `--reroll-count <v>`, `--base <v>`, `--in-reply-to <v>`, `--to <v>`, `--cc <v>`, `--add-header <v>`, `--filename-max-length <v>`; any positionals; **and** the scan saw `--stdout` as an option | write (it writes patch files; `-o`, `--output-directory`, `--inline` are outside the grammar) |

`config` keeps its positive-evidence rule on top of the grammar because git's parser stops at the first positional: `config probe.key --list` sets the key. A one-positional `config <key>` is a read in git and a `write` here; that fails closed, and no funnel read uses it.

`stash` (`list`, `show`), `worktree` (`list`) and `reflog` (bare, `show`, `exists`) keep their subcommand checks. Their read subcommands take diff and log options, which the universal rule covers.

**The universal `--output` rule.** Any invocation that would otherwise classify `read` is `write` when **any** argument, before or after `--`, is `--output`, starts with `--output=`, or is an abbreviation of it (`--o` to `--outpu`, with or without `=`). This covers `diff`, `log`, `show`, `rev-list`, `stash show`, `reflog show` and `format-patch` at once, and scanning past `--` removes the question of `--` as a value. The cost is that a path literally named `--output…` is treated as a write (refused on the read surfaces, run on the write surfaces behind the guard). `--output-indicator-new=…` is not an abbreviation of `--output` and is untouched.

`update-index` is not added (section 7).

### 4. The read guarantee, and what it does not cover

What the read surfaces enforce after this change, stated exactly:

> **Subject to the repository-config, inherited-environment and transport boundaries listed below, and as reviewed against git 2.50.1: nothing the caller passes, in arguments, pre-verb `-c` values or `opts.env`, names a program for git to run, except the fixed harmless binaries in the `-c` admit list (`false`, `cat`) and a transport helper that a URL scheme selects from the host's `PATH`. Nothing the caller passes makes git write an object, ref, config value or file. git's own opportunistic refresh of the index stat cache (under `status`, `describe --dirty` and similar) is not counted as a write.**

This wording goes into the doc comment on `READONLY_GIT_VERBS` and into the ELI16.

What it does not cover, each with its reason:

- **Repository-local config, including through the choice of repository.** Keys such as `core.fsmonitor`, `diff.external`, `diff.<driver>.textconv`, `filter.<driver>.clean`, `gpg.program`, `core.sshCommand` and `remote.<name>.uploadpack` run programs under read verbs, and `-C`, `--git-dir` and `--work-tree` choose which repository's config applies. Several keys are wildcards no fixed override covers; the security reviewer showed even `HARDENED_GIT_CONFIG` does not stop a repo-local clean filter, because `core.attributesFile=/dev/null` replaces only the global attributes file. So **the funnel does not support reading a repository whose `.git/config` was written by someone instar does not trust, with or without the hardening pairs.** Every repository instar reads today has config written by the agent, the operator, or `git clone` on this machine. The one place an agent session controls a working tree, the feedback executor's attempt clones, is read only with `rev-parse HEAD` (`executorPorts.ts:114`), which consults none of these keys. The hardening pairs stay admitted because they reduce exposure, not because they remove it.
- **The inherited process environment.** A variable whose value equals the server's own environment is the host's, at the same trust level as `PATH` and the binaries on it. Only variables a caller adds or changes are checked.
- **A local repository named as a remote.** `ls-remote <path>` and `remote show` against a local path run `upload-pack` in that repository, which reads that repository's config. It is the choice-of-repository case above.
- **Transport helpers.** A positional URL such as `evil::x` makes `ls-remote` or `remote show` run `git-remote-evil` from the host's `PATH`, and an `ssh` URL runs ssh. These are host-installed programs selected by a URL scheme. git's default protocol policy blocks `ext::`.
- **Options of `read`-class verbs not listed in section 3.** Each read verb's options were reviewed against the git 2.50.1 manual pages. The only argument-chosen writers or programs are the ones in section 3. Options that switch on a program named by repository config (`--ext-diff`, `--textconv`, `--show-signature`, `cat-file --filters`) fall under the config boundary above. For a future git, see the canary under "Verify the State".

Also not taken: always prefixing read-surface calls with part of `HARDENED_GIT_CONFIG` (`core.fsmonitor=false`, `core.sshCommand=false`): it would close the commonest repository-config program run, but turn off the built-in fsmonitor's speed-up on large repositories and break `ls-remote` over ssh for repositories that need their own ssh command; the boundary stays a stated boundary. Pinning `GIT_ALLOW_PROTOCOL` on read surfaces would close the transport-helper residual but break any agent repository that reads through a custom remote helper, and pinning `GIT_EDITOR=false` duplicates the grammar's refusal of every editor form. Verbs with an `--exec` or `--output` of their own that are not in the table (`archive`, `bundle`) stay `unclassified`; `notes` is `write`.

Considered and not taken: setting `GIT_OPTIONAL_LOCKS=0` on read surfaces would remove git's own index refresh from the caveat, but it makes every later `status` re-hash files whose stat data changed, a repeated cost on the agent's own frequent `status` calls, for a write that is git's lock-protected cache and not content. Reading through libgit2 or isomorphic-git, or an OS sandbox, would avoid parsing git's options at all, but each replaces the git binary every caller relies on (hooks, config, credential helpers, worktrees) and is a much larger change than this one.

### 5. `-c` and `opts.env` on the read surfaces (item 5)

`readSync`, `readStream`, and `run` when it routes to `readSync` admit a pre-verb `-c` only when its value is, as an exact case-sensitive string, one of the twelve pairs in `HARDENED_GIT_CONFIG`: `core.hooksPath=/dev/null`, `core.fsmonitor=false`, `diff.external=`, `core.pager=cat`, `commit.gpgsign=false`, `tag.gpgsign=false`, `core.attributesFile=/dev/null`, `protocol.file.allow=never`, `submodule.recurse=false`, `core.sshCommand=false`, `core.protectHFS=true`, `core.protectNTFS=true`. Each switches something off or pins a safe default; `core.sshCommand=false` and `core.pager=cat` name the fixed binaries `false` and `cat`; `diff.external=` makes any non-empty `git diff` fail rather than run anything (measured: exit 128, with or without a repository `diff.external`), so a caller that passes the whole list cannot use `diff`; it fails closed. The pairs the ecosystem fetchers add (`protocol.*.allow=always` among them) are not admitted: no read caller uses them, and `protocol.file.allow=always` would undo the hardening list's `never`.

Any other `-c` throws a `SafeGitExecutorError` naming the key, never the value, with audit reason `read-surface-config-not-admitted`, after the classification refusals and before the source-tree guard. `-c Core.FsMonitor=x` and a bare `-c core.fsmonitor` (meaning `true`) are refused. A unit test imports `HARDENED_GIT_CONFIG` and asserts every pair is admitted.

`opts.env` on a read surface is an admit-list too. A key whose value differs from `process.env` (one the caller added or changed) must be one of `LANG`, `LANGUAGE`, `LC_ALL`, `LC_MESSAGES`, `GIT_TERMINAL_PROMPT`, `GIT_OPTIONAL_LOCKS`, `GIT_CONFIG_NOSYSTEM` (the last is stripped and re-set to `1` by `sanitizeEnv` anyway; it is admitted so a caller that passes it is not refused for a no-op); anything else throws with audit reason `read-surface-env-not-admitted`, naming the key. The env rule catches instar code that passes a program-naming variable by mistake; it is not a defence against code that changes `process.env` itself, which is the host's environment. A caller cannot remove an inherited key: `sanitizeEnv` builds the child environment as `{ ...process.env, ...opts.env }`, so a key left out of `opts.env` is still inherited. `PrHandLease.ts:168`'s `{ ...process.env, GIT_TERMINAL_PROMPT: '0' }` passes unchanged: every inherited key equals `process.env`, and `GIT_TERMINAL_PROMPT` is admitted.

The write surfaces keep accepting any `-c` and `env`. A write surface already runs the repository's hooks.

### 6. The source-tree opt-outs are for reads (review finding 7)

`isSourceTreeCheckBypassed` honours `sourceTreeReadOk` only when the invocation classifies `read`, or the verb is `fetch`. A `write` form of a read-tier verb (`log --output=…`, `remote add …`) gets the guard like any write. The worktree-manager opt-out admits `symbolic-ref` only in a read form. Every `sourceTreeReadOk` and worktree-manager caller in `src/` is a read or `fetch`, so nothing that runs today is newly refused. `SOURCE_TREE_READ_TIER_VERBS` membership is unchanged.

The `fetch` exemption is unchanged, with any arguments, including `executorPorts.ts:84`'s fetch into `refs/heads/feedback-execute/base` on the source tree. That is an existing, documented carve-out (`SafeGitOptions.sourceTreeReadOk`), not widened here.

### 7. `update-index` (item 3)

The call at `GitStateManager.ts:345` is deleted, and `update-index` stays out of the table. The call has never run, so deleting it changes nothing that happens today. The `git status --porcelain` on the next line refreshes the index itself and re-checks racily-clean entries by content.

### 8. The force-wakeup lease claim (item 1, decided: the commit and push are removed)

`claimLeaseForSelf` keeps doing what has actually happened since it was written: build the signed +1-epoch lease and save it in the local registry. The never-run commit and push, the `git add` that ran before them, and their catch-all are deleted, so the CLI no longer stages `registry.json`; `GitSync` stages what it commits itself.

What then happens to the claim depends on where the agent's server keeps its lease, and this is unchanged by this spec (review measured both):

- **Git medium** (git backup on, a `.git`, a home that is not an instar source tree, a registry that is not git-ignored): the force path set this machine's role to awake, so at boot the server first runs `gitSync.sync()`, which pulls with autostash (its `resolvePostPullAutostashConflicts` handles a conflict there), commits and pushes, and then its `GitLeaseStore` finds this machine holding the lease and renews it through `GitSyncManager.pullRebase`, which has no such conflict handling. So the server does share the claim; the later renewals go through the weaker pull (finding 8).
- **Local medium** (everything else): the server builds `LocalLeaseStore` on `lease-local.json` and never reads `registry.lease`, so the claim is not carried at all; at boot `reconcileRoleToLease` turns the role back to standby.
- **Observe-only machine** (`leaseSelfHeal.leaseRole: 'observe-only'`, or `telegramPolling: false` with no explicit role): `initializeLease` never acquires or renews on it, on either medium.

Why removed rather than switched on:

- Switched on as written, it would commit on a standby's stale base with no pull and no epoch check, and leave a conflicting commit for the next sync (finding 8).
- Routed through the server's `GitLeaseStore.casWrite`, it corrupts `registry.json` in exactly the race it exists for (finding 8). Making it safe means fixing `GitSyncManager.pullRebase`'s conflict handling and reordering both `wakeup` paths, a change to the server's lease path that is outside this spec.
- Nothing has depended on it: the commit never ran. Removing it changes no behaviour; it removes dead code and a false message.

The force path's line "Lease claimed + pushed; the old awake machine steps down when it sees the higher epoch." becomes one of four lines, chosen by two new exported checks that read the same facts as the server (they repeat its logic rather than share it, so a later change to the server's boot choice must update them; their tests pin the cases): `leaseObserveOnly(multiMachine)` (the rule of `MultiMachineCoordinator.resolvedLeaseRole`) and `leaseKeptInGit(projectDir, gitBackupEnabled, registryAbsPath, mediumCheck)` (the boot medium choice). The line is a prediction from configuration: a boot where `configureCommitSigning()` or `sync()` throws, or a machine that defers to a healthy preferred peer, can still end on the local store.

| Outlook | Line |
|---|---|
| observe-only | "Lease claimed in this machine's registry, but this machine is set to only observe the lease, so its server will not hold or renew this claim and the other machine is not told. While the other machine is reachable, run `instar wakeup` without --force to hand over." |
| kept in git | "Lease claimed on this machine. It is expected to be shared through git when the server here next starts and syncs; until then the other machine has not been told." (No handover promise: the renewals that follow go through the pull filed as `fb-c5958717-00b`.) |
| unknown (a check throws) | "Lease claimed in this machine's registry. Could not tell whether this agent keeps its lease in git, so the other machine may not be told. While the other machine is reachable, run `instar wakeup` without --force to hand over." |
| not kept in git | "Lease claimed in this machine's registry only. This agent does not keep its lease in git, so the other machine is not told and the server here will not take over from this claim. While the other machine is reachable, run `instar wakeup` without --force to hand over." |

The pre-existing gaps (the local medium never carries the claim; lease renewals and `casWrite` after a rejected push go through a `pullRebase` with no conflict handling) are filed as feedback `fb-c5958717-00b`, and the id is recorded in the pull request body. They are not fixed here.

### 9. Lists outside the funnel (item 6)

- `scripts/run-migration.js` is deleted. Nothing imports or runs it. Its mention in `upgrades/side-effects/comprehensive-destructive-tool-containment-migration.md` is history and stays.
- The shell-string lint gains `merge-tree`, `commit-tree` and `write-tree`, and write-form patterns for `remote` (`add`, `remove`, `rm`, `rename`, `set-url`, `set-head`, `set-branches`, `prune`, `update`), `reflog` (`expire`, `delete`), `symbolic-ref` (`-d`, `--delete`, or two operands) and `config` (a write option, a `set`/`unset`/`rename-section`/`remove-section`/`edit` subcommand, or `section.key` followed by a value). Read forms stay unflagged.
- A test drives the lint over fixture shell text: for every `write` verb in the table, `git <verb> x` is flagged; for each `shape` verb's write example in the classifier test, the example is flagged and its read example is not.
- The lint is run over the repository before landing. The integration reviewer's dry run found no new hit outside `src/templates/scripts/git-sync-gate.sh`, which is already allowlisted. **A new hit in `src/templates/` (an agent-installed file) is allowlisted with its reason, never ported, in this change; a hit in the repository's own `scripts/` is ported.** The count goes in the pull request.
- The lint does not see git commands built as strings inside TypeScript (for example `WorktreeMonitor.ts:414`). That is unchanged.

## What it does not do

- It does not neutralise repository-local config or the inherited environment (section 4).
- It does not restrict `-c` or `env` on the write surfaces.
- It does not add `update-index` or any verb to the table.
- It does not change `SOURCE_TREE_READ_TIER_VERBS` membership, the `fetch` exemption, environment scrubbing, or the audit log format. Three audit reasons are added: `program-running-form`, `read-surface-config-not-admitted`, `read-surface-env-not-admitted`.
- It does not change `GitLeaseStore`, `GitSyncManager` or the server's lease path.
- It does not rename `DESTRUCTIVE_GIT_VERBS`, which will hold `grep`, `ls-remote` and `help` (shape verbs with no write form). Only tests import it; its doc comment says it means "verbs a write surface may be asked to run".

## Decision points touched

| Decision point | Classification | Justification |
|---|---|---|
| Which surface may run a git invocation (verb table plus per-verb read grammars) | `invariant` | A closed table and closed per-verb schemas over git's own option syntax. No competing signals: an argument is in the schema or it is not. It must fail closed, and a judgment step would only add a way to be wrong. |
| Whether a `-c` value or `opts.env` key is admitted on a read surface | `invariant` | Exact-string membership in fixed lists. |
| Whether a source-tree opt-out applies | `invariant` | A function of the classification and the verb. |

`claimLeaseForSelf` no longer makes a decision about git; it saves locally, as it has always effectively done. Choosing which of the four force-wakeup lines to print is `invariant`: a fixed mapping from the configuration facts in section 8 to text, with an explicit `unknown` line when a check throws.

On authority: this adds no judgment authority. It adds deterministic refusal conditions inside the funnel's existing authority, grounded in the registry's Body-and-Mind threshold clause (`docs/STANDARDS-REGISTRY.md:230`): below the threshold, a closed enum, type or schema may refuse malformed input, and a per-verb option schema over already-structured `argv` is that. The "Intelligence Infers, Keywords Only Guard" subsection (`docs/STANDARDS-REGISTRY.md:296`) names the same survivor, "validating already-structured input against a fixed, closed enum"; its emergency-stop exclusivity concerns inferring what natural language means, and nothing here infers meaning. `docs/signal-vs-authority.md:75-76` says the same for hard-invariant validators and for safety guards on irreversible actions, which covers the forms that run programs. The registry article's own wording names only the emergency-stop floor as an exception; that disagreement between the two documents is the one the parent spec reported (feedback `fb-69615365-30f`), and this spec does not rely on the registry granting a new exception. The wrong-block cost of each refusal: a `write` form refused on a read surface moves to `execSync`, and that includes the universal `--output` rule, which reclassifies rather than blocks (a path literally named `--output…` is refused by `readSync`/`readStream` and runs through `run` or `execSync` behind the source-tree guard; the scan goes past `--` because `--` can be an option's value); a `-c`, `env` or source-tree refusal is retried without the value or the opt-out; a `refused` form has no surface and needs a reviewed grammar change (section 2).

## Verify the State, Not Its Symbol

- **Symbol:** the verb, every argument after it, the pre-verb `-c` values, and the caller-added or caller-changed keys of `opts.env`.
- **State claimed:** the guarantee quoted in section 4.
- **Corroboration:** none at run time; the grammar is git's. Each grammar is tied to a measured write or program run, and the tests drive every write and program form through the real surfaces against real git, checking that the object, ref, file, remote, config value or marker file is absent afterwards.
- **Symbol present, state absent:** an invocation the grammars call read that still writes or runs a program. Known and accepted, each with a reason in section 4: repository-local config (and the choice of repository), the inherited environment, transport helpers, git's opportunistic index refresh.
- **State present, symbol absent:** a harmless invocation outside a grammar (an abbreviation, a short cluster, one-positional `config <key>`, `format-patch` without `--stdout`). It is refused on the read surfaces. That is the intended side.
- **Unmeasurable: git-version drift.** A future git may add an option to a `read`-class verb that writes or runs a program. The admit-grammar verbs reject a newly introduced option spelling by default, because it is outside their grammar; a change in what an already-admitted option does is still a drift residual. For the parse-options `read`-class verbs (`status`, `ls-files`, `ls-tree`, `cat-file`, `check-ignore`, `show-ref`, `for-each-ref`, `merge-base`, `blame`, `shortlog`, `count-objects`, `describe`, `name-rev`, `check-ref-format`, `cherry`), a canary test lists the long options `git <verb> -h` prints and fails on any not in the reviewed set recorded from git 2.50.1, naming the verb and option to review. An older git prints a subset and passes. The canary watches the git on the machine that runs the tests, not the fleet's; a fleet host with a newer git is covered only by the admit grammars. The canary sees long options only; the revision-parser verbs (`log`, `diff`, `show`, `rev-list`, `rev-parse`) do not list their options in `-h`, and the subcommand checks of `stash`, `worktree` and `reflog` are not grammars. For those, drift is covered only by the universal `--output` rule and the subcommand allowlists, an accepted residual.

## Multi-machine posture

The classifier is in-process code that ships identically to every machine; it adds no state, file, notice or URL. The lease change removes dead code: the shared machine registry (`unified` by design) is written locally exactly as it has effectively been; what the server then does with it is unchanged (section 8). No machine-local surface is added.

## EVO-029 disposition

| Item | Disposition |
|---|---|
| 1. `run` misroutes on a pre-verb flag | Fixed (section 1). The commit and push it would have switched on are removed rather than enabled (section 8). |
| 2. `reflog` through `run` | Closed with EVO-028 (#2776). |
| 3. `update-index` always refused | Fixed by deleting the never-run call (section 7). |
| 4. Read-classified invocations that write | Fixed by admit-list grammars and the universal `--output` rule (section 3). |
| 5. `-c` and config running programs | `-c` and `opts.env` fixed by exact admit lists (section 5). Repository-local config, the inherited environment and transport helpers are stated boundaries (section 4). |
| 6. Lists outside the funnel | `run-migration.js` deleted; lint widened and tied to the table by a test (section 9). |
| Review finding 7: source-tree opt-outs by verb name | Fixed (section 6). |
| Review finding 8: a safe CLI lease commit | Not buildable here; the pre-existing lease-sharing gaps are filed as `fb-c5958717-00b` (section 8). |

After this lands EVO-029 has no remaining item.

## Frontloaded Decisions

1. **The force-wakeup commit and push are removed, not switched on.** The claim is saved locally as it effectively always has been. The CLI line says what happens next, chosen by whether the lease is kept in git.
2. **The two pre-existing lease-sharing gaps are reported (`fb-c5958717-00b`), not fixed**, because fixing them changes the server's lease path.
3. **Program-running forms are `refused` on every surface**, a new class with no escape hatch, because no caller needs them.
4. **Write forms are `write`** and still run on the write surfaces with the source-tree guard.
5. **Every verb with a write or program form gets an admit grammar**, including `branch` and `config`; `config` also needs positive evidence of a read.
6. **The `--output` rule scans every argument**, past `--`.
7. **`-c` on read surfaces admits exactly the twelve `HARDENED_GIT_CONFIG` pairs**; the ecosystem pairs are not admitted.
8. **`opts.env` on read surfaces is an admit-list judged on the keys a caller adds or changes.**
9. **The source-tree opt-outs apply only to reads, and to `fetch` as today.**
10. **Repository-local config, the inherited environment and transport helpers are written boundaries**, not neutralised. `GIT_OPTIONAL_LOCKS=0` and a non-CLI git library were considered and declined (section 4).
11. **`update-index` is not classified**; the never-run call is deleted.
12. **`run-migration.js` is deleted**; the lint is widened; new lint hits in `src/templates/` are allowlisted, never ported, in this change.
13. **A canary test watches git-version drift** for the parse-options read verbs.
14. **If the canary fails** on a git newer than 2.50.1: review the named option against its manual page; if it neither writes nor runs a program, add it to the reviewed set; otherwise add it to that verb's refusals. Name it in the pull request.
15. **If a grammar refuses a real caller or test the review missed:** if the git 2.50.1 manual confirms that exact form neither writes nor runs a program, admit that exact option and name it in the pull request; otherwise move the caller to `execSync`. A grammar is never widened beyond the exact option.
16. **No config flag and no dry-run stage.** Nothing in `src/` uses a newly refused form, the classifier is a pure function, and the lease change removes code that never ran.

## Open questions

*(none)*

## Rollback

Revert the commit. There is no stored state, config or migration. After a revert the read surfaces accept the write forms again, `run` misroutes again, and the dead commit-and-push code returns, still unable to run.

## Agent awareness and migration parity

`SafeGitExecutor` is internal to instar's source. It is not an agent-facing capability, has no route, and installs nothing into an agent's home. The CLAUDE.md template and `PostUpdateMigrator` need no change. The `instar wakeup --force` line changes to say what happened.

## Tests

Unit, `tests/unit/SafeGitExecutor-read-surface-hardening.test.ts`, through the real surfaces against real git in sandbox repositories:

1. **Disconfirmation set, run first on `main` and recorded failing in the pull request:** through `readSync`, each write form in section 3 is refused and what it would have written is absent afterwards; `grep -O<cmd>`, `grep -e -- -O<cmd>` (with a file containing `--`), `ls-remote --upload-pack=<cmd>`, `ls-remote --exec=<cmd>`, `ls-remote -o -- --upload-pack=<cmd>` are refused and the marker `<cmd>` would create is absent; `-c core.fsmonitor=<cmd>` on `status` and `env` `GIT_EXTERNAL_DIFF=<cmd>` on `diff` are refused and their markers are absent; `branch --unset-up`, `branch -uzz9`, `branch --format --list newb`, `branch --sort -l newc`, `config --fil --get k v`, `config -ze` (refused), `format-patch --subject-prefix --stdout HEAD~1` and `format-patch HEAD~1 -- --stdout` are not read.
2. Read forms still run through `readSync`: the six `symbolic-ref` caller shapes, `remote`, `remote -v`, `remote get-url origin`, `config --get <key>`, `config --get-regexp <re>`, `config get <key>`, `ls-remote --exit-code <remote> refs/heads/main`, `ls-remote --tags <remote> 'refs/tags/v*'`, `format-patch -1 --stdout`, `log -1 --output-indicator-new=+`, `grep -n -e x`, `grep -m1 x`, `stash list -1`, `branch --list 'feat*'`, `branch --show-current`.
3. Each `write` form is accepted by `execSync`; each `refused` form (`grep -O…`, `ls-remote --upload-pack=…`, `help commit`, `config --edit`, `branch --edit-desc`) is refused by all five entry points with the `program-running-form` message.
4. Abbreviations and clusters: `interpret-trailers --in-pl`, `symbolic-ref --del`, `fsck --lost`, `config --unse x`, `ls-remote --upload`, `ls-remote --exe`, `log --outp=x`, `branch -vd x` are not read; `grep --open` is refused.
5. `--` handling: `log -- --output` is write; `grep -e x -- file` is read; `grep -e -- -O` is refused.
6. `-c` and `env`: every pair in the imported `HARDENED_GIT_CONFIG` is admitted on `readSync` and `readStream`; `-c core.fsmonitor=x`, `-c Core.FsMonitor=false`, bare `-c core.fsmonitor`, `-c protocol.file.allow=always` and `-c user.name=x` are refused naming the key and not the value; `env` with a changed `HOME`, `PATH`, `GIT_TRACE` or `GIT_EXTERNAL_DIFF` is refused; `{ ...process.env, GIT_TERMINAL_PROMPT: '0' }` is admitted; all are accepted by `execSync`.
7. Source-tree opt-outs, in `tests/unit/SafeGitExecutor-sourceTreeReadOk.test.ts`: on a source-tree fixture, `execSync(['log','--output=f'], { sourceTreeReadOk: true })` and `execSync(['remote','add','x','u'], { sourceTreeReadOk: true })` throw `SourceTreeGuardError`; `readSync(['log','-1'], { sourceTreeReadOk: true })` still runs; the worktree-manager opt-out admits `symbolic-ref HEAD` and refuses `symbolic-ref refs/heads/x refs/heads/main`.
8. `run` routing: `run(['-c','commit.gpgsign=false','commit','-m','m'])` commits in a sandbox; `run(['-C', <dir>, 'status'])` reads; `run(['-C', 'status', 'log'])` with a directory named `status` classifies `log`; `run(['branch','--list','x*'])` reads; an unknown pre-verb flag throws as today.
9. Canary: for each parse-options `read` verb, the long options in `git <verb> -h` are a subset of the reviewed set.
10. `GitStateManager.status()` counts a file modified in the same second as the last commit (a regression pin for the deleted call).

Existing tests updated: `SafeGitExecutor-verb-classifier.test.ts` (`FROZEN_*_VERBS` with `write-tree` to write and seven verbs to shape; `SHAPE_EXAMPLES` gains the new shape verbs, a `refused` example for `grep`, `ls-remote` and `help`, and `format-patch`'s read example becomes `['-1','--stdout']`; the "keeps run reading args[0]" test is replaced by test 8); `SafeGitExecutor.test.ts:446-451` (the overlap of the derived sets grows by the seven verbs); `wakeup-force-lease-claim.test.ts` (the lease assertions stand); `pr-hand-lease.test.ts` (its read still runs); `SafeGitExecutor.test.ts`'s "kills a hung read-only stream" test, which installs a fake slow `git` by passing a changed `PATH` in `opts.env` (now refused on purpose): it sets `process.env.PATH` for the duration of the test instead, so the fake `git` is inherited, not caller-supplied, and the timeout is still proven.

Unit, `tests/unit/machine-claim-lease-local-only.test.ts`, with a sandbox repository that has a tracked registry, an upstream, and a bare remote:

11. `claimLeaseForSelf` saves the signed +1-epoch lease locally, makes no commit (HEAD unchanged), and leaves the bare remote unchanged. `leaseKeptInGit` is true for that tracked-registry repository and false for no `.git`, `gitBackup.enabled: false`, a git-ignored registry, and an instar source-tree fixture; `leaseObserveOnly` follows the explicit `leaseRole` first and `telegramPolling: false` otherwise; `forceClaimLine` returns the matching line from section 8 for each of the four outlooks, and none says "pushed".

Lint, extended `tests/unit/lint-no-direct-destructive.test.ts`: the table-driven fixture check of section 9.

Integration and end-to-end tiers: the classifier adds no route, no injected dependency and no server feature, and the lease change removes code. The real-git sandbox tests above are the highest tier that exists for this code. The full suite must stay green.

## Maturation plan

- **test-agent-live:** the unit tests above drive the real surfaces against real git.
- **dev-agent-live:** live on the development agent from the release that carries it. Read the audit log for `program-running-form`, `read-surface-config-not-admitted`, `read-surface-env-not-admitted`, `destructive-shape-via-readSync` and source-tree refusal rows; each must trace to a caller that really asked for a write or a program.
- **fleet:** the same release, with no switch.
- **graduation criterion:** the merged tests pass on `main`, and in the first week on the development agent there is no new refusal row from a caller that only meant to read.
- **dark-window:** none. Nothing in `src/` uses a newly refused form, and rollback is a revert.
- **ladder:** not applicable: internal classification code with no switch or staged rollout.
