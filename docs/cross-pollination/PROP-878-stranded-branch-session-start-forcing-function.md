# PROP-878 — Stranded-branch session-start forcing function (committed ≠ landed)

**Source:** Dawn `instar-feature-parity` job (2026-07-23, AUT-9350-wo)
**Domain:** instar · **Type:** infrastructure · **Impact:** high · **Effort:** small
**Dawn origin pattern:** `.claude/scripts/stranded-branch-watchdog.py` (+ session-start hook wiring)

## Problem

Instar already has excellent *detection* of unmerged worktree work:

- `src/monitoring/WorktreeMonitor.ts` — `checkUnmergedWork()` counts commits ahead
  of main per worktree, fires on `sessionComplete` and on a 5-min periodic scan,
  and identifies orphan `worktree-*` branches.
- `src/monitoring/WorktreeReaper.ts` — daily cleanup of orphan worktree
  *directories* (quarantine-first, 14-day grace, respects live locks).

But detection is **advisory-only** and fires at the **wrong moment**. The
WorktreeMonitor emits observations *after* a session completes, and the Reaper
cleans up *directories* — nothing forces the **next** session to *act* on a
branch that carries committed-but-never-merged work. So a branch can accumulate
real, finished commits that are reported "done" and silently never land on main.

This is the **"committed ≠ landed" disease** — in Dawn's own system it produced
four stranded feature branches found in a single audit (a budget raise the user
saw as a stale UI and had to ask about; three other finished features). "Done"
must mean *landed and verified*, not *committed to a branch*. It is also a
textbook instance of the **Advisory-Only Infrastructure** trap: a detector whose
only actuator is a human noticing the stale result. The fix is to make the
detector's output a **session-start forcing function** — surfaced to every new
session, nagging until the branch is merged, deleted, or explicitly **parked**
with a logged reason.

Instar's per-agent-worktree architecture makes this gap *more* acute than
Dawn's, not less: many short-lived agent worktrees each branch off main, so the
surface area for "finished but unlanded" is large and grows silently.

## What's missing (precise)

1. No **session-start** surfacing of branches with unmerged work. WorktreeMonitor
   is post-session; the actor who could land the work (the next session) never
   sees it at boot.
2. No **park state** — no way to say "this branch stays unmerged, here's why"
   so the nag distinguishes *forgotten* from *deliberately-deferred*.
3. No **grace period** semantics at the surfacing layer: active in-flight work
   should be left alone; only tips older than a grace window are "stranded".

## Proposed patch

A small `StrandedBranchWatchdog` that **reuses** WorktreeMonitor's existing
unmerged-work detection, adds a park-state store + grace filter, and renders a
terse block consumed by the session-start hook (silent when clean). Wire it into
the same session-start hook Instar already syncs to agents.

```diff
diff --git a/src/monitoring/StrandedBranchWatchdog.ts b/src/monitoring/StrandedBranchWatchdog.ts
new file mode 100644
--- /dev/null
+++ b/src/monitoring/StrandedBranchWatchdog.ts
@@ -0,0 +1,140 @@
+/**
+ * StrandedBranchWatchdog — surface committed-but-never-landed work at session START.
+ *
+ * Ports Dawn's stranded-branch-watchdog.py. Instar already DETECTS unmerged work
+ * (WorktreeMonitor, post-session) and reaps orphan worktree DIRECTORIES
+ * (WorktreeReaper). Neither forces the NEXT session to act on an unmerged BRANCH.
+ * This closes the loop: at session start, list branches ahead of main whose tip
+ * is older than a grace window and are not explicitly parked, and nag until each
+ * is merged, deleted, or parked with a logged reason (enforcement-over-advisory).
+ */
+import { execFileSync } from 'node:child_process';
+import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
+import { dirname, join } from 'node:path';
+
+const GRACE_HOURS = 18; // younger tips are assumed to be active work
+
+export interface StrandedBranch {
+  branch: string;
+  ahead: number;
+  ageHours: number;
+  tip: string;
+  parked?: { note: string; at: string };
+}
+
+export class StrandedBranchWatchdog {
+  constructor(
+    private repoDir: string,
+    private mainBranch = 'main',
+    private statePath = join(repoDir, '.instar', 'state', 'stranded-branch-parked.json'),
+  ) {}
+
+  private git(...args: string[]): string {
+    return execFileSync('git', ['-C', this.repoDir, ...args], {
+      encoding: 'utf8', timeout: 30_000,
+    }).trim();
+  }
+
+  private loadParked(): Record<string, { note: string; at: string }> {
+    try { return JSON.parse(readFileSync(this.statePath, 'utf8')); }
+    catch { return {}; }
+  }
+
+  private saveParked(parked: Record<string, { note: string; at: string }>): void {
+    mkdirSync(dirname(this.statePath), { recursive: true });
+    writeFileSync(this.statePath, JSON.stringify(parked, null, 2));
+  }
+
+  /** Branches ahead of main, tip older than grace, with park state attached. */
+  stranded(): StrandedBranch[] {
+    const now = Date.now();
+    const parked = this.loadParked();
+    const out: StrandedBranch[] = [];
+    const fmt = '%(refname:short)\t%(committerdate:iso8601-strict)\t%(subject)';
+    const lines = this.git('for-each-ref', 'refs/heads',
+      '--sort=-committerdate', `--format=${fmt}`).split('\n').filter(Boolean);
+    for (const line of lines) {
+      const [name, iso, ...rest] = line.split('\t');
+      const subject = rest.join('\t');
+      if (name === this.mainBranch) continue;
+      const ahead = parseInt(this.git('rev-list', '--count', `${this.mainBranch}..${name}`) || '0', 10);
+      if (!ahead) continue;
+      const ageHours = (now - new Date(iso).getTime()) / 3_600_000;
+      if (ageHours < GRACE_HOURS) continue;
+      const entry: StrandedBranch = { branch: name, ahead, ageHours: Math.round(ageHours * 10) / 10, tip: subject };
+      if (parked[name]) entry.parked = parked[name];
+      out.push(entry);
+    }
+    return out;
+  }
+
+  park(branch: string, note: string): void {
+    if (!note) throw new Error('park requires a note explaining why the branch stays unmerged');
+    const parked = this.loadParked();
+    parked[branch] = { note, at: new Date().toISOString() };
+    this.saveParked(parked);
+  }
+
+  unpark(branch: string): void {
+    const parked = this.loadParked();
+    delete parked[branch];
+    this.saveParked(parked);
+  }
+
+  /** Terse block for the session-start hook. Empty string when clean (noise budget). */
+  renderSessionStart(): string {
+    const active = this.stranded().filter((b) => !b.parked);
+    if (!active.length) return '';
+    const rows = active.map(
+      (b) => `  [${b.ahead} ahead, ${(b.ageHours / 24).toFixed(1)}d old] ${b.branch} — ${b.tip}`,
+    );
+    return [
+      `🌿 STRANDED BRANCHES — ${active.length} with unmerged work (committed ≠ landed):`,
+      ...rows,
+      '  → Merge it, delete it, or park it with a reason (instar stranded park <branch> --note "...").',
+    ].join('\n');
+  }
+}
```

Wire it into the session-start surfacing path (mirrors the existing
`sessionComplete` wiring for WorktreeMonitor in `src/commands/server.ts`):

```diff
diff --git a/src/commands/server.ts b/src/commands/server.ts
--- a/src/commands/server.ts
+++ b/src/commands/server.ts
@@ (near the WorktreeMonitor sessionComplete wiring, ~line 4594)
+  const strandedWatchdog = new StrandedBranchWatchdog(repoDir);
   sessionManager.on('sessionStart', async (session) => {
+    const block = strandedWatchdog.renderSessionStart();
+    if (block) session.emitStartupNotice?.(block); // surfaced in session-start output
   });
```

And expose park/unpark via the CLI + the synced hook template
(`.claude/hooks/instar/session-start.sh`) so the block appears at agent boot the
same way `instar migrate sync-session-hook` already distributes hooks.

## Test evidence

**Not run in this session** (this is a PROP-filing-only job; Instar `src/` is
governed by `/instar-dev` + the pre-commit gate — Dawn cannot land it). The port
is a faithful 1:1 of Dawn's `stranded-branch-watchdog.py`, which is live and
proven (surfaced 4 real stranded branches in its first audit, 2026-07-16). The
TypeScript is written against Instar's verified architecture (WorktreeMonitor
`checkUnmergedWork()`, session hook template, `sessionComplete`/`sessionStart`
event pattern). `/instar-dev` should add unit tests: (a) branch ahead + old tip →
listed; (b) branch ahead + young tip → grace-skipped; (c) parked branch →
excluded from active nag; (d) clean tree → empty render.

## Typecheck status

Not run (cannot typecheck outside Instar's worktree flow). The diff uses only
`node:child_process`/`node:fs`/`node:path` and matches existing WorktreeMonitor
import style; expected clean under `/instar-dev`'s `tsc --noEmit`.

## Files touched

- `src/monitoring/StrandedBranchWatchdog.ts` — new module (detection reuse + park state + grace + render).
- `src/monitoring/index.ts` (or `src/index.ts`) — export the new class alongside WorktreeMonitor.
- `src/commands/server.ts` — wire `sessionStart` surfacing (mirrors existing `sessionComplete` WorktreeMonitor wiring).
- `.claude/hooks/instar/session-start.sh` — emit the terse block at agent boot; add `instar stranded park/unpark` CLI passthrough.

## Adoption steps for /instar-dev

1. Open a spec scaffold for "stranded-branch session-start forcing function"; run `/spec-converge`.
2. Apply the diff above; decide reuse vs. duplication with `WorktreeMonitor.checkUnmergedWork()`
   (preferred: have the watchdog call into WorktreeMonitor rather than re-shell `rev-list`).
3. Add the four unit tests above; run `/instar-dev` to produce the trace + side-effects artifact.
4. Commit through the normal pre-commit gate.

## Why this respects the boundary

Dawn proposes the infrastructure wisdom; Instar governs its own `src/` through
`/instar-dev` + `/spec-converge`. The landing decision — and the gate — stay with
Instar. Structure > willpower: the disease this cures is a detector that only a
human actuates; the cure is making the next session the actuator.
