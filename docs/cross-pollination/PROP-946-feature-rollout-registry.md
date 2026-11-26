# PROP-946 — Feature Rollout Registry (shadow-first governance + forcing function)

**Source:** Dawn `instar-feature-parity` job (AUT-9845-wo, 2026-08-03)
**Domain:** instar · **Type:** infrastructure · **Impact:** high · **Effort:** medium
**Ports:** Dawn `.claude/scripts/feature-rollout-gate.py` (+ `.claude/standards/enforcement-over-advisory.md`)

## Problem

Instar already ships behavior behind rollout phases — `SHARED_INFRA_FLAGS`
(`src/messaging/shared/FeatureFlags.ts`), `prGate` and `parallelDev` phase
configs (`src/core/types.ts`), the mode-flip endpoint
(`src/server/routes.ts:1476`). But every one of these is governed **ad hoc**:

- Flags are hardcoded booleans or free-form config phases with no central list.
- There is **no forcing function** ending a shadow phase. `FeatureFlags.ts`'s own
  header says *"Flags are removed once all tests pass for 2 weeks post-extraction"*
  — a manual, un-enforced deadline. Nothing watches it. A flag can sit in
  `shadow` forever and no session is told.
- There is **no audit trail** for a flip. Nothing records *who* moved a flag
  `shadow→on`, *when*, or *on what evidence*.
- There is **no drift detection** between intended mode (spec/registry) and the
  mode actually live in the deployed config.

This is the exact failure Dawn named the **"Shadow-Mode Without Forcing Function"
trap**: you ship a gate in shadow with a written "flip after N days" intent, no
mechanism fires the flip, and it silently stays observation-only until the next
incident reveals the safety layer was never enforcing. Dawn hit this concretely
(`PORTAL_FUSED_RANKING` flipped in prod with no recorded decision; nobody could
say who did it three weeks later) and closed it with `feature-rollout-gate.py`.
Instar has the same shape of flags and the same missing governance — so every
Instar agent inherits the risk.

## Proposed patch

A single central registry (`FeatureRolloutRegistry`) that every rollout flag
registers with — carrying mode, shadow-start, flip criteria, review deadline, and
recorded sign-off — plus a `surfaceOverdueRollouts()` helper wired into the
session-start banner (the forcing function) and a `setMode('on')` that **refuses
without a sign-off** (the audit trail). Idioms modeled on
`src/threadline/ThreadlineNicknames.ts` (TTL-cached JSON registry under
`stateDir`).

```diff
--- /dev/null
+++ b/src/core/FeatureRolloutRegistry.ts
@@
+/**
+ * FeatureRolloutRegistry — central, enforced shadow-first governance for every
+ * behavior flag / rollout phase in Instar.
+ *
+ * Ports Dawn's feature-rollout-gate.py. The problem it closes: flags ship behind
+ * a "shadow, flip after N days" intent with NO mechanism to fire the flip, no
+ * record of who flipped it, and no drift check between intended and live mode.
+ * Shadow phases then rot silently until an incident reveals the gate never
+ * enforced ("Shadow-Mode Without Forcing Function" trap).
+ *
+ * Storage: .instar/feature-rollouts.json
+ *   {
+ *     "version": 1,
+ *     "flags": {
+ *       "useSharedCommandRouter": {
+ *         "feature": "Phase 1a CommandRouter extraction",
+ *         "mode": "shadow",
+ *         "shadowStart": "2026-08-03T00:00:00.000Z",
+ *         "criteria": "all router tests green for 14d, zero fallbacks logged",
+ *         "reviewBy": "2026-08-17T00:00:00.000Z",
+ *         "signoff": null,
+ *         "history": [ { "mode": "shadow", "at": "...", "note": "registered" } ]
+ *       }
+ *     }
+ *   }
+ */
+import fs from 'node:fs';
+import path from 'node:path';
+
+export type RolloutMode = 'off' | 'shadow' | 'on';
+
+export interface RolloutSignoff {
+  who: string;
+  at: string;
+  where: string; // where the decision is recorded (spec, PR, session id)
+}
+
+export interface RolloutEntry {
+  feature: string;
+  mode: RolloutMode;
+  shadowStart: string | null;
+  criteria: string;
+  reviewBy: string | null;
+  signoff: RolloutSignoff | null;
+  history: Array<{ mode: RolloutMode; at: string; note?: string }>;
+}
+
+interface RolloutFile {
+  version: number;
+  flags: Record<string, RolloutEntry>;
+}
+
+export interface OverdueRollout {
+  flag: string;
+  feature: string;
+  reason: 'review-overdue' | 'missing-signoff';
+  detail: string;
+}
+
+const FILE_VERSION = 1;
+const MODES: RolloutMode[] = ['off', 'shadow', 'on'];
+
+export interface FeatureRolloutRegistryOptions {
+  stateDir: string;
+  /** Injectable clock for tests. Defaults to Date.now. */
+  now?: () => number;
+}
+
+export class FeatureRolloutRegistry {
+  private readonly stateDir: string;
+  private readonly now: () => number;
+  private cache: RolloutFile | null = null;
+  private cacheReadAt = 0;
+  private static readonly CACHE_TTL_MS = 30_000;
+
+  constructor(opts: FeatureRolloutRegistryOptions) {
+    this.stateDir = opts.stateDir;
+    this.now = opts.now ?? (() => Date.now());
+  }
+
+  filePath(): string {
+    return path.join(this.stateDir, 'feature-rollouts.json');
+  }
+
+  private load(): RolloutFile {
+    const age = this.now() - this.cacheReadAt;
+    if (this.cache && age < FeatureRolloutRegistry.CACHE_TTL_MS) return this.cache;
+    let data: RolloutFile = { version: FILE_VERSION, flags: {} };
+    try {
+      const raw = fs.readFileSync(this.filePath(), 'utf8');
+      const parsed = JSON.parse(raw) as RolloutFile;
+      if (parsed && typeof parsed === 'object' && parsed.flags) data = parsed;
+    } catch { /* first run — empty registry */ }
+    this.cache = data;
+    this.cacheReadAt = this.now();
+    return data;
+  }
+
+  private save(data: RolloutFile): void {
+    fs.mkdirSync(path.dirname(this.filePath()), { recursive: true });
+    fs.writeFileSync(this.filePath(), JSON.stringify(data, null, 2));
+    this.cache = data;
+    this.cacheReadAt = this.now();
+  }
+
+  /** Register a flag with its shadow plan. Idempotent — no-ops if already present. */
+  register(flag: string, opts: {
+    feature: string;
+    mode?: RolloutMode;
+    criteria: string;
+    reviewDays?: number;
+    signoff?: RolloutSignoff;
+  }): RolloutEntry {
+    const data = this.load();
+    if (data.flags[flag]) return data.flags[flag];
+    const nowIso = new Date(this.now()).toISOString();
+    const mode = opts.mode ?? 'off';
+    const entry: RolloutEntry = {
+      feature: opts.feature,
+      mode,
+      shadowStart: mode === 'shadow' ? nowIso : null,
+      criteria: opts.criteria,
+      reviewBy: opts.reviewDays
+        ? new Date(this.now() + opts.reviewDays * 86_400_000).toISOString()
+        : null,
+      signoff: opts.signoff ?? null,
+      history: [{ mode, at: nowIso, note: 'registered' }],
+    };
+    data.flags[flag] = entry;
+    this.save(data);
+    return entry;
+  }
+
+  /**
+   * Transition a flag. Flipping to 'on' REQUIRES a sign-off — that is the audit
+   * trail the ungoverned flip never had. Throws if absent.
+   */
+  setMode(flag: string, mode: RolloutMode, opts?: { signoff?: RolloutSignoff; note?: string }): RolloutEntry {
+    if (!MODES.includes(mode)) throw new Error(`invalid mode: ${mode}`);
+    const data = this.load();
+    const entry = data.flags[flag];
+    if (!entry) throw new Error(`flag not registered: ${flag}`);
+    if (mode === 'on' && !opts?.signoff && !entry.signoff) {
+      throw new Error(`refusing to flip ${flag} → on without a sign-off (who/when/where)`);
+    }
+    const nowIso = new Date(this.now()).toISOString();
+    if (mode === 'shadow' && !entry.shadowStart) entry.shadowStart = nowIso;
+    if (opts?.signoff) entry.signoff = opts.signoff;
+    entry.mode = mode;
+    entry.history.push({ mode, at: nowIso, note: opts?.note });
+    this.save(data);
+    return entry;
+  }
+
+  /** Current effective mode; unregistered flags read 'off' (fail-closed). */
+  mode(flag: string): RolloutMode {
+    return this.load().flags[flag]?.mode ?? 'off';
+  }
+
+  isRegistered(flag: string): boolean {
+    return !!this.load().flags[flag];
+  }
+
+  list(): Record<string, RolloutEntry> {
+    return { ...this.load().flags };
+  }
+
+  /** The forcing function: flags whose review deadline has passed, or that are
+   *  'on' with no recorded sign-off. Surfaced at every session start. */
+  overdue(): OverdueRollout[] {
+    const out: OverdueRollout[] = [];
+    const now = this.now();
+    for (const [flag, e] of Object.entries(this.load().flags)) {
+      if (e.reviewBy && Date.parse(e.reviewBy) < now && e.mode !== 'on') {
+        out.push({ flag, feature: e.feature, reason: 'review-overdue',
+          detail: `${e.mode} review due ${e.reviewBy}; criteria: ${e.criteria}` });
+      }
+      if (e.mode === 'on' && !e.signoff) {
+        out.push({ flag, feature: e.feature, reason: 'missing-signoff',
+          detail: `live 'on' with no recorded who/when/where` });
+      }
+    }
+    return out;
+  }
+}
+
+/** One-line-per-item banner for the session-start surface. Empty string when clean. */
+export function surfaceOverdueRollouts(registry: FeatureRolloutRegistry): string {
+  const items = registry.overdue();
+  if (items.length === 0) return '';
+  const lines = items.map(i => `  [${i.reason}] ${i.flag} — ${i.detail}`);
+  return `🚦 FEATURE ROLLOUTS needing attention (shadow-first standard):\n${lines.join('\n')}`;
+}
```

Wiring (session-start forcing function — exact call site is `/instar-dev`'s to
place; sketch against the existing startup banner in `src/cli.ts`):

```diff
+import { FeatureRolloutRegistry, surfaceOverdueRollouts } from './core/FeatureRolloutRegistry.js';
@@ session-start banner assembly
+  const rollouts = new FeatureRolloutRegistry({ stateDir });
+  const rolloutBanner = surfaceOverdueRollouts(rollouts);
+  if (rolloutBanner) console.log(rolloutBanner);
```

Migration of the three existing ad-hoc flag groups (`SHARED_INFRA_FLAGS`,
`prGate`, `parallelDev`) into `register()` calls is a follow-up increment, not
required for landing — the registry + forcing function is the load-bearing piece.

## Test evidence

**Not run in this job** — this job runs outside Instar's `/instar-dev` flow and
cannot produce a valid pre-commit trace, so no `pnpm test` / `tsc` was executed
against the Instar tree. The diff is authored against read Instar source
(`ThreadlineNicknames.ts` idiom, `FeatureFlags.ts`, `types.ts`) and is
self-contained (only `node:fs`/`node:path`). `/instar-dev` must run the gate.

Suggested tests for the adoption pass (mirror Dawn's gate semantics):
- `register` is idempotent; second call returns the first entry unchanged.
- `setMode(flag, 'on')` **throws** without a sign-off; succeeds with one.
- `overdue()` flags a past `reviewBy` in shadow, and an `on`-without-signoff.
- unregistered `mode(flag)` returns `'off'` (fail-closed).
- injected `now()` drives the deadline math (no real clock in tests).

## Typecheck status

Not run (see above). Diff uses only stdlib imports and matches the existing
`ThreadlineNicknames` class shape, which typechecks in-tree today.

## Files touched

- `src/core/FeatureRolloutRegistry.ts` — new registry module (the whole feature).
- `src/cli.ts` — one wiring hunk to surface overdue rollouts at session start
  (exact placement for `/instar-dev`).

## Adoption steps for /instar-dev

1. Open a spec scaffold for `FEATURE-ROLLOUT-REGISTRY`, run `/spec-converge`.
2. Apply the new-file diff; place the `cli.ts` surfacing hunk next to the
   existing startup banner assembly.
3. Add the unit tests above; run `/instar-dev` to produce the trace +
   side-effects artifact; `pnpm test` + `tsc --noEmit`.
4. Commit through the normal pre-commit gate.
5. Follow-up increment: migrate `SHARED_INFRA_FLAGS`, `prGate`, `parallelDev`
   into `register()` calls so the whole flag surface is governed by one registry.
