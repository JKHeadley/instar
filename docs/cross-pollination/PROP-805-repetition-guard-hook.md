# PROP-805 — Repetition Guard hook (Contradiction-Means-Repetition, structural)

**Source:** Dawn `instar-feature-parity` job (run 50, 2026-07-02)
**Type:** infrastructure · **Impact:** high · **Effort:** small
**Landing surface:** `src/core/PostUpdateMigrator.ts` (hook content, single source of truth) + `src/commands/init.ts` (install + settings wiring) + `src/templates/hooks/settings-template.json` + `src/data/builtin-manifest.json`

---

## Problem

Instar named the **"Contradiction Means Repetition"** trap and cross-pollinated it *to* Dawn — but Instar never built the structural defense for it, while Dawn since did (`.claude/hooks/repetition-guard.py`, PROP-391). This is the exact **pressure-valve** failure both codebases warn about: naming a trap relieves the felt need to build the defense, so the trap keeps firing in the same sessions that named it.

The trap: a human says X is true; the agent's data says not-X; the agent **re-runs the same query**; it returns the same result; the agent concludes the human is wrong. Re-running the check that already contradicted the human just reproduces the contradiction — it never resolves it. The fix is a *different angle* (different source, comparison, or level), not the same check again.

Instar's PreToolUse/Bash stack today (`dangerous-command-guard`, `grounding-before-messaging`, `deferral-detector`, `external-communication-guard`, `post-action-reflection`) has **no** same-query-repetition nudge. Because Instar ships these hooks into **every** scaffolded agent, adding one template gives every Instar agent the defense — the highest-leverage place to land it.

It mirrors the already-shipped `deferral-detector.js` exactly: PreToolUse/Bash, reads stdin JSON, **never blocks**, emits `{decision:'approve', additionalContext}`, self-heals on error. Only difference: it keeps a small per-session tally under `.instar/state/`.

## Proposed patch

Four in-scope files. New hook content lives in `PostUpdateMigrator.ts` (the DRY single source, same as `deferral-detector`); `init.ts` installs + wires it; the settings template and builtin manifest register it.

```diff
--- a/src/core/PostUpdateMigrator.ts
+++ b/src/core/PostUpdateMigrator.ts
@@ getHookContent union type
-  getHookContent(name: 'session-start' | 'compaction-recovery' | 'external-operation-gate' | 'deferral-detector' | 'post-action-reflection' | 'external-communication-guard' | 'scope-coherence-collector' | 'scope-coherence-checkpoint' | 'claim-intercept' | 'claim-intercept-response' | 'telegram-topic-context' | 'response-review' | 'auto-approve-permissions' | 'skill-usage-telemetry' | 'build-stop-hook'): string {
+  getHookContent(name: 'session-start' | 'compaction-recovery' | 'external-operation-gate' | 'deferral-detector' | 'repetition-guard' | 'post-action-reflection' | 'external-communication-guard' | 'scope-coherence-collector' | 'scope-coherence-checkpoint' | 'claim-intercept' | 'claim-intercept-response' | 'telegram-topic-context' | 'response-review' | 'auto-approve-permissions' | 'skill-usage-telemetry' | 'build-stop-hook'): string {
     switch (name) {
       case 'session-start': return this.getSessionStartHook();
       case 'compaction-recovery': return this.getCompactionRecovery();
       case 'external-operation-gate': return this.getExternalOperationGateHook();
       case 'deferral-detector': return this.getDeferralDetectorHook();
+      case 'repetition-guard': return this.getRepetitionGuardHook();
       case 'post-action-reflection': return this.getPostActionReflectionHook();

@@ upgrade() writer block (near deferral-detector.js writeFileSync, ~line 503)
       fs.writeFileSync(path.join(instarHooksDir, 'deferral-detector.js'), this.getDeferralDetectorHook(), { mode: 0o755 });
       result.upgraded.push('hooks/instar/deferral-detector.js (anti-deferral checklist)');
     } catch (err) {
       result.errors.push(`deferral-detector.js: ${err instanceof Error ? err.message : String(err)}`);
     }
+    try {
+      fs.writeFileSync(path.join(instarHooksDir, 'repetition-guard.js'), this.getRepetitionGuardHook(), { mode: 0o755 });
+      result.upgraded.push('hooks/instar/repetition-guard.js (contradiction-means-repetition nudge)');
+    } catch (err) {
+      result.errors.push(`repetition-guard.js: ${err instanceof Error ? err.message : String(err)}`);
+    }

@@ managed hook filename list (~line 673)
-      'compaction-recovery.sh', 'external-operation-gate.js', 'deferral-detector.js',
+      'compaction-recovery.sh', 'external-operation-gate.js', 'deferral-detector.js', 'repetition-guard.js',
       'post-action-reflection.js', 'external-communication-guard.js',

@@ new method — place immediately after getDeferralDetectorHook()
+  private getRepetitionGuardHook(): string {
+    return `#!/usr/bin/env node
+// Repetition guard — Contradiction-Means-Repetition, made structural.
+// PreToolUse hook for Bash. Fires ONLY when the SAME query-class command has
+// already run 3x in this session. Never blocks — injects a "try a different
+// angle" nudge (exit 0 + additionalContext) at the moment the trap recurs.
+//
+// The trap: a human says X; your data says not-X; you re-run the SAME query;
+// it returns the same result; you conclude the human is wrong. Re-running the
+// check that already contradicted the human just reproduces the contradiction.
+// The fix is a DIFFERENT kind of check — different source, comparison, or level.
+//
+// Naturally-iterative commands (git status/log, ls, build/test, polling) are
+// allowlisted and never count — a false positive there is exactly the noise
+// that gets a guard disabled. Deliberate repeats: prefix INSTAR_REPEAT_ACK=1
+// or append a trailing  # different-angle  comment to suppress for that command.
+
+const fs = require('node:fs');
+const pathMod = require('node:path');
+
+const THRESHOLD = parseInt(process.env.INSTAR_REPEAT_THRESHOLD || '3', 10);
+const TTL_MS = 2 * 24 * 3600 * 1000;
+const projectDir = process.env.CLAUDE_PROJECT_DIR || process.cwd();
+const stateDir = pathMod.join(projectDir, '.instar', 'state', 'repetition-guard');
+
+const ALLOWLIST = [
+  'git status','git log','git diff','git branch','git show','git stash','git add',
+  'git fetch','git pull','git rebase','git merge','git push','git checkout','git restore','git commit',
+  'ls','ll','pwd','cd','tree','df','du','top','htop','ps','cat','head','tail','less','more','wc',
+  'stat','file','which','type','echo','printf','env','export','date','whoami','hostname','uname',
+  'sleep','clear','true','false','touch','mkdir','cp','mv','chmod','npm','pnpm','yarn','node','tsc',
+  'jest','pytest','make','cargo','go','vercel','launchctl','tmux','kill','pkill','open','code','vim','nano',
+];
+
+function normalize(cmd) {
+  return cmd.replace(/#.*$/gm, ' ').replace(/\\s+/g, ' ').trim();
+}
+function acknowledged(cmd) {
+  if (process.env.INSTAR_REPEAT_ACK === '1') return true;
+  return /#\\s*different[- ]?angle/i.test(cmd);
+}
+function allowlisted(norm) {
+  const low = norm.toLowerCase();
+  return ALLOWLIST.some(p => low === p || low.startsWith(p + ' '));
+}
+
+let data = '';
+process.stdin.on('data', c => data += c);
+process.stdin.on('end', () => {
+  try {
+    const input = JSON.parse(data);
+    if (input.tool_name !== 'Bash') process.exit(0);
+    const command = (input.tool_input || {}).command || '';
+    if (!command) process.exit(0);
+    if (acknowledged(command)) process.exit(0);
+    const norm = normalize(command);
+    if (!norm || allowlisted(norm)) process.exit(0);
+
+    const sessionId = (input.session_id || 'unknown').replace(/[^A-Za-z0-9_.-]/g, '_');
+    fs.mkdirSync(stateDir, { recursive: true });
+    const ledgerPath = pathMod.join(stateDir, sessionId + '.json');
+
+    let ledger = { updated: Date.now(), counts: {} };
+    try {
+      const raw = JSON.parse(fs.readFileSync(ledgerPath, 'utf8'));
+      if (raw && raw.counts) ledger = raw;
+    } catch { /* fresh ledger */ }
+
+    // Prune stale ledgers so the dir doesn't grow unbounded.
+    try {
+      for (const f of fs.readdirSync(stateDir)) {
+        if (!f.endsWith('.json')) continue;
+        const p = pathMod.join(stateDir, f);
+        if (Date.now() - fs.statSync(p).mtimeMs > TTL_MS) fs.unlinkSync(p);
+      }
+    } catch { /* best effort */ }
+
+    const count = (ledger.counts[norm] || 0) + 1;
+    ledger.counts[norm] = count;
+    ledger.updated = Date.now();
+    try { fs.writeFileSync(ledgerPath, JSON.stringify(ledger)); } catch { /* best effort */ }
+
+    if (count < THRESHOLD) process.exit(0);
+
+    // Log the nudge for calibration.
+    try {
+      fs.appendFileSync(pathMod.join(stateDir, 'metrics.jsonl'),
+        JSON.stringify({ ts: new Date().toISOString(), session: sessionId, count, cmd: norm.slice(0, 200) }) + '\\n');
+    } catch { /* best effort */ }
+
+    const nudge = [
+      'REPETITION DETECTED — this query-class command has now run ' + count + ' times this session.',
+      '',
+      'Contradiction-Means-Repetition trap: if this check contradicted something a human',
+      'told you (or a prior result), re-running the SAME check just reproduces the same',
+      'contradiction — it does not resolve it.',
+      '',
+      'Try a DIFFERENT angle instead:',
+      '  - a different data source or command',
+      '  - a different comparison or level of analysis',
+      '  - the human likely has persistent context a single snapshot lacks — weight it',
+      '',
+      'Deliberate repeat (polling, retry-after-fix)? Re-run with INSTAR_REPEAT_ACK=1',
+      'or append a trailing  # different-angle  comment to silence this for the command.',
+    ].join('\\n');
+
+    process.stdout.write(JSON.stringify({ decision: 'approve', additionalContext: nudge }));
+  } catch { /* never break the tool call */ }
+  process.exit(0);
+});
+`;
+  }
```

```diff
--- a/src/commands/init.ts
+++ b/src/commands/init.ts
@@ hook writers (near deferral-detector.js writeFileSync, ~line 3716)
   fs.writeFileSync(path.join(hooksDir, 'deferral-detector.js'), migrator.getHookContent('deferral-detector'), { mode: 0o755 });
+  fs.writeFileSync(path.join(hooksDir, 'repetition-guard.js'), migrator.getHookContent('repetition-guard'), { mode: 0o755 });
   fs.writeFileSync(path.join(hooksDir, 'post-action-reflection.js'), migrator.getHookContent('post-action-reflection'), { mode: 0o755 });

@@ instarBashHooks array (~line 4263)
     {
       type: 'command',
       command: 'node ${CLAUDE_PROJECT_DIR}/.instar/hooks/instar/deferral-detector.js',
       timeout: 5000,
     },
+    {
+      type: 'command',
+      command: 'node ${CLAUDE_PROJECT_DIR}/.instar/hooks/instar/repetition-guard.js',
+      timeout: 5000,
+    },
     {
       type: 'command',
       command: 'node ${CLAUDE_PROJECT_DIR}/.instar/hooks/instar/external-communication-guard.js',
       timeout: 5000,
     },
```

```diff
--- a/src/templates/hooks/settings-template.json
+++ b/src/templates/hooks/settings-template.json
@@ PreToolUse Bash matcher hooks array
           {
             "type": "command",
             "command": "node .instar/hooks/instar/deferral-detector.js",
             "timeout": 5000
           },
+          {
+            "type": "command",
+            "command": "node .instar/hooks/instar/repetition-guard.js",
+            "timeout": 5000
+          },
           {
             "type": "command",
             "command": "node .instar/hooks/instar/external-communication-guard.js",
             "timeout": 5000
           },
```

```diff
--- a/src/data/builtin-manifest.json
+++ b/src/data/builtin-manifest.json
@@ after "hook:deferral-detector" entry
     "hook:deferral-detector": {
       "id": "hook:deferral-detector",
       "type": "hook",
       "domain": "safety",
       "sourcePath": "src/core/PostUpdateMigrator.ts",
       "installedPath": ".instar/hooks/instar/deferral-detector.js",
       "contentHash": "<regenerate>",
       "since": "2025-01-01"
     },
+    "hook:repetition-guard": {
+      "id": "hook:repetition-guard",
+      "type": "hook",
+      "domain": "safety",
+      "sourcePath": "src/core/PostUpdateMigrator.ts",
+      "installedPath": ".instar/hooks/instar/repetition-guard.js",
+      "contentHash": "<regenerate via manifest build>",
+      "since": "2026-07-02"
+    },
```

## Test evidence

Not run inside Instar's gate from this job (Dawn's `instar-feature-parity` runs
outside `/instar-dev`, per PROP-379 — cannot produce a trace/side-effects artifact).
What WAS verified from the live Instar source tree (`instar-main/src`, read 2026-07-02):

- **Gap confirmed**: PreToolUse/Bash hooks are `dangerous-command-guard`,
  `grounding-before-messaging`, `deferral-detector`, `external-communication-guard`,
  `post-action-reflection`. None does same-query repetition detection.
  (`grep -rli 'repetition|same.query|repeat.*command' src/` → only crash-loop /
  dispatch-loop hits, unrelated.)
- **I/O contract matched** against `getDeferralDetectorHook()`: stdin JSON,
  `input.tool_name`/`input.tool_input.command`, `{decision:'approve', additionalContext}`,
  `process.exit(0)` on all paths, `try/catch` swallow. The new hook is byte-for-byte
  the same contract — zero new dependencies, pure `node:fs`/`node:path`.
- **State convention matched**: `.instar/state/<feature>/` (per PostUpdateMigrator
  §pr-pipeline docs). Ledger + `metrics.jsonl` live under `.instar/state/repetition-guard/`.
- **Reference impl** proven in production on Dawn: `.claude/hooks/repetition-guard.py`
  (PROP-391), same threshold (3), same allowlist philosophy, same never-block posture,
  logging to `.claude/metrics/repetition-guard.jsonl`.

**Typecheck status**: not run from this job (would need `pnpm -C instar-main tsc`);
the patch adds one private method + string content only — no type surface changes
beyond the widened `getHookContent` union, which is exhaustively handled in the switch.

## Files touched

- `src/core/PostUpdateMigrator.ts` — new `getRepetitionGuardHook()` + union/switch/writer/filename-list wiring (single source of truth for hook content).
- `src/commands/init.ts` — install the hook file + add it to `instarBashHooks`.
- `src/templates/hooks/settings-template.json` — register in PreToolUse/Bash.
- `src/data/builtin-manifest.json` — manifest entry (`hook:repetition-guard`, regenerate `contentHash`).

## Adoption steps for /instar-dev

1. Open a spec scaffold for "repetition-guard hook"; run `/spec-converge`.
2. Apply the diff above. Regenerate `builtin-manifest.json` `contentHash` via the
   manifest build step (do not hand-write the hash).
3. Run `/instar-dev` to produce the trace + side-effects artifact; `pnpm tsc --noEmit`
   for the widened union; smoke-test by piping a fake `{tool_name:'Bash', tool_input:{command:'grep foo bar'}}`
   through `repetition-guard.js` 3× and confirming the 3rd emits `additionalContext`.
4. Commit through the normal pre-commit gate.

## Why this respects the boundary

Content lives in `PostUpdateMigrator.ts` exactly like `deferral-detector` — so the
existing upgrade path (`instar update`) back-fills it into already-initialized agents,
and `init` installs it for new ones. No new install mechanism, no new runtime dep.
