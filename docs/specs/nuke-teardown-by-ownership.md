---
title: "instar nuke tears down only what the agent home owns, and checks its delete before teardown"
slug: "nuke-teardown-by-ownership"
author: "echo (machine stewardship, topic 144503)"
tier: 2
parent-principle: "Verify the State, Not Its Symbol"
parent-principle-fit: "`instar nuke <name>` decides what to destroy from a symbol, a session name starting with `<projectName>-` (nuke.ts:141, :348), instead of the state, which sessions and entries belong to this agent home. So removing one agent can stop another whose name extends it (echo vs echo-wt-*)."
eli16-overview: "docs/specs/nuke-teardown-by-ownership.eli16.md"
---

# instar nuke tears down only what the agent home owns, and checks its delete before teardown

## Problem statement

`instar nuke` (`src/commands/nuke.ts`) has two forms:
- `nukeAgent(name)` removes a standalone agent under `~/.instar/agents/<name>`. It stops the `<projectName>-server` session (`:127`), kills every other session whose name starts with `<projectName>-` (`:141`), removes the auto-start entry (`:156`), backs up secrets, unregisters the agent (`:213`), and recursively deletes the folder (`:221`).
- `nukeHere()` removes a project-bound install but keeps the project. It stops sessions the same way (`:336`, `:348`), restores tracked shadow files with `git checkout`, deletes individual artifacts (`.claude`, `.codex`, `.mcp.json`, `instar.config.json`, the shadow files), and deletes `.instar` last.

Measured or confirmed by review on 2026-11-19:
- **Prefix matching kills other agents' sessions.** `echo` is a name prefix of the `echo-wt-*` agent homes on the Studio. Filed as fb-7e502374-a36.
- **`projectName` comes from the folder's own config.** If that folder is a symlink to another agent's home, the teardown targets the linked agent.
- **Teardown runs before any delete is known to be allowed.** Every delete's failure falls through to "has been removed" (`:222-229`, and the same in `nukeHere`).
- **The lifeline can restart the server mid-teardown.** The launch entry runs the lifeline with `KeepAlive`, and its supervisor checks every 10 s (`ServerSupervisor.ts:1316`). nuke kills the server before removing the launch entry, so a restarted server can outlive the delete.
- **Session names are matched by prefix.** tmux targets use `-t name` without `=` (`:127`, `:556`), and tmux matches those by prefix too.
- **The guard path.** Under spec `guard-runtime-state-scope` in `enforce` mode, the standalone whole-home delete has no allowance, so that spec cannot enforce until this one lands.

Every session instar starts gets a start folder inside its agent home: SessionManager `-c` at `SessionManager.ts:5036`, `:5523`, `:8514`, the server at `ServerSupervisor.ts:1228`, and the rest by inheriting the server's folder. The live check on the Studio (17 sessions) matched that. The session registry (`<H>/.instar/state/sessions/<id>.json`, `StateManager.ts:278`) covers only SessionManager sessions.

## Scope

- **`nukeAgent` (standalone)** is covered fully.
- **`nukeHere`** gets the ownership, exact-target, pre-check and honest-result parts only (§2, the per-delete `checkScope`, §4).

How `nukeHere` restores and removes project files is out of scope. That covers the `git checkout HEAD` of modified tracked files, which can discard a user's own edits, and the removal of `.claude` and `.codex`. It is filed separately (see Frontloaded Decisions).

## Proposed design

### 1. Plan, then check every planned step, before anything is torn down

Both forms first build the full plan: the sessions to stop, the launch entry to remove, and every delete (target, recursive, force). Then they check it, and only then act.

- **The home.** The target folder must be a real directory (`lstat`, not a symlink); its realpath is `H`.
  - **`nukeAgent`:** `H` must equal `realpath(<instarHome>/agents/<name>)`. The name must be one existing path component: no `/`, no NUL, not `.` or `..`, at most 255 bytes, so a legacy uppercase name like `Echo` is accepted. Setup does not check this today: `runNonInteractiveSetup` joins any name into the path, so `team/echo` makes a nested home. This change gives setup the same shared validator, so new homes always satisfy it. An existing nested home is refused by nuke with a message naming its path, and is removed by hand after its sessions are stopped.
  - **No nested agent home.** No other registered agent home (`~/.instar/registry.json`, each `path` realpath-ed, gone paths skipped) may be at or inside `H`. Otherwise the command refuses, because the recursive delete would take it too.
  - **No always-on service.** If the agent is run by the always-available LaunchDaemon (the `alwaysAvailableRefusal` check in `setup.ts`), the command refuses before teardown and says the service must be turned off first.
  - **`nukeHere`:** the three-way classifier from spec `guard-runtime-state-scope` (§1) must find no confirmed instar checkout at or above `H`.
- **Every planned delete is checked**, including the launch entry's plist or unit-file unlink that `uninstallAutoStart` does, with the new `SafeFsExecutor.checkScope(target, { recursive, force, ...scopeOptions })`. It is the same decision function the delete wrappers call, so a pre-check and the real delete cannot disagree.
  - **`nukeAgent`:** one check, under `nukeAgentHomeScope` (§3).
  - **`nukeHere`:** one check per artifact path, with its real flags.
- **Ambiguous sessions stop the command** (§2).

Any refusal stops the command with nothing changed, and names what failed.

### 2. Tear down by ownership, never by name alone

A session's start folder is compared as a realpath, falling back to a lexical normalisation when the folder no longer exists. Comparisons are component-wise, so `/agents/echo` never matches `/agents/echo-wt-1`.

A session's start folder is tmux's `#{session_path}`, the same field the server uses. Its **home** is the most specific registered agent home that contains it, or none.

The candidate homes are the registry's homes read once at plan time, plus `H` itself always, whether or not it is registered. They are not re-read after step 3 unregisters the agent, so a session restarted in `H` is still recognised as `H`'s.

A session is:
- **owned**, if its home is `H` and either the agent's registry lists it as live, or (for `nukeAgent`) its name is `<projectName>-server` or starts with `<projectName>-`. For `nukeHere`, whose project name defaults to the folder name and whose folder holds the user's own work, only registry-listed sessions and the exact `<projectName>-server` are owned. Any other name match is ambiguous;
- **not owned**, if its home is another registered agent home (for example `echo-wt-1` while nuking `echo`), or if it is neither registry-listed nor named for the project;
- **ambiguous**, if the evidence conflicts or is missing: a name starting with `<projectName>-` but a start folder outside every registered home; a registry entry whose session's start folder is not in `H`; or a session whose home is `H` but which is neither registry-listed nor named for the project, such as a hand-started or renamed session working in the folder about to be deleted.

The registry adds sessions; it never removes one. Pipe, codex-arm, doctor and login sessions are not in it but are owned by the name-and-folder rule. A registry entry alone never makes a session owned.

**Positive identity from now on.** Every session instar creates gets a tmux user option, `@instar_home=<realpath H>`, set at creation: SessionManager's three `new-session` calls, the server supervisor, the lifeline, and the pipe, codex-arm, doctor and login spawners. A session tagged `@instar_home=H` is owned. A session tagged with another home is not owned, whatever its name or folder.

An untagged session (a legacy one, or one a person started by hand) supported only by name and folder is **ambiguous**. A user's own `echo-debug` session started in `echo`'s home is therefore never killed on a guess. The refusal lists these sessions, and the operator may pass `--stop-untagged` to stop exactly the listed untagged sessions named for the project in `H`. Without it, nothing is torn down.

**Each stop is bound to the session observed.** At plan time the tmux `#{session_id}` (a `$N` value) is recorded, and the stop targets that id (`kill-session -t '$N'`). A different session that later reuses the same name is never stopped. Lookups by name (`has-session`) use the exact form `-t =<name>`. Ids are used for stops, exact names only for lookups.

Ambiguous sessions stop the command before teardown. They are listed, so the operator can stop them or confirm they are unrelated, and nothing is torn down. A live server of this agent started elsewhere would be ambiguous, so it can never be left writing into a deleted home.

Every tmux target uses the exact form `-t =<name>`.

**The launch entry.** `ai.instar.<projectName>` is owned only when its `WorkingDirectory` and the value after `--dir` in `ProgramArguments` both equal `H` exactly after realpath. A missing `--dir` counts as agreement; a contradiction counts as ambiguous. A substring match is never used. On Linux the unit's `WorkingDirectory` is compared the same way. If the entry exists but is not owned, it is listed and the command stops, as for an ambiguous session.

**The loaded job and the file are both checked.** `launchctl print gui/<uid>/<label>` shows the job launchd actually has loaded, including its working directory and program arguments. Separately, the plist on disk is checked. Both must agree with `H`. A loaded job for another home, under the same label as an on-disk plist for `H` (possible after `installMacOSLaunchAgent(..., noStart=true)`), is ambiguous. So is a loaded job with no file.

**Every supervisor that can restart the agent is accounted for:**
- **The per-user launch entry:** removed and verified (below).
- **A hand-started lifeline:** `H/.instar/state/lifeline.lock` records `{pid, procStart, …}`. The existing `provenLifelineRecords()` (`lifelineLock.ts:284`) confirms that this pid has that start time, and `ps` must also show `lifeline start --dir H`. Only then is it stopped. `unproven`, or a failed stop, refuses.
- **The fleet watchdog** (`~/.instar/instar-watchdog.sh`, every 300 s): it reloads `ai.instar.*.plist` files that exist and heals registered agents, so the plist file is deleted and the agent unregistered before the server is stopped.
- **The always-available LaunchDaemon:** refused up front (§1).

### 3. Order, and a narrow allowance for the whole-home delete

**Locks: by service label, by home, and the existing teardown lock.** The launch entry's label and file come from `projectName`, so two homes with the same project name share them. nuke therefore takes three locks, in a fixed order:
1. `~/.instar/locks/label-<label>.lock`;
2. the per-home lock below;
3. the existing `withTeardownLock(H)`, which the self-heal writers already take (`installAutoStart` from the server, the lifeline and PostUpdateMigrator).

`installAutoStart` also takes the label lock, so no install or self-heal can change the entry between nuke's ownership check and its unlink. If any lock cannot be taken, including `withTeardownLock` returning `unlocked`, the command refuses.

**A per-home lock outside the target.** The teardown runs under a lock at `~/.instar/locks/agent-<sha256(realpath H)>.lock`, outside `H`, so the delete never removes the lock it holds. `runNonInteractiveSetup` takes the same lock before its first write, which is a small change in `setup.ts`, and `installAutoStart` keeps its existing `withTeardownLock` inside it. A reinstall therefore cannot write between nuke's final backup and its delete. If the lock cannot be created, the command refuses.

**Before teardown (step 0), standalone agents only:** push the git backup when a remote exists. A failed `git remote` query is an error and refuses; only a confirmed empty list means "no remote". The command runs `add`, `commit` and `push`. If the push fails, the command refuses before any teardown and reports the local commit it made, which is kept. `nukeHere` never commits or pushes: the project's own work is not the installer's to publish.

**An explicit way past a dead remote.** If the remote is gone (deleted, revoked, offline), the operator can pass `--skip-backup`. The refusal message names this flag. It skips only the push: ownership, scope and supervisor checks all stay, and the output records that no backup was made. Without it, an agent with a dead remote could never be removed except by hand, which would skip every check here.
1. **Remove the owned launch entry.** Run `launchctl bootout`, then confirm with `launchctl print gui/<uid>/<label>` that the job is gone. A real bootout failure is told apart from "not loaded" by that check, not by a swallowed error. Then delete the plist file and confirm it is gone. On Linux, the unit's effective `KillMode` is read first (`systemctl --user show -p KillMode`). Anything but `process` refuses before any stop, because `control-group` would kill the shared tmux server and every agent's sessions (the case `setup.ts` documents). Then `stop` and `disable` are each checked, and `is-active` must report inactive. Any failure stops the command here.
2. **Stop a hand-started lifeline**, if one holds the lock (above).
3. **Unregister**, so the watchdog no longer heals the agent.
4. **Stop the owned server session**, by its recorded id.
5. **Stop the other owned sessions**, by recorded id.
6. **Confirm every writer has exited.**
   - Re-list tmux sessions. If an owned session is running again, its restarter was missed: the command stops it once, reports which supervisor is still live, and refuses the deletes.
   - Scan processes (`ps`, then `lsof -d cwd`) for any whose command line contains `--dir <H>` or whose working directory is `H` or inside it. That catches a hand-started `server start --foreground` with no launch entry and no tmux session. Any found are listed and the deletes are refused.
7. **Standalone agents only: push the final git backup** after the writers are stopped, so the copy holds the last state. A failure here stops the command before deleting. The agent is then stopped and unregistered but its folder is intact, and the output says so and says that a rerun finishes the removal. The delete cannot be undone, and the push is the copy.
8. **Back up secrets.**
9. **Run the deletes.** For `nukeAgent`'s whole-home delete, the audit entry is written to `~/.instar/audit/` before the delete, outside `H`, so the audit write cannot recreate `H/.instar/audit` afterwards. `nukeHere` keeps its existing audit suppression for its final `.instar` delete.
10. **Re-check afterwards, per form.**
    - **`nukeAgent`:** `H` is gone, and no `ai.instar.<projectName>.plist` (or unit) has reappeared.
    - **`nukeHere`:** every planned artifact is gone and the project root still exists.

    Anything else is reported as a failure.

**The allowance.** `SafeFsExecutor` gains the option `nukeAgentHomeScope: { agentName }`. It allows exactly one thing: a recursive, forced `rm` of `realpath(<instarHome>/agents/<agentName>)`. The path is built by the guard from the instar home it resolves itself and the validated name, and the target must equal it exactly and be a real directory. No caller-supplied path is trusted.

The home is itself a checkout. Removing it whole is the intent, so the tracked-file rule of spec `guard-runtime-state-scope` §3 does not apply to this one allowance. It is protected by the built path and the precondition checks instead.

`nukeHere` gets no allowance. Its artifact deletes go through the normal guard checks.

### 4. Honest result

Every step's outcome is collected: each delete, each restore and each session stop. If any failed, the command prints each failure with its path, does not print "has been removed", and exits non-zero. Steps already done are listed, so the operator knows the state.

## Decision points touched

- **Which sessions nuke stops.** — invariant. basis: irreversible-consequence; evidence: stopping a session ends its work. Only owned sessions are stopped: listed in the agent's registry, or named for the project and started inside the canonical home (compared component-wise). Sessions in another agent's home are never touched, and ambiguous ones stop the command before any teardown.
- **Whether nuke may proceed at all.** — invariant. basis: irreversible-consequence; evidence: teardown is not reversible. The full plan is checked before the first teardown step: every delete and unlink with its real flags through the same `checkScope` the delete uses, the pre-teardown push, the locks, ownership, supervisors and `KillMode`. Any refusal or ambiguity there changes nothing. Refusals after teardown begins (step 1 failing, a writer that will not exit at step 6, a failed final push at step 7) never delete anything. Each prints the exact partial state (what was stopped, booted out or unregistered) and the rerun that finishes. Every step is idempotent and skips itself when already done, so a rerun completes the removal.
- **The whole-home delete allowance.** — invariant. basis: enumerable-domain; evidence: exactly one path, `realpath(<instarHome>/agents/<name>)`, built by the guard.

## Frontloaded Decisions

- **Ownership comes from the registry, or from the project name together with the start folder.** Every instar-started session starts inside its home (measured on all 17 live sessions), so this needs no new state.
- **Ambiguity stops the command instead of guessing.** A prefix-named session outside every agent home, or a launch entry that does not point at `H`, is listed and the command does nothing. That is a cost only in an unusual setup, and it is never a wrong kill or a ghost writer.
- **The name rule matches creation.** It is one path component of at most 255 bytes, with no `/`, NUL, `.` or `..`, the same as setup accepts, so every existing home can be removed.
- **A failed push blocks the delete, with an explicit escape.** Today a failed push only warns. The delete is irreversible and the push is the copy, so a failure stops the command. `--skip-backup` is the stated way past a dead remote.
- **`nukeHere`'s file restore is filed separately.** It runs `git checkout HEAD` on modified tracked shadow files and recursively removes `.claude` and `.codex`, which can discard a user's own edits. It needs a record of what setup created or changed, so it is a separate fix (fb-c05cedd1-82b).

## Multi-machine posture

`machine-local-justification: hardware-bound-resource`. nuke stops this machine's tmux sessions and launch entries and deletes this machine's folder. Its one remote effect is the final git backup push (step 7), the same as today, and its result is reported.

## Testing

- **Unit, ownership:**
  - the comparison is component-wise (`/agents/echo` versus `/agents/echo-wt-1`);
  - a session in `H/.instar/worktrees/x` is owned;
  - a registry-listed session is owned whatever its name;
  - a pipe or codex-arm session that is not in the registry is owned by name and folder;
  - a session in another agent's home is not owned and does not block;
  - an ambiguous session stops the command before teardown, with nothing called;
  - an unrelated `<projectName>-dev` session outside every home is ambiguous;
  - a deleted worktree start folder falls back to the lexical comparison;
  - stops target the recorded `#{session_id}`, so a same-name replacement survives;
  - a registry entry whose session started in another home is ambiguous;
  - an unnamed session in `H` is ambiguous;
  - `--here`: a user's `myapp-dev` in `myapp/` is ambiguous, not killed;
  - a server restarted in `H` after unregister is still recognised as owned;
  - the most specific home wins.
- **Unit, the launch entry:**
  - `WorkingDirectory` or `--dir` equal to `H` means owned;
  - `ProgramArguments` containing `H/.instar/bin/node` for another `H` means not owned and stops the command;
  - a missing per-user entry is fine only when the always-available daemon is not in use; a daemon-run agent is refused before teardown;
  - a failed bootout (still listed by `launchctl print`) stops the command;
  - a failed stop followed by a successful unlink still stops the command.
- **Unit, preconditions and plan:**
  - a symlinked home is refused before teardown;
  - a bad name is refused;
  - `nukeHere` inside an instar checkout is refused;
  - a registered home nested inside `H` refuses the command;
  - a legacy uppercase name like `Echo` is accepted;
  - every planned `nukeHere` delete is checked with its real flags;
  - a refused one changes nothing.
- **Unit, order:**
  - the launch entry is removed before the server is stopped;
  - a hand-started lifeline holding the lock is stopped, and an unconfirmable one refuses;
  - the plist is deleted and the agent unregistered before the server is stopped;
  - a session that restarts is stopped once, its supervisor is reported, and the deletes are refused;
  - a failed pre-teardown push changes nothing;
  - a failed final push stops before the delete with the folder intact;
  - `--here` against a dirty project with a remote never commits or pushes;
  - an `unlocked` teardown lock refuses;
  - a legacy unit with `KillMode=control-group` refuses before any stop;
  - a denied plist unlink in preflight causes no service change;
  - after the delete, a reappeared plist is reported;
  - a successful `--here` run keeps the project root and passes its own check;
  - `--skip-backup` skips only the push, and the refusal message names it;
  - a failed `git remote` query refuses, and a kept local commit after a rejected push is reported;
  - the whole-home delete's audit entry lands outside `H`, and `H` stays gone;
  - the per-home lock outside `H` blocks a reinstall racing the delete;
  - a loaded job for another home, under the same label, is ambiguous;
  - a session tagged `@instar_home=H` is owned, another tag is not owned, an untagged `echo-debug` in `echo`'s home is ambiguous, and `--stop-untagged` stops exactly the listed ones;
  - a hand-started foreground server (no tmux session, no launch entry) is found by the process scan and blocks the delete;
  - two homes sharing a project name contend for one label lock;
  - `withTeardownLock(H)` is held, so a self-heal `installAutoStart` waits;
  - each refusal after teardown starts prints the partial state, and a rerun finishes idempotently.
- **Unit, the allowance:** `nukeAgentHomeScope` allows exactly the built path with `recursive` and `force`, and refuses another agent's home, a nested path and a symlink. `checkScope` and the delete give the same answer.
- **Unit, the result:** an early failed restore followed by a successful `.instar` delete exits non-zero, names the failed artifact, and does not claim removal.
- **Integration:** two throwaway agents, `nt` and `nt-two`, each with a live tmux session. `instar nuke nt` removes `nt`'s home, sessions and launch entry, and `nt-two`'s session keeps running.

## Maturation plan

- **test-agent-live:** the integration case with two throwaway agents.
- **dev-agent-live:** one real `instar nuke` of a throwaway agent on the Studio, with the other agents' sessions counted before and after.
- **fleet:** ships on; it only narrows what nuke touches.
- **graduation criterion:** the dev run removes exactly the target's sessions, launch entry and folder, and leaves every other agent's sessions running.
- **dark-window:** none; it ships on.
- **ladder:** none (no flag; a command-safety fix that only narrows behaviour).

## Rollout

Ships on. After it merges, spec `guard-runtime-state-scope` may consider `enforce`.
