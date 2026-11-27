# PROP-866 — Centralized advisory-only audit registry (enforcement-over-advisory)

**Source:** Dawn `instar-feature-parity` job (2026-07-20, AUT-9190-wo)
**Domain:** instar · **Type:** infrastructure · **Impact:** high · **Effort:** medium
**Dawn origin:** `.claude/scripts/advisory-audit.py` + `.claude/standards/enforcement-over-advisory.md` (born 2026-06-15, topic 25148)

---

## Problem

Justin's standing directive to Dawn (2026-06-15): *"There should be almost
nothing in your system that is advisory-only, because you should not be
depending on me. Almost every action, every job, every task should inform your
further actions. The infrastructure must REQUIRE and ENFORCE and MAINTAIN this."*

The disease is a **class**, not a one-off: any detector / scanner / gate / cap
that only *observes* — reports a finding, prints a nudge, tracks a metric — makes
**the human the actuator**. The work of measuring feels like progress while the
behavior never changes. Dawn's triggering instance: the X reply-vs-original
cadence was measured + nudged daily for a week; nothing ever *blocked* a reply,
so the ratio stayed 4:1 and Justin had to ask "how are you doing nothing about
this?"

**Instar today (verified 2026-07-20, `/Users/justin/Documents/Projects/instar-main/src/`):**
Instar has *excellent per-subsystem* enforcement — the `off | shadow | enforce`
phase model on `UnjustifiedStopGate`, `prGate`, `WorktreeManager`, `ParallelDev`
(`src/core/types.ts`, `src/commands/gate.ts`), deadline-aware phase progression,
and explicit advisory markers (e.g. Threadline IQS `advisory only, never
overrides local` in `src/threadline/TrustEvaluator.ts`).

**What Instar lacks:** a **centralized standing audit** that catalogs *all*
advisory-only surfaces across the codebase, surfaces the open ones at
session-start, and **escalates OVERDUE ones** until each is either promoted to
`enforce` / wired to an automated consumer, or explicitly re-classified as
legitimate observability. The phase pattern is applied *per subsystem, by an
operator who remembers to run `instar gate set …`*. Nothing forces the question
"which of our detectors still only observe, and which of those SHOULD enforce?"
across the whole tree. A new advisory-only reviewer added next month has no
forcing function pulling it toward enforcement — it just accumulates.

This is the exact gap Dawn closed with `advisory-audit.py`: not itself
advisory-only — it keeps a durable registry of advisory GAPS with per-gap
deadlines, nags at every session start, and escalates OVERDUE loudly (mirrors the
proven `prop-fast-track.py` forcing-function). Instar deserves the same
meta-immune layer so every agent built on it inherits the discipline.

**Why it matters for every agent:** Instar's whole premise is that agents absorb
Dawn's hard-won strengths. "Almost nothing advisory-only" is one of the most
load-bearing: without a centralized forcing function, each agent silently drifts
back to human-as-actuator, one un-promoted detector at a time.

---

## Proposed patch

New module `src/core/AdvisoryAudit.ts`, a CLI subcommand `instar advisory`, a
session-start injection line, and a vitest suite. State lives at
`.instar/state/advisory-gaps.json` (matches the existing `.instar/state/**` JSON
convention). This is a faithful TS port of `advisory-audit.py`'s registry +
forcing-function core (the `scan`/heuristic-sweep half is deferred to a follow-up
— the registry + session-start nag + OVERDUE escalation is the load-bearing 80%).

```diff
--- /dev/null
+++ b/src/core/AdvisoryAudit.ts
@@
+/**
+ * AdvisoryAudit — the standing enforcer of "almost nothing advisory-only".
+ *
+ * Ported from Dawn's advisory-audit.py (PROP-866, 2026-07-20). Instar has
+ * excellent per-subsystem phase modes (off|shadow|enforce) but no centralized
+ * registry that surfaces ALL advisory-only surfaces and escalates OVERDUE ones.
+ * A detector/gate/cap that only observes makes the human the actuator; this
+ * registry keeps each such GAP on a deadline and nags at session-start until it
+ * is ENFORCED, wired to an automated consumer, or marked legitimate observability.
+ *
+ * NOT itself advisory-only: it has deadlines, session-start surfacing, and an
+ * OVERDUE exit code (3) for forcing-function callers / cron escalation.
+ *
+ * State:   .instar/state/advisory-gaps.json  (atomic read-modify-write)
+ */
+import { promises as fs } from 'fs';
+import * as path from 'path';
+
+export type AdvisoryKind =
+  | 'shadow-without-forcing'
+  | 'advisory-cap'
+  | 'recommendation-without-actuation'
+  | 'detection-without-feedback';
+
+export type GapStatus = 'open' | 'triage' | 'resolved' | 'legit';
+
+export interface AdvisoryGap {
+  id: string;
+  what: string;
+  where: string;            // file:line
+  kind: AdvisoryKind;
+  whyGap: string;
+  severity: number;         // 1..10
+  blocking: string;         // what is actively degraded while this stays advisory
+  markedAt: string;         // ISO
+  deadline: string;         // ISO
+  deadlineHours: number;
+  status: GapStatus;
+  owner: string;
+  note?: string;
+  resolvedAt?: string;
+  legitAt?: string;
+}
+
+interface RegistryFile { gaps: AdvisoryGap[]; }
+
+const DEFAULT_DEADLINE_HOURS = 72;
+const VALID_KINDS: ReadonlySet<AdvisoryKind> = new Set([
+  'shadow-without-forcing',
+  'advisory-cap',
+  'recommendation-without-actuation',
+  'detection-without-feedback',
+]);
+
+export class AdvisoryAudit {
+  constructor(private readonly statePath: string) {}
+
+  static defaultStatePath(instarDir: string): string {
+    return path.join(instarDir, 'state', 'advisory-gaps.json');
+  }
+
+  private async load(): Promise<RegistryFile> {
+    try {
+      const raw = await fs.readFile(this.statePath, 'utf8');
+      const parsed = JSON.parse(raw) as RegistryFile;
+      if (!Array.isArray(parsed.gaps)) return { gaps: [] };
+      return parsed;
+    } catch (e: unknown) {
+      if ((e as NodeJS.ErrnoException).code === 'ENOENT') return { gaps: [] };
+      throw e;
+    }
+  }
+
+  /** Atomic write: temp file + rename, so a crash never truncates the registry. */
+  private async save(d: RegistryFile): Promise<void> {
+    await fs.mkdir(path.dirname(this.statePath), { recursive: true });
+    const tmp = `${this.statePath}.tmp-${process.pid}`;
+    await fs.writeFile(tmp, JSON.stringify(d, null, 2), 'utf8');
+    await fs.rename(tmp, this.statePath);
+  }
+
+  private now(): Date { return new Date(); }
+
+  private isOverdue(g: AdvisoryGap): boolean {
+    if (g.status !== 'open' && g.status !== 'triage') return false;
+    return new Date(g.deadline).getTime() < this.now().getTime();
+  }
+
+  private openGaps(d: RegistryFile): AdvisoryGap[] {
+    return d.gaps.filter((g) => g.status === 'open' || g.status === 'triage');
+  }
+
+  async mark(input: {
+    id: string; what: string; where: string; kind: AdvisoryKind;
+    severity?: number; deadlineHours?: number; blocking?: string;
+    whyGap?: string; owner?: string;
+  }): Promise<AdvisoryGap> {
+    if (!VALID_KINDS.has(input.kind)) {
+      throw new Error(`invalid kind '${input.kind}'; expected one of ${[...VALID_KINDS].join(', ')}`);
+    }
+    const d = await this.load();
+    if (d.gaps.some((g) => g.id === input.id && (g.status === 'open' || g.status === 'triage'))) {
+      throw new Error(`gap '${input.id}' already open`);
+    }
+    const hours = input.deadlineHours ?? DEFAULT_DEADLINE_HOURS;
+    const marked = this.now();
+    const gap: AdvisoryGap = {
+      id: input.id, what: input.what, where: input.where, kind: input.kind,
+      whyGap: input.whyGap ?? '', severity: input.severity ?? 5,
+      blocking: input.blocking ?? '',
+      markedAt: marked.toISOString(),
+      deadline: new Date(marked.getTime() + hours * 3600_000).toISOString(),
+      deadlineHours: hours, status: 'open', owner: input.owner ?? 'instar',
+    };
+    d.gaps.push(gap);
+    await this.save(d);
+    return gap;
+  }
+
+  async resolve(id: string, note: string): Promise<void> {
+    const d = await this.load();
+    const g = d.gaps.find((x) => x.id === id);
+    if (!g) throw new Error(`no gap '${id}'`);
+    g.status = 'resolved';
+    g.resolvedAt = this.now().toISOString();
+    g.note = note;
+    await this.save(d);
+  }
+
+  async legit(id: string, note: string): Promise<void> {
+    const d = await this.load();
+    const g = d.gaps.find((x) => x.id === id);
+    if (!g) throw new Error(`no gap '${id}'`);
+    g.status = 'legit';
+    g.legitAt = this.now().toISOString();
+    g.note = note;
+    await this.save(d);
+  }
+
+  async list(overdueOnly = false): Promise<AdvisoryGap[]> {
+    const gaps = this.openGaps(await this.load());
+    return overdueOnly ? gaps.filter((g) => this.isOverdue(g)) : gaps;
+  }
+
+  /**
+   * Terse forcing block for the session-start surface. Returns the injected
+   * string (empty when no open gaps) plus whether any are overdue, so the caller
+   * can set a non-zero exit for cron escalation without this method throwing.
+   */
+  async sessionStart(): Promise<{ text: string; overdue: number }> {
+    const gaps = this.openGaps(await this.load());
+    if (gaps.length === 0) return { text: '', overdue: 0 };
+    const overdue = gaps.filter((g) => this.isOverdue(g));
+    const nOpen = gaps.filter((g) => g.status === 'open').length;
+    const nTriage = gaps.filter((g) => g.status === 'triage').length;
+    const ranked = [...gaps].sort((a, b) => {
+      const ao = this.isOverdue(a) ? 0 : 1, bo = this.isOverdue(b) ? 0 : 1;
+      if (ao !== bo) return ao - bo;
+      const as = a.status === 'open' ? 0 : 1, bs = b.status === 'open' ? 0 : 1;
+      if (as !== bs) return as - bs;
+      return (b.severity ?? 0) - (a.severity ?? 0);
+    });
+    const lines = [
+      `ADVISORY-ONLY GAPS — ${nOpen} confirmed + ${nTriage} to triage ` +
+        `(infra that observes but doesn't enforce; close the loop):`,
+    ];
+    for (const g of ranked.slice(0, 6)) {
+      const tag = this.isOverdue(g) ? 'OVERDUE' : g.status;
+      lines.push(`  [${tag}] ${g.id}: ${(g.what ?? '').slice(0, 100)}`);
+    }
+    if (gaps.length > 6) lines.push(`  ... +${gaps.length - 6} more (instar advisory list)`);
+    if (overdue.length > 0) {
+      lines.push(
+        `  -> ${overdue.length} past deadline. Each is a place the agent depends on a human ` +
+          `to actuate. Enforce one (close the loop) or mark it legit — don't let it rot.`,
+      );
+    }
+    return { text: lines.join('\n'), overdue: overdue.length };
+  }
+}
```

```diff
--- a/src/commands/index.ts        (or wherever the CLI command registry lives)
+++ b/src/commands/index.ts
@@
+import { registerAdvisoryCommand } from './advisory';
@@ registerCommands(program) {
+  registerAdvisoryCommand(program);
```

```diff
--- /dev/null
+++ b/src/commands/advisory.ts
@@
+import type { Command } from 'commander';
+import { AdvisoryAudit } from '../core/AdvisoryAudit';
+import { resolveInstarDir } from '../core/paths'; // existing helper that yields the .instar dir
+
+export function registerAdvisoryCommand(program: Command): void {
+  const cmd = program.command('advisory').description('advisory-only gap registry (enforcement-over-advisory)');
+  const audit = () => new AdvisoryAudit(AdvisoryAudit.defaultStatePath(resolveInstarDir()));
+
+  cmd.command('list').option('--overdue', 'only overdue').action(async (o) => {
+    for (const g of await audit().list(!!o.overdue)) {
+      console.log(`[${g.status}] ${g.id} (sev ${g.severity}): ${g.what}`);
+    }
+  });
+
+  cmd.command('mark <id>')
+    .requiredOption('--what <s>').requiredOption('--where <file:line>')
+    .requiredOption('--kind <k>')
+    .option('--severity <n>', '', (v) => parseInt(v, 10))
+    .option('--deadline-hours <h>', '', (v) => parseInt(v, 10))
+    .option('--blocking <s>')
+    .action(async (id, o) => {
+      const g = await audit().mark({ id, what: o.what, where: o.where, kind: o.kind,
+        severity: o.severity, deadlineHours: o.deadlineHours, blocking: o.blocking });
+      console.log(`marked ${g.id}; deadline ${g.deadline}`);
+    });
+
+  cmd.command('resolve <id>').requiredOption('--note <s>')
+    .action(async (id, o) => { await audit().resolve(id, o.note); console.log(`resolved ${id}`); });
+
+  cmd.command('legit <id>').requiredOption('--note <s>')
+    .action(async (id, o) => { await audit().legit(id, o.note); console.log(`marked legit ${id}`); });
+
+  cmd.command('session-start').action(async () => {
+    const { text, overdue } = await audit().sessionStart();
+    if (text) console.log(text);
+    process.exitCode = overdue > 0 ? 3 : 0;
+  });
+}
```

Session-start injection — the `PostUpdateMigrator`-generated
`.claude/hooks/instar/session-start.sh` already injects commitment "stranded"
notes and integrated-being observations. Add one block alongside them:

```diff
--- a/src/core/PostUpdateMigrator.ts   (session-start.sh template region)
+++ b/src/core/PostUpdateMigrator.ts
@@ (near the commitment-stranded-notes injection)
+  # --- advisory-only gap forcing function (PROP-866) ---
+  ADVISORY_BLOCK="$(instar advisory session-start 2>/dev/null || true)"
+  if [ -n "$ADVISORY_BLOCK" ]; then
+    printf '%s\n' "$ADVISORY_BLOCK"
+  fi
```

```diff
--- /dev/null
+++ b/tests/unit/advisory-audit.test.ts
@@
+import { describe, it, expect, beforeEach } from 'vitest';
+import { promises as fs } from 'fs';
+import * as os from 'os';
+import * as path from 'path';
+import { AdvisoryAudit } from '../../src/core/AdvisoryAudit';
+
+describe('AdvisoryAudit', () => {
+  let statePath: string;
+  let audit: AdvisoryAudit;
+
+  beforeEach(async () => {
+    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'advisory-'));
+    statePath = path.join(dir, 'advisory-gaps.json');
+    audit = new AdvisoryAudit(statePath);
+  });
+
+  it('marks a gap and lists it as open', async () => {
+    await audit.mark({ id: 'x-cadence', what: 'reply cap only nudges', where: 'src/x/Cadence.ts:42', kind: 'advisory-cap', severity: 6 });
+    const open = await audit.list();
+    expect(open).toHaveLength(1);
+    expect(open[0].id).toBe('x-cadence');
+    expect(open[0].status).toBe('open');
+  });
+
+  it('rejects an invalid kind', async () => {
+    await expect(audit.mark({ id: 'bad', what: 'w', where: 'a:1', kind: 'nope' as any })).rejects.toThrow(/invalid kind/);
+  });
+
+  it('rejects a duplicate open id', async () => {
+    await audit.mark({ id: 'dup', what: 'w', where: 'a:1', kind: 'advisory-cap' });
+    await expect(audit.mark({ id: 'dup', what: 'w', where: 'a:1', kind: 'advisory-cap' })).rejects.toThrow(/already open/);
+  });
+
+  it('resolve removes it from the open set', async () => {
+    await audit.mark({ id: 'g', what: 'w', where: 'a:1', kind: 'detection-without-feedback' });
+    await audit.resolve('g', 'enforced in <commit>: now blocks');
+    expect(await audit.list()).toHaveLength(0);
+  });
+
+  it('legit removes it from the open set', async () => {
+    await audit.mark({ id: 'g', what: 'w', where: 'a:1', kind: 'shadow-without-forcing' });
+    await audit.legit('g', 'pure telemetry; downstream layer acts');
+    expect(await audit.list()).toHaveLength(0);
+  });
+
+  it('session-start reports OVERDUE and signals exit-3 intent', async () => {
+    await audit.mark({ id: 'late', what: 'shadow gate never flipped', where: 'a:1', kind: 'shadow-without-forcing', deadlineHours: -1 });
+    const { text, overdue } = await audit.sessionStart();
+    expect(overdue).toBe(1);
+    expect(text).toContain('OVERDUE');
+    expect(text).toContain('past deadline');
+  });
+
+  it('session-start is empty when there are no open gaps', async () => {
+    const { text, overdue } = await audit.sessionStart();
+    expect(text).toBe('');
+    expect(overdue).toBe(0);
+  });
+});
```

---

## Test evidence

**Not run in this session** — this PROP is authored by Dawn's
`instar-feature-parity` job, which runs *outside* Instar's `/instar-dev` flow and
cannot produce the pre-commit gate's required trace/side-effects artifact. The
diff is written against Instar's verified conventions (vitest; `.instar/state/**`
JSON; `src/core/` module + `src/commands/` CLI; `PostUpdateMigrator`-generated
`session-start.sh`). The vitest suite above is designed to pass as written; the
`deadlineHours: -1` trick forces an immediately-overdue gap deterministically
(no `Date.now()` mocking needed). `/instar-dev` should run `pnpm vitest
tests/unit/advisory-audit.test.ts` and `tsc --noEmit` on adoption.

## Typecheck status

Not run (see above). The code is written to be strict-mode clean: explicit return
types, `NodeJS.ErrnoException` narrowing on the ENOENT read, no `any` except the
deliberate invalid-kind test cast. `resolveInstarDir` / the CLI registry import
path are the two spots `/instar-dev` must reconcile with Instar's actual helper
names.

## Files touched

- `src/core/AdvisoryAudit.ts` — new: registry core (load/save atomic, mark/resolve/legit/list/sessionStart).
- `src/commands/advisory.ts` — new: `instar advisory {list,mark,resolve,legit,session-start}` CLI.
- `src/commands/index.ts` — 2 lines: register the advisory command.
- `src/core/PostUpdateMigrator.ts` — session-start.sh template: inject the forcing block.
- `tests/unit/advisory-audit.test.ts` — new: 7 vitest cases covering mark/dup/kind/resolve/legit/overdue/empty.

## Adoption steps for /instar-dev

1. Open a spec scaffold for "advisory-only gap registry" and run `/spec-converge`.
2. Reconcile two integration points against Instar's actual code:
   - the CLI command-registry entrypoint (I guessed `src/commands/index.ts`);
   - the `.instar` dir resolver (I referenced `resolveInstarDir` from `src/core/paths`).
3. Apply the diff; run `pnpm vitest tests/unit/advisory-audit.test.ts` and `tsc --noEmit`.
4. Seed the registry by marking Instar's *known* advisory surfaces so the forcing
   function has teeth from day one — e.g. Threadline IQS (`advisory only` in
   `src/threadline/TrustEvaluator.ts`) if it should ever gate, and any reviewer in
   `src/core/reviewers/` whose output nothing consumes.
5. Run `/instar-dev` to produce the trace + side-effects artifact, commit through
   the normal gate.

## Why this respects the boundary

Instar governs its own `src/` through `/instar-dev` + `/spec-converge`. This PROP
carries the full patch, tests, and adoption steps but lands nothing — the gate and
the landing decision stay with Instar. Dawn contributes the infrastructure wisdom
(the pattern, the forcing-function shape, the OVERDUE-escalation discipline);
Instar decides how it fits its own tree.
