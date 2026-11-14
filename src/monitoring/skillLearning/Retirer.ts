/**
 * Retirer — retire as its OWN reconciliation, archive first; lock retraction; restore; retire-all
 * (spec docs/specs/skill-learning-sentinel.md §3.8 "Retire, never delete; never merge; lock is not immunity",
 * §3.10 routes; integration map brief 3B, deviations (cc)/(ii)).
 *
 * Two sides, one module:
 *
 * HOLDER side (the lease holder's tick, `judge` → `retire`):
 *   - the evidence FLOOR: a skill is never retired for score with fewer than `retire.minCorroboratedRuns`
 *     corroborated runs on its CURRENT version (below it the skill is "unmeasured"); never on a single
 *     misfire verdict (≥ 2); unused = one observed request of its key with no use on a telemetry-emitting
 *     framework, OR silence for 3 × `defaultGate.windowDays`;
 *   - above the floor the reviewer (`skillLearning.reviewer`, an injected fn) answers `retire | keep | patch`
 *     with a reason; the verdict is discarded unless the provenance recorder recorded it; the STATIC DEFAULTS
 *     (`defaultScoreFloor`, `defaultMisfireFloor`, `defaultUnusedDays`) decide ONLY when the reviewer is
 *     unavailable, and `retire-arbiter-vs-default` is logged whenever the reviewer answered;
 *   - a locked (`operator-owned`) skill is never patched, but IS retirable for harm;
 *   - `retire`: `CommitProtocol.move('retire', <canonical dir>, <stateDir>/skill-learning/retired/<name>/)`
 *     (fenced, journaled, a `retire` version row), then `instar-learned-state: "retired"` + the reason are
 *     written into the moved canonical's frontmatter and a `retired.json` sidecar; retire for harm posts a
 *     learning through the injected `addLearning` (EvolutionManager.addLearning on the holder, deviation (ii));
 *   - one judgment per (skill, version), durably memoised, so a tick over the same tree asks nothing twice.
 *
 * EVERY-MACHINE side (`reconcileRetiredRenderings`, called from INSIDE `LearnedSkillReconciler.reconcileAll`
 * under its mutex):
 *   - for each `retired/<name>/` holding a learned canonical, with a local rendering present: ARCHIVE FIRST —
 *     `.claude/skills/<name>` → `retired/<name>/renderings/<machineId>/claude/` (and `.agents/skills/<name>` →
 *     `/agents/`) byte-for-byte, edited or not, journaled `move-prepare` → `move-commit` in this machine's
 *     commit journal (the protocol's txId scheme, so its recovery completes or reverses a half-done move); a
 *     rename failure → copy, verify bytes, `SafeFsExecutor.safeRmSync({ operation: 'skill-learning:retire-rendering' })`;
 *     a total failure → `retire-blocked` (status) and the skill reported active, never silently;
 *   - lock retraction (carried from the slice-2 review): a lock stops renders but retracts nothing, so every
 *     locked learned canonical with a rendering still present has that rendering archived the same way into
 *     `retired/<name>/renderings/<machineId>/` (the canonical stays); `lockLeftRendering` lists it until then;
 *   - never a rendering without a learned canonical behind it (in `retired/` or locked in `.instar/skills`);
 *     never a rendering without a learned marker; never `removeOrphans`.
 *
 * A blocked archive is re-attempted only when the rendering's bytes change or 24 h have passed (durable per
 * machine), so the sweep converges: one archive+remove per skill × target × machine.
 *
 * Self-action posture: both sides are self-triggered controllers, registered in src/testing/selfActionRegistry.ts
 * as `learned-skill-retire-reconcile` (verb `converge-retire-rendering`) and `skill-learning-retire-judgment`
 * (verb `converge-retire`).
 */
/* @self-action-controller: learned-skill-retire-reconcile */
/* @self-action-controller: skill-learning-retire-judgment */

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { SafeFsExecutor } from '../../core/SafeFsExecutor.js';
import { isLearnedCanonical, learnedStateOf } from '../LearnedSkillReconciler.js';
import { dirsByteIdentical, dirIsPartialCopyOf, fileHashOf } from './CommitProtocol.js';
import { lintDraft, extractReferences, type LintResult } from './Lint.js';
import { parseSkillDoc, type ReviewFlag } from './Drafter.js';
import { SKILL_LEARNING_PATHS, SKILL_NAME_RE, type CommitProtocolLike, type RetireKind, type RetiredSummary, type SkillLearningConfig } from './types.js';

export type RenderingLayout = 'claude' | 'agents';
const LAYOUTS: ReadonlyArray<{ layout: RenderingLayout; root: string }> = [
  { layout: 'claude', root: '.claude/skills' },
  { layout: 'agents', root: '.agents/skills' },
];
const CANONICAL_ROOT = '.instar/skills';
const STAMP_LINE_RE = /^x-instar-stamp:\s*([a-f0-9]{64})\s*$/m;
const LEARNED_ORIGIN_RE = /^\s+instar-learned-origin:\s*\S/m;
const DAY_MS = 86_400_000;
/** Canonical states the reconciler never renders: a rendering left behind by one of these is retracted (archived). */
const HELD_STATES: ReadonlySet<string> = new Set(['operator-owned', 'pending', 'proposal', 'retired']);
const BLOCKED_RETRY_MS = 24 * 3600_000;
const RETIRE_ALL_REARM_DAYS = 14;
export const RETIRE_RENDERING_OPERATION = 'skill-learning:retire-rendering';

// ─── Holder-side contracts ─────────────────────────────────────────────

/** What the sentinel computes per learned skill for the retire judgment (numbers as signals, §3.8). */
export interface RetireCandidate {
  name: string;
  state: 'active' | 'operator-owned';
  locked: boolean;
  version: number;
  key: string;
  authorFamily?: string;
  /** The §3.7 score on the current version, or null when unmeasured. */
  score: number | null;
  /** Corroborated runs on the CURRENT version (the floor for a score retire). */
  corroboratedRuns: number;
  correctedRuns: number;
  uses: number;
  /** Misfire verdicts (§3.6) on the current version. */
  misfires: number;
  lastUsedAt?: string;
  /** The key's last observed request (any session), when the ledger knows one. */
  lastRequestAt?: string;
  /** Observed requests of the key (after the counters' start) whose run used no skill on a telemetry-emitting framework. */
  requestsWithoutUse: number;
  /** The key's occurrences in the last `defaultGate.windowDays`. */
  occurrencesInWindow: number;
  /** ISO: the moment the counters started (creation, or the restore that reset them). */
  countersSince: string;
  /** This skill's description bytes in the rendered index, and the sessions per week it is loaded into (§3.9), when measured. */
  indexBytes?: number | null;
  sessionsPerWeek?: number | null;
}

export interface RetireReviewInput {
  candidate: RetireCandidate;
  signals: RetireSignals;
  defaults: { scoreFloor: number; misfireFloor: number; unusedDays: number };
  prompt: string;
}

export type RetireVerdict = 'retire' | 'keep' | 'patch';

export interface RetireReviewAnswer {
  verdict: RetireVerdict;
  reason: string;
  /** The reviewer's own judgment: the skill is harming (corrections it causes), not merely unused or costly. */
  harm: boolean;
  family: string;
}

/** The reviewer fn: `null` = unavailable (static defaults decide); `'unrecorded'` = the provenance recorder refused (verdict discarded, re-asked later). */
export type RetireReviewer = (input: RetireReviewInput) => Promise<RetireReviewAnswer | null | 'unrecorded'>;

export interface RetireSignals {
  scoreFloorMet: boolean;
  misfireFloorMet: boolean;
  unusedFloorMet: boolean;
  misfireRate: number | null;
  daysUnused: number | null;
  daysSilent: number | null;
  /** index bytes × sessions per week ÷ occurrences per week — null when a factor is unmeasured. */
  costPerExpectedUse: number | null;
}

export interface RetireDecision {
  name: string;
  version: number;
  verdict: RetireVerdict | 'unmeasured' | 'unrecorded' | 'memoised';
  by: 'reviewer' | 'default-rung' | 'floor' | 'memo';
  kind?: RetireKind;
  harm?: boolean;
  reason?: string;
  reviewerFamily?: string;
  /** What the static defaults alone would have said (logged as `retire-arbiter-vs-default` when a reviewer answered). */
  defaultVerdict?: RetireVerdict;
  /** Set when a retire verdict was refused by a rule (locked without harm) or the protocol. */
  refused?: string;
  applied?: boolean;
  /** `mode: shadow`: the verdict was logged as `would-retire` and NOT applied (no move, no protocol call). */
  shadow?: boolean;
}

export interface RetireRequest {
  kind: RetireKind;
  reason: string;
  harm: boolean;
  by: 'reviewer' | 'default-rung' | 'operator';
  reviewerFamily?: string;
  actor?: string;
}

export type RetireOutcome =
  | { ok: true; txId: string; version: number; archived: ArchivedRendering[]; blocked: BlockedRendering[] }
  | { ok: false; error: string };

export interface RestoreReviewInput { name: string; skillMd: string; flags: ReviewFlag[]; authorFamily?: string; harmReason?: string }
/** `'one-family'` = no family other than the author's is reachable (held `pending` with that reason); `null` = unavailable/unrecorded (restore refused). */
export type RestoreReviewer = (input: RestoreReviewInput) => Promise<{ pass: boolean; reason: string; family: string } | 'one-family' | null>;

export type RestoreOutcome =
  | { ok: true; txId: string; version: number; pendingReason: 'restored' | 'one-family'; reviewerFamily?: string; harmReason?: string; description: string }
  | { ok: false; error: string; detail?: string };

// ─── Every-machine contracts ───────────────────────────────────────────

export interface ArchivedRendering { name: string; layout: RenderingLayout; rel: string; to: string; via: 'rename' | 'copy' | 'already-archived' }
export interface BlockedRendering { name: string; layout: RenderingLayout; rel: string; reason: string }

export interface RetiredRenderingSweep {
  at: string;
  /** Renderings of RETIRED skills archived this pass. */
  archived: ArchivedRendering[];
  /** Renderings of LOCKED skills archived this pass (lock retraction). */
  lockArchived: ArchivedRendering[];
  blocked: BlockedRendering[];
  /** Held learned canonicals (locked / pending / proposal / retired) whose rendering is still on this machine after the pass. */
  lockLeftRendering: Array<{ name: string; layouts: string[]; state: string }>;
  /** Rendering paths (project-relative) that left the layouts — the reconciler forgets their baselines. */
  forgottenRels: string[];
}

interface BlockedEntry { renderingHash: string; attempts: number; lastAt: string; reason: string }
interface BlockedFile { version: 1; machineId: string; blocked: Record<string, BlockedEntry> }
interface JudgmentMemo { version: number; verdict: string; at: string; reaskAt?: string; applied?: boolean }
interface JudgmentsFile { version: 1; machineId: string; judgments: Record<string, JudgmentMemo> }

export interface RetiredSidecar {
  name: string;
  reason: string;
  kind: RetireKind;
  harm: boolean;
  by: 'reviewer' | 'default-rung' | 'operator';
  reviewerFamily?: string;
  authorFamily?: string;
  retiredAt: string;
  version: number;
  fileHashBefore: string;
  machineId: string;
  txId: string;
  actor?: string;
}

export interface RetireAllRecord { at: string; actor: string; reArmReviewAt: string; retired: string[]; refused: Array<{ name: string; error: string }>; machineId: string }

export interface RetirerDeps {
  projectDir: string;
  stateDir: string;
  machineId: string;
  config: Pick<SkillLearningConfig, 'retire' | 'defaultGate' | 'shadow'>;
  /** Holder side; null on a machine that only sweeps. */
  commitProtocol?: CommitProtocolLike | null;
  /** Version rows (author family of the retired version, the current version number). */
  versions?: { rows(name: string): ReadonlyArray<{ version: number; op?: string; authorFamily?: string; void?: boolean; superseded?: boolean }> } | null;
  reviewer?: RetireReviewer | null;
  restoreReviewer?: RestoreReviewer | null;
  /** The live learned skills with their numbers (the sentinel computes them from the ledger); the index-cost heal reads it. */
  candidates?: (() => RetireCandidate[]) | null;
  /** `EvolutionManager.addLearning` on the holder (deviation (ii)); a retire for harm posts one learning. */
  addLearning?: ((learning: { title: string; category: string; description: string; source: { agent: string; platform: string; contentId?: string; discoveredAt: string }; tags: string[] }) => unknown) | null;
  /** Names of every existing skill + the hand-written descriptions (the restore lint's collision/overlap inputs). */
  existingSkills?: () => Array<{ name: string; description: string; learned: boolean }>;
  /** `logs/skill-learning.jsonl` (the sentinel's appendLog); default: this module's own fsync-free append. */
  appendLog?: (row: Record<string, unknown>) => void;
  /** After a direct archive outside a reconcile pass: the reconciler drops the baselines of the moved renderings. */
  forgetRenderings?: (rels: string[]) => Promise<void> | void;
  now?: () => number;
  logger?: (message: string) => void;
  /** Test seams for the move primitives (default: fs.renameSync / SafeFsExecutor.safeRmSync). */
  rename?: (from: string, to: string) => void;
  removeDir?: (dir: string, operation: string) => void;
}

const yamlQuote = (s: string): string => JSON.stringify(String(s).replace(/[\r\n]+/g, ' ').slice(0, 400)); // bounded-input-reviewed: a frontmatter value written to disk (one YAML line), never a model prompt; the full reason is in the retired.json sidecar and the log row

/** Set/replace flat `metadata:` keys in a canonical's frontmatter, preserving every other byte (the protocol's `withLearnedState` shape). */
export function patchMetadata(raw: string, patch: Record<string, string | null>): string | null {
  const m = raw.match(/^---\r?\n([\s\S]*?)\r?\n---(\r?\n)?([\s\S]*)$/);
  if (!m) return null;
  const lines = m[1].split('\n');
  let mdIdx = lines.findIndex((l) => /^metadata:\s*$/.test(l));
  if (mdIdx < 0) { lines.push('metadata:'); mdIdx = lines.length - 1; }
  for (const [key, value] of Object.entries(patch)) {
    const re = new RegExp(`^(\\s+)${key.replace(/-/g, '\\-')}:\\s*.*$`);
    const i = lines.findIndex((l, idx) => idx > mdIdx && re.test(l));
    if (value === null) { if (i >= 0) lines.splice(i, 1); continue; }
    if (i >= 0) lines[i] = lines[i].replace(re, `$1${key}: ${yamlQuote(value)}`);
    else lines.splice(mdIdx + 1, 0, `  ${key}: ${yamlQuote(value)}`);
  }
  return `---\n${lines.join('\n')}\n---${m[2] ?? '\n'}${m[3]}`;
}

function writeFileAtomicSync(target: string, content: string): void {
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const tmp = `${target}.tmp-${process.pid}-${crypto.randomBytes(4).toString('hex')}`;
  try {
    const fd = fs.openSync(tmp, 'w', 0o644);
    try { fs.writeSync(fd, content); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    fs.renameSync(tmp, target);
  } catch (err) {
    try { SafeFsExecutor.safeRmSync(tmp, { force: true, operation: 'skill-learning:retire-temp-cleanup' }); } catch { /* @silent-fallback-ok — best-effort temp cleanup after a failed write; the write error itself is thrown on the next line */ }
    throw err;
  }
}

function writeJsonAtomic(file: string, value: unknown): void {
  writeFileAtomicSync(file, `${JSON.stringify(value, null, 2)}\n`);
}

function readJson<T>(file: string): T | null {
  try { return JSON.parse(fs.readFileSync(file, 'utf-8')) as T; } catch { return null; } // @silent-fallback-ok — absent/corrupt state reads as none; every caller treats null explicitly (a corrupt memo re-judges, a corrupt blocked file re-attempts once)
}

function copyDirRecursive(from: string, to: string): void {
  fs.mkdirSync(to, { recursive: true });
  for (const e of fs.readdirSync(from, { withFileTypes: true })) {
    const s = path.join(from, e.name);
    const t = path.join(to, e.name);
    if (e.isDirectory()) copyDirRecursive(s, t);
    else fs.copyFileSync(s, t);
  }
}

/** A content hash over a directory tree (relative path + bytes), for the blocked-retry key. */
export function dirContentHash(dir: string): string | null {
  const h = crypto.createHash('sha256');
  const walk = (d: string, rel: string): void => {
    for (const e of fs.readdirSync(d, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) walk(path.join(d, e.name), r);
      else { h.update(r); h.update('\0'); h.update(fs.readFileSync(path.join(d, e.name))); h.update('\0'); }
    }
  };
  try { walk(dir, ''); } catch { return null; } // @silent-fallback-ok — an unreadable tree has no hash; the caller reports it blocked ("unreadable") instead of touching it
  return h.digest('hex');
}

/** The prompt the retire reviewer answers (numbers as signals; the defaults named as the fallback rung). */
export function buildRetireReviewPrompt(c: RetireCandidate, s: RetireSignals, defaults: { scoreFloor: number; misfireFloor: number; unusedDays: number }): string {
  const n = (v: number | null | undefined, digits = 2): string => (typeof v === 'number' && Number.isFinite(v) ? v.toFixed(digits) : 'unmeasured');
  return [
    'You are the skill-learning reviewer judging whether a LEARNED skill should be retired.',
    'Answer ONLY a JSON object: {"verdict":"retire"|"keep"|"patch","harm":true|false,"reason":"<one sentence>"}.',
    '"retire" means the skill is harming (its runs get corrected), misfiring (loaded for the wrong requests), or dead (unused);',
    '"keep" means the numbers do not justify retiring; "patch" means a targeted fix would do (a locked skill is never patched).',
    'Set "harm": true only when the skill actively causes corrections; a dead or costly skill is not harm.',
    'The numbers are signals, not thresholds. The static defaults below are the fallback rung when you are unavailable.',
    '',
    `Skill: ${c.name} (version ${c.version}, ${c.locked ? 'locked by the operator' : 'unlocked'}, counters since ${c.countersSince})`,
    `Score (accepted+1 over measured+2): ${n(c.score)}  corroborated runs on this version: ${c.corroboratedRuns}  corrected: ${c.correctedRuns}  uses: ${c.uses}`,
    `Misfire verdicts: ${c.misfires}  misfire rate: ${n(s.misfireRate)}`,
    `Days since last use: ${s.daysUnused === null ? 'never used' : s.daysUnused}  days since the key was last requested: ${s.daysSilent === null ? 'never requested' : s.daysSilent}  requests of its key with no use: ${c.requestsWithoutUse}`,
    `Cost per expected use (index bytes × sessions/week ÷ occurrences/week): ${n(s.costPerExpectedUse, 0)}`,
    `Floors met: score ${s.scoreFloorMet}, misfire ${s.misfireFloorMet}, unused ${s.unusedFloorMet}`,
    `Static defaults: retire when score < ${defaults.scoreFloor}, misfire rate > ${defaults.misfireFloor}, or unused ≥ ${defaults.unusedDays} days.`,
  ].join('\n');
}

export function parseRetireReviewOutput(raw: string): { verdict: RetireVerdict; harm: boolean; reason: string } | null {
  const m = String(raw ?? '').match(/\{[\s\S]*\}/);
  if (!m) return null;
  let parsed: unknown;
  try { parsed = JSON.parse(m[0]); } catch { return null; } // @silent-fallback-ok — an unparseable reviewer answer is "no verdict": the caller records `unclassified` and the defaults do NOT act (unavailable ≠ unparseable)
  if (!parsed || typeof parsed !== 'object') return null;
  const p = parsed as Record<string, unknown>;
  const verdict = p.verdict;
  if (verdict !== 'retire' && verdict !== 'keep' && verdict !== 'patch') return null;
  return { verdict, harm: p.harm === true, reason: typeof p.reason === 'string' ? p.reason.replace(/\s+/g, ' ').trim().slice(0, 300) : '' };
}

export class Retirer {
  private readonly d: RetirerDeps;
  private readonly machineId: string;
  private readonly now: () => number;
  private readonly log: (m: string) => void;
  private readonly rename: (from: string, to: string) => void;
  private readonly removeDir: (dir: string, operation: string) => void;
  private lastSweep: RetiredRenderingSweep | null = null;
  private chain: Promise<unknown> = Promise.resolve();

  constructor(deps: RetirerDeps) {
    this.d = deps;
    this.machineId = /^[\w.-]{1,96}$/.test(deps.machineId) ? deps.machineId : 'unknown';
    this.now = deps.now ?? (() => Date.now());
    this.log = deps.logger ?? (() => {});
    this.rename = deps.rename ?? ((from, to) => fs.renameSync(from, to));
    this.removeDir = deps.removeDir ?? ((dir, operation) => SafeFsExecutor.safeRmSync(dir, { recursive: true, force: true, operation }));
  }

  /** Late binding of the sentinel-owned seams (reviewer fns need families + provenance that exist only on the sentinel). */
  bind(partial: Pick<RetirerDeps, 'reviewer' | 'restoreReviewer' | 'existingSkills' | 'appendLog' | 'addLearning' | 'candidates'>): void {
    for (const [k, v] of Object.entries(partial)) if (v !== undefined) (this.d as unknown as Record<string, unknown>)[k] = v;
  }

  /** Skills retired for harm (attention item 1's input): from the sidecars under `retired/`. */
  harmRetired(): Array<{ skill: string; version: number; reason?: string }> {
    return this.listRetired().filter((r) => r.harm).map((r) => ({ skill: r.name, version: r.version, reason: r.reason }));
  }

  // ─── Paths ───────────────────────────────────────────────────────────

  get retiredRoot(): string { return path.join(this.d.stateDir, SKILL_LEARNING_PATHS.retiredDir); }
  retiredDir(name: string): string { return path.join(this.retiredRoot, name); }
  canonicalDir(name: string): string { return path.join(this.d.projectDir, CANONICAL_ROOT, name); }
  renderingDir(layout: RenderingLayout, name: string): string { return path.join(this.d.projectDir, LAYOUTS.find((l) => l.layout === layout)!.root, name); }
  archiveDir(name: string, layout: RenderingLayout): string { return path.join(this.retiredDir(name), 'renderings', this.machineId, layout); }
  private get journalPath(): string { return path.join(this.d.stateDir, SKILL_LEARNING_PATHS.journalDir, `${this.machineId}.jsonl`); }
  private get blockedPath(): string { return path.join(this.d.stateDir, 'skill-learning', `retire-blocked.${this.machineId}.json`); }
  private get judgmentsPath(): string { return path.join(this.d.stateDir, 'skill-learning', `retire-judgments.${this.machineId}.json`); }
  get retireAllPath(): string { return path.join(this.d.stateDir, 'skill-learning', `retire-all.${this.machineId}.json`); }

  // ─── Reads (status) ──────────────────────────────────────────────────

  /** Every retired canonical with its sidecar and the renderings each machine archived. */
  listRetired(): RetiredSummary[] {
    let entries: fs.Dirent[] = [];
    try { entries = fs.readdirSync(this.retiredRoot, { withFileTypes: true }); } catch { return []; } // @silent-fallback-ok — no retired directory yet means nothing retired
    const out: RetiredSummary[] = [];
    for (const e of entries) {
      if (!e.isDirectory() || !SKILL_NAME_RE.test(e.name)) continue;
      const dir = this.retiredDir(e.name);
      const raw = this.readIf(path.join(dir, 'SKILL.md'));
      if (raw === null || !isLearnedCanonical(raw)) continue;
      const side = readJson<RetiredSidecar>(path.join(dir, 'retired.json'));
      const renderingsArchived: Record<string, string[]> = {};
      let machines: fs.Dirent[] = [];
      try { machines = fs.readdirSync(path.join(dir, 'renderings'), { withFileTypes: true }); } catch { machines = []; } // @silent-fallback-ok — no renderings archived yet on any machine
      for (const m of machines) {
        if (!m.isDirectory()) continue;
        try { renderingsArchived[m.name] = fs.readdirSync(path.join(dir, 'renderings', m.name)).sort(); } catch { renderingsArchived[m.name] = []; } // @silent-fallback-ok — an unreadable machine dir lists as empty; the directory itself is still named
      }
      const meta = parseSkillDoc(raw)?.metadata ?? {};
      out.push({
        name: e.name,
        reason: side?.reason ?? meta['instar-learned-retire-reason'] ?? 'retired',
        kind: side?.kind ?? 'operator',
        retiredAt: side?.retiredAt ?? meta['instar-learned-retired'] ?? '',
        ...(side?.harm ? { harm: true } : {}),
        by: side?.by ?? 'operator',
        version: side?.version ?? Number.parseInt(meta['instar-learned-version'] ?? '0', 10) ?? 0,
        ...(side?.reviewerFamily ? { reviewerFamily: side.reviewerFamily } : {}),
        ...(side?.authorFamily ? { authorFamily: side.authorFamily } : {}),
        renderingsArchived,
        archiveDir: path.posix.join(SKILL_LEARNING_PATHS.retiredDir, e.name),
      });
    }
    return out.sort((a, b) => b.retiredAt.localeCompare(a.retiredAt));
  }

  /**
   * HELD learned canonicals (locked `operator-owned`, or `pending` / `proposal` / `retired` still in the layout — a
   * refused revert leaves N+1 pending with its rendering on disk) with a rendering still on this machine
   * (read-only; the tick archives them). Named for the lock case it was built for; `state` says which it is.
   */
  lockLeftRendering(): Array<{ name: string; layouts: string[]; state: string }> {
    const out: Array<{ name: string; layouts: string[]; state: string }> = [];
    for (const { name, state } of this.heldCanonicals()) {
      const layouts = LAYOUTS.filter((l) => fs.existsSync(path.join(this.renderingDir(l.layout, name), 'SKILL.md'))).map((l) => l.layout);
      if (layouts.length) out.push({ name, layouts, state });
    }
    out.push(...this.orphanLearnedRenderings());
    return out;
  }

  retireBlocked(): Array<{ name: string; layout: string; reason: string }> {
    const file = readJson<BlockedFile>(this.blockedPath);
    const out: Array<{ name: string; layout: string; reason: string }> = [];
    for (const [key, b] of Object.entries(file?.blocked ?? {})) {
      const [name, layout] = key.split(':');
      // Still blocked only while the rendering is still there (an operator may have moved it by hand).
      if (name && layout && fs.existsSync(this.renderingDir(layout as RenderingLayout, name))) out.push({ name, layout, reason: b.reason });
    }
    // Archives set aside for a retire that never merged them back (a crash in between): `layout: 'aside'`, visible until the sweep puts them back.
    for (const a of this.asideDirs()) out.push({ name: a.name, layout: 'aside', reason: `archives set aside at ${path.relative(this.d.stateDir, a.dir)} while a retire was in flight; the next check puts them back` });
    return out;
  }

  /** Names of retired skills whose rendering this machine could not archive — reported ACTIVE by the sentinel (asides are not a live skill). */
  blockedNames(): string[] { return [...new Set(this.retireBlocked().filter((b) => b.layout !== 'aside').map((b) => b.name))]; }

  /** `retired/<name>.aside-<hex>` directories: the set-aside archives of a retire that did not finish. */
  private asideDirs(): Array<{ name: string; dir: string }> {
    let entries: fs.Dirent[] = [];
    try { entries = fs.readdirSync(this.retiredRoot, { withFileTypes: true }); } catch { return []; } // @silent-fallback-ok — no retired directory yet
    const out: Array<{ name: string; dir: string }> = [];
    for (const e of entries) {
      const m = e.isDirectory() ? e.name.match(/^([a-z0-9][a-z0-9-]{0,63})\.aside-[a-f0-9]{8}$/) : null;
      if (m && SKILL_NAME_RE.test(m[1])) out.push({ name: m[1], dir: path.join(this.retiredRoot, e.name) });
    }
    return out;
  }

  /** Put a crash-orphaned aside back: merged into `retired/<name>/` when the retire landed, renamed back when it did not. */
  private recoverAsides(sweep: RetiredRenderingSweep): void {
    for (const a of this.asideDirs()) {
      const to = this.retiredDir(a.name);
      try {
        if (fs.existsSync(to)) { this.mergeAside(a.dir, to); }
        else {
          const txId = crypto.randomBytes(8).toString('hex');
          this.journalMove('move-prepare', a.name, a.dir, to, 'retire:aside-put-back', txId);
          this.rename(a.dir, to);
          this.journalMove('move-commit', a.name, a.dir, to, 'retire:aside-put-back', txId);
        }
        this.appendLog({ kind: 'retire-aside-recovered', name: a.name, dir: path.relative(this.d.stateDir, a.dir), merged: fs.existsSync(path.join(to, 'SKILL.md')) });
      } catch (err) { // @silent-fallback-ok — reported as a blocked `aside` entry in status (retireBlocked) and logged here; nothing is deleted, the next sweep retries
        sweep.blocked.push({ name: a.name, layout: 'claude', rel: path.relative(this.d.stateDir, a.dir), reason: `aside-recovery-failed: ${(err as Error).message}` });
        this.log(`[Retirer] aside ${a.dir} could not be put back: ${(err as Error).message}`);
      }
    }
  }

  /** Learned-marker renderings with no canonical in `.instar/skills` (any state) and none in `retired/`: reported, never moved. */
  orphanLearnedRenderings(): Array<{ name: string; layouts: string[]; state: 'orphan-learned-rendering' }> {
    const byName = new Map<string, string[]>();
    for (const l of LAYOUTS) {
      let entries: fs.Dirent[] = [];
      try { entries = fs.readdirSync(path.join(this.d.projectDir, l.root), { withFileTypes: true }); } catch { continue; } // @silent-fallback-ok — an absent layout holds no renderings
      for (const e of entries) {
        if (!e.isDirectory() || !SKILL_NAME_RE.test(e.name)) continue;
        const rendered = this.readIf(path.join(this.d.projectDir, l.root, e.name, 'SKILL.md'));
        if (rendered === null || (!STAMP_LINE_RE.test(rendered) && !LEARNED_ORIGIN_RE.test(rendered))) continue;
        if (fs.existsSync(path.join(this.canonicalDir(e.name), 'SKILL.md')) || fs.existsSync(path.join(this.retiredDir(e.name), 'SKILL.md'))) continue;
        byName.set(e.name, [...(byName.get(e.name) ?? []), l.layout]);
      }
    }
    return [...byName.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([name, layouts]) => ({ name, layouts, state: 'orphan-learned-rendering' as const }));
  }

  retireAllRecord(): RetireAllRecord | null { return readJson<RetireAllRecord>(this.retireAllPath); }

  /** True while a `retire-all` hold is in force (now < reArmReviewAt): the holder drafts nothing. */
  retireAllHold(): boolean {
    const r = this.retireAllRecord();
    if (!r) return false;
    const t = Date.parse(r.reArmReviewAt);
    return Number.isFinite(t) && this.now() < t;
  }

  lastSweepResult(): RetiredRenderingSweep | null { return this.lastSweep; }

  /** The retired canonical's raw text (for the sentinel to report a blocked skill as still active). */
  retiredCanonicalRaw(name: string): string | null {
    return SKILL_NAME_RE.test(name) ? this.readIf(path.join(this.retiredDir(name), 'SKILL.md')) : null;
  }

  // ─── Every-machine side ───────────────────────────────────────────────

  /**
   * Called from INSIDE `LearnedSkillReconciler.reconcileAll` (under its mutex). Archives, never deletes:
   * retired skills' renderings and locked skills' leftover renderings. Returns what moved and what is blocked.
   */
  reconcileRetiredRenderings(): RetiredRenderingSweep {
    const sweep: RetiredRenderingSweep = { at: new Date(this.now()).toISOString(), archived: [], lockArchived: [], blocked: [], lockLeftRendering: [], forgottenRels: [] };
    // Crash-orphaned `retired/<name>.aside-*` directories (set aside for a retire that never merged them back): put back or merged.
    this.recoverAsides(sweep);
    // Retired canonicals first (archive-first is the ONLY removal path of a retired skill's rendering).
    for (const name of this.retiredNames()) {
      if (this.liveCanonicalExists(name)) continue;           // restored (or being restored): the rendering belongs to a live skill again
      for (const l of LAYOUTS) this.archiveOne(name, l.layout, 'retired', sweep);
    }
    // Lock retraction, generalised to every HELD state: a held canonical keeps its bytes; its rendering leaves every discovery path.
    for (const { name, state } of this.heldCanonicals()) {
      for (const l of LAYOUTS) this.archiveOne(name, l.layout, 'held', sweep);
      const left = LAYOUTS.filter((l) => fs.existsSync(path.join(this.renderingDir(l.layout, name), 'SKILL.md'))).map((l) => l.layout);
      if (left.length) sweep.lockLeftRendering.push({ name, layouts: left, state });
    }
    // A learned-marker rendering with NO canonical anywhere (hand-deleted, or a rejected pending skill's leftover): visible, never moved.
    for (const o of this.orphanLearnedRenderings()) sweep.lockLeftRendering.push(o);
    this.lastSweep = sweep;
    if (sweep.archived.length || sweep.lockArchived.length || sweep.blocked.length) {
      this.appendLog({ kind: 'retire-sweep', archived: sweep.archived.map((a) => `${a.name}:${a.layout}:${a.via}`), lockArchived: sweep.lockArchived.map((a) => `${a.name}:${a.layout}:${a.via}`), blocked: sweep.blocked.map((b) => `${b.name}:${b.layout}:${b.reason}`) });
    }
    return sweep;
  }

  /**
   * The hold path's one-liner (the sentinel's lock, 3A's refused revert / held patch): archive whatever rendering a
   * canonical in ANY held state (`operator-owned`, `pending`, `proposal`, `retired`) left behind on this machine.
   * An `active` canonical is never touched (its rendering is live).
   */
  async archiveLeftoverRenderings(name: string): Promise<{ archived: ArchivedRendering[]; blocked: BlockedRendering[]; left: string[] }> {
    const sweep: RetiredRenderingSweep = { at: new Date(this.now()).toISOString(), archived: [], lockArchived: [], blocked: [], lockLeftRendering: [], forgottenRels: [] };
    if (!SKILL_NAME_RE.test(name)) return { archived: [], blocked: [], left: [] };
    const raw = this.readIf(path.join(this.canonicalDir(name), 'SKILL.md'));
    if (raw === null || !isLearnedCanonical(raw) || !HELD_STATES.has(learnedStateOf(raw) ?? 'active')) return { archived: [], blocked: [], left: [] };
    for (const l of LAYOUTS) this.archiveOne(name, l.layout, 'held', sweep);
    if (sweep.forgottenRels.length) await this.forget(sweep.forgottenRels);
    const left = LAYOUTS.filter((l) => fs.existsSync(path.join(this.renderingDir(l.layout, name), 'SKILL.md'))).map((l) => l.layout);
    return { archived: sweep.lockArchived, blocked: sweep.blocked, left };
  }

  /** One (skill × layout × this machine): archive first; a failure is recorded, bounded, and visible. */
  private archiveOne(name: string, layout: RenderingLayout, cause: 'retired' | 'held', sweep: RetiredRenderingSweep): void {
    const from = this.renderingDir(layout, name);
    const skillMd = path.join(from, 'SKILL.md');
    if (!fs.existsSync(skillMd)) return;
    const rel = path.posix.join(LAYOUTS.find((l) => l.layout === layout)!.root, name, 'SKILL.md');
    const rendered = this.readIf(skillMd) ?? '';
    // Never a rendering without a learned marker: a hand-written skill that took the name is not ours to move.
    if (!STAMP_LINE_RE.test(rendered) && !LEARNED_ORIGIN_RE.test(rendered)) {
      sweep.blocked.push({ name, layout, rel, reason: 'no-learned-marker' });
      return;
    }
    const renderingHash = dirContentHash(from);
    if (renderingHash === null) { sweep.blocked.push({ name, layout, rel, reason: 'unreadable' }); return; }
    const blockedFile = readJson<BlockedFile>(this.blockedPath) ?? { version: 1, machineId: this.machineId, blocked: {} };
    const key = `${name}:${layout}`;
    const prior = blockedFile.blocked[key];
    if (prior && prior.renderingHash === renderingHash && this.now() - Date.parse(prior.lastAt) < BLOCKED_RETRY_MS) {
      sweep.blocked.push({ name, layout, rel, reason: prior.reason });   // still blocked, not re-attempted (bytes unchanged, < 24 h)
      return;
    }
    let to = this.archiveDir(name, layout);
    if (fs.existsSync(to)) {
      if (dirsByteIdentical(from, to)) {
        // A previous pass archived it and could not remove the source: finish the removal.
        try { this.removeDir(from, RETIRE_RENDERING_OPERATION); } catch (err) {
          return this.block(blockedFile, key, renderingHash, `remove-failed: ${(err as Error).message}`, { name, layout, rel }, sweep);
        }
        this.journalMove('move-commit', name, from, to, `archive-rendering:${layout}:${cause}:late-remove`);
        this.record(cause, sweep, { name, layout, rel, to, via: 'already-archived' });
        this.unblock(blockedFile, key);
        return;
      }
      if (dirIsPartialCopyOf(to, from)) {
        try { this.removeDir(to, RETIRE_RENDERING_OPERATION); } catch (err) { // @silent-fallback-ok — recorded as a blocked entry (visible in status + log) on the next line; nothing else is touched
          return this.block(blockedFile, key, renderingHash, `partial-archive-cleanup-failed: ${(err as Error).message}`, { name, layout, rel }, sweep);
        }
      } else {
        // An earlier archive holds OTHER bytes (an edit before a restore): never deleted — this one lands beside it.
        to = `${to}.${new Date(this.now()).toISOString().replace(/[-:.TZ]/g, '').slice(0, 14)}`;
      }
    }
    const txId = crypto.randomBytes(8).toString('hex');
    this.journalMove('move-prepare', name, from, to, `archive-rendering:${layout}:${cause}`, txId);
    let via: ArchivedRendering['via'] = 'rename';
    try {
      fs.mkdirSync(path.dirname(to), { recursive: true });
      this.rename(from, to);
    } catch (renameErr) { // @silent-fallback-ok — the rename failure is the named fallback path (copy → verify → remove); a failure there is recorded as blocked below
      via = 'copy';
      try { copyDirRecursive(from, to); } catch (err) {
        return this.block(blockedFile, key, renderingHash, `copy-failed after rename (${(renameErr as Error).message}): ${(err as Error).message}`, { name, layout, rel }, sweep);
      }
      if (!dirsByteIdentical(from, to)) {
        return this.block(blockedFile, key, renderingHash, 'copy did not verify byte-for-byte (archive partial, rendering intact)', { name, layout, rel }, sweep);
      }
      try { this.removeDir(from, RETIRE_RENDERING_OPERATION); } catch (err) {
        // The archive EXISTS and the rendering is intact: the next pass finishes the removal (byte-identical → remove).
        return this.block(blockedFile, key, renderingHash, `archived, remove-failed: ${(err as Error).message}`, { name, layout, rel }, sweep);
      }
    }
    this.journalMove('move-commit', name, from, to, `archive-rendering:${layout}:${cause}:${via}`, txId);
    this.record(cause, sweep, { name, layout, rel, to, via });
    this.unblock(blockedFile, key);
  }

  private record(cause: 'retired' | 'held', sweep: RetiredRenderingSweep, a: ArchivedRendering): void {
    (cause === 'retired' ? sweep.archived : sweep.lockArchived).push(a);
    sweep.forgottenRels.push(a.rel);
    this.log(`[Retirer] ${a.name} (${a.layout}) archived → ${path.relative(this.d.stateDir, a.to)} (${a.via}, ${cause})`);
  }

  private block(file: BlockedFile, key: string, renderingHash: string, reason: string, b: Omit<BlockedRendering, 'reason'>, sweep: RetiredRenderingSweep): void {
    const prior = file.blocked[key];
    file.blocked[key] = { renderingHash, attempts: (prior?.attempts ?? 0) + 1, lastAt: new Date(this.now()).toISOString(), reason };
    try { writeJsonAtomic(this.blockedPath, file); } catch (err) { this.log(`[Retirer] blocked file write failed: ${(err as Error).message}`); }
    sweep.blocked.push({ ...b, reason });
    this.log(`[Retirer] ${b.name} (${b.layout}) retire-blocked: ${reason}`);
  }

  private unblock(file: BlockedFile, key: string): void {
    if (!file.blocked[key]) return;
    delete file.blocked[key];
    try { writeJsonAtomic(this.blockedPath, file); } catch (err) { this.log(`[Retirer] blocked file write failed: ${(err as Error).message}`); }
  }

  // ─── Holder side: judgment ────────────────────────────────────────────

  signalsOf(c: RetireCandidate): RetireSignals {
    const nowMs = this.now();
    const days = (iso?: string): number | null => { const t = iso ? Date.parse(iso) : NaN; return Number.isFinite(t) ? Math.floor((nowMs - t) / DAY_MS) : null; };
    const daysUnused = days(c.lastUsedAt);
    const daysSilent = days(c.lastRequestAt ?? c.countersSince);
    const silenceDays = 3 * this.d.config.defaultGate.windowDays;
    const misfireRate = c.uses > 0 ? c.misfires / c.uses : null;
    const occPerWeek = c.occurrencesInWindow / Math.max(1, this.d.config.defaultGate.windowDays / 7);
    const costPerExpectedUse = typeof c.indexBytes === 'number' && typeof c.sessionsPerWeek === 'number' && occPerWeek > 0 ? (c.indexBytes * c.sessionsPerWeek) / occPerWeek : null;
    return {
      scoreFloorMet: c.corroboratedRuns >= this.d.config.retire.minCorroboratedRuns,
      misfireFloorMet: c.misfires >= 2,
      unusedFloorMet: c.requestsWithoutUse >= 1 || (daysSilent !== null && daysSilent >= silenceDays),
      misfireRate, daysUnused, daysSilent, costPerExpectedUse,
    };
  }

  /** The static defaults' answer (the fallback rung), honouring the floors. */
  defaultVerdictOf(c: RetireCandidate, s: RetireSignals): { verdict: RetireVerdict; kind?: RetireKind; harm: boolean; reason: string } {
    const r = this.d.config.retire;
    if (s.scoreFloorMet && c.score !== null && c.score < r.defaultScoreFloor) return { verdict: 'retire', kind: 'score', harm: true, reason: `score ${c.score.toFixed(2)} below the default floor ${r.defaultScoreFloor} over ${c.corroboratedRuns} corroborated runs` };
    if (s.misfireFloorMet && s.misfireRate !== null && s.misfireRate > r.defaultMisfireFloor) return { verdict: 'retire', kind: 'misfire', harm: false, reason: `misfire rate ${s.misfireRate.toFixed(2)} above the default floor ${r.defaultMisfireFloor} (${c.misfires} verdicts)` };
    const unusedDays = s.daysUnused ?? s.daysSilent;
    if (s.unusedFloorMet && unusedDays !== null && unusedDays >= r.defaultUnusedDays) return { verdict: 'retire', kind: 'unused', harm: false, reason: `unused for ${unusedDays} days (default ${r.defaultUnusedDays})` };
    return { verdict: 'keep', harm: false, reason: 'no default floor crossed' };
  }

  /**
   * Judge every candidate once per (name, version): floor → reviewer (or defaults when unavailable) → retire.
   * Returns one decision per candidate (memoised ones included, so a tick over the same tree is visibly idle).
   */
  async judge(candidates: ReadonlyArray<RetireCandidate>, opts: { dryRun?: boolean } = {}): Promise<RetireDecision[]> {
    const out: RetireDecision[] = [];
    const memoFile = readJson<JudgmentsFile>(this.judgmentsPath) ?? { version: 1, machineId: this.machineId, judgments: {} };
    let dirty = false;
    const nowIso = new Date(this.now()).toISOString();
    for (const c of candidates) {
      const memo = memoFile.judgments[c.name];
      // A shadow `:would` memo holds only shadow ticks: the flip to live acts on the judgment once.
      if (memo && memo.version === c.version && (!memo.reaskAt || this.now() < Date.parse(memo.reaskAt)) && !(memo.verdict.endsWith(':would') && !opts.dryRun)) {
        out.push({ name: c.name, version: c.version, verdict: 'memoised', by: 'memo', reason: memo.verdict });
        continue;
      }
      const s = this.signalsOf(c);
      if (!s.scoreFloorMet && !s.misfireFloorMet && !s.unusedFloorMet) {
        out.push({ name: c.name, version: c.version, verdict: 'unmeasured', by: 'floor', reason: `below every floor (corroborated ${c.corroboratedRuns}/${this.d.config.retire.minCorroboratedRuns}, misfires ${c.misfires}/2, requests without use ${c.requestsWithoutUse}, silent ${s.daysSilent ?? 'n/a'} d)` });
        continue;
      }
      const defaults = { scoreFloor: this.d.config.retire.defaultScoreFloor, misfireFloor: this.d.config.retire.defaultMisfireFloor, unusedDays: this.d.config.retire.defaultUnusedDays };
      const def = this.defaultVerdictOf(c, s);
      let decision: RetireDecision;
      const reviewer = this.d.reviewer ?? null;
      let answer: RetireReviewAnswer | null | 'unrecorded' = null;
      if (reviewer) {
        const prompt = buildRetireReviewPrompt(c, s, defaults);
        try { answer = await reviewer({ candidate: c, signals: s, defaults, prompt }); } catch (err) { // @silent-fallback-ok — a reviewer outage is the named 'unavailable' arm: logged here as retire-reviewer-error, and the static defaults decide (spec §3.8)
          this.appendLog({ kind: 'retire-reviewer-error', name: c.name, error: (err instanceof Error ? err.message : String(err)).slice(0, 200) });
          answer = null;
        }
      }
      if (answer === 'unrecorded') {
        // Not a verdict: nothing acts, re-asked after a day (bounded: one call per candidate per day while the recorder is down).
        this.appendLog({ kind: 'retire-unrecorded', name: c.name, version: c.version });
        memoFile.judgments[c.name] = { version: c.version, verdict: 'unrecorded', at: nowIso, reaskAt: new Date(this.now() + DAY_MS).toISOString() };
        dirty = true;
        out.push({ name: c.name, version: c.version, verdict: 'unrecorded', by: 'reviewer' });
        continue;
      }
      if (answer) {
        this.appendLog({ kind: 'retire-arbiter-vs-default', name: c.name, version: c.version, arbiter: answer.verdict, arbiterHarm: answer.harm, default: def.verdict, defaultKind: def.kind ?? null, agree: answer.verdict === def.verdict, family: answer.family, signals: { score: c.score, corroboratedRuns: c.corroboratedRuns, misfires: c.misfires, misfireRate: s.misfireRate, daysUnused: s.daysUnused, daysSilent: s.daysSilent, costPerExpectedUse: s.costPerExpectedUse } });
        const kind: RetireKind = answer.harm ? 'score' : s.misfireFloorMet && (s.misfireRate ?? 0) > 0 ? 'misfire' : 'unused';
        decision = { name: c.name, version: c.version, verdict: answer.verdict, by: 'reviewer', kind, harm: answer.harm, reason: answer.reason, reviewerFamily: answer.family, defaultVerdict: def.verdict };
      } else {
        decision = { name: c.name, version: c.version, verdict: def.verdict, by: 'default-rung', kind: def.kind, harm: def.harm, reason: def.reason, defaultVerdict: def.verdict };
      }
      if (decision.verdict === 'patch' && c.locked) {
        decision.refused = 'locked-never-patched';
        this.appendLog({ kind: 'retire-refused', name: c.name, version: c.version, verdict: 'patch', reason: 'locked-never-patched' });
      } else if (decision.verdict === 'retire' && c.locked && !decision.harm) {
        decision.refused = 'locked-not-harm';
        this.appendLog({ kind: 'retire-refused', name: c.name, version: c.version, verdict: 'retire', reason: 'locked-not-harm', detail: decision.reason });
      } else if (decision.verdict === 'retire' && opts.dryRun) {
        // Shadow mode: the same judgment, measured, with no move and no protocol call.
        decision.shadow = true;
        decision.applied = false;
        this.appendLog({ kind: 'would-retire', name: c.name, version: c.version, retireKind: decision.kind ?? 'score', harm: decision.harm === true, reason: decision.reason ?? null, by: decision.by, reviewerFamily: decision.reviewerFamily ?? null, mode: 'shadow' });
      } else if (decision.verdict === 'retire') {
        const res = await this.retire(c.name, { kind: decision.kind ?? 'score', reason: decision.reason ?? 'retired', harm: decision.harm === true, by: decision.by === 'reviewer' ? 'reviewer' : 'default-rung', reviewerFamily: decision.reviewerFamily });
        decision.applied = res.ok;
        if (!res.ok) decision.refused = res.error;
      }
      // Memo: one judgment per (name, version). A refused APPLY (fence) is re-tried after a day; keep/patch re-asked after verdictReaskDays.
      const reaskDays = decision.verdict === 'retire' && decision.applied === false && !decision.shadow ? 1 : Math.max(1, this.d.config.shadow.verdictReaskDays);
      memoFile.judgments[c.name] = { version: c.version, verdict: decision.verdict + (decision.refused ? `:${decision.refused}` : decision.shadow ? ':would' : ''), at: nowIso, applied: decision.applied, reaskAt: decision.verdict === 'retire' && decision.applied ? undefined : new Date(this.now() + reaskDays * DAY_MS).toISOString() };
      dirty = true;
      out.push(decision);
    }
    if (dirty) {
      try { writeJsonAtomic(this.judgmentsPath, memoFile); } catch (err) { this.log(`[Retirer] judgments memo write failed: ${(err as Error).message}`); }
    }
    return out;
  }

  // ─── Holder side: retire / restore / retire-all ───────────────────────

  retire(name: string, req: RetireRequest): Promise<RetireOutcome> {
    return this.serial(() => this.retireInner(name, req));
  }

  private async retireInner(name: string, req: RetireRequest): Promise<RetireOutcome> {
    if (!SKILL_NAME_RE.test(name)) return { ok: false, error: 'invalid-name' };
    const protocol = this.d.commitProtocol;
    if (!protocol) return { ok: false, error: 'no-commit-protocol' };
    const from = this.canonicalDir(name);
    const raw = this.readIf(path.join(from, 'SKILL.md'));
    if (raw === null) {
      return this.readIf(path.join(this.retiredDir(name), 'SKILL.md')) !== null ? { ok: false, error: 'already-retired' } : { ok: false, error: 'not-found' };
    }
    if (!isLearnedCanonical(raw)) return { ok: false, error: 'not-learned' };
    const state = learnedStateOf(raw) ?? 'active';
    if (state === 'pending') return { ok: false, error: 'pending-use-reject' };
    if (state === 'proposal') return { ok: false, error: 'not-live' };
    const to = this.retiredDir(name);
    // A `retired/<name>/` left by lock-retraction archives (renderings only, no canonical) is set aside, then merged back in.
    const aside = this.setAside(name, to);
    if (aside.error) return { ok: false, error: aside.error };
    const fileHashBefore = fileHashOf(raw);
    const lastLive = this.lastLiveRow(name);
    const res = await protocol.move('retire', name, from, to);
    if (!res.ok) {
      this.restoreAside(aside.dir, to);
      this.appendLog({ kind: 'retire-refused', name, reason: res.reason, detail: (res.detail ?? '').slice(0, 200), kind2: req.kind });
      return { ok: false, error: `commit:${res.reason}${res.detail ? ` (${res.detail.slice(0, 160)})` : ''}` };
    }
    this.mergeAside(aside.dir, to);
    const retiredAt = new Date(this.now()).toISOString();
    const movedRaw = this.readIf(path.join(to, 'SKILL.md')) ?? raw;
    // 3C's item-1 signal reads the harm from the frontmatter: `instar-learned-retire-reason: "harm: <reason>"`.
    const patched = patchMetadata(movedRaw, { 'instar-learned-state': 'retired', 'instar-learned-locked': 'false', 'instar-learned-retired': retiredAt, 'instar-learned-retire-reason': req.harm ? `harm: ${req.reason}` : req.reason, 'instar-learned-retire-kind': req.kind });
    try { if (patched) writeFileAtomicSync(path.join(to, 'SKILL.md'), patched); } catch (err) {
      this.log(`[Retirer] ${name}: retired frontmatter write failed (the move landed, the sidecar names the reason): ${(err as Error).message}`);
    }
    const sidecar: RetiredSidecar = { name, reason: req.reason, kind: req.kind, harm: req.harm, by: req.by, ...(req.reviewerFamily ? { reviewerFamily: req.reviewerFamily } : {}), ...(lastLive?.authorFamily ? { authorFamily: lastLive.authorFamily } : {}), retiredAt, version: res.version, fileHashBefore, machineId: this.machineId, txId: res.txId, ...(req.actor ? { actor: req.actor } : {}) };
    try { writeJsonAtomic(path.join(to, 'retired.json'), sidecar); } catch (err) { this.log(`[Retirer] ${name}: retired.json write failed: ${(err as Error).message}`); }
    this.appendLog({ kind: 'retire', name, version: res.version, txId: res.txId, retireKind: req.kind, harm: req.harm, by: req.by, reason: req.reason.slice(0, 300), reviewerFamily: req.reviewerFamily ?? null, actor: req.actor ?? null });
    if (req.harm) this.postHarmLearning(name, req, res.version);
    // This machine's own renderings go now (the other machines' go on their next tick).
    const sweep: RetiredRenderingSweep = { at: retiredAt, archived: [], lockArchived: [], blocked: [], lockLeftRendering: [], forgottenRels: [] };
    for (const l of LAYOUTS) this.archiveOne(name, l.layout, 'retired', sweep);
    if (sweep.forgottenRels.length) await this.forget(sweep.forgottenRels);
    return { ok: true, txId: res.txId, version: res.version, archived: sweep.archived, blocked: sweep.blocked };
  }

  private postHarmLearning(name: string, req: RetireRequest, version: number): void {
    if (!this.d.addLearning) { this.appendLog({ kind: 'retire-learning-skipped', name, reason: 'no-add-learning' }); return; }
    try {
      this.d.addLearning({
        title: `Learned skill "${name}" retired for harm`,
        category: 'skill-learning',
        description: `Version ${version} of the learned skill "${name}" was retired because its runs were being corrected: ${req.reason}. Judged by ${req.by}${req.reviewerFamily ? ` (${req.reviewerFamily})` : ''}. The canonical and every machine's rendering are archived under skill-learning/retired/${name}/; restore is one tap.`,
        source: { agent: 'skill-learning-sentinel', platform: 'instar', contentId: `skill-learning:retire:${name}:v${version}`, discoveredAt: new Date(this.now()).toISOString() },
        tags: ['skill-learning', 'retire', 'harm'],
      });
      this.appendLog({ kind: 'retire-learning', name, version });
    } catch (err) {
      this.appendLog({ kind: 'retire-learning-failed', name, error: (err instanceof Error ? err.message : String(err)).slice(0, 200) });
    }
  }

  restore(name: string, opts: { actor?: string } = {}): Promise<RestoreOutcome> {
    return this.serial(() => this.restoreInner(name, opts));
  }

  private async restoreInner(name: string, opts: { actor?: string }): Promise<RestoreOutcome> {
    if (!SKILL_NAME_RE.test(name)) return { ok: false, error: 'invalid-name' };
    const protocol = this.d.commitProtocol;
    if (!protocol) return { ok: false, error: 'no-commit-protocol' };
    const from = this.retiredDir(name);
    const raw = this.readIf(path.join(from, 'SKILL.md'));
    if (raw === null) return { ok: false, error: 'not-retired' };
    if (!isLearnedCanonical(raw)) return { ok: false, error: 'not-learned' };
    if (fs.existsSync(path.join(this.canonicalDir(name), 'SKILL.md'))) return { ok: false, error: 'canonical-exists' };
    const side = readJson<RetiredSidecar>(path.join(from, 'retired.json'));
    const harmReason = side?.harm ? side.reason : undefined;
    const restoredAt = new Date(this.now()).toISOString();
    // Held like a patch: `pending`, counters reset from now; the retire keys leave the frontmatter.
    const held = patchMetadata(raw, { 'instar-learned-state': 'pending', 'instar-learned-locked': 'false', 'instar-learned-restored': restoredAt, 'instar-learned-counters-since': restoredAt, 'instar-learned-retired': null, 'instar-learned-retire-reason': null, 'instar-learned-retire-kind': null });
    if (!held) return { ok: false, error: 'unparseable-canonical' };
    const doc = parseSkillDoc(held);
    if (!doc) return { ok: false, error: 'unparseable-canonical' };
    // 1. The structural lint, as a draft: no run slice exists for a restore, so the body's own references ground themselves.
    const existing = this.d.existingSkills?.() ?? [];
    const lint: LintResult = lintDraft(doc, {
      operatorMessages: [], toolTargets: extractReferences(doc.body), argsExcerpts: [],
      existingSkillNames: existing.map((e) => e.name).filter((n) => n !== name),
      handWrittenDescriptions: existing.filter((e) => !e.learned).map((e) => e.description),
    });
    if (!lint.ok) {
      this.appendLog({ kind: 'restore-refused', name, reason: 'lint', refusals: lint.refusals.map((r) => r.rule) });
      return { ok: false, error: 'lint', detail: lint.refusals.map((r) => `${r.rule}: ${r.detail}`).join('; ').slice(0, 300) };
    }
    // 2. The reviewer, of a family other than the retired version's author.
    const authorFamily = side?.authorFamily ?? this.lastLiveRow(name)?.authorFamily;
    let pendingReason: 'restored' | 'one-family' = 'restored';
    let reviewerFamily: string | undefined;
    const reviewer = this.d.restoreReviewer ?? null;
    if (!reviewer) {
      this.appendLog({ kind: 'restore-refused', name, reason: 'review-unavailable' });
      return { ok: false, error: 'review-unavailable' };
    }
    let verdict: Awaited<ReturnType<RestoreReviewer>>;
    try { verdict = await reviewer({ name, skillMd: held, flags: lint.flags, authorFamily, harmReason }); } catch (err) {
      this.appendLog({ kind: 'restore-refused', name, reason: 'review-error', error: (err instanceof Error ? err.message : String(err)).slice(0, 200) });
      return { ok: false, error: 'review-error' };
    }
    if (verdict === null) { this.appendLog({ kind: 'restore-refused', name, reason: 'review-unrecorded' }); return { ok: false, error: 'review-unrecorded' }; }
    if (verdict === 'one-family') pendingReason = 'one-family';
    else {
      reviewerFamily = verdict.family;
      if (!verdict.pass) { this.appendLog({ kind: 'restore-refused', name, reason: 'review', family: verdict.family, detail: verdict.reason.slice(0, 200) }); return { ok: false, error: 'review-refused', detail: verdict.reason.slice(0, 300) }; }
    }
    // 3. The held document is what moves back (the move carries what is on disk); the archive + sidecar go to history first.
    try { writeFileAtomicSync(path.join(from, 'SKILL.md'), held); } catch (err) { return { ok: false, error: `write-failed: ${(err as Error).message}` }; }
    const history = this.moveToHistory(name, from, side?.retiredAt ?? restoredAt);
    if (history.error) { try { writeFileAtomicSync(path.join(from, 'SKILL.md'), raw); } catch { /* @silent-fallback-ok — the held frontmatter staying in retired/ is harmless (still retired, nothing renders); the history error below is the reported failure */ } return { ok: false, error: history.error }; }
    const res = await protocol.move('restore', name, from, this.canonicalDir(name));
    if (!res.ok) {
      this.moveFromHistory(history.dir, from);
      try { writeFileAtomicSync(path.join(from, 'SKILL.md'), raw); } catch { /* @silent-fallback-ok — the held frontmatter staying in retired/ is harmless (still retired); the refusal below carries the protocol's reason */ }
      this.appendLog({ kind: 'restore-refused', name, reason: res.reason, detail: (res.detail ?? '').slice(0, 200) });
      return { ok: false, error: `commit:${res.reason}${res.detail ? ` (${res.detail.slice(0, 160)})` : ''}` };
    }
    this.appendLog({ kind: 'restore', name, version: res.version, txId: res.txId, pendingReason, reviewerFamily: reviewerFamily ?? null, authorFamily: authorFamily ?? null, harm: Boolean(harmReason), history: history.dir ? path.relative(this.d.stateDir, history.dir) : null, actor: opts.actor ?? null });
    return { ok: true, txId: res.txId, version: res.version, pendingReason, ...(reviewerFamily ? { reviewerFamily } : {}), ...(harmReason ? { harmReason } : {}), description: doc.description };
  }

  /**
   * Attention item 2's heal (§3.9 / §3.10): the index cost was judged too high for a wanted draft, so the reviewer
   * PROPOSES retiring the lowest-scored unused learned skill — never a counter. Candidates: live skills above the
   * unused floor (one request with no use, or silence for 3 × windowDays), lowest score first (unmeasured lowest of
   * all), oldest use breaking ties. The reviewer (or the defaults when it is unavailable) must say `retire`; the
   * retire then runs through the normal path. `terminal: true, reason: 'nothing-retirable'` when nothing qualifies.
   */
  async retireLowestUnused(input: { key: string; indexBytes: number | null; claudeHeadroomChars: number | null }): Promise<{ healed: true; name: string; version: number } | { healed: false; reason: string; detail?: string; terminal?: true }> {
    let candidates: RetireCandidate[] = [];
    try { candidates = this.d.candidates?.() ?? []; } catch (err) { return { healed: false, reason: 'candidates-unreadable', detail: (err as Error).message.slice(0, 200) }; }
    const unused = candidates
      .filter((c) => this.signalsOf(c).unusedFloorMet && !c.locked)
      .sort((a, b) => (a.score ?? -1) - (b.score ?? -1) || (a.lastUsedAt ?? '').localeCompare(b.lastUsedAt ?? ''));
    if (unused.length === 0) {
      this.appendLog({ kind: 'index-heal-nothing-retirable', key: input.key, indexBytes: input.indexBytes, claudeHeadroomChars: input.claudeHeadroomChars, candidates: candidates.length });
      return { healed: false, reason: 'nothing-retirable', terminal: true };
    }
    const c = unused[0];
    const s = this.signalsOf(c);
    const defaults = { scoreFloor: this.d.config.retire.defaultScoreFloor, misfireFloor: this.d.config.retire.defaultMisfireFloor, unusedDays: this.d.config.retire.defaultUnusedDays };
    const prompt = `${buildRetireReviewPrompt(c, s, defaults)}\nContext: the skill index is judged too costly for a wanted draft (key ${input.key}; index ${input.indexBytes ?? 'unmeasured'} bytes, Claude headroom ${input.claudeHeadroomChars ?? 'unmeasured'} chars). This skill is the lowest-scored unused one. Retire it to make room, or keep it and say why.`;
    let answer: RetireReviewAnswer | null | 'unrecorded' = null;
    if (this.d.reviewer) {
      try { answer = await this.d.reviewer({ candidate: c, signals: s, defaults, prompt }); } catch (err) { // @silent-fallback-ok — a reviewer outage is the named 'unavailable' arm: logged as retire-reviewer-error, the static defaults decide (spec §3.8)
        this.appendLog({ kind: 'retire-reviewer-error', name: c.name, error: (err instanceof Error ? err.message : String(err)).slice(0, 200) });
        answer = null;
      }
    }
    if (answer === 'unrecorded') return { healed: false, reason: 'unrecorded', detail: 'the reviewer verdict could not be recorded; nothing acts on it' };
    const def = this.defaultVerdictOf(c, s);
    const verdict = answer ? answer.verdict : (def.verdict === 'retire' ? 'retire' : 'keep');
    if (answer) this.appendLog({ kind: 'retire-arbiter-vs-default', name: c.name, version: c.version, arbiter: answer.verdict, arbiterHarm: answer.harm, default: def.verdict, defaultKind: def.kind ?? null, agree: answer.verdict === def.verdict, family: answer.family, heal: 'index-cost' });
    if (verdict !== 'retire') return { healed: false, reason: answer ? `reviewer-${answer.verdict}` : 'defaults-keep', detail: (answer?.reason ?? def.reason).slice(0, 200) };
    const r = await this.retire(c.name, { kind: 'unused', reason: `index cost heal (key ${input.key}): ${answer?.reason ?? def.reason}`, harm: answer?.harm === true, by: answer ? 'reviewer' : 'default-rung', reviewerFamily: answer?.family });
    if (!r.ok) return { healed: false, reason: 'retire-refused', detail: r.error };
    return { healed: true, name: c.name, version: r.version };
  }

  /** Retire every live learned canonical, with the audit row `{ actor, reArmReviewAt: now + 14 d }` (log + durable file). */
  async retireAll(actor: string, reason = 'retire-all by the operator'): Promise<RetireAllRecord> {
    const at = new Date(this.now()).toISOString();
    const reArmReviewAt = new Date(this.now() + RETIRE_ALL_REARM_DAYS * DAY_MS).toISOString();
    const retired: string[] = [];
    const refused: Array<{ name: string; error: string }> = [];
    for (const name of this.liveCanonicals()) {
      const r = await this.retire(name, { kind: 'retire-all', reason, harm: false, by: 'operator', actor });
      if (r.ok) retired.push(name); else refused.push({ name, error: r.error });
    }
    const record: RetireAllRecord = { at, actor, reArmReviewAt, retired, refused, machineId: this.machineId };
    this.appendLog({ kind: 'retire-all', ...record });
    try { writeJsonAtomic(this.retireAllPath, record); } catch (err) { this.log(`[Retirer] retire-all record write failed: ${(err as Error).message}`); }
    return record;
  }

  // ─── Internals ───────────────────────────────────────────────────────

  private retiredNames(): string[] {
    let entries: fs.Dirent[] = [];
    try { entries = fs.readdirSync(this.retiredRoot, { withFileTypes: true }); } catch { return []; } // @silent-fallback-ok — no retired directory yet
    return entries.filter((e) => e.isDirectory() && SKILL_NAME_RE.test(e.name)).map((e) => e.name)
      .filter((n) => { const raw = this.readIf(path.join(this.retiredDir(n), 'SKILL.md')); return raw !== null && isLearnedCanonical(raw); }).sort();
  }

  private liveCanonicalExists(name: string): boolean {
    const raw = this.readIf(path.join(this.canonicalDir(name), 'SKILL.md'));
    return raw !== null && isLearnedCanonical(raw) && learnedStateOf(raw) !== 'retired';
  }

  private canonicalsWhere(pred: (state: string) => boolean): string[] {
    let entries: fs.Dirent[] = [];
    try { entries = fs.readdirSync(path.join(this.d.projectDir, CANONICAL_ROOT), { withFileTypes: true }); } catch { return []; } // @silent-fallback-ok — no canonical layout yet
    const out: string[] = [];
    for (const e of entries) {
      if (!e.isDirectory() || !SKILL_NAME_RE.test(e.name)) continue;
      const raw = this.readIf(path.join(this.canonicalDir(e.name), 'SKILL.md'));
      if (raw === null || !isLearnedCanonical(raw)) continue;
      if (pred(learnedStateOf(raw) ?? 'active')) out.push(e.name);
    }
    return out.sort();
  }

  /** Canonicals in a held state (never rendered by the reconciler) with their state. */
  private heldCanonicals(): Array<{ name: string; state: string }> {
    return this.canonicalsWhere((s) => HELD_STATES.has(s)).map((name) => ({ name, state: learnedStateOf(this.readIf(path.join(this.canonicalDir(name), 'SKILL.md')) ?? '') ?? 'active' }));
  }
  /** Live = rendered or lockable: active and operator-owned (pending is rejected, not retired; proposals are not in the layout). */
  liveCanonicals(): string[] { return this.canonicalsWhere((s) => s === 'active' || s === 'operator-owned'); }

  private lastLiveRow(name: string): { version: number; authorFamily?: string } | null {
    const rows = this.d.versions?.rows(name) ?? [];
    for (let i = rows.length - 1; i >= 0; i--) { const r = rows[i]; if (!r.void && !r.superseded) return r; }
    return null;
  }

  /** `retired/<name>/` holding only archives (no canonical): moved aside so the protocol's move can land; `error` when it holds a canonical. */
  private setAside(name: string, to: string): { dir: string | null; error?: string } {
    if (!fs.existsSync(to)) return { dir: null };
    if (fs.existsSync(path.join(to, 'SKILL.md'))) return { dir: null, error: 'already-retired' };
    const aside = `${to}.aside-${crypto.randomBytes(4).toString('hex')}`;
    const txId = crypto.randomBytes(8).toString('hex');
    this.journalMove('move-prepare', name, to, aside, 'retire:set-aside-archives', txId);
    try { this.rename(to, aside); } catch (err) { // @silent-fallback-ok — the refusal is returned to the caller by name on the next line; nothing was moved
      this.journalMove('move-void', name, to, aside, `retire:set-aside failed: ${(err as Error).message}`, txId);
      return { dir: null, error: `archives-in-the-way: ${(err as Error).message}` };
    }
    this.journalMove('move-commit', name, to, aside, 'retire:set-aside-archives', txId);
    return { dir: aside };
  }

  private restoreAside(aside: string | null, to: string): void {
    if (!aside || fs.existsSync(to)) return;
    try { this.rename(aside, to); } catch (err) { this.log(`[Retirer] could not put the archive directory back (${aside} → ${to}): ${(err as Error).message}`); }
  }

  /** Merge the set-aside archives (`renderings/`, older history) into the freshly moved `retired/<name>/`; nothing is deleted on a clash. */
  private mergeAside(aside: string | null, to: string): void {
    if (!aside) return;
    let entries: string[] = [];
    try { entries = fs.readdirSync(aside); } catch { return; } // @silent-fallback-ok — an aside dir that vanished has nothing to merge
    for (const e of entries) {
      const s = path.join(aside, e);
      let t = path.join(to, e);
      if (fs.existsSync(t)) t = `${t}.${crypto.randomBytes(3).toString('hex')}`;
      try { this.rename(s, t); } catch (err) { this.log(`[Retirer] could not merge ${s} into ${to}: ${(err as Error).message}`); }
    }
    try { if (fs.readdirSync(aside).length === 0) this.removeDir(aside, 'skill-learning:retire-aside-cleanup'); } catch (err) { this.log(`[Retirer] aside cleanup skipped: ${(err as Error).message}`); }
  }

  /** Before a restore: the archived renderings + sidecar move to `retired/_history/<name>/<retiredAt>/` (kept, never deleted). */
  private moveToHistory(name: string, from: string, retiredAt: string): { dir: string | null; error?: string } {
    const stamp = retiredAt.replace(/[-:.TZ]/g, '').slice(0, 14) || String(this.now());
    const dir = path.join(this.retiredRoot, '_history', name, stamp);
    const items = ['renderings', 'retired.json'].filter((i) => fs.existsSync(path.join(from, i)));
    if (items.length === 0) return { dir: null };
    fs.mkdirSync(dir, { recursive: true });
    for (const i of items) {
      const s = path.join(from, i);
      const t = fs.existsSync(path.join(dir, i)) ? path.join(dir, `${i}.${crypto.randomBytes(3).toString('hex')}`) : path.join(dir, i);
      const txId = crypto.randomBytes(8).toString('hex');
      this.journalMove('move-prepare', name, s, t, 'restore:to-history', txId);
      try { this.rename(s, t); } catch (err) { // @silent-fallback-ok — the refusal is returned by name on the next line (the restore is refused, the retired dir stays whole)
        this.journalMove('move-void', name, s, t, `restore:to-history failed: ${(err as Error).message}`, txId);
        return { dir, error: `history-move-failed: ${(err as Error).message}` };
      }
      this.journalMove('move-commit', name, s, t, 'restore:to-history', txId);
    }
    return { dir };
  }

  private moveFromHistory(dir: string | null, to: string): void {
    if (!dir) return;
    let entries: string[] = [];
    try { entries = fs.readdirSync(dir); } catch { return; } // @silent-fallback-ok — nothing to put back
    for (const e of entries) {
      try { this.rename(path.join(dir, e), path.join(to, e)); } catch (err) { this.log(`[Retirer] could not put ${e} back from history: ${(err as Error).message}`); }
    }
  }

  private async forget(rels: string[]): Promise<void> {
    try { await this.d.forgetRenderings?.(rels); } catch (err) { this.log(`[Retirer] reconciler forget failed: ${(err as Error).message}`); }
  }

  /** The protocol's journal row shape (same file, same txId scheme): its recovery completes or reverses a half-done move. */
  private journalMove(op: 'move-prepare' | 'move-commit' | 'move-void', name: string, from: string, to: string, detail: string, txId = crypto.randomBytes(8).toString('hex')): void {
    const row = { ts: new Date(this.now()).toISOString(), machineId: this.machineId, op, txId, name, commitOp: 'archive-rendering', from, to, detail };
    try {
      fs.mkdirSync(path.dirname(this.journalPath), { recursive: true, mode: 0o700 });
      const fd = fs.openSync(this.journalPath, 'a', 0o600);
      try { fs.writeSync(fd, JSON.stringify(row) + '\n'); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    } catch (err) {
      this.log(`[Retirer] journal append failed (${op} ${name}): ${(err as Error).message}`);
    }
  }

  private appendLog(row: Record<string, unknown>): void {
    if (this.d.appendLog) { try { this.d.appendLog(row); return; } catch (err) { this.log(`[Retirer] log append failed: ${(err as Error).message}`); return; } }
    try {
      const file = path.join(this.d.stateDir, SKILL_LEARNING_PATHS.log);
      fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
      fs.appendFileSync(file, `${JSON.stringify({ ts: new Date(this.now()).toISOString(), machineId: this.machineId, ...row })}\n`, { mode: 0o600 });
    } catch (err) {
      this.log(`[Retirer] log append failed: ${(err as Error).message}`);
    }
  }

  private readIf(file: string): string | null {
    try { return fs.readFileSync(file, 'utf-8'); } catch { return null; } // @silent-fallback-ok — absent reads as null (no file); every caller treats null explicitly
  }

  private serial<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.chain.then(fn, fn);
    this.chain = next.catch(() => undefined);
    return next;
  }
}
