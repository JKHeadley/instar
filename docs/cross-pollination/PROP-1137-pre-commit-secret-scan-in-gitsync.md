# PROP-1137 — Pre-commit secret scan in GitSync (auto-commit is a publish surface)

**Source**: Dawn `instar-feature-parity` job, 2026-09-14
**Impact**: high (credential exposure) | **Effort**: small | **Type**: infrastructure/security

## Problem

`GitSync` debounce-auto-commits and (by default) auto-pushes whatever is staged:

- `src/core/GitSync.ts:419` — `result.pushed = this.commitAndPush('sync: auto-commit')`
- `src/core/GitSync.ts:441-456` — `commitAndPush()` runs `git add <paths>` → `git commit` → `git push` with **no content inspection whatsoever**
- `GitSyncConfig.debounceMs` defaults to 30s; `autoPush` defaults to true

So any file that lands in a synced path gets published to `origin` within ~30 seconds, unreviewed. Agents write files. Agents that debug auth write files containing tokens. That combination has already fired once in the wild:

> Dawn, 2026-08-23: a sub-agent wrote `_fmtest_jwt.txt` (a freshly minted admin JWT) into the repo working tree while debugging. `git-periodic-sync` auto-committed and **pushed it to origin/main** (commit `9c775400b6`) within ~30 minutes. The token was in pushed history until it expired. The fix Dawn adopted was a rule ("secrets go to /tmp, never the repo") — willpower, and it only binds the agents who read the rule. Instar can do better because it already owns the detector.

Instar already has the detection layer: `SecretRedactor` (`src/core/SecretRedactor.ts`) does two-layer detection — built-in patterns for `sk-`, `sk-ant-api`, `ghp_`/`ghs_`/`gho_`, `AKIA…`, `AIza…`, `npm_`, `glpat-`, JWTs, connection strings, private keys — plus Shannon-entropy scanning with `shouldExcludeFile()` returning a ready-made "this looks like a credentials file" verdict.

But `SecretRedactor` is wired **only to LLM-exposure paths**:

```
src/core/SyncOrchestrator.ts   — redact before sending conflicts to an LLM
src/monitoring/SystemReviewer.ts:929 — sanitize review output
```

Nothing scans the **commit** path. The detector protects the model from seeing secrets and does not protect the remote from receiving them — and the remote is the irreversible one. This is the same shape as `SourceTreeGuard`: a brittle blocker on an irreversible action, where false-block costs a re-run and false-pass costs a credential rotation.

## Proposed patch

Full unified diff against `src/core/GitSync.ts`.

```diff
--- a/src/core/GitSync.ts
+++ b/src/core/GitSync.ts
@@ -22,6 +22,7 @@ import { FileClassifier } from './FileClassifier.js';
 import type { ClassificationResult } from './FileClassifier.js';
 import { DegradationReporter } from '../monitoring/DegradationReporter.js';
 import { assertNotInstarSourceTree } from './SourceTreeGuard.js';
+import { SecretRedactor } from './SecretRedactor.js';
 import { SafeFsExecutor } from './SafeFsExecutor.js';
 import { SafeGitExecutor } from './SafeGitExecutor.js';
 
@@ -44,6 +45,11 @@ export interface GitSyncConfig {
   debounceMs?: number;
   /** Intelligence provider for LLM-based conflict resolution. */
   intelligence?: IntelligenceProvider;
+  /**
+   * Block commits whose staged content contains detected secrets (default: true).
+   * Set false ONLY for repos that intentionally version encrypted credential blobs.
+   */
+  blockSecretCommits?: boolean;
 }
 
@@ -90,6 +96,8 @@ export class GitSync {
   private debounceTimer: ReturnType<typeof setTimeout> | null = null;
   private pendingPaths: Set<string> = new Set();
   private llmResolver: LLMConflictResolver | null = null;
   private fileClassifier: FileClassifier;
+  private blockSecretCommits: boolean;
+  private secretRedactor: SecretRedactor;
 
   constructor(config: GitSyncConfig) {
@@ -100,6 +108,8 @@ export class GitSync {
     this.autoPush = config.autoPush ?? true;
     this.debounceMs = config.debounceMs ?? 30_000;
+    this.blockSecretCommits = config.blockSecretCommits ?? true;
+    this.secretRedactor = new SecretRedactor();
     this.fileClassifier = new FileClassifier();
@@ -441,15 +451,25 @@ export class GitSync {
   commitAndPush(message: string, paths?: string[]): boolean {
     const filesToAdd = paths || [this.stateDir];
 
     try {
       for (const p of filesToAdd) {
         this.gitExec(['add', p]);
       }
 
       // Check if there's anything staged
       const diff = this.gitExec(['diff', '--cached', '--name-only']);
       if (!diff.trim()) return false;
 
+      // Auto-commit is a PUBLISH surface (autoPush defaults true, debounce 30s).
+      // Scan staged content before it becomes irreversible. Fail CLOSED.
+      if (this.blockSecretCommits) {
+        const offenders = this.scanStagedForSecrets(
+          diff.split('\n').map((l) => l.trim()).filter(Boolean),
+        );
+        if (offenders.length > 0) {
+          this.quarantineSecretFiles(offenders);
+          return false;
+        }
+      }
+
       this.gitExec(['commit', '-m', message]);
 
       if (this.autoPush) {
         this.gitExec(['push']);
       }
 
       return true;
     } catch {
@@ -1009,6 +1029,71 @@ export class GitSync {
+  /**
+   * Scan staged files for secrets. Returns offending paths with a reason.
+   *
+   * Fail-closed: a file that cannot be read is treated as an offender rather
+   * than waved through — the false-block cost is one re-run, the false-pass
+   * cost is a leaked credential in pushed history.
+   */
+  private scanStagedForSecrets(
+    stagedPaths: string[],
+  ): Array<{ path: string; reason: string }> {
+    const offenders: Array<{ path: string; reason: string }> = [];
+
+    for (const rel of stagedPaths) {
+      const abs = path.join(this.projectDir, rel);
+      let content: string;
+      try {
+        const stat = fs.statSync(abs);
+        if (!stat.isFile()) continue;
+        // Skip binaries by size guard; entropy scan is O(n) and large blobs
+        // are not the exposure shape this guard exists for.
+        if (stat.size > 2_000_000) continue;
+        content = fs.readFileSync(abs, 'utf-8');
+      } catch (err) {
+        // Deleted-in-worktree staged deletions read as ENOENT — those carry
+        // no new content and are safe to skip.
+        if ((err as NodeJS.ErrnoException).code === 'ENOENT') continue;
+        offenders.push({ path: rel, reason: `unreadable staged file: ${String(err)}` });
+        continue;
+      }
+
+      const exclusion = this.secretRedactor.shouldExcludeFile(rel, content);
+      if (exclusion.excluded) {
+        offenders.push({ path: rel, reason: exclusion.reason ?? 'credentials-file heuristic' });
+        continue;
+      }
+
+      const result = this.secretRedactor.redact(content, 'ours');
+      if (result.count > 0) {
+        const types = Object.entries(result.typeCounts)
+          .filter(([, n]) => n > 0)
+          .map(([t, n]) => `${t}×${n}`)
+          .join(', ');
+        offenders.push({ path: rel, reason: `detected secrets: ${types}` });
+      }
+    }
+
+    return offenders;
+  }
+
+  /**
+   * Unstage offending files and record the block. The files stay on disk —
+   * destroying an agent's work is not this guard's job; keeping it out of
+   * pushed history is.
+   */
+  private quarantineSecretFiles(offenders: Array<{ path: string; reason: string }>): void {
+    for (const o of offenders) {
+      try {
+        this.gitExec(['reset', 'HEAD', '--', o.path]);
+      } catch {
+        // Best-effort unstage; the commit is refused regardless.
+      }
+    }
+
+    this.securityLog.append({
+      event: 'secret_commit_blocked',
+      machineId: this.machineId,
+      files: offenders.map((o) => o.path),
+      reasons: offenders.map((o) => `${o.path}: ${o.reason}`),
+    });
+
+    DegradationReporter.report({
+      component: 'GitSync',
+      severity: 'high',
+      summary: `Blocked auto-commit: ${offenders.length} staged file(s) contain detected secrets`,
+      detail: offenders.map((o) => `${o.path}: ${o.reason}`).join('\n'),
+    });
+  }
+
   private gitExec(args: string[]): string {
```

Two call-site notes for the adopting agent:

1. `SafeGitExecutor` allowlists subcommands (`src/core/SafeGitExecutor.ts:56` shows `'add'` in the list). Confirm `'reset'` is allowlisted; if not, add it there — the guard's unstage path needs it.
2. `DegradationReporter.report(...)` signature should be matched to the current normalization shim (`027829e65 feat(monitoring): F-3 — DegradationReporter normalization shim`); the call above is written against the shim's shape and may need a field rename.

## Test evidence

**Not run.** Per PROP-379 scope, this job does not edit or build Instar's `src/` — it files the proposal and leaves the gate with `/instar-dev`. What *was* verified in this run, by reading the current tree (`/Users/justin/Documents/Projects/instar-main`, HEAD `007162176`):

- `GitSync.commitAndPush()` performs `add` → `diff --cached` → `commit` → `push` with no content inspection (`src/core/GitSync.ts:441-456`). Confirmed by reading the method.
- Auto-commit fires from the sync path at `src/core/GitSync.ts:419`; `autoPush` defaults true and `debounceMs` defaults to 30 000 (`src/core/GitSync.ts:41-45`, `constructor`).
- `SecretRedactor` has exactly two consumers today, both LLM-facing: `src/core/SyncOrchestrator.ts` and `src/monitoring/SystemReviewer.ts:929`. Confirmed by `grep -rn "SecretRedactor" src` (excluding the module and the `index.ts` re-export).
- An existing unit suite for this class lives at `tests/unit/GitSync.test.ts` — the new cases belong there.

**Typecheck status**: not run (no `src/` edit made in this session).

Suggested test cases for the adopting agent, to add to `tests/unit/GitSync.test.ts`:

1. staged file containing `sk-ant-api…` → `commitAndPush()` returns `false`, no commit object created, file is unstaged, `securityLog` has a `secret_commit_blocked` entry.
2. staged file containing ordinary prose → commits normally (no regression to the happy path).
3. staged *deletion* (path absent from worktree) → skipped, commit proceeds.
4. unreadable staged file (chmod 000) → treated as an offender, commit refused (fail-closed assertion).
5. `blockSecretCommits: false` → legacy behavior, commit proceeds even with a detected secret.

## Files touched

- `src/core/GitSync.ts` — import `SecretRedactor`; add `blockSecretCommits` config + field; gate `commitAndPush()` on `scanStagedForSecrets()`; add `scanStagedForSecrets()` and `quarantineSecretFiles()`.
- `src/core/SafeGitExecutor.ts` — only if `'reset'` is not already in the allowlist.
- `tests/unit/GitSync.test.ts` — the five cases above.

## Adoption steps for /instar-dev

1. Open a spec scaffold for "pre-commit secret scan in GitSync" and run `/spec-converge`. The load-bearing decision to converge on is the **fail-closed** posture: unreadable staged file blocks the commit. Treat it the way `SourceTreeGuard` is treated (`docs/signal-vs-authority.md` safety-guard carve-out) — false-block is trivial, false-pass is a credential rotation.
2. Apply the diff above, reconciling the two call-site notes (`SafeGitExecutor` allowlist, `DegradationReporter.report` shape).
3. Add the five test cases; run `pnpm test` and `tsc --noEmit`.
4. Run `/instar-dev` to produce the trace + side-effects artifact, then commit through the normal gate.

## Why this is the highest-value parity gap this run

The 24 prior cross-pollination PROPs are predominantly *reviewer* patterns — post-hoc judgment on Dawn's reasoning failures. This one is different in kind: the detector already exists inside Instar and is simply not wired to the irreversible surface. The gap is one import and one call away from closed, and the failure it prevents is the only one on Dawn's list that cannot be undone by a later session noticing the mistake.
