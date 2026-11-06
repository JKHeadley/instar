/**
 * Skill Learning Sentinel — run windows and outcome rows (spec §3.6, §3.9).
 *
 * Every verified/asserted request row opens a RUN. Its window closes at the next operator message on the
 * topic after ≥ 1 delivered agent reply (that message is inside the window and is recorded as `closedBy`
 * so the classifier's `outcomeOfPrevRun` for it can be attributed back — durably, across restarts), at
 * the session clock's end for a time-boxed run, or at 2 h. A new request before any reply closes the
 * previous run as `unknown`. Silence is never a label: a close without a classifier verdict is `unknown`.
 *
 * Labels are written as outcome REVISIONS (never rewritten): revision 0 at close, a later revision when
 * the classifier attributes, another when a late correction flips a provisional run (which also appends
 * an `improve` event row for slice 3's reviewer), and a final one when `windowDays` expire. Every
 * non-`corrected` label is provisional until then.
 *
 * The §3.9 join: a slice-0 telemetry row (`<stateDir>/skill-telemetry/<machine>.jsonl`, any machine) whose
 * `session_name` is the run's session (or whose `session_id` is the session's Claude UUID), whose
 * `topic_id` is the run's topic and whose `ts` lies inside the window ⇒ `skillUsed`, corroborated only
 * when a bounded read of the session transcript shows the Skill tool call; `misfire` when the request's
 * key ≠ the skill's key; `versionUncertain` when the reconciler journal holds a `render-commit` for that
 * skill inside the window. No telemetry row ⇒ no claim (never "not used").
 */
import fs from 'node:fs';
import path from 'node:path';
import yaml from 'js-yaml';
import { resolveFrameworkTranscriptPath, type SessionFramework } from '../../core/FrameworkSessionStore.js';
import { extractTurnEvidenceFromRows } from '../TurnEvidence.js';
import type { Ledger } from './Ledger.js';
import { newEventId, type SeamEvent } from './SeamFilter.js';
import { OUTCOME_PRECEDENCE, type EventRow, type OutcomeLabel, type OutcomeRow, type RequestRow, type RowSource } from './types.js';

export const RUN_WINDOW_MS = 2 * 60 * 60 * 1000;
const DEFAULT_TRANSCRIPT_SCAN_BYTES = 4 * 1024 * 1024;
const WINDOW_SLACK_MS = 60_000;

export interface TelemetryRow {
  ts: string;
  skill: string;
  session_id: string;
  session_name: string;
  topic_id: string;
  machine_id: string;
  content_hash: string;
}

export interface OutcomesDeps {
  ledger: Ledger;
  machineId: string;
  stateDir: string;
  projectDir: string;
  /** `defaultGate.windowDays` — provisional labels finalize after it. */
  windowDays: number;
  /** `evidence.transcriptScanBytes`. Default 4 MB. */
  transcriptScanBytes?: number;
  /** `StateManager.findSessionByTmux(name)` projection. */
  findSession?: (sessionName: string) => { claudeSessionId?: string; framework?: SessionFramework } | undefined;
  /** ISO end of the time-boxed session serving a topic, or null when unbounded (`readSessionClocks`). */
  sessionClockEnd?: (topicId: string) => string | null;
  /**
   * Does this machine hold the operator-messaging lease (§3.2 single writer)? Outcome REVISIONS —
   * windowDays finalization and the late-correction flip — are written only by the holder, so two
   * machines never produce competing revisions. Default: true (a single-machine agent is never observe-only).
   */
  holdsLease?: () => boolean;
  /** The learned skill's procedure key (canonical frontmatter `metadata.instar-learned-key`); default reads `.instar/skills/<skill>/SKILL.md`. */
  skillKeyFor?: (skill: string) => string | null;
  /** Test seam for the transcript path. */
  transcriptPath?: (opts: { framework: SessionFramework; sessionId: string; projectDir: string }) => string;
  now?: () => number;
  logger?: (message: string) => void;
}

interface OpenRun {
  runId: string;
  topicId: string;
  sessionName?: string;
  source: RowSource;
  windowStart: string;
  replies: number;
  procedureKey?: string;
}

export interface OutcomesCounters {
  opened: number;
  closedByMessage: number;
  closedByNewRequest: number;
  closedByTimeout: number;
  closedBySessionClock: number;
  attributed: number;
  lateFlips: number;
  finalized: number;
  joins: number;
  corroborated: number;
  misfires: number;
  versionUncertain: number;
  appendErrors: number;
}

export class Outcomes {
  private readonly deps: OutcomesDeps;
  private readonly now: () => number;
  private readonly runs = new Map<string, OpenRun>();
  private readonly inflight = new Set<Promise<void>>();
  private readonly c: OutcomesCounters = {
    opened: 0, closedByMessage: 0, closedByNewRequest: 0, closedByTimeout: 0, closedBySessionClock: 0, attributed: 0,
    lateFlips: 0, finalized: 0, joins: 0, corroborated: 0, misfires: 0, versionUncertain: 0, appendErrors: 0,
  };

  constructor(deps: OutcomesDeps) {
    this.deps = deps;
    this.now = deps.now ?? (() => Date.now());
  }

  counters(): OutcomesCounters {
    return { ...this.c };
  }

  openRunCount(): number {
    return this.runs.size;
  }

  /** Re-open runs the ledger shows without an outcome (after a restart). Reply counts are unknown ⇒ 0. */
  start(): void {
    for (const row of this.deps.ledger.openRuns()) {
      if (!row.runId || this.runs.has(row.runId)) continue;
      this.runs.set(row.runId, {
        runId: row.runId, topicId: row.topicId, source: row.source, windowStart: row.at, replies: 0,
        ...(row.sessionName ? { sessionName: row.sessionName } : {}), ...(row.procedureKey ? { procedureKey: row.procedureKey } : {}),
      });
    }
  }

  /** Await every in-flight close (tests and shutdown). */
  async settle(): Promise<void> {
    while (this.inflight.size > 0) await Promise.allSettled([...this.inflight]);
  }

  // ─── Window rules (§3.6) ─────────────────────────────────────────────

  observe(event: SeamEvent): void {
    const open = [...this.runs.values()].filter((r) => r.topicId === event.topicId);
    if (event.kind === 'reply') {
      for (const r of open) r.replies += 1;
      return;
    }
    for (const r of open) {
      if (r.replies >= 1) {
        this.c.closedByMessage++;
        this.close(r, { windowEnd: event.at, closedBy: event.source });
      } else {
        this.c.closedByNewRequest++;
        this.close(r, { windowEnd: event.at });
      }
    }
    const row = event.row;
    if (!row?.runId) return;
    this.runs.set(row.runId, {
      runId: row.runId, topicId: row.topicId, source: row.source, windowStart: row.at, replies: 0,
      ...(row.sessionName ? { sessionName: row.sessionName } : {}),
    });
    this.c.opened++;
  }

  /** Timeouts, session-clock ends, and windowDays finalization. */
  tick(nowMs = this.now()): void {
    for (const r of [...this.runs.values()]) {
      const startMs = Date.parse(r.windowStart);
      const clockEnd = this.deps.sessionClockEnd?.(r.topicId) ?? null;
      const clockEndMs = clockEnd ? Date.parse(clockEnd) : NaN;
      if (Number.isFinite(clockEndMs) && clockEndMs <= nowMs && clockEndMs >= startMs) {
        this.c.closedBySessionClock++;
        this.close(r, { windowEnd: new Date(clockEndMs).toISOString() });
      } else if (Number.isFinite(startMs) && nowMs - startMs >= RUN_WINDOW_MS) {
        this.c.closedByTimeout++;
        this.close(r, { windowEnd: new Date(startMs + RUN_WINDOW_MS).toISOString() });
      }
    }
    if (this.deps.holdsLease?.() === false) return;   // finalization is a revision: holder only
    const cutoff = nowMs - this.deps.windowDays * 86_400_000;
    for (const o of this.deps.ledger.provisionalOutcomes()) {
      if (Date.parse(o.windowStart) < cutoff) {
        this.appendRevision(o, { provisional: false });
        this.c.finalized++;
      }
    }
  }

  /** The classifier keyed a request: carry the key onto its run (and onto an already-closed outcome). */
  noteClassified(row: RequestRow): void {
    if (!row.runId) return;
    const run = this.runs.get(row.runId);
    if (run) { if (row.procedureKey) run.procedureKey = row.procedureKey; return; }
    const latest = this.deps.ledger.latestOutcome(row.runId);
    if (latest && latest.procedureKey === '' && row.procedureKey) {
      const misfire = this.misfireFor(row.procedureKey, latest.skillUsed?.skill);
      this.appendRevision(latest, { procedureKey: row.procedureKey, ...(misfire === undefined ? {} : { misfire }) });
    }
  }

  /**
   * The classifier's `outcomeOfPrevRun` for the message that closed a window. `procedureKey` is the
   * closing message's own key (an `accepted-inferred` needs the same key as the run it labels). A
   * `corrected` verdict that closes no window flips the latest provisional run of that key (late
   * correction) and appends an `improve` event for the reviewer.
   */
  applyVerdict(input: { closingSource: RowSource; label: OutcomeLabel; procedureKey?: string }): 'attributed' | 'late-flip' | 'none' {
    const closed = this.deps.ledger.outcomeClosedBy(input.closingSource);
    if (closed) {
      let label = input.label;
      if (label === 'accepted-inferred' && (!input.procedureKey || closed.procedureKey !== input.procedureKey)) label = 'weak-positive';
      if (closed.label === 'corrected') return 'none'; // corrected is terminal
      this.appendRevision(closed, { label, provisional: label !== 'corrected' });
      this.c.attributed++;
      return 'attributed';
    }
    if (input.label !== 'corrected' || !input.procedureKey) return 'none';
    if (this.deps.holdsLease?.() === false) return 'none';   // a late flip is a revision: holder only
    const cutoff = this.now() - this.deps.windowDays * 86_400_000;
    const latest = this.deps.ledger.outcomesForKey(input.procedureKey)[0];
    if (!latest || !latest.provisional || Date.parse(latest.windowStart) < cutoff) return 'none';
    this.appendRevision(latest, { label: 'corrected', provisional: false });
    const ev: EventRow = {
      kind: 'event', eventId: newEventId(), event: 'improve', runId: latest.runId, procedureKey: latest.procedureKey,
      ...(latest.skillUsed ? { skill: latest.skillUsed.skill } : {}),
      reason: 'late correction attributed to the latest run of this key', at: new Date(this.now()).toISOString(), machineId: this.deps.machineId,
    };
    this.safeAppend(ev);
    this.c.lateFlips++;
    return 'late-flip';
  }

  /** `corroborated runs ÷ uses` per learned skill (§3.6 `measurableRate`). */
  measurableRates(): Record<string, { uses: number; corroborated: number; rate: number | null }> {
    const out: Record<string, { uses: number; corroborated: number; rate: number | null }> = {};
    for (const t of this.readTelemetry()) {
      out[t.skill] ??= { uses: 0, corroborated: 0, rate: null };
      out[t.skill].uses += 1;
    }
    for (const o of this.deps.ledger.allOutcomes()) {
      if (!o.skillUsed) continue;
      out[o.skillUsed.skill] ??= { uses: 0, corroborated: 0, rate: null };
      if (o.skillUsed.corroborated) out[o.skillUsed.skill].corroborated += 1;
    }
    for (const v of Object.values(out)) v.rate = v.uses > 0 ? v.corroborated / v.uses : null;
    return out;
  }

  // ─── Close + join ────────────────────────────────────────────────────

  private close(run: OpenRun, opts: { windowEnd: string; closedBy?: RowSource }): void {
    this.runs.delete(run.runId);
    const p = this.closeAsync(run, opts).catch((err) => {
      this.c.appendErrors++;
      this.deps.logger?.(`[SkillLearning/Outcomes] close failed for ${run.runId}: ${(err as Error).message}`);
    }).finally(() => { this.inflight.delete(p); });
    this.inflight.add(p);
  }

  private async closeAsync(run: OpenRun, opts: { windowEnd: string; closedBy?: RowSource }): Promise<void> {
    const skillUsed = await this.join(run, opts.windowEnd);
    const misfire = skillUsed ? this.misfireFor(run.procedureKey, skillUsed.skill) : undefined;
    const row: OutcomeRow = {
      kind: 'outcome', eventId: newEventId(), runId: run.runId, revision: 0, procedureKey: run.procedureKey ?? '',
      topicId: run.topicId, ...(run.sessionName ? { sessionName: run.sessionName } : {}), label: 'unknown', provisional: true,
      ...(skillUsed ? { skillUsed } : {}), ...(misfire === undefined ? {} : { misfire }),
      windowStart: run.windowStart, windowEnd: opts.windowEnd, ...(opts.closedBy ? { closedBy: opts.closedBy } : {}),
      at: new Date(this.now()).toISOString(), machineId: this.deps.machineId,
    };
    this.safeAppend(row);
  }

  private appendRevision(base: OutcomeRow, patch: Partial<Pick<OutcomeRow, 'label' | 'provisional' | 'procedureKey' | 'misfire' | 'skillUsed'>>): void {
    const latest = this.deps.ledger.latestOutcome(base.runId) ?? base;
    const row: OutcomeRow = {
      ...latest, ...patch, eventId: newEventId(), revision: latest.revision + 1,
      at: new Date(this.now()).toISOString(), machineId: this.deps.machineId,
    };
    delete row.conflict;
    this.safeAppend(row);
  }

  private safeAppend(row: OutcomeRow | EventRow): void {
    try { this.deps.ledger.append(row); } catch (err) {
      this.c.appendErrors++;
      this.deps.logger?.(`[SkillLearning/Outcomes] append failed: ${(err as Error).message}`);
    }
  }

  private misfireFor(requestKey: string | undefined, skill: string | undefined): boolean | undefined {
    if (!requestKey || !skill) return undefined;
    const skillKey = this.deps.skillKeyFor ? this.deps.skillKeyFor(skill) : this.defaultSkillKey(skill);
    if (!skillKey) return undefined;
    const misfire = skillKey !== requestKey;
    if (misfire) this.c.misfires++;
    return misfire;
  }

  private defaultSkillKey(skill: string): string | null {
    if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(skill)) return null;
    let raw: string;
    try { raw = fs.readFileSync(path.join(this.deps.projectDir, '.instar', 'skills', skill, 'SKILL.md'), 'utf-8'); } catch { return null; }
    const m = raw.match(/^---\r?\n([\s\S]*?)\r?\n---/);
    if (!m) return null;
    try {
      const fm = yaml.load(m[1], { schema: yaml.FAILSAFE_SCHEMA }) as { metadata?: Record<string, unknown> } | null;
      const key = fm?.metadata?.['instar-learned-key'];
      return typeof key === 'string' && key ? key : null;
    } catch { return null; }
  }

  private async join(run: OpenRun, windowEnd: string): Promise<OutcomeRow['skillUsed'] | undefined> {
    if (!run.topicId) return undefined;
    const startMs = Date.parse(run.windowStart) - WINDOW_SLACK_MS;
    const endMs = Date.parse(windowEnd) + WINDOW_SLACK_MS;
    const session = run.sessionName ? this.safeFindSession(run.sessionName) : undefined;
    const sessionId = session?.claudeSessionId;
    const rows = this.readTelemetry().filter((t) => {
      const ts = Date.parse(t.ts);
      if (!Number.isFinite(ts) || ts < startMs || ts > endMs) return false;
      if (t.topic_id !== run.topicId) return false;
      return (!!run.sessionName && t.session_name === run.sessionName) || (!!sessionId && t.session_id === sessionId);
    });
    if (rows.length === 0) return undefined;
    this.c.joins++;
    const first = rows[0];
    const corroborated = await this.transcriptShowsSkill(session?.framework ?? 'claude-code', sessionId, startMs, endMs);
    if (corroborated) this.c.corroborated++;
    const versionUncertain = this.renderCommitInside(first.skill, startMs, endMs);
    if (versionUncertain) this.c.versionUncertain++;
    return { skill: first.skill, contentHash: first.content_hash, corroborated, versionUncertain };
  }

  private safeFindSession(name: string): { claudeSessionId?: string; framework?: SessionFramework } | undefined {
    try { return this.deps.findSession?.(name); } catch { return undefined; }
  }

  /** Per-file parse cache keyed by (size, mtime): a file is re-read only when it changed. */
  private readonly telemetryCache = new Map<string, { size: number; mtimeMs: number; rows: TelemetryRow[] }>();

  readTelemetry(): TelemetryRow[] {
    const dir = path.join(this.deps.stateDir, 'skill-telemetry');
    let names: string[] = [];
    try { names = fs.readdirSync(dir).filter((n) => n.endsWith('.jsonl')); } catch { return []; }
    const out: TelemetryRow[] = [];
    const seen = new Set<string>();
    for (const n of names) {
      const file = path.join(dir, n);
      seen.add(file);
      let stat: fs.Stats;
      try { stat = fs.statSync(file); } catch { continue; }
      const cached = this.telemetryCache.get(file);
      if (cached && cached.size === stat.size && cached.mtimeMs === stat.mtimeMs) { out.push(...cached.rows); continue; }
      let raw: string;
      try { raw = fs.readFileSync(file, 'utf-8'); } catch { continue; }
      const rows: TelemetryRow[] = [];
      for (const line of raw.split('\n')) {
        if (!line.trim()) continue;
        try {
          const r = JSON.parse(line) as Partial<TelemetryRow>;
          if (typeof r.ts === 'string' && typeof r.skill === 'string') {
            rows.push({ ts: r.ts, skill: r.skill, session_id: String(r.session_id ?? ''), session_name: String(r.session_name ?? ''),
              topic_id: String(r.topic_id ?? ''), machine_id: String(r.machine_id ?? ''), content_hash: String(r.content_hash ?? 'unknown') });
          }
        } catch { /* torn line */ }
      }
      this.telemetryCache.set(file, { size: stat.size, mtimeMs: stat.mtimeMs, rows });
      out.push(...rows);
    }
    for (const k of [...this.telemetryCache.keys()]) if (!seen.has(k)) this.telemetryCache.delete(k);
    return out;
  }

  /** Bounded async read of the transcript tail; true only when a turn inside the window shows a Skill tool call. */
  private async transcriptShowsSkill(framework: SessionFramework, sessionId: string | undefined, startMs: number, endMs: number): Promise<boolean> {
    if (!sessionId) return false;
    let file = '';
    try {
      file = (this.deps.transcriptPath ?? resolveFrameworkTranscriptPath)({ framework, sessionId, projectDir: this.deps.projectDir });
    } catch { return false; }
    if (!file) return false;
    const bound = this.deps.transcriptScanBytes && this.deps.transcriptScanBytes > 0 ? this.deps.transcriptScanBytes : DEFAULT_TRANSCRIPT_SCAN_BYTES;
    let lines: string[];
    try {
      const stat = await fs.promises.stat(file);
      if (!stat.isFile()) return false;
      const start = Math.max(0, stat.size - bound);
      const fh = await fs.promises.open(file, 'r');
      const buf = Buffer.alloc(stat.size - start);
      try { await fh.read(buf, 0, buf.length, start); } finally { await fh.close(); }
      lines = buf.toString('utf8').split('\n');
      if (start > 0) lines.shift();
    } catch { return false; }
    // Group rows into turns at operator-message boundaries, then run the structural extractor per turn.
    const turns: Array<{ ts: number | null; lines: string[] }> = [];
    for (const line of lines) {
      if (!line.trim()) continue;
      let row: Record<string, unknown> | null = null;
      try { row = JSON.parse(line) as Record<string, unknown>; } catch { continue; }
      if (isOperatorRow(row) || turns.length === 0) {
        turns.push({ ts: typeof row.timestamp === 'string' ? Date.parse(row.timestamp) : null, lines: [] });
      }
      const turn = turns[turns.length - 1];
      if (turn.ts === null && typeof row.timestamp === 'string') turn.ts = Date.parse(row.timestamp);
      turn.lines.push(line);
    }
    for (const turn of turns) {
      if (turn.ts !== null && Number.isFinite(turn.ts) && (turn.ts < startMs || turn.ts > endMs)) continue;
      const ev = extractTurnEvidenceFromRows(turn.lines, false, { redactIdentifiers: true });
      if (ev.toolCalls.some((t) => t.tool === 'Skill')) return true;
    }
    return false;
  }

  private renderCommitInside(skill: string, startMs: number, endMs: number): boolean {
    const dir = path.join(this.deps.stateDir, 'skill-learning', 'journal');
    let names: string[] = [];
    try { names = fs.readdirSync(dir).filter((n) => n.endsWith('.jsonl')); } catch { return false; }
    for (const n of names) {
      let raw: string;
      try { raw = fs.readFileSync(path.join(dir, n), 'utf-8'); } catch { continue; }
      for (const line of raw.split('\n')) {
        if (!line.includes('render-commit')) continue;
        try {
          const r = JSON.parse(line) as { op?: string; skill?: string; ts?: string };
          if (r.op !== 'render-commit' || r.skill !== skill || typeof r.ts !== 'string') continue;
          const ts = Date.parse(r.ts);
          if (Number.isFinite(ts) && ts >= startMs && ts <= endMs) return true;
        } catch { /* torn line */ }
      }
    }
    return false;
  }
}

function isOperatorRow(row: Record<string, unknown>): boolean {
  const message = row.message && typeof row.message === 'object' ? row.message as Record<string, unknown> : null;
  const content = Array.isArray(message?.content) ? message!.content : Array.isArray(row.content) ? row.content : [];
  const toolResultOnly = content.length > 0 && content.every((b) => !!b && typeof b === 'object' && (b as { type?: unknown }).type === 'tool_result');
  return !toolResultOnly && (row.type === 'user' || row.role === 'user' || message?.role === 'user');
}

/** The reducer order is part of this module's public reasoning; re-exported for consumers. */
export { OUTCOME_PRECEDENCE };
