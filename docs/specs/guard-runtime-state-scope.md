---
title: "The source-tree guard's runtime-state rule matches only the source root's own .instar folder"
slug: "guard-runtime-state-scope"
author: "echo (machine stewardship, topic 144503)"
tier: 2
parent-principle: "A Dark Feature Guards Nothing"
parent-principle-fit: "The guard's runtime-state rule allows any path containing `/.instar/` anywhere. Agent homes live at `~/.instar/agents/<name>/`, so on every agent home the rule allows every path, including source files. The source-tree guard exists there but guards nothing (fb-abdf2088-f27)."
eli16-overview: "docs/specs/guard-runtime-state-scope.eli16.md"
---

# The source-tree guard's runtime-state rule matches only the source root's own .instar folder

## Problem statement

`SafeFsExecutor.guard()` checks one shortcut before the source-tree check: `isUnderAgentRuntimeState` (`src/core/SafeFsExecutor.ts:97-103`). Its comment says the intent is to allow runtime files "under an `.instar/` subdirectory of the source root". But the code matches the first `/.instar/` anywhere in the canonical path.

An agent home is itself an instar checkout, and lives at `~/.instar/agents/<name>/`. Every path in it therefore contains `/.instar/`: source files, `.git`, every worktree under `.worktrees/`. So the shortcut allows all of them, and the source-tree check behind it never runs for anything in an agent home. Found in review of spec `reaper-removal-out-of-process` on 2026-11-18. The only reason that spec is safe is its own narrower guard option, checked first.

Measured on the Studio, from all 1,739 rows in `.instar/audit/destructive-ops.jsonl` that the shortcut allowed (read 2026-11-19 00:40 PT):

| Rows | What they were |
|---|---|
| 1,442 | Inside the agent home's own `.instar/` folder, the intended case: state (1,314), messages, hook events, topic intent, conversation graph, locks, backups |
| 294 | Outside the agent home, under `~/.instar/` itself: the machine-level lock files `host-spawn-holders.json.lock`, `host-maintenance/plan.json.lock`, `host-recovery-slot.json.lock`, test-runner queue files, `disk-steward/caches.lock` |
| 3 | Under `.worktrees/`: the feedback executor's confinement canary (`.feedback-canary-sib-*`, `confinementCanary.ts:95-97`) |
| 0 | Source files, `.git`, or any other part of an agent home |

The intended behaviour therefore covers all but the 3 canary rows. The machine-level `~/.instar/` files sit outside any source tree, so the source-tree check itself allows them; they don't need the shortcut at all.

The audit log rotates at 16 MB, roughly hourly here, so these 1,739 rows are the retained window, not a full history. That is why §4 keeps its own durable ledger before anything is enforced.

## Proposed design

### 1. The shortcut matches the `.instar/` folder of an enclosing instar checkout

`isUnderAgentRuntimeState` is replaced by `insideInstarRuntimeState(entry)`, which returns true only when `entry` is strictly inside `<R>/.instar/` for some ancestor `R` that is itself an instar source tree (`isInstarSourceTree`).

It walks every ancestor that holds a `.git` entry, up to the filesystem root, so it does not stop at the nearest one. A checkout nested inside `.instar/` (`.instar/worktrees/*`, `.instar/lanes/*/clone`) is therefore still covered by the agent home's own `.instar/`, exactly as today.

It uses the same canonicalisation as `isInstarSourceTree`: the nearest existing ancestor is realpath-ed, then the remaining components are appended.

**The entry, not the referent.** For every verb (`unlink`, `rmdir`, `rm`), the checked path is the directory entry the operation modifies: the realpath of its parent plus its own final name, never resolving a final symlink. A link inside source is judged as a link inside source, whatever it points at. Raw components are rejected before any normalisation: `..`, an empty name, and NUL.

**A three-way ancestor classifier.** The walk does not reuse `isInstarSourceTree`, which answers true when it cannot canonicalise, a fail-closed answer that must never become an allow. A new classifier walks the canonical parent's ancestors, plus the entry itself only when `lstat` shows it is a real directory. Each ancestor is one of three things:
- `instar`: a confirmed instar checkout, by the same layer and remote evidence `isInstarSourceTree` uses;
- `ordinary`: a git root that is not instar, or a folder without git metadata that also lacks the instar marker and package signature. A folder carrying the `.instar-source-tree` marker or the instar package signature counts as `instar` even without `.git`, exactly as `isInstarSourceTree` treats it today;
- `indeterminate`: unreadable, or the 40-level cap was reached. Each piece of evidence (marker, package signature, layer files, `.git/config` remote) is read with its errors kept, never collapsed to false. One positive match confirms `instar`. With no positive match, any read that failed makes the ancestor `indeterminate`, never `ordinary`.

Only a confirmed `instar` ancestor `R` can make the shortcut true.

### 2. The protection check covers every enclosing instar checkout

When neither the shortcut nor a named scope applies, the decision comes from the same classifier on the entry:
- **Refused:** any confirmed `instar` ancestor makes the entry inside source, even when a nearer ordinary repository sits in between. The entry itself, when it is a real directory that is a confirmed instar checkout, counts too.
- **Allowed:** an entry with only `ordinary` ancestors.
- **Indeterminate:** see below.

It does not call `assertNotInstarSourceTree`, which re-resolves a final symlink.

This closes the case where a nested ordinary repository (`foo/.git`) hides an enclosing instar checkout from today's nearest-root check. If the ancestor walk cannot finish (an unreadable ancestor, or the 40-level cap), the answer is `indeterminate`: allow in `report` mode, refuse in `enforce`. Indeterminate cases are logged either way.

### 3. Named scopes for the callers that rely on the hole today

Each is a typed option the caller passes, checked before the shortcut. Each allows exactly its targets and is tested.

| Scope | Caller | Allows exactly |
|---|---|---|
| `localVerifyScopeOk: { verifyRoot }` | the Local Verify service | Unchanged from today: its existing verify-root clone paths and verbs. It is listed so `enforce` keeps it. |
| `feedbackCanaryScope: { worktreesDir }` | `confinementCanary.ts:95`, `:97`, `:148` | By shape only, never a caller-supplied list. Each name must also match `[A-Za-z0-9]+` after its prefix, and only `unlink` and a non-recursive `rmdir` are allowed, never `rm`. Allowed entries: (1) a direct child of the realpath of `worktreesDir` named `.feedback-canary-sib-<nonce>`, with non-recursive `rmdir` only; (2) inside such a folder, exactly the files `sib-<nonce>.txt` and `w.txt`, with `unlink` only; (3) an entry named `.feedback-canary-{hl,link,siblink}-<nonce>` directly inside a feedback workspace root `<worktreesDir>/feedback-<slug>-a<n>` (the path `FeedbackExecutorService.ts:705` builds), with `unlink` only. The canary's other files live under `.instar/state/.../canary` (`FeedbackExecutorService.ts:898`) and are covered by the shortcut. The `depsWrite` leftover in the dependency cache exists only after a confinement breach, and its refusal there is intended. |
| `gitRebaseStateScope: { projectDir }` | `GitSync.ts:419`, `:420` | A recursive `rm` of exactly `<projectDir>/.git/rebase-merge` or `<projectDir>/.git/rebase-apply`, after `rebase --abort` failed. |
| `learnedSkillScope: { projectDir }` | `skillLearning/Retirer.ts:357` (via :588/:597/:619), `CommitProtocol.ts:679`/`:715`/`:719` | A recursive `rm` of exactly one direct child of `<projectDir>/.claude/skills/` or `<projectDir>/.agents/skills/`. The retired-archive side is under `.instar/` and already covered. |
| `nodeModulesCloneStagingScope: { worktreeRoot }` | `InstarWorktreeManager.ts:927` | A recursive, forced `rm` of exactly one direct child of the worktree root named `node_modules.clone-<digits>-<digits>`, the shape `:916` creates. |
| `worktreeTrashScope` | the reclaim child | Already defined by PR 3490, which must merge first. |

**Every scope has an explicit root predicate, and refuses tracked files.** No root option is trusted as given. The guard realpaths it and checks it against that scope's own predicate:

| Scope | Root must be |
|---|---|
| `feedbackCanaryScope` | exactly `realpath(<R>/.worktrees)` for a confirmed `instar` checkout root `R` |
| `nodeModulesCloneStagingScope` | a worktree root listed by `git -C <R> worktree list --porcelain` for a confirmed `instar` checkout root `R` |
| `gitRebaseStateScope`, `learnedSkillScope` | a confirmed `instar` checkout root itself |

So `<checkout>/src` passed as `worktreesDir` is refused. Every scope also refuses a target that is git-tracked: for a file, the file; for a folder, the folder or anything under it, by `git -C <enclosing checkout> ls-files --error-unmatch -- <target>` through `SafeGitExecutor`'s read path with a timeout. The check does not apply to `gitRebaseStateScope`, whose targets are inside `.git`, which git never tracks. Exit 0 means tracked (refused); exit 1 ("did not match") means untracked (allowed). Any other exit, or a timeout, means git could not answer, and the scope refuses in `enforce`. None of these scopes removes a whole checkout.

**The feedback executor's cross-disk fallback is not given a scope.** `attemptFs.ts:68` deletes an attempt tree in place only when renaming it into the trash fails with `EXDEV`. The trash is under `.instar/state`, on the same disk as `.worktrees`, so this does not happen in practice. Such a tree can be a whole disposable checkout, which the tracked-file check cannot vet. In `enforce` the delete is refused, the tree stays (a leak, never a loss), and the `report` ledger shows it first.

**`instar nuke` is out of scope.** It keeps today's path unchanged. Its teardown and guard path are spec B (queued). Its session-prefix bug is filed separately as fb-7e502374-a36 (`nuke.ts:141`, `:348`). Today its whole-home delete is allowed only by the broad shortcut, so in `enforce` it would be refused. **`enforce` therefore cannot be chosen until spec B has merged**, which is part of the enforce floor below. In `report` mode nuke behaves exactly as today, and its whole-home delete is recorded as a `would-deny` with disposition `needs-scope (spec B)`.

**How the list was made.** It comes from a static scan of all 284 files that call the delete functions (2026-11-19 00:48 PT). Callers whose targets resolve inside an enclosing instar checkout but outside its `.instar/` were listed.

Not needed after all:
- `WorktreeManager`'s `.session.lock` deletes live under `<home>/.instar/worktrees/`, which the new rule covers.
- The reaper's gate-record deletes (`agentWorktreeGit.ts:301`) are inside each worktree's own `.instar/`, which the new rule covers too.

About 400 call sites whose path arguments are named for `.instar` state were not traced one by one. The `report`-mode ledger is what catches any of them.

**Silent catches become visible.** Callers with `@silent-fallback-ok` catches around these deletes keep the catches, but a guard refusal is now recorded as a `guard-refused` degradation, no longer swallowed.

**The canary's cleanup fallbacks are removed.** `confinementCanary.ts:95` truncates a file with `writeFileSync(file, '')` when the delete fails, and the same function truncates its system-temp probe file the same way. Both re-resolve the path (following a symlink) and would also truncate through a hard link. This change removes both truncations; the system-temp probe is simply unlinked.

An unlink that fails with `ENOENT` counts as clean, since a healthy run's write probe never created its file. Any other failure is recorded as a `guard-refused` or `cleanup-failed` degradation with the path, and the file is left as it is. The nonce is worthless once the canary run ends, and `pruneScratch` still removes leftovers.

**Recursive removes check the top entry only (a stated non-goal).** Today's guard checks only the top-level target of a recursive `rm`, and so does this change. An `rm -r` of an ordinary folder that contains an instar checkout is not detected. Nested checkouts under `<home>/.instar/worktrees/*` and `.instar/lanes/*` stay covered by the agent home's `.instar/` shortcut, exactly as today. Walking every descendant for `.git` on each recursive delete is a different cost profile; it is filed separately as feedback (fb-6ad01267-11d) and is not part of this change.

### 4. Report first, then enforce

The change ships behind `safety.sourceTreeGuard.runtimeStateScope`, with modes `report` (the default) and `enforce`.

**`report` mode.** Both policies are evaluated independently on the original request. The shadow evaluation is fenced: it runs inside a catch, any exception, timeout or ledger-write failure in it is recorded as a `would-deny` row with reason `shadow-error` (when the ledger can be written at all), and it never throws, blocks or changes the executed verdict. Its `git ls-files` runs only for paths that match a scope's shape, which are rare. Differences are recorded in **both** directions: `would-deny` (legacy allows, new refuses) and `would-allow` (legacy refuses, new allows). One example of the second: unlinking a link outside source whose target is in source, which today's guard refuses because it follows the link. The shadow verdict is always the one `enforce` would issue, so an indeterminate walk counts as a refusal there and is recorded as a would-deny with reason `indeterminate`. The legacy verdict (today's `guard()`, unchanged) is the one executed. A **would-deny** is exactly the case where legacy allows and the new policy refuses. A request both refuse is not a would-deny: it is refused today and stays refused. The new policy's raw-component rejection affects only its own verdict, never what `report` executes.

The 294 machine-level `~/.instar/*.lock` rows have only `ordinary` ancestors, so they are allowed by both and never would-deny.

**Durable ledger.** Both directions go to one ledger, `.instar/state/guard-scope-diff.jsonl`, separate from the audit log, which rotates about hourly. It is **append-only**, written with `O_APPEND` single-line writes, so the server, the CLI and the out-of-process children (reaper, feedback executor) can all write without read-modify-write races. Each process suppresses repeats of the same fingerprint within a day in memory, which bounds writes. Counts, deduplication and dispositions are computed at read time. Dispositions are themselves append-only rows in `guard-scope-dispositions.jsonl`, keyed by fingerprint. Each row records:
- direction (`would-deny` or `would-allow`);
- verb, and whether the delete is recursive;
- the new policy's reason;
- the caller frame (`captureCallerFrame()`, as the audit already records);
- the operation label;
- the target's shape: the path with nonces, pids and timestamps replaced by placeholders.

Rows are deduplicated per day by all of those fields together, so one operation label covering several paths (the canary's) still yields one row per distinct target shape. Each row also carries a target class:
- `source-file` (tracked by git in the enclosing checkout);
- `checkout-root`;
- `other`.

Each row carries one sample path. The ledger is capped at 50 MB and is **never rolled or rewritten**. Each write opens the file, appends one line and closes it. A writer that finds the file at or over the cap appends nothing and creates `guard-scope-diff.incomplete` instead, with `O_EXCL` so a creation race is harmless. While that marker exists, the observation is incomplete and `enforce` cannot be chosen. Clearing it is a deliberate reviewed reset: the ledger is archived under `.instar/state/guard-scope-diff/archive/` and a fresh observation window starts. Nothing is ever rewritten in place.

**Reading the ledger.** A `source-file` would-deny is a correct refusal, and is recorded as such. Any other class from an operation not named in §3 is the signal that another caller depends on the hole.

**Enforcing.** Moving to `enforce` is the Chief of Staff's decision, with the ledger in hand. The floor: at least 14 days of `report` on the Studio, the observation not marked incomplete, zero distinct differences without a disposition in either direction, and spec B (nuke) merged. A disposition is one of:
- `correct-refusal`, for example a `.git/config` or source-file delete that must stay refused. This satisfies the floor and creates no exception.
- `correct-allow`, for a `would-allow` the new policy is right about, such as unlinking an outside link into source.
- `needs-scope`, which gets its own named scope before enforcing.
- `scope-bug`, which is fixed first.

The route lists the rows that still have no disposition.

**The exposure is recorded.** In `report` mode the hole stays as open as it is today. The Chief of Staff's approval of this spec records that time-limited acceptance, with the enforce decision due by 2026-12-17.

In `enforce` mode, the new rule decides alone.

## Decision points touched

- **Whether a destructive file operation on a target entry inside an instar checkout is allowed.** — invariant. basis: irreversible-consequence; evidence: a delete or rename in a source tree cannot be undone. In `enforce`, the target entry (the top-level entry, per the stated non-goal for recursive removes) must be inside an enclosing instar checkout's own `.instar/`, or inside exactly one named scope's targets. Anything else inside any enclosing instar checkout is refused, as is an indeterminate walk.
- **The named scopes in the §3 table.** — invariant. basis: enumerable-domain; evidence: each lists exactly its caller's targets (§3 table), checked against the entry that is modified, with raw components validated before normalisation.
- **Report versus enforce.** — judgment-candidate. Floor: `report` allows exactly what is allowed today and records every difference in a durable ledger. `enforce` is set only by the Chief of Staff with the ledger in hand. Arbiter: the Chief of Staff. The 14-day minimum is the observation span, not a gate on any single operation.

## Frontloaded Decisions

- **Machine-level `~/.instar/` files get no special rule.** They are outside every source tree, so the source-tree check allows them. That covers 294 of the measured rows with no new code path.
- **Report mode is the default on every agent.** The fleet stays exactly as permissive as today until the switch is flipped deliberately. The Chief of Staff's approval records that time-limited exposure.
- **The switch is a config key, not a version gate,** so it can be turned back to `report` at once if `enforce` breaks something.

## Multi-machine posture

`machine-local-justification: hardware-bound-resource`. Each machine's guard protects its own disk. The switch is per machine because the evidence (the would-deny ledger) is per machine. The Studio flips first. Each other machine of the same agent flips only after its own ledger meets the same floor, and a new read-only route, `GET /source-tree-guard/scope` (with `?scope=pool`), returns each machine's mode and ledger counts, so a mixed state is visible.

## Testing

- **Unit, the shortcut:**
  - **Allowed:** an entry inside `<home>/.instar/` where `<home>` is an instar checkout living under a parent `/.instar/` folder, as an agent home does.
  - **Also allowed:** an entry inside a nested instar checkout under `<home>/.instar/worktrees/x/`.
  - **Not covered:** the `.instar` folder itself.
- **Unit, the protection check:**
  - **Refused in `enforce`:**
    - a source file under the home;
    - a path under `<home>/.worktrees/x` outside any scope;
    - an entry in an ordinary repository nested inside an instar checkout;
    - a deeply nested source path;
    - an indeterminate walk.
  - **Allowed:** a machine-level lock outside any checkout.
  - **Symlinks, both directions:** an `unlink` of a symlink inside source that points at runtime state, or at `/tmp` outside every checkout, is refused and the link survives. An `unlink` of a link outside source that points into source is allowed, and the target is untouched.
  - **Indeterminate:** an unreadable ancestor is indeterminate and never an allow proof; an instar checkout whose only evidence (its `.git/config`) is unreadable is `indeterminate`, not `ordinary`. In `report` it writes a would-deny row with reason `indeterminate`.
  - **Marker without git:** a directory with the `.instar-source-tree` marker and no `.git` is refused, as today.
  - **Canary fallback:** a refused canary unlink leaves the file and any hard-linked twin untouched and records a degradation; an `ENOENT` unlink counts as clean and records nothing; the system-temp probe is unlinked, never truncated.
- **Unit, the scopes:**
  - each scope allows exactly its targets and verbs: the canary by shape (`sib` folder `rmdir`, files `unlink`, `hl`/`link`/`siblink` leftovers in a feedback workspace), the staging recursive `rm`, the two rebase folders, a learned-skill folder and Local Verify as today;
  - a caller-chosen path outside the shapes is refused;
  - each scope refuses a root that fails its predicate (for example `<checkout>/src` as `worktreesDir`);
  - a tracked folder target, or one holding tracked files, is refused; git being unable to answer means refused in `enforce`;
  - a git-tracked target inside any scope is refused;
  - each refuses a sibling, a deeper path, `..` and a recursive remove where not allowed;
  - after a refused canary `rmdir`, unexpected contents survive.
- **Unit, modes and ledger:**
  - `report` executes the legacy verdict exactly; a throwing or timed-out shadow evaluation (injected) still executes the legacy verdict and records `shadow-error`;
  - differences are recorded in both directions (`would-deny` and `would-allow`), and both-deny and both-allow write nothing;
  - a disposition can be set on a ledger row, and the route lists undisposed rows;
  - one ledger row per direction, verb, reason, caller, target shape and day, with counts;
  - writes are append-only from several processes at once with no lost rows (concurrent-writer test);
  - at the cap, nothing more is appended, the `incomplete` marker is created once (racing writers included), and `enforce` is blocked;
  - the reviewed reset archives and starts a fresh window;
  - machine-level locks never appear;
  - a `source-file` row is classed as such;
  - the ledger cap holds;
  - `enforce` refuses;
  - the default is `report`.
- **Unit, the route:** `GET /source-tree-guard/scope` returns the mode and the per-class counts; `?scope=pool` lists every machine and names an unreachable one.
- **Unit, silent catches:** a refused staging delete records a `guard-refused` degradation.
- **Unit, covered without a scope:** a `.session.lock` under `<home>/.instar/worktrees/x/` and a gate record under `<home>/.worktrees/x/.instar/instar-dev-traces/` are allowed by the shortcut.
- **Integration:** a throwaway agent home under a `/.instar/` parent runs, in both modes:
  - the canary;
  - a worktree create and remove;
  - a `node_modules` clone fallback;
  - a state-store delete.

  `report` yields no would-deny rows for them.

## Maturation plan

- **test-agent-live:** the integration case on a throwaway agent home living under a `~/.instar/agents/` path.
- **dev-agent-live:** Echo on the Studio in `report` mode for at least 14 days. Its `would-deny` rows are read weekly.
- **fleet:** `report` everywhere until the Studio has run `enforce` for 14 days with no refused legitimate call.
- **graduation criterion:** over at least 14 days of `report`, the observation is complete and every distinct difference in both directions has a disposition. Then 14 days of `enforce` on the Studio with no `guard-refused` degradation from a named caller.
- **dark-window:** if `enforce` is not decided by 2026-12-17, the board entry records why and a new date.
- **ladder:** safety.sourceTreeGuard.runtimeStateScope

## Rollout

Ship in `report` mode. After 14 days, bring the Chief of Staff the `would-deny` count and operations for the enforce decision.
