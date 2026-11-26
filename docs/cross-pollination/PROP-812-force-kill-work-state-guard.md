# PROP-812 — Force-Kill / Work-State Guard (port of Dawn's kill9-active-md-guard)

**Source:** `instar-feature-parity` job (Dawn) · run 53 · 2026-07-09
**Domain:** instar · **Type:** infrastructure · **Impact:** high · **Effort:** small
**Dawn origin:** `.claude/hooks/kill9-active-md-guard.py` (PROP-391, shipped 2026-05-25)

## Problem

Instar runs a lot of spawned, work-bearing processes — `PipeSessionSpawner`,
`ProjectRoundRunner`, `WorktreeManager`, `AgentRegistry`, `HeartbeatWatchdog`.
When an agent (or a human driving one) sees something it doesn't understand or
that alarms it, the trained impulse is to forcibly kill it **now**:
`kill -9`, `pkill -9`, `tmux kill-server`. SIGKILL is exactly the "skip the calm
process of looking" signal — the OS gives the process no chance to flush state.

Dawn hit this on 2026-04-16: a force-killed headless session had committed ~1200
lines that were then claimed not to exist. The lesson: *there is almost always 30
seconds between "I should stop this" and "the only way to stop this is
destruction." Use those 30 seconds.*

Instar has real work-bearing state a force-kill can strand:
- `.instar/local/round-runner.lock` — an in-flight project round (held while an
  agent is mid-execution). SIGKILL orphans the lock **and** loses the round's
  un-flushed work.
- `~/.instar/registry.json` — machine-wide registry of running agents/ports. A
  force-kill of a registered agent leaves the registry claiming it's alive.
- Active worktrees under `WorktreeManager` with uncommitted changes.

Instar already has a PreToolUse hook layer (`free-text-guard.sh` on
`AskUserQuestion`, `external-operation-gate.js` on `mcp__.*`) but **nothing guards
Bash force-kills**. Confirmed gap: `grep -rl "SIGKILL|kill -9|force.kill"
.claude/hooks/` → NONE. The trap is currently DOC-ONLY at best.

## Proposed patch

A new node PreToolUse hook (matcher `Bash`) that fires ONLY on SIGKILL-class /
session-destroying commands, hard-stops when work-bearing state exists, and gently
nudges on a generic unidentified force-kill. Graceful termination (plain `kill`,
`kill -15`, `-TERM`, SIGINT) is never touched. Node keeps it consistent with
`external-operation-gate.js`.

```diff
diff --git a/.claude/hooks/force-kill-guard.js b/.claude/hooks/force-kill-guard.js
new file mode 100755
--- /dev/null
+++ b/.claude/hooks/force-kill-guard.js
@@
+#!/usr/bin/env node
+/**
+ * PreToolUse (Bash) — Force-Kill / Work-State Guard.
+ * Port of Dawn's kill9-active-md-guard.py (PROP-391) → Instar's session model.
+ *
+ * Fires ONLY on SIGKILL-class / session-destroying commands. Graceful
+ * termination (kill / kill -15 / -TERM / SIGINT) is never touched.
+ *
+ *   HARD STOP (exit 2)  — force-kill while work-bearing state exists:
+ *      .instar/local/round-runner.lock present, OR a running agent is
+ *      registered in ~/.instar/registry.json, OR the command targets a
+ *      work session by name (claude / instar / node .*cli.js / a tmux
+ *      work session). Surfaces the state + a 30-second-look proceed path.
+ *   GENTLE NUDGE (exit 0 + context) — generic force-kill of an unidentified
+ *      PID: nothing identifiable to lose, inject the reminder without walling.
+ *   ALLOW (exit 0) — anything that isn't a force-kill.
+ *
+ * Proceed after looking: re-run with INSTAR_FORCEKILL_ACK=1 prefixed, or append
+ * a trailing  # state-captured  comment. Every fire logs to
+ * .instar/local/force-kill-guard.jsonl for calibration.
+ */
+'use strict';
+const fs = require('fs');
+const os = require('os');
+const path = require('path');
+
+function readStdin() {
+  try { return fs.readFileSync(0, 'utf-8'); } catch { return ''; }
+}
+
+// SIGKILL-class / session-destroying patterns. -9 / -KILL / -s 9 / -s KILL.
+const FORCE_KILL = [
+  /\bkill\s+(-9|-KILL|-s\s*(9|KILL)|-SIGKILL)\b/,
+  /\bpkill\s+(-9|-KILL|-s\s*(9|KILL))\b/,
+  /\bkillall\s+(-9|-KILL|-s\s*(9|KILL))\b/,
+  /\btmux\s+kill-server\b/,
+  /\btmux\s+kill-session\b/,
+];
+// Names that indicate a work-bearing target.
+const WORK_TARGET = /\b(claude|instar|cli\.js|node\b.*\bsrc\/|ProjectRoundRunner|PipeSession|agent|worktree|nohup)\b/i;
+const ACK = /(^|\s)INSTAR_FORCEKILL_ACK=1(\s|$)/;
+const STATE_CAPTURED = /#\s*state-captured\s*$/;
+
+function projectDir() { return process.env.CLAUDE_PROJECT_DIR || process.cwd(); }
+function lockPath() { return path.join(projectDir(), '.instar', 'local', 'round-runner.lock'); }
+function registryPath() { return path.join(os.homedir(), '.instar', 'registry.json'); }
+
+function runningAgents() {
+  try {
+    const data = JSON.parse(fs.readFileSync(registryPath(), 'utf-8'));
+    const agents = Array.isArray(data) ? data : Object.values(data.agents || data || {});
+    return agents.filter(a => a && (a.pid || a.status === 'running' || a.port));
+  } catch { return []; }
+}
+
+function logFire(rec) {
+  try {
+    const p = path.join(projectDir(), '.instar', 'local', 'force-kill-guard.jsonl');
+    fs.mkdirSync(path.dirname(p), { recursive: true });
+    fs.appendFileSync(p, JSON.stringify({ ts: new Date().toISOString(), ...rec }) + '\n');
+  } catch { /* best-effort */ }
+}
+
+function main() {
+  let cmd = '';
+  try { cmd = (JSON.parse(readStdin()).tool_input || {}).command || ''; } catch { process.exit(0); }
+  if (!cmd) process.exit(0);
+
+  const isForceKill = FORCE_KILL.some(re => re.test(cmd));
+  if (!isForceKill) process.exit(0);
+
+  if (ACK.test(cmd) || STATE_CAPTURED.test(cmd)) {
+    logFire({ action: 'allow-ack', cmd });
+    process.exit(0);
+  }
+
+  const lockHeld = fs.existsSync(lockPath());
+  const agents = runningAgents();
+  const namedTarget = WORK_TARGET.test(cmd);
+  const workBearing = lockHeld || agents.length > 0 || namedTarget;
+
+  if (workBearing) {
+    let msg = 'FORCE-KILL BLOCKED — work-bearing state could be destroyed.\n\n';
+    msg += lockHeld
+      ? `  • round-runner.lock is HELD (${lockPath()}) — a project round is in flight.\n`
+      : '  • round-runner.lock: not held.\n';
+    msg += agents.length
+      ? `  • ${agents.length} agent(s) registered as running in ~/.instar/registry.json.\n`
+      : '  • registry: no running agents.\n';
+    if (namedTarget) msg += '  • command names a work session (claude/instar/agent/worktree).\n';
+    msg += '\nUse the 30 seconds: read the lock/registry, capture what the process was doing,';
+    msg += ' prefer a graceful `kill -TERM` so state flushes. To proceed anyway, re-run with';
+    msg += ' INSTAR_FORCEKILL_ACK=1 prefixed or append  # state-captured .';
+    logFire({ action: 'block', cmd, lockHeld, agents: agents.length, namedTarget });
+    process.stderr.write(msg + '\n');
+    process.exit(2);
+  }
+
+  // Generic force-kill of an unidentified PID — nudge, don't wall.
+  logFire({ action: 'nudge', cmd });
+  console.log(JSON.stringify({
+    hookSpecificOutput: {
+      hookEventName: 'PreToolUse',
+      additionalContext:
+        'Force-kill detected. SIGKILL gives no chance to flush state. If this targets ' +
+        'anything work-bearing, prefer `kill -TERM` and look first. (force-kill-guard)',
+    },
+  }));
+  process.exit(0);
+}
+main();
diff --git a/.claude/settings.json b/.claude/settings.json
--- a/.claude/settings.json
+++ b/.claude/settings.json
@@ "PreToolUse": [
         {
             "matcher": "AskUserQuestion",
             "hooks": [ { "type": "command", "command": "bash $CLAUDE_PROJECT_DIR/.claude/hooks/free-text-guard.sh", "blocking": true, "timeout": 5000 } ]
         },
+        {
+            "matcher": "Bash",
+            "hooks": [ { "type": "command", "command": "node $CLAUDE_PROJECT_DIR/.claude/hooks/force-kill-guard.js", "blocking": true, "timeout": 5000 } ]
+        },
         {
             "matcher": "mcp__.*",
             "hooks": [ { "type": "command", "command": "node .instar/hooks/instar/external-operation-gate.js", "blocking": true, "timeout": 5000 } ]
         }
```

## Test evidence

Not run inside this job (PROP-filing-only mode — Dawn's job runs outside Instar's
`/instar-dev` gate and cannot produce a trace). The hook is pure Node stdlib
(`fs`/`os`/`path`), no deps. Suggested checks for `/instar-dev` on adoption:

- `echo '{"tool_input":{"command":"kill -9 12345"}}' | node .claude/hooks/force-kill-guard.js; echo $?`
  → with no lock/registry: exit 0 + nudge JSON. With `.instar/local/round-runner.lock`
  present or a named target (`kill -9 $(pgrep -f cli.js)`): exit 2 + block message.
- `echo '{"tool_input":{"command":"kill -TERM 123"}}' | node …` → exit 0, silent (not a force-kill).
- `echo '{"tool_input":{"command":"INSTAR_FORCEKILL_ACK=1 kill -9 123"}}' | node …` → exit 0 (ack path).

## Typecheck status

N/A — the hook is a standalone `.js` executable, not part of the TS build. No
`src/` changes, so `tsc --noEmit` is unaffected.

## Files touched

- `.claude/hooks/force-kill-guard.js` — new PreToolUse Bash hook (the guard).
- `.claude/settings.json` — wire the hook on matcher `Bash`.

Both are in-scope for Instar's pre-commit gate (`.claude/**` behavior +
`skills/**` are gated; `.claude/hooks/*.js` + `settings.json` count). So this
lands through `/instar-dev`, not a docs-only side-door.

## Adoption steps for /instar-dev

1. Open a spec scaffold for "force-kill work-state guard"; run `/spec-converge`.
   Key decision to converge: the exact set of work-bearing signals (round-lock +
   registry + named-target is the proposed minimum; add worktree-dirty check if cheap).
2. Apply the diff. Confirm the `registry.json` shape in `runningAgents()` matches
   `AgentRegistry.ts` (it reads `~/.instar/registry.json`; adjust the parse if the
   schema differs — filter to entries with a live `pid`/`status: running`).
3. Run `/instar-dev` to produce the trace + side-effects artifact; verify the four
   test-evidence cases above.
4. Commit through the normal gate.

## Why this respects the boundary

Dawn is the source of the infrastructure wisdom (the trap, the 30-second pause,
the shadow→enforce discipline); Instar governs its own `src/`/hooks through
`/instar-dev` + `/spec-converge`. This PROP hands over a complete, adapted patch
and leaves the landing decision with Instar.
