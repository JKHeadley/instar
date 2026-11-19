# Side-Effects Review — instar nuke stops only its own sessions and checks its deletes before teardown

**Version / slug:** `nuke-teardown-narrowing`
**Date:** `2026-11-19`
**Author:** `echo`
**Second-pass reviewer:** `required (Chief of Staff approval a9037bba: the build's second pass covers the five round-5 fixes — empty name, unregistered nested home, has-session errors, the Linux running unit, launchctl list in place of parsing print)`

## Summary of the change

`instar nuke` (`src/commands/nuke.ts`, `nukeAgent` and `nukeHere`) chose which tmux sessions to stop by a name prefix (`<projectName>-`), so `instar nuke echo` would also stop every `echo-wt-*` agent's sessions (fb-7e502374-a36). It also removed the auto-start entry after killing the server and whatever folder it pointed at, attempted deletes after teardown, and printed "has been removed" even when a delete failed. This change implements spec `docs/specs/nuke-teardown-narrowing.md`, sections 1-5:

- Everything is planned before teardown:
  - other agent homes: sibling `~/.instar/agents/*` folders holding `.instar`, plus live registry entries;
  - nested homes, which refuse;
  - the session list, with each session placed by its start folder;
  - the auto-start entry;
  - the delete plan, each item checked with `SafeFsExecutor.checkScope`.
- Sessions are stopped by their `$N` id and each stop is confirmed with `has-session`.
- The auto-start entry is removed first, and only when it points at the home.
- Every step's outcome is collected, and any failure exits non-zero.

`src/core/SafeFsExecutor.ts` gains:
- a side-effect-free `checkScope`, made by splitting `guard()` into `decide()` (pure) and the audit wrapper;
- `isSingleComponentName`;
- the exclusive `nukeAgentHomeScope` allowance, checked first.

`src/cli.ts` gains `--also-stop <ids...>`. The CLI reference gets a short paragraph. `tests/unit/nuke-here.test.ts` is now sandboxed; before this change it reached the real tmux server and real `launchctl bootout`.

## Decision-point inventory

- `nuke: which sessions are stopped` — modify — today's name rule, then placement: inside H stops; inside another home is skipped; anywhere else refuses unless named with `--also-stop`. Always a subset of today's set.
- `nuke: whether the auto-start entry is removed` — modify — only when the file and/or the loaded job point at H; contradictory or indeterminate entries refuse; foreign ones are kept and printed.
- `nuke: whether teardown may begin` — add — nested home, unreadable registry, failed tmux/launchctl/systemctl lookup, a refused planned delete, a bad name or a symlinked home each refuse before anything changes.
- `SafeFsExecutor: nukeAgentHomeScope allowance` — add — an exclusive allow for exactly `realpath(~/.instar/agents/<name>)` with recursive+force, interior `/.instar/` required.
- `SafeFsExecutor: guard()` — modify (refactor only) — the decision is now `decide()`; the carve-out order, the reasons and the audit entries are unchanged for callers that do not pass the new option.

---

## 1. Over-block

**What legitimate inputs does this change reject that it shouldn't?**

- **A helper session the operator started by hand outside every agent home**, for example `echo-scratch` in `/tmp`. It now refuses until it is named with `--also-stop <id>`. This is intended (spec §1, "ambiguous"), and the refusal prints the exact ids and the flag.
- **An agent home that contains any nested folder holding `.instar/config.json`.** It refuses, even when that folder is a stale copy and not a live agent. The operator has to move or delete the nested folder first. Intended: the recursive delete would otherwise remove it.
- **A corrupt `~/.instar/registry.json`.** nuke now refuses for every agent until the file is repaired. Before, `loadRegistry()` silently read a corrupt file as empty.
- **An unreadable subfolder inside H**, for example a root-owned folder. The nested-home scan refuses. Today's recursive delete would also have failed on it, but only after the sessions were stopped.
- **A tmux binary missing from PATH.** This is treated as "no sessions", not as a refusal: with no tmux installed there can be no tmux server. This deviates from the spec's literal "other listing errors refuse"; see Conclusion.

---

## 2. Under-block

**What failure modes does this still miss?**

- **Where a session starts does not limit where it writes.** A session that started in a sibling agent's home but writes into H by absolute path is left running while H is deleted. Spec C (tags and a writer-process scan) covers this.
- **The nested-home scan skips `node_modules` and `.git`.** An agent home buried inside either would not be found by the scan; a registered one is still caught by the registry check. The skip keeps the walk bounded on large checkouts.
- **Hand-started lifelines, the fleet watchdog (`ai.instar.watchdog`) and Linux `KillMode` are out of scope** (spec C). The watchdog may re-bootstrap an `ai.instar.*` plist between nuke's bootout and its file delete; the file delete is verified, and a re-loaded job would show up only on a later run.
- **A session whose name does not match the rule is never touched, as today.**

---

## 3. Level-of-abstraction fit

The session and auto-start decisions belong to the command. They are local, deterministic checks on an irreversible operator action, and they sit where the teardown happens.

The delete allowance belongs to `SafeFsExecutor`, the single funnel for destructive fs operations, beside the existing `localVerifyScopeOk` allowance. It builds its own path, so it trusts no caller-supplied path.

`checkScope` reuses the guard's own decision function, so the pre-check and the real delete cannot drift apart. A test asserts that they agree.

No higher-level gate exists for this CLI path that it should feed instead.

---

## 4. Signal vs authority compliance

**Required reference:** [docs/signal-vs-authority.md](../../docs/signal-vs-authority.md)

- [ ] No — this change produces a signal consumed by an existing smart gate.
- [ ] No — this change has no block/allow surface.
- [ ] Yes — but the logic is a smart gate with full conversational context (LLM-backed with recent history or equivalent).
- [ ] ⚠️ Yes, with brittle logic — STOP.

None of the boxes fits exactly. The change holds block authority with deterministic logic, and that logic only ever narrows what an irreversible operator command does. Every new decision makes nuke stop, remove or report less than, or the same as, today, or refuse before acting. The signal-vs-authority concern is brittle logic blocking legitimate work. Here a wrong refusal costs one re-run with `--also-stop`, or a manual fix of a corrupt file. A wrong allow would lose another agent's work, which this change removes. Safety guards on irreversible actions are deterministic by design.

## 4b. Judgment-point check (Judgment Within Floors standard)

No new static heuristic sits at a competing-signals decision point. The spec's `## Decision points touched` declares each decision an invariant:

- the stopped set and the auto-start removal: `irreversible-consequence`;
- the allowance: `enumerable-domain`, exactly one guard-built path.

---

## 5. Interactions

- **Shadowing.** The `nukeAgentHomeScope` decision runs before the runtime-state carve-out and the source-tree assert, but only when a caller passes it. Only `nukeAgent` does. Every other caller of `safeRm*` / `safeUnlink*` / `safeRmdir*` gets the same decision path, reasons and audit entries as before, because `decide()` keeps today's order.
- **Double-fire.** nuke no longer calls `uninstallAutoStart` (`src/commands/setup.ts`). It reads and removes the entry itself, so it can check that the entry points at H and verify each part. `uninstallAutoStart` is unchanged for `cli.ts`'s `autostart uninstall` and for `test-as-self`.
- **Races.**
  - *The server restarts between plan and stop.* The second list detects a `<p>-server` with a new id and refuses the deletes.
  - *A worker starts at the last moment.* The second list catches it and stops it by its new id.
  - *A target is swapped between check and delete.* The real delete re-runs the full guard, and a refusal at that point is reported as a failure.
  - *launchd may lag after bootout.* The check polls `launchctl print` up to 10 times, 200 ms apart, before refusing.
- **Feedback loops.** None.

---

## 6. External surfaces

- **Other agents on the same machine:** this is the point of the change. Their tmux sessions and auto-start entries are no longer stopped or removed by nuking a name-prefix agent.
- **Install base:** CLI output changes. nuke prints left-running sessions, refusal reasons and failure summaries. On a failure the exit code is now 1; before, it was 0 even when a delete failed.
- **External systems:** none. The git backup push is unchanged.
- **Persistent state:** none new. Auto-start files are deleted through `SafeFsExecutor.safeUnlinkSync`, as before.
- **Operator surface:** `instar nuke` is a terminal command the user runs themselves by design (`src/scaffold/templates.ts`, "Agent Removal": "the ONE command the user must run themselves"). This adds no new operator action; `--also-stop` is a flag on that same command.

## 6b. Operator-surface quality (Operator-Surface Quality standard)

No operator surface. No dashboard, approval page or grant form is touched, so this is not applicable.

---

## 7. Multi-machine posture (Cross-Machine Coherence)

**machine-local BY DESIGN** (`hardware-bound-resource`). nuke acts on this machine's tmux server, launchd/systemd entries and disk. It:
- emits no user-facing notices;
- holds no durable state;
- generates no URLs.

The git backup push is unchanged. No `/status`, `/health`, `/capabilities` or `/channels` answer changes.

---

## 8. Rollback cost

- **Hot-fix release:** pure code change; revert and ship a patch.
- **Data migration:** none. No persistent state is added.
- **Agent state repair:** none.
- **User visibility:** during a rollback, nuke goes back to the old prefix behaviour. That is the bug this change fixes, so rolling back re-exposes `echo-wt-*` sessions to `instar nuke echo`.

---

## Conclusion

The review produced no design change beyond the spec. Four implementation choices are worth flagging:

1. **No tmux binary counts as no sessions** (spec: "other listing errors refuse"). With no tmux installed there can be no tmux server. Refusing would make nuke unusable on a machine that never ran tmux.
2. **The nested-home scan skips `node_modules` and `.git`.** This bounds the walk on large agent-mode checkouts. Registered nested homes are still caught by the registry check.
3. **When the second list finds a new ambiguous session or a replacement server, nuke stops nothing further.** The in-home sessions in that list are left running. This is the narrower of the two readings of "refuses the deletes".

4. **Session listing uses a space after the `$N` id, not a tab** (spec §1 says tab-delimited). Measured on tmux 3.7c: when tmux does not run in a UTF-8 locale, as under the test runner, it replaces the tab in `-F` output with `_`. The first real-tmux run of the fix therefore refused, safely, with `unparseable tmux line: "$0_zz-nt-server_/…"`. nuke now takes two listings, `#{session_id} #{session_name}` and `#{session_id} #{session_path}`, and joins them by id. Each line splits on its first space; an id never contains a space, and the rest of the line may contain spaces. If the two listings disagree, nuke lists again up to 3 times and then refuses. This keeps the spec's intent that names and paths with spaces parse.

The `uninstallAutoStart` callers outside nuke are untouched.

Second pass done: the five round-5 items were checked by name; see below.

---

## Second-pass review (if required)

**Reviewer:** an independent reviewer subagent, 2026-11-19 03:04 PT.

**First pass: concern raised.** The real-tmux integration test's fake made `systemctl` throw. On the Linux CI integration job (`ubuntu-latest`), nuke reads the running unit and refuses when it cannot. That made the test fail there, although the code was correct.

**Fix:** the fake now returns `LoadState=not-found`, the same way `tests/unit/nuke-here.test.ts` does.

**The five round-5 items, each checked by name against the code:**
1. **The empty name:** refused in the command and in the guard, which builds its own path. Tested through `safeRmSync`.
2. **An unregistered nested home:** refused for both forms, including `H/.instar/agents/<x>`.
3. **`has-session` errors:** only "can't find session" or "no server running" count as gone. Permission-denied is tested.
4. **The Linux running unit:** read with `systemctl --user show`, and `NeedDaemonReload=yes` counts as contradictory. Fixture-tested.
5. **`launchctl list <label>`:** used for the arguments, while `print` gives exit status only. A parse failure refuses. The fixture matches real `launchctl list` output.

**Also confirmed:**
- Against `HEAD`, nothing is stopped or deleted beyond today.
- The allowance is exclusive, checked first, built by the guard, and requires an interior `/.instar/`.
- All four builder deviations are acceptable.
- No test reaches the real tmux server, `launchctl`, LaunchAgents or the registry.

**Independent read of the artifact:** Concur with the review, after the Linux-fake fix.

---

## Evidence pointers

- Reproduction before the fix, unit: `/tmp/claude-501/nuke-repro-before.txt`. Shows `zz-echo-wt-1-server` killed: `expected [] to include 'zz-echo-wt-1-server'`.
- Reproduction before and after the fix, real tmux on an isolated `TMUX_TMPDIR` server: `/tmp/claude-501/nuke-integration-before.txt` and `/tmp/claude-501/nuke-integration-after.txt`.
- Tests:
  - `tests/unit/nuke-teardown-narrowing.test.ts`
  - `tests/unit/SafeFsExecutor-nukeAgentHomeScope.test.ts`
  - `tests/unit/nuke-here.test.ts` (now sandboxed)
  - `tests/integration/nuke-teardown-narrowing.test.ts`

---

## Class-Closure Declaration (display-only mirror)

No agent-authored-artifact defect, so this is not applicable. The defect is in instar source code (`src/commands/nuke.ts`), not in a prompt, hook, config, skill or standards text. It adds no self-triggered controller.
