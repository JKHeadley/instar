# PROP-1166 — Instar: ratchet against ambiguous negatives (a failed probe read as "no")

**Source**: Dawn `instar-feature-parity` job, run 2026-09-21 (AUT-12517-wo)
**Type**: infrastructure · **Impact**: high · **Effort**: small
**Dawn counterpart**: `.claude/scripts/ambiguous-negative-scan.py` (live; fires in Dawn's SessionStart hook)

## Problem

A state-reporting function — `is*` / `has*` / `check*` / `verify*` / `probe*`, or a name
containing alive/reachable/health/exists/stalled/responsive — has three honest answers:
**yes**, **no**, and **unknown**. Most ship two. When the failure path (`catch`, non-ok
response, timeout) returns a definite negative, "I could not tell" is silently converted
into "no", and the caller then acts destructively on no evidence.

Dawn hit **seven distinct instances of this one class in a single day** (2026-09-19):

- a timeout read as "failed" → duplicate sessions building the same thing
- a failed ping read as "session gone" → respawned over live mid-thought work
- a boot window read as "listener dead" → kickstart loop on the only inbound channel
- `catch → return false` in a stall verifier → the whole repair chain skipped in silence

Naming the class was not enough: two NEW instances shipped the same night, one of them
*inside the tool written to prevent it*. A lesson whose only enforcement is a future reader
remembering it is an advisory-only control. It needed a ratchet.

**Instar has no equivalent check** (verified: no match for `ambiguous.negative` anywhere in
`src/` or `scripts/`), and the population is large. Measured against
`~/.instar/agents/echo/.instar/w27/rebuild-worktree` (HEAD `e6f6babf6`), scanning 1,671
`.ts` files under `src/`:

- **168 distinct sites** (214 matched lines) where a state-reporting function returns a
  definite negative from an *undiscriminated* failure path.
- Distribution by area: `core` 79, `monitoring` 44, `commands` 27, `threadline` 12,
  `lifeline` 12, `messaging` 11, `providers` 8, `server` 7, `memory` 4, `utils` 3.

Real examples from the scan:

```
src/threadline/ListenerSessionManager.ts:426  verifyEntry() -> false
src/threadline/SecureInvitation.ts:188        verifyTokenSignature() -> false
src/threadline/ThreadlineReplyValidation.ts:43 isAuthenticatedThreadlineInbound() -> false
src/threadline/AgentDiscovery.ts:253          HealthResponse() -> null
```

These are not all bugs. The proposal is **not** to fix 168 sites. It is to stop the
population from growing a 169th silently — Instar's own established ratchet pattern
(`lint-blocking-decisions-declared.mjs`, `scripts/blocking-decision-surfaces-baseline.json`).

## Proposed patch

Three changes. Deliberately matched to Instar's existing lint conventions (shrink-only
baseline against a committed `ceiling`, `--json`, `--staged`, `MEASURED`/`CERTIFIED`
header, exit 0 clean / 1 violation).

### 1. New file: `scripts/lint-no-ambiguous-negative.mjs`

```diff
--- /dev/null
+++ b/scripts/lint-no-ambiguous-negative.mjs
+#!/usr/bin/env node
+/**
+ * lint-no-ambiguous-negative.mjs — a state-reporting function must not turn
+ * "I could not tell" into "no".
+ *
+ * ── The class ──────────────────────────────────────────────────────────────
+ * A failure path (catch / non-ok / timeout) that returns a DEFINITE negative
+ * from a function whose job is to REPORT STATE — is / has / check / verify /
+ * probe prefixes,
+ * or a name containing alive/reachable/liveness/health/exists/stall/responsive.
+ * Those functions have three honest answers (yes / no / unknown) and usually
+ * ship two. "Unknown" is the one that goes missing, and it is the one that stops
+ * a caller from acting destructively on no evidence.
+ *
+ * Observed instances of this exact class (Dawn, 2026-09-19, seven in one day):
+ *   a timeout read as "failed"           -> duplicate sessions building the same thing
+ *   a failed ping read as "session gone" -> respawned over live mid-thought work
+ *   a boot window read as "listener dead"-> kickstart loop on the only inbound channel
+ *   catch -> return false in a stall verifier -> the repair chain skipped in silence
+ *
+ * ── What this measures, and what it certifies ──────────────────────────────
+ *   MEASURED  — every `.ts` under `src/` whose state-reporting function returns
+ *               a definite negative on an UNDISCRIMINATED failure path is either
+ *               in the baseline or is a violation.
+ *   CERTIFIED — this population cannot GROW a new ambiguous negative silently.
+ *
+ * It does NOT certify that the baselined instances are correct. It certifies
+ * that no new one is added without a human verdict. A catch that INSPECTS the
+ * error (`err.code === 'ESRCH'`) has thought about it and is not flagged: that
+ * is a real answer, not a shrug.
+ *
+ * ── Why a ratchet rather than a report ─────────────────────────────────────
+ * A backlog reported every run becomes wallpaper, and wallpaper is how the
+ * original class survived. Precision over recall on purpose: a noisy scanner
+ * gets muted, and a muted scanner is worse than none because it looks like
+ * coverage.
+ *
+ * The baseline is SHRINK-ONLY against `ceiling`. The remedy for a new instance
+ * is to return an explicit unknown — not to raise the ceiling. Raising it is
+ * possible, deliberate, and visible in review, which is the point.
+ *
+ * Exit codes: 0 — clean; 1 — at least one new instance.
+ *
+ * Usage:
+ *   node scripts/lint-no-ambiguous-negative.mjs
+ *   node scripts/lint-no-ambiguous-negative.mjs --json
+ *   node scripts/lint-no-ambiguous-negative.mjs --staged     # pre-commit subset
+ *   node scripts/lint-no-ambiguous-negative.mjs --write-baseline
+ */
+
+import fs from 'node:fs';
+import path from 'node:path';
+import { execSync } from 'node:child_process';
+import { fileURLToPath } from 'node:url';
+
+const __filename = fileURLToPath(import.meta.url);
+const ROOT = path.resolve(path.dirname(__filename), '..');
+const BASELINE_REL = 'scripts/ambiguous-negative-baseline.json';
+const POPULATION_DIR = 'src';
+const JSON_OUT = process.argv.includes('--json');
+const STAGED = process.argv.includes('--staged');
+const WRITE_BASELINE = process.argv.includes('--write-baseline');
+
+const STATE_FN =
+  /(?:async\s+)?(?:export\s+)?(?:function\s+|const\s+|private\s+|public\s+|\s)(is[A-Z]\w*|has[A-Z]\w*|check[A-Z]\w*|verify[A-Z]\w*|probe[A-Z]\w*|get\w*(?:Status|State|Health)\w*|\w*(?:Alive|Reachable|Liveness|Health|Exists|Stalled|Responsive)\w*)\s*[(=]/;
+const DEFINITE_NEG =
+  /return\s+(false|null|'(?:dead|missing|unreachable|offline|gone)'|"(?:dead|missing|unreachable|offline|gone)")\s*;/;
+const HONEST = /'unknown'|"unknown"|UNKNOWN|asked:\s*false|indeterminate/;
+const DISCRIMINATED =
+  /err(?:or)?\.code\s*===|instanceof\s+\w+Error|\bif\s*\(\s*err|errno\s*===|\.code\s*==\s*'/;
+const FAILURE_PATH = /\bcatch\b|!resp\.ok|!res\.ok|status\s*!==\s*200|TimeoutError|ETIMEDOUT/;
+const NOT_A_PROBE = new Set(['isNaN', 'isArray', 'isFinite', 'isInteger', 'isSafeInteger', 'isString', 'isBuffer']);
+const SKIP = /__tests__|\/tests?\/|\.test\.|\.spec\.|node_modules|\/dist\//;
+
+function walk(absDir, relBase, out) {
+  for (const entry of fs.readdirSync(absDir, { withFileTypes: true })) {
+    const abs = path.join(absDir, entry.name);
+    const rel = path.posix.join(relBase, entry.name);
+    if (entry.isSymbolicLink()) continue;
+    if (entry.isDirectory()) walk(abs, rel, out);
+    else if (entry.isFile() && rel.endsWith('.ts') && !SKIP.test(rel)) out.push(rel);
+  }
+  return out;
+}
+
+function stagedFiles() {
+  try {
+    return execSync('git diff --cached --name-only --diff-filter=ACMR', { cwd: ROOT, encoding: 'utf8' })
+      .split('\n')
+      .filter((f) => f.startsWith(`${POPULATION_DIR}/`) && f.endsWith('.ts') && !SKIP.test(f))
+      .filter((f) => fs.existsSync(path.join(ROOT, f)));
+  } catch {
+    return null; // not a work tree — say so, do not claim "no staged files"
+  }
+}
+
+function enclosingFn(lines, idx) {
+  for (let i = idx; i >= Math.max(0, idx - 60); i--) {
+    const m = STATE_FN.exec(lines[i]);
+    if (m) return m[1];
+  }
+  return null;
+}
+
+function scanFile(rel) {
+  const findings = [];
+  const lines = fs.readFileSync(path.join(ROOT, rel), 'utf8').split('\n');
+  for (let i = 0; i < lines.length; i++) {
+    const neg = DEFINITE_NEG.exec(lines[i]);
+    if (!neg) continue;
+    const window = lines.slice(Math.max(0, i - 6), i + 1).join('\n');
+    if (!FAILURE_PATH.test(window)) continue;
+    if (DISCRIMINATED.test(lines[i]) || DISCRIMINATED.test(lines.slice(Math.max(0, i - 2), i).join('\n'))) continue;
+    const fn = enclosingFn(lines, i);
+    if (!fn || NOT_A_PROBE.has(fn)) continue;
+    if (HONEST.test(lines.slice(Math.max(0, i - 20), i + 20).join('\n'))) continue;
+    findings.push({ file: rel, line: i + 1, function: fn, returns: neg[1], snippet: lines[i].trim().slice(0, 110) });
+  }
+  return findings;
+}
+
+const keyOf = (f) => `${f.file}:${f.function}:${f.returns}`;
+
+function main() {
+  let population;
+  if (STAGED) {
+    const s = stagedFiles();
+    if (s === null) {
+      console.error('lint-no-ambiguous-negative: cannot read the index (not a work tree) — UNKNOWN, not clean.');
+      return 1;
+    }
+    population = s;
+  } else {
+    population = walk(path.join(ROOT, POPULATION_DIR), POPULATION_DIR, []);
+  }
+
+  const findings = population.flatMap(scanFile);
+
+  if (WRITE_BASELINE) {
+    const keys = [...new Set(findings.map(keyOf))].sort();
+    fs.writeFileSync(
+      path.join(ROOT, BASELINE_REL),
+      `${JSON.stringify(
+        {
+          $comment: [
+            'Accepted pre-existing ambiguous negatives: a state-reporting function that returns a',
+            'definite negative from an undiscriminated failure path. SHRINK-ONLY against ceiling.',
+            'The remedy for a NEW instance is to return an explicit unknown, not to raise the ceiling.',
+          ],
+          ceiling: keys.length,
+          keys,
+        },
+        null,
+        2,
+      )}\n`,
+    );
+    console.log(`baselined ${keys.length} existing instance(s) -> ${BASELINE_REL}`);
+    return 0;
+  }
+
+  const baseline = JSON.parse(fs.readFileSync(path.join(ROOT, BASELINE_REL), 'utf8'));
+  const known = new Set(baseline.keys);
+  const novel = findings.filter((f) => !known.has(keyOf(f)));
+
+  // Shrink-only: the DISTINCT-SITE count must never exceed the committed
+  // ceiling. Counted in the same unit the ceiling was written in (distinct
+  // file:function:returns keys, not matched lines) — a ceiling and the query it
+  // gates must share their filters, or the gate fires on a unit mismatch.
+  const distinct = new Set(findings.map(keyOf)).size;
+  const ceilingBreach = !STAGED && distinct > baseline.ceiling;
+
+  if (JSON_OUT) {
+    console.log(JSON.stringify({ scanned: population.length, sites: distinct, matches: findings.length, ceiling: baseline.ceiling, novel }, null, 2));
+    return novel.length || ceilingBreach ? 1 : 0;
+  }
+
+  if (!novel.length && !ceilingBreach) {
+    console.log(`lint-no-ambiguous-negative: clean (${distinct}/${baseline.ceiling} baselined site(s) across ${population.length} file(s))`);
+    return 0;
+  }
+
+  if (ceilingBreach) {
+    console.error(`🔻 ceiling breach: ${distinct} distinct site(s) > committed ceiling ${baseline.ceiling}.`);
+  }
+  console.error(`🔻 ${novel.length} NEW ambiguous-negative(s) since the baseline.`);
+  console.error('   Something new tells a caller "no" when the truth is "I could not tell".\n');
+  for (const f of novel) {
+    console.error(`   ${f.file}:${f.line}  ${f.function}() -> ${f.returns}`);
+    console.error(`      ${f.snippet}`);
+  }
+  console.error('\n   Fix shape: return an explicit unknown and let the caller refuse to act on it.');
+  console.error(`   If it is genuinely definite, discriminate the error (err.code === ...) or re-baseline deliberately.`);
+  return 1;
+}
+
+process.exit(main());
+
```

### 2. New file: `scripts/ambiguous-negative-baseline.json`

Generated by `node scripts/lint-no-ambiguous-negative.mjs --write-baseline`.
`ceiling: 168`, 168 sorted `file:function:returns` keys. First 12:

```
  src/commands/init.ts:hasRemote:null
  src/commands/listener.ts:getStateDir:null
  src/commands/listener.ts:readHealth:null
  src/commands/machine.ts:isTunnelUrl:null
  src/commands/nuke.ts:hasGitRemote:false
  src/commands/nuke.ts:isInstarSourceRepo:false
  src/commands/nuke.ts:isTmuxSessionRunning:false
  src/commands/playbook.ts:isVersionAtLeast:null
  src/commands/server.ts:AutonomousLivenessReconciler:null
  src/commands/server.ts:auditLiveness:null
  src/commands/server.ts:hasMeaningfulDeliverableDelta:false
  src/commands/server.ts:isAutoAck:null
  … 156 more
```

### 3. `package.json` — wire into the existing `lint` chain

```diff
-    "lint": "tsc --noEmit && node scripts/lint-no-direct-destructive.js && ... && node scripts/lint-framework-list-completeness.mjs",
+    "lint": "tsc --noEmit && node scripts/lint-no-direct-destructive.js && ... && node scripts/lint-framework-list-completeness.mjs && node scripts/lint-no-ambiguous-negative.mjs",
+    "lint:ambiguous-negative": "node scripts/lint-no-ambiguous-negative.mjs",
+    "lint:ambiguous-negative:staged": "node scripts/lint-no-ambiguous-negative.mjs --staged",
```

(The `lint` value is a single long line in `package.json`; append the one clause to its end.
`--staged` exists so `/instar-dev`'s pre-commit path can run the cheap subset.)

## Test evidence

All run against the real Instar tree (`w27/rebuild-worktree`, HEAD `e6f6babf6`), symlinked
into an isolated harness so nothing in the Instar worktree was written to.

1. **Baseline generation** — `node scripts/lint-no-ambiguous-negative.mjs --write-baseline`
   → `baselined 168 existing instance(s) -> scripts/ambiguous-negative-baseline.json`
2. **Clean run (the ratchet is quiet on the accepted backlog)** —
   → `lint-no-ambiguous-negative: clean (168/168 baselined site(s) across 1671 file(s))`, **exit 0**
3. **The guard can FAIL** — added `checkListenerHealth()` with `catch { return false; }` to a
   fresh baselined population:
   ```
   🔻 ceiling breach: 2 distinct site(s) > committed ceiling 1.
   🔻 1 NEW ambiguous-negative(s) since the baseline.
      src/probe/B.ts:6  checkListenerHealth() -> false
   ```
   **exit 1**
4. **A case that must PASS** — `isPeerReachable()` returning `'yes' | 'no' | 'unknown'` with
   `catch { return 'unknown'; }` → **not flagged** (0 matches). The honest-unknown shape is
   the remedy, so the check must not punish it.

One defect was found and fixed during testing and is worth naming, because it is the same
class of mistake in miniature: the first draft compared `findings.length` (matched *lines*,
214) against a ceiling written in distinct *sites* (168), so the gate fired on a unit
mismatch rather than on a real breach. A ceiling and the query it gates must share their
filters. Fixed; test 2 is the regression.

## Typecheck status

**Not run, and stated rather than implied.** The patch adds no TypeScript — two new files
under `scripts/` (`.mjs` + `.json`) and one `package.json` line, none of which are in
`tsc --noEmit`'s input set, so `tsc` output is unchanged by construction. Instar's full
`tsc --noEmit` was not executed from this job (Dawn runs outside `/instar-dev`); `/instar-dev`
will run it as part of the normal gate.

## Files touched

- `scripts/lint-no-ambiguous-negative.mjs` — new; the ratchet.
- `scripts/ambiguous-negative-baseline.json` — new; 168 accepted pre-existing sites, shrink-only.
- `package.json` — one clause appended to `lint`, plus two convenience aliases.

No `src/` file is modified. Nothing in the existing 168 is required to change.

## Adoption steps for /instar-dev

1. Open a spec scaffold for *"a state-reporting function must not convert unknown into no"*
   and run `/spec-converge`. The standard it belongs under is the same family as
   *Verify the State, Not Its Symbol*.
2. Apply the three changes above. Regenerate the baseline **in your own tree** rather than
   copying this one — HEAD will have moved, and the ceiling must be measured, not inherited:
   `node scripts/lint-no-ambiguous-negative.mjs --write-baseline`.
3. Confirm the guard can fail in your tree before trusting it: add a throwaway
   `catch { return false; }` inside an `isX()` and check for exit 1. A guard that has never
   been seen to fail is not known to work.
4. Run `/instar-dev` to produce the trace + side-effects artifact, then commit through the
   normal gate.

## Why this and not a fix-the-168 campaign

The 168 are a backlog, and a backlog reported every run becomes wallpaper — which is exactly
how the class survived on Dawn's side. The ratchet accepts what exists and surfaces only what
is new, so the population can only shrink. That is the part that would have caught Dawn
writing the lesson down and then shipping two fresh instances the same night.
