# Autonomous Stop Hook Scoping — Architecture Brainstorm

## The Core Problem Restated

The Stop hook in `.claude/settings.json` is a global broadcast. When autonomous mode activates, every Claude Code session in the project receives the hook. The hook cannot distinguish "I am the autonomous session" from "I am an unrelated session that happens to be running concurrently." The only runtime information available to the hook is what arrives on stdin: `session_id` and `transcript_path`.

The attempted fix (storing `CLAUDE_CODE_SESSION_ID` in the state file during setup) failed because setup runs from a bash script outside a Claude Code session context, where the env var is empty.

---

## The Real Fix Hidden in Plain Sight

Before presenting 3 solutions, note a critical observation: the Stop hook RECEIVES `session_id` on stdin as part of the hook payload JSON. The original approach tried to capture `CLAUDE_CODE_SESSION_ID` from the env var during setup — which is empty outside a Claude Code process. But the hook itself always has access to the current session's ID via stdin. This means the autonomous session's ID is discoverable on the very FIRST Stop hook call, from the hook's own stdin — not from the environment. The env var problem was a red herring.

---

## Solution 1: Self-Bootstrapping Session ID from Hook Stdin

**Mechanism:**
On the first Stop hook call within the autonomous session, write the `session_id` from stdin into the state file. All subsequent calls — from any session — compare their stdin `session_id` against the stored value. Non-matching sessions pass through immediately.

**Implementation:**
The state file currently has `session_id: ""` (empty, because the env var was empty at setup time). The hook change:

```js
const hookInput = JSON.parse(stdinData);
const currentSessionId = hookInput.session_id;

const state = readStateFile();

if (state.active) {
  // Bootstrap: if we have no stored session ID yet, claim this session
  if (!state.session_id && currentSessionId) {
    state.session_id = currentSessionId;
    writeStateFile(state);  // atomic write
  }

  // Gate: if stored session ID doesn't match this call, pass through
  if (state.session_id && currentSessionId !== state.session_id) {
    process.stdout.write(JSON.stringify({ decision: 'approve' }));
    process.exit(0);
  }

  // ... rest of autonomous logic
}
```

**Bootstrap race condition:** Two sessions could both see `session_id: ""` and both try to write. Use an atomic write with a temp file + rename (`fs.renameSync` is atomic on POSIX) combined with a read-after-write verification. The session that wins the rename owns the ID.

**Simpler alternative:** The autonomous session is activated BY a Claude Code session (the user typed `/autonomous`). That means the first Stop hook call after activation is necessarily from the autonomous session itself — no other session would stop immediately after activation. Write the ID unconditionally on first call. The race window is vanishingly small.

**Rating:**
- Reliability: **9/10** — Session ID is always present in hook stdin. Bootstrap window is tiny. Atomic write eliminates the race.
- Complexity: **3/10** — Minimal hook change. No new infrastructure.
- Risk: **2/10** — Worst case: wrong session claims the ID during the sub-second bootstrap window. Mitigated by atomic rename.

---

## Solution 2: Transcript Path as Immutable Session Fingerprint

**Mechanism:**
The `transcript_path` in the hook payload encodes the session identity in its filesystem path (e.g., `.claude/transcripts/<session-id>/session.jsonl`). Store the transcript path (or its dirname) in the state file on first activation. Subsequent hooks extract the path from stdin and compare.

**Why this is robust vs Solution 1:** The transcript path is a filesystem artifact — it cannot be spoofed or collide. If session IDs were ever non-unique (unlikely but hypothetically), the transcript path is still unique per session.

**Implementation:**
```js
const hookInput = JSON.parse(stdinData);
const transcriptPath = hookInput.transcript_path;
const sessionDir = path.dirname(transcriptPath);  // unique per session

const state = readStateFile();
if (state.active) {
  if (!state.transcript_dir) {
    state.transcript_dir = sessionDir;
    writeStateFile(state);
  }
  if (state.transcript_dir && sessionDir !== state.transcript_dir) {
    process.stdout.write(JSON.stringify({ decision: 'approve' }));
    process.exit(0);
  }
  // ... autonomous logic
}
```

**Additional use:** The transcript path lets the hook read the actual conversation to check for completion signals — not just block/allow, but understand what the session has been doing.

**Rating:**
- Reliability: **9/10** — Transcript path is always unique and always present. Same bootstrap window as Solution 1.
- Complexity: **3/10** — Nearly identical to Solution 1 but using path instead of ID field.
- Risk: **2/10** — Same race window caveat. Slightly more path parsing.

---

## Solution 3: Per-Session Settings Override via `--settings` Flag

**Mechanism:**
Claude Code supports a `--settings <path>` flag that loads a per-invocation settings file. The autonomous stop hook would NOT live in the global `.claude/settings.json`. Instead, the autonomous session is launched with a generated settings file that includes the stop hook. Other sessions, launched normally, never see the hook.

**Implementation:**
1. Autonomous setup script generates `.claude/autonomous-settings.local.json` containing the stop hook config.
2. The tmux session that runs autonomous mode is launched with:
   ```bash
   claude --settings .claude/autonomous-settings.local.json
   ```
3. The stop hook only fires in that session. No session ID matching needed. Problem structurally eliminated.
4. On completion, the setup script deletes the generated settings file.

**Constraint:** This only works when autonomous mode is the LAUNCH condition for a session. If a user activates `/autonomous` mid-session inside an existing Claude Code instance, there's no way to inject `--settings` retroactively. The hook would need to be added to global settings and fall back to Solutions 1/2 for session identification.

**Settings merge semantics matter:** If `--settings` merges additively with the global file, the generated file must omit the stop hook from global settings (or Claude Code deduplicates). If `--settings` replaces global settings entirely, the generated file must include all global hooks plus the autonomous hook.

**Hybrid:** Reserve Solution 3 for future autonomous mode redesign where mode is always a launch condition (common for long-running autonomous jobs). For current in-session activation, use Solution 1.

**Rating:**
- Reliability: **10/10** — If used correctly, the hook is physically absent from all non-autonomous sessions. Zero matching logic needed.
- Complexity: **6/10** — Requires changing launch infrastructure. Must understand `--settings` merge semantics. Cannot handle mid-session activation.
- Risk: **3/10** — Risk is in `--settings` additive behavior and the mid-session case. Both are known and bounded.

---

## Recommended Path

**Immediate fix: Solution 1** — change the existing stop hook to write its own `session_id` from stdin on first call (when state file has no ID yet). This is a ~10 line change to the existing hook script and fixes the reported bug without changing anything else.

**Future architecture: Solution 3** — when designing the next generation of autonomous mode, make it a launch-time flag rather than a mid-session activation. This eliminates the problem at the structural level and removes the session-matching complexity entirely.

**Solution 2** is a useful supplement to Solution 1 — store both `session_id` AND `transcript_dir` for defense in depth. If one field is missing, fall back to the other.

---

## What NOT to Do

- Do not rely on `CLAUDE_CODE_SESSION_ID` env var from setup scripts — empty outside Claude Code process context, confirmed failed.
- Do not walk the process tree to find tmux session ancestry — fragile across OS versions, adds latency to every session exit.
- Do not poll tmux on every Stop hook call — adds 50-100ms latency to every session termination across the project.
- Do not use transcript content inspection to identify session purpose — too slow, too fragile, too late in the hook lifecycle.
