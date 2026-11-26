# Avoid TCC-Protected Directories — Plain-English Overview

> The one-line version: on a Mac, Instar now refuses to create an agent inside Documents, Desktop, Downloads or iCloud Drive, and an agent that already lives there is told loudly at every boot and every update, because macOS can pull the plug on those folders for every agent at once.

## The problem in one breath

On 2026-10-14 at 16:00 the Mac's privacy system (TCC, the thing behind "Terminal would like to access your Documents folder") withdrew Documents access from the one tmux server that every agent on the laptop runs under. In the next 22 minutes there were 28,382 permission failures. Two agents whose folders were under `~/Documents/Projects` died in the same second, because they could no longer write their own state files. They had not crashed, run out of memory, or updated. Fourteen minutes later access came back and they recovered on their own. A third agent survived only because it had been moved out of Documents the day before. Even reading the logs needed sudo, because sessions under that tmux server could not see Documents either. The operator's reaction: "the Documents folder on Mac is AVOIDED AT ALL COSTS." This change turns that sentence into code.

## What already exists

- **The worktree convention** — `instar worktree create` already refuses any destination outside the agent's own home, because the macOS sandbox can revoke access elsewhere. This change copies that shape: resolve the real path, refuse the wrong place, say why.
- **The guards inventory** — `GET /guards` already lists every safety system and whether it is really on. New guards are declared in a manifest and register themselves at boot.
- **The attention queue** — one durable hub where things that need a human land, deduplicated by item id, with a JSONL fallback when Telegram is not set up.
- **`instar doctor`** — the health checklist an operator runs by hand.
- **The post-update migrator** — the piece that patches every existing agent when a new Instar version lands, so a change reaches old agents, not only new ones.
- **The standards registry** — the constitution. Each standard names the code that enforces it, and an audit checks that code really exists.

## What this adds

- **A standard** in the registry: *Avoid TCC-Protected Directories — No Agent State Under ~/Documents on macOS*. It covers Documents, Desktop and Downloads (Apple treats all three as one consent class, so one withdrawal hits all three) and iCloud Drive (same class, and it can also push files to the cloud underneath a running process). Linux is explicitly out of scope: this is a macOS mechanism and the guard must not fire there.
- **Refusal at creation.** `instar init` (fresh, existing-directory, and standalone) checks the target before writing anything. On a Mac, a target under one of those folders is refused with the reason, the safe alternatives, and the runbook. There is no override flag. A new agent has nothing to move, so the only cost of refusing is picking another folder, and an override would let the exact incident happen again.
- **Detection at boot.** The server checks its own project and state directories once at start. If they are in a protected folder it prints one loud `TCC-PROTECTED PATH` line, raises one HIGH attention item (the same finding is never re-posted while it is open; if someone marked it resolved without moving the agent, the next boot reopens it), and reports the guard as a row on `GET /guards`. Once the agent has been moved, the next boot closes the item by itself. It never moves anything, and a slow Telegram cannot hold the boot up (the wait is capped, and the finding is written to a local file instead).
- **`instar doctor`** gains a "Project location" line: ok, or fail with the folder and the runbook.
- **Migration parity.** On update, an existing agent inside a protected folder gets the finding in its migration summary (which rides the update notice) and the new CLAUDE.md section, so it knows about the mandate and the runbook. The finding repeats on every update until the agent is moved, then disappears by itself.
- **A runbook** (`docs/runbooks/move-agent-out-of-documents.md`) with the move that was proven on three agents: rename on the same disk, leave a symlink at the old path, update the launchd plist, reload, verify.

## The new pieces

- **TccProtectedPathGuard** (`src/core/TccProtectedPathGuard.ts`) — the classification (is this path inside a protected folder on macOS?), the refusal used by init, the boot detector, and the guards-row getter. It resolves symlinks on the longest part of the path that exists, so a symlink left at the old location after a move is not a finding, while a symlink that points into Documents is.
- **The manifest row** `monitoring.tccProtectedPathGuard` — always on, no config key, marked load-bearing. A failed check shows as "verdict unknown", never as green.

## The safeguards

**Prevents false alarms on Linux.** The platform is checked first; on anything but macOS the classification is always "not protected" and the boot line says "not applicable".

**Prevents a flood.** The detector emits at most one item per boot, keyed on the set of protected paths. Without Telegram the finding goes to a JSONL file with a 24-hour dedupe window.

**Prevents the guard from touching anything.** No code in this change moves, renames, deletes or rewrites a directory. The move is a documented operator action.

**Prevents the guard from blocking a boot.** Every failure inside the detector is captured into the result and shown on the guards row; the server keeps starting.

## What ships when

One PR: the standard, the guard module, the init refusal, the boot detection and guards row, the doctor check, the migrator parity, the CLAUDE.md section for new and existing agents, the runbook, and tests in all three tiers (the refusal actually refuses; Linux is untouched; the row is alive on the real server boot path).

## What you actually need to decide

Nothing beyond the merge. The one judgment call, whether the refusal at creation should be absolute, follows the operator's own words ("at all costs"): it is absolute, and the reasons are recorded in the standard and in the code.
