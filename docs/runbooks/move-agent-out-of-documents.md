# Runbook — Move an agent out of ~/Documents (macOS)

```bash
# 1. Stop the agent (launchd label is usually com.instar.<agent>; check: launchctl list | grep instar)
launchctl bootout gui/$(id -u)/com.instar.<agent>
# 2. Rename in place onto the SAME disk, outside Documents/Desktop/Downloads/iCloud Drive
mv ~/Documents/Projects/<agent> ~/Projects/<agent>
# 3. Leave a symlink at the old path so anything still pointing there keeps working
ln -s ~/Projects/<agent> ~/Documents/Projects/<agent>
# 4. Point the launchd plist at the new path (program args, WorkingDirectory, any --dir)
sed -i '' 's#/Users/<you>/Documents/Projects/<agent>#/Users/<you>/Projects/<agent>#g' ~/Library/LaunchAgents/com.instar.<agent>.plist
# 5. Reload
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.instar.<agent>.plist
# 6. Verify: the port answers and the boot log is clean
curl -s http://localhost:<port>/health | head -c 200; echo
tail -40 ~/Projects/<agent>/logs/server.log | grep -E "TCC-protected path guard|listening|error" 
```

Done when `/health` answers, the boot log shows `TCC-protected path guard: clear`, and `instar doctor` shows `Project location` as ok. The attention item that pointed you here is closed by the guard itself at that boot (the finding set is empty, so it resolves the category's open items); without Telegram, the JSONL fallback simply stops gaining lines. (`GET /guards` shows the guard's row as on-confirmed in both states; it reports that the check ran, not what it found.)

---

## Why this runbook exists

On 2026-10-14 at 16:00:05 PDT macOS TCC (Transparency, Consent and Control) withdrew `~/Documents` access from the single tmux server that every agent server on the operator's laptop is a child of. 28,382 permission denials followed in 22 minutes. Two agents whose project directories lived under `~/Documents/Projects` died in the same second on `EPERM` writing their own state files. Not a crash, not memory, not an update. Access returned about fourteen minutes later and they self-recovered. A third agent survived only because its project directory had been moved out of `~/Documents` the day before, with exactly the steps above.

The grant belongs to the process tree, not to the agent. One withdrawal takes every agent under that tree down at once, and a session spawned under it cannot even read the folder to find out why. This is the constitutional standard *Avoid TCC-Protected Directories — No Agent State Under ~/Documents on macOS* (`docs/STANDARDS-REGISTRY.md`). The operator's words: "the Documents folder on Mac is AVOIDED AT ALL COSTS."

## Which folders count

`~/Documents`, `~/Desktop`, `~/Downloads` (Apple's three "protected folders", one consent class) and iCloud Drive (`~/Library/Mobile Documents`, same class, plus cloud eviction). Removable and network volumes are also TCC-gated but are not checked by the guard.

Safe places: `~/.instar/agents/<name>` (what `instar init --standalone <name>` creates), `~/Projects/<name>`, or any other path directly under your home that is not one of the four above.

## What Instar does about it

- **Refuses at creation.** `instar init` on macOS refuses a project directory under a protected folder and prints why. There is no override flag: a new agent has nothing to move, so choose another path.
- **Detects at boot.** If an agent already lives there, the server prints a loud `TCC-PROTECTED PATH` line, raises one deduped HIGH attention item (this runbook is named in it), and reports the guard as a row on `GET /guards` (`monitoring.tccProtectedPathGuard`). `instar doctor` shows a `Project location` check.
- **Re-surfaces on update.** The post-update migrator adds the finding to the migration summary on every update until the agent is moved.
- **Never moves anything.** The move is yours; that is this runbook.

## Notes on the move

- **Same disk.** A rename on the same volume is instant and keeps inode identity, so open files, sockets and the SQLite stores are unaffected once the agent is restarted. Moving across volumes is a copy; stop the agent first and expect it to take as long as the data is large.
- **Why the symlink.** Shell history, scripts, other agents' topic bindings, and the Claude Code project index (`~/.claude/projects/<encoded path>`) may still name the old path. The symlink keeps them working while you update them at leisure. The guard resolves symlinks on the real path, so a symlink left at the old location is never counted as a finding.
- **Symlink the other way is the trap.** A path like `~/Projects/<agent>` that is itself a symlink *into* `~/Documents` still resolves inside the protected folder, and the guard says so. Move the real directory, not the link.
- **Claude Code transcripts.** Claude Code keys its per-project transcript directory on the encoded project path. After the move, resumed sessions start a fresh transcript directory for the new path; nothing is lost, the old directory stays under `~/.claude/projects/`.
- **Multi-machine agents.** The protected-folder rule is per machine (the grant is local). Move each machine's copy separately; the mesh registry carries the machine id, not the path.
- **Worktrees.** `instar worktree create` already refuses any destination outside the agent home, so once the home is out of Documents its worktrees are too.
