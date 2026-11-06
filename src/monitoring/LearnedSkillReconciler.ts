/**
 * LearnedSkillReconciler — every-machine reconcile of LEARNED skill renderings.
 *
 * Spec: docs/specs/skill-learning-sentinel.md §3.2 (the "Renderings" row of
 * the multi-machine posture table), decisions 19 and 28; concept spec
 * specs/instar-concepts/skill.md (parity contract, `x-instar-stamp`,
 * `user-edit-conflict`).
 *
 * Renderings (`.claude/skills/`, `.agents/skills/`) live outside `stateDir`
 * and never git-sync, so a canonical skill pulled from another machine has to
 * be re-rendered HERE. This reconciler does that for the skills the sentinel
 * owns — canonicals whose frontmatter carries `metadata.instar-learned-origin`
 * — and for nothing else: a hand-written canonical is never touched.
 *
 * Behaviour (verify-then-render):
 *   - `verifyRendering` first; render only when it reports issues. A
 *     steady-state tick performs zero writes.
 *   - Before ANY render the local rendering's content hash is compared with the
 *     per-machine BASELINE shard (`.instar/skill-learning/rendered-baselines/
 *     <machineId>.json`, the hash of what THIS machine last rendered). A
 *     difference is an operator edit on this machine → `user-edit-conflict`:
 *     recorded in the shard, locked, never overwritten. The stamp alone cannot
 *     tell this case from a remote canonical update (a stale stamp reads as
 *     overwritable), which is why the baseline exists.
 *   - No baseline for a rendering whose body does not match canonical ⇒
 *     unknown provenance ⇒ treated as a conflict (cache-loss / first-boot case).
 *   - Each rendering/baseline transition is journaled to this machine's own
 *     journal (`render-prepare` → render → baseline → `render-commit`) and a
 *     dangling prepare is recovered at startup BEFORE edit detection, so a
 *     crash between the render and the baseline write never reads as an edit.
 *   - A render that throws is caught and counted; the (skill × target) is
 *     locked in the shard under `failed` keyed by the canonical hash, so it is
 *     retried only when the canonical changes — never every tick.
 *   - Inert (no-op, no error) when `.instar/skills/` does not exist.
 *   - Runs regardless of `monitoring.skillLearning.enabled` (it repairs the
 *     concept spec's own deferred design); `monitoring.skillLearning.reconcile
 *     .enabled === false` is the live kill switch.
 *
 * It never calls `removeOrphans()`.
 *
 * Self-action posture: the tick is a self-triggered controller. Its convergence
 * argument is registered as `learned-skill-reconciler` in
 * src/testing/selfActionRegistry.ts: one render per learned skill per canonical
 * change, then zero (verify-then-render), with the conflict lock and the
 * canonical-hash-keyed failure lock as the settling brakes.
 */
/* @self-action-controller: learned-skill-reconciler */

import { SafeFsExecutor } from '../core/SafeFsExecutor.js';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import yaml from 'js-yaml';
import type { IntelligenceFramework } from '../core/intelligenceProviderFactory.js';
import { skillParityRule } from '../providers/parity/rules/skillParityRule.js';
import type { ParityMismatch } from '../providers/parity/types.js';

export type ReconcileReason = 'boot' | 'pull' | 'tick';

/** The two on-disk rendering layouts. Every non-Claude framework shares `.agents/skills`. */
type RenderTarget = 'claude-code' | 'codex-cli';

export interface LearnedSkillReconcilerDeps {
  /** The agent home (holds `.instar/`, `.claude/`, `.agents/`). */
  projectDir: string;
  /** The `.instar` directory. */
  stateDir: string;
  /** This machine's id (`.instar/machine/identity.json`); names the per-machine shards. */
  machineId: string;
  /** Read live — which frameworks are enabled on this agent. */
  enabledFrameworks: () => ReadonlyArray<IntelligenceFramework> | undefined;
  /** Read live — the `monitoring.skillLearning.reconcile.enabled` kill switch. */
  reconcileEnabled?: () => boolean;
  /** Tick cadence (`monitoring.skillLearning.tickMinutes`), default 10. */
  tickMinutes?: number;
  logger?: (message: string) => void;
  now?: () => number;
}

interface BaselineEntry {
  /** sha256 of the rendered SKILL.md as this machine last wrote it. */
  contentHash: string;
  /** The canonical body hash (the stamp) that rendering carried. */
  bodyHash: string;
  at: string;
}

interface ConflictEntry {
  skill: string;
  target: RenderTarget;
  reason: 'user-edit-conflict' | 'unknown-provenance';
  /** Content hash of the rendering when the conflict was recorded. */
  contentHash: string;
  detail: string;
  at: string;
}

interface FailedEntry {
  skill: string;
  target: RenderTarget;
  /** The canonical body hash whose render failed; a different hash re-arms the render. */
  bodyHash: string;
  error: string;
  at: string;
}

interface BaselineShard {
  version: 1;
  machineId: string;
  baselines: Record<string, BaselineEntry>;
  conflicts: Record<string, ConflictEntry>;
  failed: Record<string, FailedEntry>;
}

interface JournalRow {
  ts: string;
  machineId: string;
  op: 'render-prepare' | 'render-commit' | 'render-void' | 'render-failed' | 'baseline';
  txId: string;
  skill: string;
  target: RenderTarget;
  renderingPath: string;
  bodyHash: string;
  prevContentHash?: string | null;
  contentHash?: string;
  detail?: string;
}

export interface ReconcileRunSummary {
  reason: ReconcileReason;
  at: string;
  durationMs: number;
  /** Learned skills examined. */
  learned: number;
  rendered: number;
  skipped: number;
  conflicts: number;
  failed: number;
  /** Per-skill exceptions outside the render step (parse errors, unreadable canonicals). */
  errors: number;
  /** Why nothing happened, when nothing happened. */
  inert?: 'disabled' | 'no-canonical-dir' | 'already-running';
}

export interface LearnedSkillReconcilerStatus {
  machineId: string;
  running: boolean;
  tickMinutes: number;
  lastRun: ReconcileRunSummary | null;
  runs: number;
  /** Totals across runs since construction. */
  rendered: number;
  skipped: number;
  conflicts: number;
  failed: number;
  errors: number;
  /** The currently locked renderings (from the shard). */
  lockedConflicts: Array<{ renderingPath: string; skill: string; target: RenderTarget; reason: string; at: string }>;
  lockedFailures: Array<{ renderingPath: string; skill: string; target: RenderTarget; error: string; at: string }>;
}

const CANONICAL_ROOT = '.instar/skills';
const SLUG_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;
const LEARNED_ORIGIN_KEY = 'instar-learned-origin';
const STAMP_LINE_RE = /^x-instar-stamp:\s*([a-f0-9]{64})\s*$/m;
const DEFAULT_TICK_MINUTES = 10;

function sha256(s: string | Buffer): string {
  return crypto.createHash('sha256').update(s).digest('hex');
}

/**
 * Same frontmatter split the parity rule uses, so the body hash computed here
 * equals the rule's `bodyHash` (the stamp it writes).
 */
function splitFrontmatter(raw: string): { fm: Record<string, unknown>; body: string } | null {
  const match = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (!match) return null;
  let fm: unknown;
  try {
    fm = yaml.load(match[1], { schema: yaml.FAILSAFE_SCHEMA, json: false });
  } catch { // @silent-fallback-ok — a learned-origin probe reads frontmatter best-effort; an unreadable or unparseable canonical is simply not learned (safe: nothing renders)
    return null;
  }
  if (fm === null || typeof fm !== 'object' || Array.isArray(fm)) return null;
  return { fm: fm as Record<string, unknown>, body: match[2] };
}

/** Is this canonical SKILL.md owned by the skill-learning sentinel? */
export function isLearnedCanonical(raw: string): boolean {
  const parsed = splitFrontmatter(raw);
  if (!parsed) return false;
  const md = parsed.fm.metadata;
  if (!md || typeof md !== 'object' || Array.isArray(md)) return false;
  const origin = (md as Record<string, unknown>)[LEARNED_ORIGIN_KEY];
  return typeof origin === 'string' && origin.trim().length > 0;
}

function renderTargetFor(framework: IntelligenceFramework): RenderTarget {
  return framework === 'claude-code' ? 'claude-code' : 'codex-cli';
}

/** Rendering layout per target — mirrors the parity rule's renderers. */
function renderingSkillMdRel(target: RenderTarget, name: string): string {
  return target === 'claude-code'
    ? path.posix.join('.claude/skills', name, 'SKILL.md')
    : path.posix.join('.agents/skills', name, 'SKILL.md');
}

function writeJsonAtomic(file: string, value: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.tmp-${process.pid}-${crypto.randomBytes(4).toString('hex')}`;
  try {
    fs.writeFileSync(tmp, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 });
    fs.renameSync(tmp, file);
  } catch (err) {
    try { SafeFsExecutor.safeRmSync(tmp, { force: true, operation: 'learned-skill-reconciler:temp-cleanup' }); } catch { /* @silent-fallback-ok — best-effort temp cleanup after a failed write */ }
    throw err;
  }
}

function emptyShard(machineId: string): BaselineShard {
  return { version: 1, machineId, baselines: {}, conflicts: {}, failed: {} };
}

export class LearnedSkillReconciler {
  private readonly projectDir: string;
  private readonly stateDir: string;
  private readonly machineId: string;
  private readonly deps: LearnedSkillReconcilerDeps;
  private readonly log: (m: string) => void;
  private readonly now: () => number;
  private readonly tickMinutes: number;

  private shard: BaselineShard;
  private recovered = false;
  private running = false;
  private timer: ReturnType<typeof setInterval> | null = null;

  private lastRun: ReconcileRunSummary | null = null;
  private runs = 0;
  private totals = { rendered: 0, skipped: 0, conflicts: 0, failed: 0, errors: 0 };

  constructor(deps: LearnedSkillReconcilerDeps) {
    this.deps = deps;
    this.projectDir = deps.projectDir;
    this.stateDir = deps.stateDir;
    this.machineId = /^[\w.-]{1,96}$/.test(deps.machineId) ? deps.machineId : 'unknown';
    this.log = deps.logger ?? (() => {});
    this.now = deps.now ?? (() => Date.now());
    const tm = deps.tickMinutes;
    this.tickMinutes = typeof tm === 'number' && Number.isFinite(tm) && tm > 0 ? tm : DEFAULT_TICK_MINUTES;
    this.shard = emptyShard(this.machineId);
  }

  // ─── Paths ───────────────────────────────────────────────────────────

  get shardPath(): string {
    return path.join(this.stateDir, 'skill-learning', 'rendered-baselines', `${this.machineId}.json`);
  }

  get journalPath(): string {
    return path.join(this.stateDir, 'skill-learning', 'journal', `${this.machineId}.jsonl`);
  }

  private get canonicalDir(): string {
    return path.join(this.projectDir, CANONICAL_ROOT);
  }

  // ─── Lifecycle ───────────────────────────────────────────────────────

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      void this.reconcileAll('tick');
    }, this.tickMinutes * 60_000);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  status(): LearnedSkillReconcilerStatus {
    return {
      machineId: this.machineId,
      running: this.running,
      tickMinutes: this.tickMinutes,
      lastRun: this.lastRun,
      runs: this.runs,
      ...this.totals,
      lockedConflicts: Object.entries(this.shard.conflicts).map(([renderingPath, c]) => ({
        renderingPath, skill: c.skill, target: c.target, reason: c.reason, at: c.at,
      })),
      lockedFailures: Object.entries(this.shard.failed).map(([renderingPath, f]) => ({
        renderingPath, skill: f.skill, target: f.target, error: f.error, at: f.at,
      })),
    };
  }

  // ─── Shard (baseline) ────────────────────────────────────────────────

  /** Synchronous; a corrupt or unparseable shard is treated as missing. */
  private loadShard(): void {
    let parsed: unknown = null;
    try {
      parsed = JSON.parse(fs.readFileSync(this.shardPath, 'utf-8'));
    } catch { // @silent-fallback-ok — a corrupt baseline shard is treated as missing; every rendering then reads as unknown-provenance and LOCKS rather than overwrites (safe direction)
      parsed = null;
    }
    const fresh = emptyShard(this.machineId);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      const p = parsed as Partial<BaselineShard>;
      if (p.baselines && typeof p.baselines === 'object') fresh.baselines = { ...p.baselines };
      if (p.conflicts && typeof p.conflicts === 'object') fresh.conflicts = { ...p.conflicts };
      if (p.failed && typeof p.failed === 'object') fresh.failed = { ...p.failed };
    }
    this.shard = fresh;
  }

  private saveShard(): void {
    writeJsonAtomic(this.shardPath, this.shard);
  }

  // ─── Journal ─────────────────────────────────────────────────────────

  private journal(row: Omit<JournalRow, 'ts' | 'machineId'>): void {
    const full: JournalRow = { ts: new Date(this.now()).toISOString(), machineId: this.machineId, ...row };
    fs.mkdirSync(path.dirname(this.journalPath), { recursive: true, mode: 0o700 });
    fs.appendFileSync(this.journalPath, JSON.stringify(full) + '\n', { mode: 0o600 });
  }

  private readJournal(): JournalRow[] {
    let raw: string;
    try {
      raw = fs.readFileSync(this.journalPath, 'utf-8');
    } catch { // @silent-fallback-ok — journal rows are best-effort audit; a failed append is logged by the caller and never blocks the render
      return [];
    }
    const rows: JournalRow[] = [];
    for (const line of raw.split('\n')) {
      if (!line.trim()) continue;
      try {
        const r = JSON.parse(line) as JournalRow;
        if (r && typeof r === 'object' && typeof r.op === 'string' && typeof r.txId === 'string') rows.push(r);
      } catch {
        /* a torn tail line is not a transition */
      }
    }
    return rows;
  }

  /**
   * Recover dangling `render-prepare` rows from THIS machine's journal only.
   * The rendering carries the stamp our render wrote, or it does not:
   *   - stamp === prepare.bodyHash → the render landed; adopt its content hash
   *     as the baseline and commit (the crash was between render and baseline).
   *   - otherwise → the render never landed; void the prepare. The rendering
   *     is whatever it was before, and edit detection judges it normally.
   */
  private recoverJournal(): void {
    if (this.recovered) return;
    this.recovered = true;
    const rows = this.readJournal();
    if (rows.length === 0) return;
    const closed = new Set<string>();
    for (const r of rows) if (r.op !== 'render-prepare' && r.op !== 'baseline') closed.add(r.txId);
    const dangling = rows.filter((r) => r.op === 'render-prepare' && !closed.has(r.txId) && r.machineId === this.machineId);
    if (dangling.length === 0) return;
    let shardDirty = false;
    for (const p of dangling) {
      const abs = path.join(this.projectDir, p.renderingPath);
      let content: string | null = null;
      try { content = fs.readFileSync(abs, 'utf-8'); } catch { content = null; } // @silent-fallback-ok — an absent rendering is the normal first-render case; null means "not present"
      const stamp = content ? (content.match(STAMP_LINE_RE)?.[1] ?? null) : null;
      if (content !== null && stamp === p.bodyHash) {
        const contentHash = sha256(content);
        this.shard.baselines[p.renderingPath] = { contentHash, bodyHash: p.bodyHash, at: new Date(this.now()).toISOString() };
        delete this.shard.conflicts[p.renderingPath];
        shardDirty = true;
        this.journal({ op: 'render-commit', txId: p.txId, skill: p.skill, target: p.target, renderingPath: p.renderingPath, bodyHash: p.bodyHash, contentHash, detail: 'recovered: render had landed before the baseline was written' });
        this.log(`[LearnedSkillReconciler] recovered dangling render of ${p.skill} (${p.target}) — baseline adopted`);
      } else {
        this.journal({ op: 'render-void', txId: p.txId, skill: p.skill, target: p.target, renderingPath: p.renderingPath, bodyHash: p.bodyHash, detail: 'recovered: render never landed' });
      }
    }
    if (shardDirty) {
      try { this.saveShard(); } catch (err) { this.log(`[LearnedSkillReconciler] baseline shard write failed during recovery: ${(err as Error).message}`); } // @silent-fallback-ok — the shard save failure is logged on the line itself; the in-memory shard stays authoritative for this run
    }
  }

  // ─── Reconcile ───────────────────────────────────────────────────────

  private listLearnedCanonicals(): string[] {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(this.canonicalDir, { withFileTypes: true });
    } catch { // @silent-fallback-ok — an unreadable journal yields no recovery work; nothing is rendered on a guess (safe direction)
      return [];
    }
    const out: string[] = [];
    for (const e of entries) {
      if (!e.isDirectory() || !SLUG_RE.test(e.name)) continue;
      let raw: string;
      try {
        raw = fs.readFileSync(path.join(this.canonicalDir, e.name, 'SKILL.md'), 'utf-8');
      } catch {
        continue;
      }
      if (isLearnedCanonical(raw)) out.push(e.name);
    }
    return out.sort();
  }

  private targets(): RenderTarget[] {
    const fws = this.deps.enabledFrameworks() ?? ['claude-code'];
    const set = new Set<RenderTarget>();
    for (const fw of fws) set.add(renderTargetFor(fw));
    if (set.size === 0) set.add('claude-code');
    return [...set];
  }

  async reconcileAll(reason: ReconcileReason): Promise<ReconcileRunSummary> {
    const startedAt = this.now();
    const summary: ReconcileRunSummary = {
      reason, at: new Date(startedAt).toISOString(), durationMs: 0,
      learned: 0, rendered: 0, skipped: 0, conflicts: 0, failed: 0, errors: 0,
    };
    const finish = (inert?: ReconcileRunSummary['inert']): ReconcileRunSummary => {
      summary.durationMs = this.now() - startedAt;
      if (inert) summary.inert = inert;
      if (inert !== 'already-running') {
        this.lastRun = summary;
        this.runs += 1;
        this.totals.rendered += summary.rendered;
        this.totals.skipped += summary.skipped;
        this.totals.conflicts += summary.conflicts;
        this.totals.failed += summary.failed;
        this.totals.errors += summary.errors;
      }
      return summary;
    };

    if (this.running) return finish('already-running');
    if (this.deps.reconcileEnabled && this.deps.reconcileEnabled() === false) return finish('disabled');
    if (!fs.existsSync(this.canonicalDir)) return finish('no-canonical-dir');

    this.running = true;
    try {
      // The baseline is loaded synchronously before any reconcile, and a
      // dangling prepare is recovered before any edit detection.
      this.loadShard();
      this.recoverJournal();

      const learned = this.listLearnedCanonicals();
      summary.learned = learned.length;
      if (learned.length === 0) return finish();
      const targets = this.targets();
      let shardDirty = false;

      for (const name of learned) {
        for (const target of targets) {
          try {
            const outcome = await this.reconcileOne(name, target);
            if (outcome.shardDirty) shardDirty = true;
            summary[outcome.kind] += 1;
          } catch (err) {
            summary.errors += 1;
            this.log(`[LearnedSkillReconciler] ${name} (${target}): ${(err as Error).message}`);
          }
        }
      }
      if (shardDirty) {
        try { this.saveShard(); } catch (err) {
          summary.errors += 1;
          this.log(`[LearnedSkillReconciler] baseline shard write failed: ${(err as Error).message}`);
        }
      }
      if (summary.rendered > 0 || summary.conflicts > 0 || summary.failed > 0) {
        this.log(`[LearnedSkillReconciler] ${reason}: ${summary.rendered} rendered, ${summary.skipped} in sync, ${summary.conflicts} conflict(s), ${summary.failed} failed`);
      }
      return finish();
    } finally {
      this.running = false;
    }
  }

  private async reconcileOne(
    name: string,
    target: RenderTarget,
  ): Promise<{ kind: 'rendered' | 'skipped' | 'conflicts' | 'failed'; shardDirty: boolean }> {
    const rel = renderingSkillMdRel(target, name);
    const abs = path.join(this.projectDir, rel);
    const nowIso = new Date(this.now()).toISOString();

    const canonicalRaw = fs.readFileSync(path.join(this.canonicalDir, name, 'SKILL.md'), 'utf-8');
    const parsed = splitFrontmatter(canonicalRaw);
    if (!parsed) throw new Error('canonical SKILL.md has no parseable frontmatter');
    const bodyHash = sha256(parsed.body);

    // verify-then-render: the rule's verify covers both layouts; keep this target's issues.
    const verify = await skillParityRule.verify(this.projectDir, name);
    const issues: ParityMismatch[] = verify.mismatches.filter((m) => m.framework === target);
    const canonicalIssue = verify.mismatches.find((m) => m.framework === 'canonical');
    if (canonicalIssue) throw new Error(canonicalIssue.detail);

    let content: string | null = null;
    try { content = fs.readFileSync(abs, 'utf-8'); } catch { content = null; } // @silent-fallback-ok — an absent rendering is the normal case for a new machine; null means "not present"
    const contentHash = content === null ? null : sha256(content);
    const baseline = this.shard.baselines[rel];
    let shardDirty = false;

    if (issues.length === 0) {
      // In sync. Nothing to render; keep the baseline current and clear any
      // lock — the rendering now says exactly what canonical says.
      if (contentHash && (!baseline || baseline.contentHash !== contentHash || baseline.bodyHash !== bodyHash)) {
        this.shard.baselines[rel] = { contentHash, bodyHash, at: nowIso };
        shardDirty = true;
      }
      if (this.shard.conflicts[rel]) { delete this.shard.conflicts[rel]; shardDirty = true; }
      if (this.shard.failed[rel]) { delete this.shard.failed[rel]; shardDirty = true; }
      return { kind: 'skipped', shardDirty };
    }

    // ── Edit detection (before any render) ──────────────────────────────
    if (content !== null && contentHash !== null) {
      const existing = this.shard.conflicts[rel];
      if (existing && existing.contentHash === contentHash) {
        return { kind: 'conflicts', shardDirty: false }; // still locked, nothing new to say
      }
      const bodyDiffers = issues.some((i) => i.reasonCode === 'user-edit-conflict' || i.reasonCode === 'body-content-mismatch' || i.reasonCode === 'rendering-parse-error');
      let conflict: ConflictEntry | null = null;
      if (baseline) {
        if (baseline.contentHash !== contentHash) {
          conflict = { skill: name, target, reason: 'user-edit-conflict', contentHash, detail: 'rendering differs from what this machine last rendered — operator edit on this machine', at: nowIso };
        }
      } else if (bodyDiffers) {
        // No baseline and the body does not match canonical: provenance is
        // unknown (stale stamp after a cache loss, or an edit) → conflict.
        conflict = { skill: name, target, reason: 'unknown-provenance', contentHash, detail: 'no baseline for a rendering whose body differs from canonical — never rendered over', at: nowIso };
      }
      if (conflict) {
        this.shard.conflicts[rel] = conflict;
        this.log(`[LearnedSkillReconciler] ${name} (${target}) locked: ${conflict.reason} — ${conflict.detail}`);
        return { kind: 'conflicts', shardDirty: true };
      }
    }

    // ── Failure lock: a failed render is retried only when canonical changes.
    const failed = this.shard.failed[rel];
    if (failed && failed.bodyHash === bodyHash) return { kind: 'failed', shardDirty: false };

    // ── Render (journaled) ─────────────────────────────────────────────
    const txId = crypto.randomBytes(8).toString('hex');
    this.journal({ op: 'render-prepare', txId, skill: name, target, renderingPath: rel, bodyHash, prevContentHash: contentHash });
    try {
      await skillParityRule.remediate(this.projectDir, name, target);
    } catch (err) {
      const message = (err as Error).message;
      this.journal({ op: 'render-failed', txId, skill: name, target, renderingPath: rel, bodyHash, detail: message });
      if (/user-edit-conflict/.test(message)) {
        this.shard.conflicts[rel] = { skill: name, target, reason: 'user-edit-conflict', contentHash: contentHash ?? '', detail: message, at: nowIso };
        return { kind: 'conflicts', shardDirty: true };
      }
      this.shard.failed[rel] = { skill: name, target, bodyHash, error: message, at: nowIso };
      this.log(`[LearnedSkillReconciler] render of ${name} (${target}) failed: ${message}`);
      return { kind: 'failed', shardDirty: true };
    }
    const renderedHash = sha256(fs.readFileSync(abs, 'utf-8'));
    this.shard.baselines[rel] = { contentHash: renderedHash, bodyHash, at: nowIso };
    delete this.shard.conflicts[rel];
    delete this.shard.failed[rel];
    this.journal({ op: 'baseline', txId, skill: name, target, renderingPath: rel, bodyHash, contentHash: renderedHash });
    try {
      this.saveShard();
    } catch (err) {
      // The prepare row stays open: the next startup re-adopts this render
      // from its stamp instead of reading it as an edit.
      this.log(`[LearnedSkillReconciler] baseline shard write failed after render: ${(err as Error).message}`);
      return { kind: 'rendered', shardDirty: true };
    }
    this.journal({ op: 'render-commit', txId, skill: name, target, renderingPath: rel, bodyHash, contentHash: renderedHash });
    return { kind: 'rendered', shardDirty: false };
  }
}
