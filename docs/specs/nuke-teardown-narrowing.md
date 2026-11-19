---
title: "instar nuke no longer stops sessions started in another agent's home, and checks its deletes before teardown"
slug: "nuke-teardown-narrowing"
author: "echo (machine stewardship, topic 144503)"
tier: 2
parent-principle: "Verify the State, Not Its Symbol"
parent-principle-fit: "`instar nuke` decides which sessions to stop from a symbol, a name starting with `<projectName>-` (nuke.ts:141, :348). It does not check the state: whether the session actually works inside this agent's home. So removing `echo` stops the `echo-wt-*` agents' sessions."
eli16-overview: "docs/specs/nuke-teardown-narrowing.eli16.md"
review-convergence: "operator-approved after 5 rounds (NOT converged: round-5 fixes go to the build second pass; Chief of Staff msg a9037bba, 2026-11-19 01:44 PT)"
review-iterations: 5
review-report: "docs/specs/reports/nuke-teardown-narrowing-convergence.md"
approved: true
approved-by: "Chief of Staff, msg a9037bba, 2026-11-19 01:44 PT"
supersedes-draft: "docs/specs/nuke-teardown-by-ownership.md (6 rounds, not converged; split approved by the Chief of Staff, msgs 3d7f24de -> 718c4317)"
---

# instar nuke no longer stops sessions started in another agent's home, and checks its deletes before teardown

## Problem statement

`instar nuke` (`src/commands/nuke.ts`) stops sessions by name prefix:
- `nukeAgent` at `:127` and `:141`;
- `nukeHere` at `:336` and `:348`.

Every session whose name starts with `<projectName>-` is killed. `echo` is a name prefix of the `echo-wt-*` agent homes on the Studio, so `instar nuke echo` would kill their sessions (fb-7e502374-a36).

Three related faults:
- **tmux targets are prefixes too.** `-t name` without `=` (`:127`, `:556`) also matches by prefix.
- **Order.** The auto-start entry is removed after the server is killed (`:156`), and it is removed even if it points at a different folder.
- **Deletes are attempted after teardown.** A refused or failed delete still ends in "has been removed" (`:222-229`, and the same in `nukeHere`).

## Scope

This spec is the narrowing fix only. Every change makes nuke stop, remove or report **less than or equal to** what it does today, or refuse before doing anything. It never adds a new thing nuke may stop or delete.

The broader hardening goes to spec C, queued by the Chief of Staff (msg 718c4317). It covers:
- session tagging;
- locks;
- a writer-process scan;
- hand-started lifelines and the fleet watchdog;
- Linux `KillMode`;
- git-backup policy;
- `nukeHere`'s file restore (fb-c05cedd1-82b).

The git backup push keeps today's behaviour and today's place in the order.

## Proposed design

### 1. Which sessions are stopped: today's rule, sorted by where they started

Let `H` be the agent home:
- **`nukeHere`:** the project folder.
- **`nukeAgent`:** `<instarHome>/agents/<name>`. It is checked with `lstat` first, so it must be a real directory and not a symlink, and only then realpath-ed.

**Other agent homes** are the union of:
- every sibling folder `<instarHome>/agents/<other>`, with `<other>` not equal to `<name>`, that holds a `.instar` directory. These are standalone homes, registered or not; the `echo-wt-*` homes on the Studio hold `.instar` but are not in the registry. A stray folder without `.instar` does not count;
- entries in `~/.instar/registry.json` whose realpath still exists, still holds `.instar/config.json`, and neither equals `H`, contains `H`, nor sits above `H`.

So a stale entry, or a home at an ancestor folder (such as `~` or a test root), never counts. A missing registry file means no entries. A registry that exists but cannot be read or parsed is indeterminate and refuses before teardown, since it may be the only evidence of a nested home. Only homes beside or inside `H` do, and the most specific home wins.

nuke lists sessions with `tmux list-sessions -F '#{session_id}\t#{session_name}\t#{session_path}'`, splitting each line only on its first two tabs, since names and paths may contain spaces. If tmux reports that no server is running, that is an empty list (the agent is offline, as today). Any other listing error is indeterminate and refuses. Every session that matches **today's name rule** (`<projectName>-server`, or a name starting with `<projectName>-`) is placed by its start folder. The folder is realpath-ed, or lexically normalised when it no longer exists, and compared path component by path component, so `/agents/echo` never matches `/agents/echo-wt-1`. There are three outcomes:
- **Inside `H`:** stopped, as today.
- **Inside another agent home beside `H`** (for example `echo-wt-1` while nuking `echo`): left running and printed. This is the fix for fb-7e502374-a36.
- **Anywhere else** (outside `H` and outside every other agent home): **ambiguous**. Where a session starts does not limit where it writes; a hand-started helper may write into `H` by absolute path. So nuke refuses before any teardown, lists these sessions with their ids, and names the way out. `--also-stop <session_id>...` stops exactly those listed ids, and any id not on the list is refused.

  Measured on the Studio at 01:37 PT on 2026-11-19:
  - all 10 live `echo-*` sessions are echo's own (`echo-server`, `echo-topic-*` and similar) and start in `~/.instar/agents/echo`, so none is ambiguous;
  - no `echo-wt-*` session was live then;
  - an `echo-wt-<x>` agent's sessions start in its own home, because instar starts every session in its agent home (SessionManager `-c`, the server supervisor). So they fall in the skip case.

**Why not tags now.** Live sessions carry no `@instar_home` tag, so tags could not classify them. `#{session_path}` is still a symbol (the start folder, not where processes work), only a better one than the name prefix. Tags and a writer scan are spec C.

Sessions that do not match the name rule are not touched, as today. Every outcome is either today's stop, a skip of a session in another agent's home, or a refusal that changes nothing, so nuke never stops a session today's command would not.

**Nested homes.** If any other agent home is inside `H`, the command refuses before teardown. That means any registered home, any folder holding `.instar/config.json`, or, when `H/.instar` is itself an instar home, any `H/.instar/agents/<other>`. The command refuses whether or not that home has live sessions. That covers both `nukeAgent`'s whole-home delete and `nukeHere`'s recursive delete of `H/.instar`, for example a registered home under `H/.instar/worktrees/x`. The recursive delete would remove that agent's files while its sessions were left running.

**Listed twice.** The list is taken once at plan time, for the pre-check and the display. It is taken again after the auto-start entry is removed and the server is stopped, as today's code does at `:141`, to catch sessions the server started at the last moment. The same rule applies to the second list, with two exceptions:
- **The server.** The only eligible server target is the server id recorded at plan time. A different session named `<projectName>-server` in the second list means something restarted the server, so the deletes are refused.
- **New ambiguous sessions** also refuse the deletes.

Each refusal prints the partial state: what was stopped and what was removed.

**Which listing authorises which stop.**
- **Plan-time list:** authorises the server's stop by its recorded id.
- **Second list:** authoritative for every non-server session in it that matches the name rule and is inside `H`, whether new or already seen. They are stopped by their second-list ids.

Ambiguous sessions in the second list must each be named with `--also-stop`; otherwise the deletes are refused.

If stopping the server leaves no tmux server running, the second list is empty.

**Failed listing or stop.** A failed `list-sessions`, other than "no server running", is never read as "no sessions". It refuses before teardown or, on the second list, refuses the deletes. Each stop is confirmed with `has-session` on its id. Only tmux's "can't find session" (or "no server running") counts as gone. Any other error is indeterminate. A selected session still alive refuses unregistration and the deletes, and the partial state is printed.

### 2. Exact tmux targets

- **Stops** target the `#{session_id}` recorded at plan time, passed as one `execFileSync` argument (`['kill-session', '-t', '$N']`, no shell, no quotes), so a different session that later takes the same name is never stopped.
- **Lookups by name** use `-t =<name>`.

### 3. The auto-start entry: first, and only when it points at the home

Before any session is stopped, nuke reads the per-user entry (`ai.instar.<projectName>` plist, or the Linux unit):
- **It points at `H`.** Both the file on disk (read with `plutil`) and the loaded job (`launchctl print gui/<uid>/<label>`, read before any change) agree with `H`. At least one of `WorkingDirectory` and `--dir` must be present, and every one present must equal `H` after realpath. An entry with neither is unknown: it is kept and printed.

  Whether the job is loaded, and its program arguments, come from `launchctl list <label>`. That output is a property list carrying `ProgramArguments`, and it is parsed with a fixture test against its real output. `launchctl print` is used only for its exit status, to tell loaded from not loaded. A parse failure is indeterminate and refuses.

  An entry is **contradictory** when:
  - its fields disagree within one source (for example `WorkingDirectory` is `H` but `--dir` is elsewhere); or
  - the file and the loaded job disagree.

  A contradictory entry with a loaded job refuses before teardown. One with no loaded job is kept and printed.

  **On Linux**, the unit file is read, and the running unit is read with `systemctl --user show -p WorkingDirectory,ExecStart,NeedDaemonReload`. `NeedDaemonReload=yes` means the running unit may differ from the file, so it counts as contradictory. Gone is confirmed with `is-active` reporting inactive and the unit file removed. nuke removes the entry first, before stopping the server, so the lifeline cannot restart the server meanwhile. It runs `launchctl bootout`, then checks with `launchctl print` that the job is gone, then deletes the file. A job still loaded, or a file still present, stops the command before any session is stopped. On Linux, `stop` and `disable` are each checked, instead of one shared `try`.
- **Both point elsewhere.** nuke leaves them untouched, prints them, and continues. Today it would remove the entry.
- **They contradict each other.**
  - If the loaded job points at `H` but the file does not, the running lifeline could restart the server mid-teardown, so nuke refuses before teardown and changes neither.
  - If the file points at `H` but the loaded job does not, nuke leaves both and prints them.
- **Only one part exists** (a file with no loaded job, or a loaded job with no file, for example after a bootout whose file delete failed). That part is removed when it points at `H`, and kept and printed otherwise. Each part is handled on its own.
- **There is no entry.** Nothing to do.

A failed `launchctl print` (other than "service not found") or an unreadable file is an indeterminate lookup and refuses before teardown. It is never read as absent.

### 4. Every delete checked before teardown

**Preconditions:**
- `H` must be a real directory, not a symlink (`lstat` on the given path).
- For `nukeAgent`, the name must be one non-empty path component: not empty, no `/`, no NUL, not `.` or `..`. The guard repeats this check itself, so an empty name can never make the target the agents directory. There is no length cap of nuke's own; the folder must already exist.

**The check.** nuke builds the full delete plan:
- **`nukeAgent`:** the whole home.
- **`nukeHere`:** each artifact with its real `recursive` and `force` flags.

Each planned delete goes through the new `SafeFsExecutor.checkScope(target, opts)`. It is the decision half of the guard, extracted so it is side-effect-free: it writes no audit entry, and the audit stays in the execution wrapper. The real delete still runs the full guard again. If the target changed in between and is refused then, that is reported as a failure under §5, never skipped.

**One allowance.** `nukeAgentHomeScope: { agentName }` allows exactly a recursive, forced removal of `realpath(<instarHome>/agents/<agentName>)`. The guard builds that path itself from the instar home it resolves and the validated name, and the target must equal it and be a real directory. No caller-supplied path is trusted. It is the path spec `guard-runtime-state-scope` needs before it can enforce.

**Where the allowance sits.** When a caller supplies `nukeAgentHomeScope`, it is an exclusive decision, checked first: before the runtime-state carve-out and before the source-tree assert, the way `localVerifyScopeOk` already is. It allows only if:
- the target is the guard-built path;
- that path is a real directory;
- `recursive` and `force` are both set.

Otherwise it refuses, and no generic allow is consulted. It also requires the canonical (realpath-ed) target to contain an interior `/.instar/` segment, which is exactly today's carve-out condition. If `~/.instar` is a symlink to a folder named differently, today's guard would go on to the source-tree check, and the allowance refuses rather than bypass it. Today the carve-out (any interior `/.instar/` segment) already allows `safeRmSync(~/.instar/agents/<name>)`, including an agent-mode home that is itself a checkout. So the allowance permits nothing today's command cannot do. It also keeps exactly that one delete working once spec `guard-runtime-state-scope` narrows the carve-out. Both outcomes are tested through `safeRmSync` itself.

Any refusal stops the command before anything is torn down, and names the refused path.

### 5. Honest result

Each step's outcome is collected: each session stop, the entry removal, unregistration (an absent registration counts as done), each restore and each delete. If any failed, nuke prints each failure with its path, does not print "has been removed", and exits non-zero.

## Decision points touched

- **Which sessions nuke stops.** — invariant. basis: irreversible-consequence; evidence: stopping a session ends its work. Today's name rule, and then: a start folder inside the home is stopped; one in a sibling agent home is skipped; anything else refuses, unless the operator names its id with `--also-stop`. The result is always a subset of today's.
- **Whether the auto-start entry is removed.** — invariant. basis: irreversible-consequence; evidence: removing another folder's entry disables that agent. Only when it points at the home; otherwise it is left and printed.
- **Whether teardown may begin.** — invariant. basis: irreversible-consequence; evidence: teardown is not reversible. Every planned delete must pass `checkScope` with its real flags first.
- **The whole-home delete allowance.** — invariant. basis: enumerable-domain; evidence: exactly one path, built by the guard.

## Frontloaded Decisions

- **Narrow, never widen.** A session the old rule would not stop is never stopped. A name-matched session is left running only when it started inside another agent home beside `H` (a sibling folder holding `.instar`, or a live registry entry). One with no home is refused, not guessed at, because where a session starts does not limit where it writes.
- **A non-matching entry is left, not refused.** It belongs to another folder, and refusing would block removal for a reason unrelated to this agent.
- **The backup push is unchanged.** Changing its policy is spec C's.

## Multi-machine posture

`machine-local-justification: hardware-bound-resource`. nuke acts on this machine's tmux sessions, launch entries and disk. The existing git backup push is unchanged.

## Testing

**Sandboxing, required for every nuke test.** `nukeAgent` calls `execFileSync('tmux')`, `uninstallAutoStart` (real `launchctl` and `~/Library/LaunchAgents`), the SecretManager backup and `unregisterAgent` directly. So every unit test:
- mocks `node:child_process`, `./setup.js`, SecretManager, AgentRegistry and `standaloneAgentsDir`;
- runs with a temporary `HOME`;
- uses names that are not real agents (`zz-echo`, `zz-echo-wt-1`).

No test may reach the live `ai.instar.echo` entry or the real registry.

**Tests:**
- **Reproduction first (Chief of Staff request, msg 718c4317).** Two sibling homes, `<tmp>/.instar/agents/zz-echo` and `<tmp>/.instar/agents/zz-echo-wt-1`. The second is not registered, as on the Studio today. Sessions `zz-echo-server` and `zz-echo-wt-1-server` each started in their own home. Nuking `zz-echo` must stop `zz-echo-server` and must not stop `zz-echo-wt-1-server`. The test is committed first and fails on today's code (`zz-echo-wt-1-server` is killed by the prefix rule).
- **Integration, real tmux, sandboxed `HOME` and its own tmux server (`TMUX_TMPDIR`):** sibling throwaway homes `zz-nt` and `zz-nt-two` with live sessions. The case is run once against today's code and shown to kill `zz-nt-two-server`, with output recorded in the PR (Bug-Fix Evidence Bar). With the fix, `nukeAgent('zz-nt')` removes `zz-nt`'s home and sessions, and `tmux has-session -t =zz-nt-two-server` still succeeds.
- **Unit, the session rule:**
  - component-wise comparison;
  - inside `H` (including `H/.instar/worktrees/x`) is stopped;
  - inside a sibling home (registered or not) is skipped and printed;
  - a stale registry entry, or one above `H`, never causes a skip;
  - `--also-stop` stops only listed ids;
  - a replacement server in the second list refuses the deletes;
  - a failed listing refuses, and "no server running" is an empty list (an offline agent is removable);
  - a single-session agent on an isolated tmux server finishes after its last session stops;
  - a new in-home worker in the second list is stopped by its second-list id;
  - a file-only or loaded-only entry is removed when it points at `H`;
  - a failed `launchctl print` refuses;
  - names and paths containing spaces parse correctly;
  - a worker in both lists is stopped by its second-list id, and of two ambiguous ones with one approved, the deletes are refused;
  - an unreadable registry refuses, even for an offline agent;
  - an entry with neither `WorkingDirectory` nor `--dir` is kept;
  - a `launchctl list <label>` fixture parses, and a parse failure refuses;
  - an empty name refuses in the command and through `safeRmSync`;
  - an unregistered foreign home under `H/.instar/agents/` refuses `--here`;
  - a permission error from `has-session` after a failed kill keeps the home and exits non-zero;
  - an internally conflicting loaded entry refuses;
  - Linux `NeedDaemonReload=yes` refuses, with a `systemctl show` fixture;
  - with `~/.instar` symlinked to a differently named folder, the allowance refuses, tested through `safeRmSync`;
  - a sibling folder without `.instar` does not count as a home;
  - a stop that leaves the session alive refuses unregister and the deletes;
  - a loaded job pointing at `H` with a file pointing elsewhere refuses before teardown;
  - for `nukeHere`, a registered home under `H/.instar` refuses;
  - a home-less name match refuses before teardown with no call made;
  - a missing start folder is compared lexically;
  - a registered home nested in `H` refuses;
  - a session appearing in the second list is handled by the same rule, and a new ambiguous one refuses the deletes and prints the partial state;
  - a property check confirms the stopped set is never larger than the old rule's.
- **Unit, targets:** stops use the recorded `$N` id; a same-name session created after planning survives; lookups use `=name`.
- **Unit, the entry:**
  - file and loaded job both pointing at `H`: removed before any session stop, with `print` verified;
  - a matching file with a foreign loaded job: both untouched;
  - still loaded after bootout: the command stops with no session stopped;
  - pointing elsewhere: untouched and printed;
  - Linux: `stop` and `disable` are checked separately.
- **Unit, preconditions and plan:**
  - a symlinked home is refused before teardown;
  - a bad name is refused;
  - every `nukeHere` delete is pre-checked with its real flags;
  - a refused one changes nothing;
  - `checkScope` writes no audit entry.
- **Unit, the allowance:**
  - it allows exactly the built path with `recursive` and `force`;
  - it refuses another agent's home, a nested path and a symlink;
  - an agent-mode home that is a checkout, under `<tmp>/.instar/agents/zz-echo`, is allowed exactly as today, and is allowed through the allowance once the carve-out is narrowed;
  - `checkScope` and the delete agree.
- **Unit, the result:**
  - a failed restore followed by a successful delete exits non-zero, names the failure, and does not claim removal;
  - a failed unregister is reported;
  - an absent registration is not a failure.

## Maturation plan

- **test-agent-live:** the integration case.
- **dev-agent-live:** one real `instar nuke` of a throwaway agent on the Studio. Every other session's `#{session_id}` is recorded before and after, and the two sets must be equal.
- **fleet:** ships on; it only narrows.
- **graduation criterion:** the dev run removes exactly the target's sessions, entry and folder, and every other session still runs.
- **dark-window:** none.
- **ladder:** none (no flag; a narrowing safety fix).

## Rollout

Ships on. After it merges, spec `guard-runtime-state-scope` may consider `enforce`.
