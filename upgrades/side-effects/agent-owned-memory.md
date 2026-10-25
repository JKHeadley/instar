# Side-Effects Review — agent-owned Claude Code memory (never per login)

**Version / slug:** `agent-owned-memory`
**Date:** 2026-09-25
**Author:** Echo
**Driving rule:** operator (Justin), 2026-09-25, marked CRITICAL: "We should NEVER have anything dependent on a specific login. Those accounts are for token/quota access ONLY, NOT for data storage."

## Summary of the change

New `src/core/AgentOwnedMemory.ts`. `ensureAgentOwnedMemory({agentHome, configHome, cwd})` makes `<configHome>/projects/<key>/memory` a symlink to `.instar/agent-memory`. It does this only for the agent's own project: its home, plus any worktree or subfolder that resolves to it.

- A symlink someone else placed, which resolves outside this agent's home, is left alone.
- When a real folder or a stale symlink of our own is already at that spot, its contents are merged in. The merge is a union of files where the newest copy wins, a differing older copy goes to `_superseded/`, and `MEMORY.md` is merged by linked filename. The old entry is then renamed to `memory.pre-shared`, or a timestamped name if that is taken.
- A correct link is left untouched.

It is called from four places:
- `SessionManager.linkAgentOwnedMemory`, which runs in all four claude-code tmux spawn lanes (headless, reroute, interactive, triage) just before `new-session`, and fails open.
- `EnrollmentWizard.ensureCompletedLoginReady`, when a claude-code login completes. `agentHome` is wired from `server.ts`.
- `PostUpdateMigrator.migrateAgentOwnedMemory`, which sweeps every `~/.claude*` home for the agent's own key.
- `migrateClaudeMd` and the `generateClaudeMd` template, which reword the auto-memory line.

## Decision-point inventory

- Link / merge / skip in `ensureAgentOwnedMemory`: an `invariant` filesystem rule, with no judgment involved. It skips when the project is not the agent's own, when an existing link points outside the agent's home, when there is no `.instar/config.json`, when the config home is missing, when the key is longer than 200 characters (Claude Code hashes those and we do not guess), or when the agent is under the temp folder but the login is not.
- Newest-wins on a conflicting memory file: deterministic, and the losing copy is always kept, so no information is lost whichever way it goes.

## 1. Over-block

Nothing is blocked. Every call site is fail-open: an exception is logged and the spawn or enrollment proceeds as before. The spawn cost is one `lstat` plus `realpath` when the link is already correct.

## 2. Under-block

- **Claude launches that do not go through SessionManager**, such as builder scripts, a human running `claude`, or `claude -p` helpers, are not linked at spawn. They are still covered for the agent's own key: the update migrator and enrollment link every login home on the host. A brand-new login used only by a non-Instar launcher, and never enrolled through Instar, stays unlinked until the next update or Instar spawn.
- **Other projects the agent works in** (outside its home) keep per-login memory. Their memory folders can be shared with other agents on the host, or with a person running `claude` there, so taking them over is not safe without an ownership record. Sessions the agent runs in its own home and worktrees, which is the normal case, are covered. This is tracked with the transcript follow-up as CMT-596 <!-- tracked: CMT-596 -->.
- **Keys longer than 200 characters** are skipped, because Claude Code appends a hash we do not reproduce. Agent homes are short paths, so in practice this only affects deep temp folders.
- **Transcripts** (`projects/<key>/*.jsonl`) stay per login. This is tracked as CMT-596 <!-- tracked: CMT-596 -->. Doing it safely needs a merge of diverged copies of the same conversation, and a migration that doesn't rename folders live sessions are writing into (the Mac Studio has up to 884 entries per folder). Those risks don't fit this change. The copy-on-move step (`placeResumeTranscript`) keeps conversations working across logins in the meantime.
- **Codex homes**: `memories_1.sqlite` is empty in every Codex home on the Mac Studio (all tables have 0 rows in stage1_outputs and jobs), so no agent data lives there. Sharing a live SQLite file between homes through a symlink would be unsafe in any case. Codex homes stay credentials and quota only.

## 3. Level-of-abstraction fit

The link is made at the point where a config home is chosen for a launch, which is the SessionManager spawn lanes, and at the point where a login is created, which is enrollment. The migrator covers existing state.

Claude Code 2.1.282 also has an `autoMemoryDirectory` setting (flag, user or policy settings; ignored in project settings). It would cover only sessions Instar launches with that flag, and it depends on the CLI version. The symlink covers every launcher and every CLI version, and it matches the manual fix already live on echo. So the symlink is the more robust layer.

## 4. Signal vs authority compliance

No gate, filter or block is added. It is a data-placement step with no authority over agent behavior.

## 4b. Judgment-point check

None. The rules are deterministic, and every losing copy is preserved.

## 5. Interactions

- **Follow-me wipe** (`accountFollowMeCooperativeWipe`): `safeRmSync(home, recursive)` removes the symlink without following it. Before this change, wiping a login deleted that login's memory. Now the memory survives the wipe.
- **Resume placement** (`placeResumeTranscript`, `ensureResumeTranscriptInConfigHome`): these only touch `*.jsonl` and `<uuid>/` folders, never `memory/`, so there is no interaction.
- **Concurrent spawns**: `ensureAgentOwnedMemory` is fully synchronous, so two spawns inside one server cannot interleave. Only separate processes can race, such as the server and an update-migrator run. If both try to create the link, `symlink` fails with `EEXIST` for one of them, which re-checks that the link is correct and returns. If both see the same real folder, the loser either fails on `rename` (logged, fail-open, and the next spawn finds a correct link), or it merges the already-linked folder into itself, which changes nothing, and leaves one extra `memory.pre-shared-<time>` symlink behind. Nothing is lost in either case.
- **Live session under a login being migrated**: that session's next memory write goes through the new link into the agent folder. An open file handle in the renamed folder keeps writing there, and that data remains in `memory.pre-shared`. Claude Code writes memory files whole, by path, so this window is at most one write.
- **Tests with a real HOME**: the temp-agent guard means no test fixture can plant links in a developer's real login homes. The agent-home guard (`.instar/config.json`) covers the same risk for non-agent fixtures.
- **Manual fix already on echo**: its links point at `.instar/agent-memory`, which is exactly the target this code computes, so it reports already-linked and changes nothing.

## 6. External surfaces

Only the local filesystem changes: the login config homes, and only for the agent's own project key, plus `.instar/agent-memory` inside the agent home. Other agents' project folders, a person's memory for other projects, and links placed by someone else are never touched. The second-pass review showed that an earlier draft could take those over. The CLAUDE.md wording changes for agents. `.instar/agent-memory` is not git-ignored, so an agent whose home is git-synced carries its memory into its backups.

## 7. Multi-machine posture

`machine-local-justification: per-host-login-homes`: login config homes are per host, and the links are made on each host against that host's agent home. What memory an agent carries across machines is unchanged by this PR: before, it was one copy per login per machine; now it is one copy per machine. Any replication comes from the agent home's own git sync, which picks up `.instar/agent-memory` because it is not ignored.

## 8. Rollback cost

Revert the PR, and spawns stop linking. Existing links keep working, since they are just symlinks to a real folder. To restore the old per-login layout by hand, remove a link and rename its `memory.pre-shared` back to `memory`. No data is lost either way, because every merged-away copy is kept.

## Conclusion

Additive, idempotent and fail-open, and it never deletes anything. It closes the memory half of the operator's rule. Transcripts are tracked separately as CMT-596.

## Class-Closure Declaration (display-only mirror)

`{defectClass: "unbounded-self-action", closure: "n/a", reason: "no self-triggered action loop; a per-spawn idempotent link check and a one-shot idempotent migration"}`

## Second-pass review

Reviewer (independent subagent, 2026-09-25), first pass:

- **Concern 1:** two agents, or an agent and a person, working in the same outside project would take the memory folder from each other on every spawn, copying one's notes into the other's.
- **Concern 2:** the MEMORY.md merge could overwrite the agent's own index line without keeping a copy.

**Resolution:**
- Linking is now limited to the agent's own project key.
- A link that resolves outside the agent's home is left alone.
- The previous MEMORY.md is copied to `_superseded/` before being rewritten.
- Unit tests pin all three.
- On everything else the reviewer concurred: collision naming, key correctness, fail-open spawn wrapping, test guards and race handling.
