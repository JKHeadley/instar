# PROP-763 — PreCompact state flush (preserve WIP before compaction, not just identity after)

**Source:** Dawn `instar-feature-parity` job (PROP-filing-only, PROP-379)
**Domain:** instar · **Type:** infrastructure · **Impact:** high · **Effort:** small
**Filed:** 2026-06-15 · **Dawn queue:** PROP-763

> **Re-scope note, added 2026-10-27 at delivery (read this before the Problem
> section).** This filing was authored on 2026-06-15 and its "Problem" section
> describes the tree as it was then. Measured against `JKHeadley/instar@main`
> (e0ff984b3cb, 4330 commits newer), the pre-compaction area has since been
> built out and this proposal's premise is partly stale:
>
> - `src/monitoring/CompactionSentinel.ts` and
>   `src/monitoring/ProactiveCompactionSentinel.ts` both exist, with tests
>   (`tests/unit/CompactionSentinel.test.ts`,
>   `tests/unit/CompactionSentinel-recoverable-guard.test.ts`,
>   `tests/unit/ProactiveCompactionSentinel.test.ts`).
> - The `PreCompact` hook event is already wired and consumed:
>   `src/commands/server.ts:14334` registers `hookEventReceiver.on('PreCompact', ...)`
>   and reports to the sentinel; compaction auto-resume is live.
>
> So the gap this filing names as "no pre-compaction half at all" is no longer
> accurate. What is still unaddressed is the narrower ask: flushing **work-in-progress
> state** before compaction, as opposed to detecting compaction and resuming after
> it. Treat the diff below as a starting point to be re-scoped as an addition to
> `CompactionSentinel`, not as a new mechanism, and re-verify every line number
> against current `main` before applying.
>
> Disclosure: this doc was triaged `supersede` (re-scope before delivering) and
> was then delivered in the same session by operator error. Rather than remove it
> from your tree, the note above is added so the stale premise is visible to
> whoever reads it. The verdict and its evidence are recorded in Dawn's
> `.claude/state/instar-filing-triage.json`.

## Problem

Instar handles the *post*-compaction half of continuity well but has a hole on the
*pre*-compaction half.

- **Post-compaction (covered):** `.claude/settings.json` wires `SessionStart`
  (matchers `startup`/`resume`/`compact`) → `session-start.sh`, and
  `compaction-recovery.sh` re-injects **identity + topic context** after context
  compresses (the 164th-Lesson "inject content, don't point at files" pattern).
- **Pre-compaction (the gap):** `.claude/settings.json` already registers a
  `PreCompact` hook (line 177), but its only command is
  `node .instar/hooks/instar/hook-event-reporter.js` — generic event telemetry.
  **Nothing snapshots work-in-progress state to disk before the context is
  compressed.**

So when compaction fires mid-job, the *identity* survives but the *operational
state the agent was holding in context* — which job/session it was running, the
Telegram topic it was answering, where it was in the work — is only recoverable
to the extent it was already on disk. Recovery re-grounds *who* the agent is, but
not *what it was doing*. This is exactly the split Dawn closed with PROP-317:
PostCompact restores identity; **PreCompact preserves the in-flight work** so the
post-compaction recovery has something concrete to resume from.

Dawn's `find_active_session()` + report-append pattern means that after a
compaction the recovered session reads a "Pre-Compaction Snapshot" block naming
the session, job, topic, and trigger — turning a blind resume into a guided one.

## What Dawn has (battle-tested)

`the-portal/.claude/hooks/pre-compact-state-flush.py` (167 lines, in production
since 2026-05-02, PROP-317). On the `PreCompact` event it:

1. Detects the active session/job from on-disk markers (source of truth, mirrors
   the PostCompact detector so the two always agree).
2. Appends a **Pre-Compaction Snapshot** block to the session report:
   session id, job slug, telegram topic, trigger (`manual`/`auto`).
3. Writes a JSONL row to `metrics/pre-compact-events.jsonl` for observability.
4. **Never raises** — compaction proceeds regardless; the hook only adds a paper
   trail (defensive `try/except` → `exit(0)`).

## Proposed patch (Instar-native port)

Instar already *has* the `PreCompact` registration point and the env-var
plumbing (`INSTAR_SESSION_ID`, `INSTAR_TELEGRAM_TOPIC`) — so this is additive,
not a rewire. Add a second command to the existing `PreCompact` array and a small
node hook that flushes state into `.instar/state/`.

```diff
--- a/.instar/hooks/instar/pre-compact-state-flush.js
+++ b/.instar/hooks/instar/pre-compact-state-flush.js
@@ -0,0 +1,72 @@
+#!/usr/bin/env node
+// PreCompact state flush — preserves work-in-progress BEFORE context compaction.
+//
+// Complements compaction-recovery.sh (which restores identity + topic AFTER).
+// Mirrors Dawn's pre-compact-state-flush.py (PROP-317): PostCompact restores
+// WHO the agent is; PreCompact preserves WHAT it was doing, so the recovered
+// session resumes from a concrete snapshot instead of a blind restart.
+//
+// Defensive by design: must never throw and never block compaction. Dynamic
+// import so it runs under both ESM and CJS host package.json (same reason as
+// hook-event-reporter.js).
+
+const flush = async () => {
+  const fs = await import('node:fs');
+  const path = await import('node:path');
+
+  const projectDir = process.env.CLAUDE_PROJECT_DIR || '.';
+  const stateDir = path.join(projectDir, '.instar', 'state');
+  const snapshotPath = path.join(stateDir, 'pre-compact-snapshot.json');
+  const eventsPath = path.join(stateDir, 'ledger', 'pre-compact-events.jsonl');
+
+  // Read the hook payload from stdin ({ trigger, session_id, ... }).
+  let trigger = 'unknown';
+  let hookSessionId = '';
+  try {
+    const raw = fs.readFileSync(0, 'utf8');
+    if (raw) {
+      const parsed = JSON.parse(raw);
+      trigger = parsed.trigger || 'unknown';
+      hookSessionId = parsed.session_id || '';
+    }
+  } catch { /* no stdin / not JSON — fall through with defaults */ }
+
+  const snapshot = {
+    ts: new Date().toISOString(),
+    trigger,
+    sessionId: process.env.INSTAR_SESSION_ID || hookSessionId || null,
+    telegramTopic: process.env.INSTAR_TELEGRAM_TOPIC || null,
+    jobSlug: process.env.INSTAR_JOB_SLUG || null,
+    note: 'WIP snapshot before compaction; compaction-recovery.sh resumes from here.',
+  };
+
+  try {
+    fs.mkdirSync(path.dirname(eventsPath), { recursive: true });
+    // Latest-wins snapshot the recovery hook can read on next session start.
+    fs.writeFileSync(snapshotPath, JSON.stringify(snapshot, null, 2));
+    // Append-only event log for observability.
+    fs.appendFileSync(eventsPath, JSON.stringify(snapshot) + '\n');
+    process.stdout.write(
+      `[PreCompact] WIP snapshot flushed (trigger=${trigger}, session=${snapshot.sessionId ?? 'none'})\n`,
+    );
+  } catch (err) {
+    // Never block compaction — best-effort only.
+    try {
+      fs.appendFileSync(eventsPath, JSON.stringify({ ts: new Date().toISOString(), error: String(err) }) + '\n');
+    } catch { /* give up silently */ }
+  }
+};
+
+flush().catch(() => process.exit(0)).then(() => process.exit(0));
```

```diff
--- a/.claude/settings.json
+++ b/.claude/settings.json
@@ PreCompact
   "PreCompact": [
     {
       "matcher": "",
       "hooks": [
         {
           "type": "command",
           "command": "node .instar/hooks/instar/hook-event-reporter.js",
           "timeout": 3000
+        },
+        {
+          "type": "command",
+          "command": "node .instar/hooks/instar/pre-compact-state-flush.js",
+          "timeout": 3000
         }
       ]
     }
   ],
```

Then make the recovery hook *consume* the snapshot (optional, second increment —
turns the snapshot into a guided resume):

```diff
--- a/.instar/hooks/instar/compaction-recovery.sh
+++ b/.instar/hooks/instar/compaction-recovery.sh
@@ after the identity block
+  # ── PRE-COMPACTION WIP (what was I doing before compaction?) ──
+  SNAP="$INSTAR_DIR/state/pre-compact-snapshot.json"
+  if [ -f "$SNAP" ]; then
+    echo "=== WORK-IN-PROGRESS (pre-compaction snapshot) ==="
+    cat "$SNAP"
+  fi
```

## Test evidence

Not run inside this job (Dawn's `instar-feature-parity` runs outside Instar's
`/instar-dev` flow and the Instar repo at `/Users/justin/Documents/Projects/instar`
is now a **bare** repo — see "Adoption notes"). What `/instar-dev` should run:

- `node .instar/hooks/instar/pre-compact-state-flush.js < /dev/null` → exits 0,
  writes `state/pre-compact-snapshot.json` + appends to
  `state/ledger/pre-compact-events.jsonl`.
- `echo '{"trigger":"manual","session_id":"X"}' | node ...pre-compact-state-flush.js`
  → snapshot records `trigger:"manual"`.
- Trigger a real `/compact` and confirm `compaction-recovery.sh` echoes the
  snapshot. **Verify with the REAL event, not a synthetic fixture** (Dawn's
  `feedback_verify_hooks_with_real_triggers`: a synthetic fixture produced a
  49-cycle false-positive on a SubagentStop hook).
- `node -c pre-compact-state-flush.js` (syntax) — clean.

## Files touched

- `.instar/hooks/instar/pre-compact-state-flush.js` — new hook (the flush).
- `.claude/settings.json` — add the hook to the existing `PreCompact` array.
- `.instar/hooks/instar/compaction-recovery.sh` — (optional 2nd increment) read
  the snapshot back on recovery.

## Adoption steps for /instar-dev

1. Open a spec scaffold for "PreCompact WIP state flush"; run `/spec-converge`.
2. Apply the diff above in a worktree; `node -c` the new hook.
3. Run `/instar-dev` to produce the trace + side-effects artifact, then commit
   through the normal gate (the `.instar/**` + `.claude/settings.json` paths are
   in scope for the pre-commit gate, so this lands via the gated flow — not as a
   docs-only commit).

## Adoption notes (stale-grounding flag for Dawn)

Dawn's job grounding (`.claude/grounding/jobs/instar-feature-parity.md`,
surface (b)) tells this job to **commit a docs-only PROP from the Instar repo**.
That instruction is now **stale**: `/Users/justin/Documents/Projects/instar` is a
**bare** repo (`core.bare = true`; source lives in per-agent worktrees, e.g.
`/Users/justin/Documents/Projects/instar-main`). `git status`/`git commit` fail
there ("must be run in a work tree"). This PROP was therefore filed to Dawn's
evolution queue (surface a) and written to disk at
`docs/cross-pollination/PROP-763-pre-compaction-state-flush.md` for `/instar-dev`
to pick up, but **not git-committed from the bare root**. Dawn should update that
grounding file to commit docs PROPs from a work tree (`instar-main`) or via the
`/instar-dev` flow. (Tracked as a follow-up note, not a separate PROP.)
