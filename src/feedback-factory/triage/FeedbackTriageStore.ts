/**
 * Triage disposition record (docs/specs/feedback-triage-and-execution.md §2).
 *
 * Lives in the drain's own feedback-drain.db (shared connection), so it rides the drain's
 * WAL, backup checkpoint and owner-epoch fence. Every mutation carries the caller's owner
 * epoch and is refused when a newer epoch has been recorded (a stale writer). The triage
 * record is the ONLY state triage writes: it never touches Cluster.status, report statuses,
 * or readiness state (spec Non-goals, Frontloaded Decision 1).
 */
import { createHash, createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import type { Database as BetterSqliteDatabase } from 'better-sqlite3';
import { DrainConflictError, type FeedbackDrainStore } from '../drain/FeedbackDrainStore.js';
import type { TriageBrief, TriageDisposition, TriageSeverity } from './triageFloors.js';

export type TriageState = 'untriaged' | 'queued' | 'work' | 'hold' | 'ignored';
export type GradeValue = 'right' | 'wrong' | 'unknown' | 'superseded';
export type GradeStrength = 'strong' | 'medium' | 'weak';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS triage (
  initiative_id TEXT PRIMARY KEY, cluster_id TEXT NOT NULL, feedback_work_key TEXT NOT NULL,
  state TEXT NOT NULL CHECK(state IN ('untriaged','queued','work','hold','ignored')),
  reason TEXT NOT NULL DEFAULT '', would_ignore_reason TEXT,
  severity TEXT, severity_raw TEXT, priority INTEGER, confidence REAL, effort TEXT,
  needs_spec INTEGER, user_facing INTEGER, summary TEXT, brief_json TEXT,
  duplicate_of TEXT, fixed_by TEXT, evidence_complete INTEGER,
  rank_tier INTEGER, rank_band INTEGER, single_report_critical INTEGER NOT NULL DEFAULT 0,
  duplicate_bonus INTEGER NOT NULL DEFAULT 0, applied_duplicate_count INTEGER NOT NULL DEFAULT 0,
  dup_applied_target TEXT, dup_applied_amount INTEGER NOT NULL DEFAULT 0,
  first_seen_at INTEGER NOT NULL, floors_json TEXT NOT NULL DEFAULT '[]', rule_default TEXT,
  bound_report_count INTEGER NOT NULL DEFAULT 0, hold_count INTEGER NOT NULL DEFAULT 0,
  next_review_at INTEGER, notified_at INTEGER, decided_at INTEGER, decided_tick TEXT,
  authority_generation INTEGER, owner_epoch INTEGER, packet_ref TEXT, correlation_id TEXT,
  last_requeued_at INTEGER, requeue_exempt INTEGER NOT NULL DEFAULT 0, requeue_reason TEXT,
  truncated_retry INTEGER NOT NULL DEFAULT 0, operator_override TEXT, expected_initiative_status TEXT,
  work_since INTEGER, work_paused_ms INTEGER NOT NULL DEFAULT 0, work_paused_since INTEGER,
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_triage_state ON triage(state, first_seen_at);
CREATE INDEX IF NOT EXISTS idx_triage_cluster ON triage(cluster_id);
CREATE TABLE IF NOT EXISTS triage_decisions (
  sequence INTEGER PRIMARY KEY AUTOINCREMENT, initiative_id TEXT NOT NULL, cluster_id TEXT NOT NULL,
  model_disposition TEXT NOT NULL, disposition TEXT NOT NULL, reason TEXT NOT NULL, would_ignore INTEGER NOT NULL,
  rule_default TEXT NOT NULL, shadow INTEGER NOT NULL, floors_json TEXT NOT NULL, keyword_floor INTEGER NOT NULL,
  packet_ref TEXT, correlation_id TEXT, bound_report_count INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_triage_decisions_time ON triage_decisions(created_at);
CREATE TABLE IF NOT EXISTS triage_grades (
  decision_sequence INTEGER NOT NULL, rule TEXT NOT NULL, grade TEXT NOT NULL CHECK(grade IN ('right','wrong','unknown','superseded')),
  strength TEXT NOT NULL CHECK(strength IN ('strong','medium','weak')), disposition TEXT NOT NULL, shadow INTEGER NOT NULL,
  created_at INTEGER NOT NULL, PRIMARY KEY(decision_sequence, rule)
);
CREATE TABLE IF NOT EXISTS triage_daily_usage (
  utc_day TEXT NOT NULL, kind TEXT NOT NULL, calls INTEGER NOT NULL DEFAULT 0, PRIMARY KEY(utc_day, kind)
);
CREATE TABLE IF NOT EXISTS triage_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS triage_plans (
  plan_id TEXT PRIMARY KEY, action TEXT NOT NULL, payload_json TEXT NOT NULL, rendered_text TEXT NOT NULL,
  nonce_hash TEXT NOT NULL, expires_at INTEGER NOT NULL, used_at INTEGER, created_at INTEGER NOT NULL
);
`;

export interface TriageRow {
  initiativeId: string;
  clusterId: string;
  feedbackWorkKey: string;
  state: TriageState;
  reason: string;
  wouldIgnoreReason: string | null;
  severity: TriageSeverity | null;
  severityRaw: TriageSeverity | null;
  priority: number | null;
  confidence: number | null;
  effort: string | null;
  needsSpec: boolean | null;
  userFacing: boolean | null;
  summary: string | null;
  brief: TriageBrief | null;
  duplicateOf: string | null;
  fixedBy: string | null;
  evidenceComplete: boolean | null;
  rankTier: number | null;
  rankBand: number | null;
  singleReportCritical: boolean;
  duplicateBonus: number;
  firstSeenAt: number;
  floors: string[];
  ruleDefault: TriageDisposition | null;
  boundReportCount: number;
  holdCount: number;
  nextReviewAt: number | null;
  notifiedAt: number | null;
  decidedAt: number | null;
  decidedTick: string | null;
  authorityGeneration: number | null;
  ownerEpoch: number | null;
  packetRef: string | null;
  correlationId: string | null;
  lastRequeuedAt: number | null;
  requeueExempt: boolean;
  requeueReason: string | null;
  truncatedRetry: boolean;
  operatorOverride: string | null;
  expectedInitiativeStatus: string | null;
  workSince: number | null;
  workPausedMs: number;
  workPausedSince: number | null;
  createdAt: number;
  updatedAt: number;
}

export interface DecisionWrite {
  initiativeId: string;
  tickId: string;
  state: Exclude<TriageState, 'untriaged' | 'queued'>;
  reason: string;
  wouldIgnoreReason: string | null;
  severity: TriageSeverity;
  priority: number;
  confidence: number;
  effort: string;
  needsSpec: boolean;
  userFacing: boolean;
  summary: string;
  brief: TriageBrief;
  duplicateOf: string | null;
  fixedBy: string | null;
  evidenceComplete: boolean;
  rankTier: number;
  rankBand: number;
  singleReportCritical: boolean;
  floors: string[];
  ruleDefault: TriageDisposition;
  boundReportCount: number;
  nextReviewAt: number | null;
  authorityGeneration: number;
  packetRef: string;
  correlationId: string | null;
  expectedInitiativeStatus: string;
  modelDisposition: TriageDisposition;
  wouldIgnore: boolean;
  shadow: boolean;
  keywordFloor: boolean;
  /** The applied duplicate's own report count, added to its target's effective recurrence. */
  duplicateReports?: number;
  /** The executor is unavailable right now: a new work item's 30-day ceiling clock starts paused. */
  workClockPaused?: boolean;
}

const clamp = (value: unknown, max: number): string => String(value ?? '').replace(/[\r\n\u0000-\u001f\u007f]/g, ' ').trim().slice(0, max);

export class FeedbackTriageStore {
  private readonly db: BetterSqliteDatabase;
  private readonly now: () => number;
  private readonly hmacKey: string | Buffer;

  constructor(private readonly drain: FeedbackDrainStore, opts: { hmacKey: string | Buffer; clock?: () => number }) {
    this.db = drain.sharedDatabase();
    this.now = opts.clock ?? Date.now;
    this.hmacKey = opts.hmacKey;
    this.db.exec(SCHEMA);
    const decisionColumns = new Set((this.db.pragma('table_info(triage_decisions)') as Array<{ name: string }>).map((row) => row.name));
    if (!decisionColumns.has('bound_report_count')) this.db.exec('ALTER TABLE triage_decisions ADD COLUMN bound_report_count INTEGER NOT NULL DEFAULT 0');
    const triageColumns = new Set((this.db.pragma('table_info(triage)') as Array<{ name: string }>).map((row) => row.name));
    if (!triageColumns.has('dup_applied_target')) this.db.exec('ALTER TABLE triage ADD COLUMN dup_applied_target TEXT');
    if (!triageColumns.has('dup_applied_amount')) this.db.exec('ALTER TABLE triage ADD COLUMN dup_applied_amount INTEGER NOT NULL DEFAULT 0');
  }

  /** Refuse a stale writer: the drain's recorded owner epoch or triage's own may never move back. */
  private fence(ownerEpoch: number): void {
    if (!Number.isSafeInteger(ownerEpoch) || ownerEpoch < 1) throw new DrainConflictError('triage owner epoch is invalid');
    const drainEpoch = this.drain.ownerAuthorityEpoch();
    if (drainEpoch !== null && ownerEpoch < drainEpoch) throw new DrainConflictError('triage owner epoch is stale');
    const recorded = Number(this.meta('owner_epoch') ?? 0);
    if (ownerEpoch < recorded) throw new DrainConflictError('triage owner epoch is stale');
    if (ownerEpoch > recorded) this.setMeta('owner_epoch', String(ownerEpoch));
  }

  /** Run `fn` in one immediate transaction under the owner fence. */
  fenced<T>(ownerEpoch: number, fn: () => T): T {
    return this.db.transaction(() => { this.fence(ownerEpoch); return fn(); }).immediate();
  }

  meta(key: string): string | null {
    const row = this.db.prepare('SELECT value FROM triage_meta WHERE key=?').get(key) as { value: string } | undefined;
    return row?.value ?? null;
  }

  setMeta(key: string, value: string): void {
    this.db.prepare('INSERT INTO triage_meta(key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(key, value);
  }

  metaJson<T>(key: string): T | null {
    const raw = this.meta(key);
    if (raw === null) return null;
    try { return JSON.parse(raw) as T; } catch { return null; }
  }

  get(initiativeId: string): TriageRow | null {
    const row = this.db.prepare('SELECT * FROM triage WHERE initiative_id=?').get(initiativeId) as Record<string, unknown> | undefined;
    return row ? fromRow(row) : null;
  }

  byCluster(clusterId: string): TriageRow | null {
    const row = this.db.prepare('SELECT * FROM triage WHERE cluster_id=? ORDER BY created_at DESC LIMIT 1').get(clusterId) as Record<string, unknown> | undefined;
    return row ? fromRow(row) : null;
  }

  all(): TriageRow[] {
    return (this.db.prepare('SELECT * FROM triage ORDER BY first_seen_at, initiative_id').all() as Record<string, unknown>[]).map(fromRow);
  }

  inState(...states: TriageState[]): TriageRow[] {
    const marks = states.map(() => '?').join(',');
    return (this.db.prepare(`SELECT * FROM triage WHERE state IN (${marks}) ORDER BY first_seen_at, initiative_id`).all(...states) as Record<string, unknown>[]).map(fromRow);
  }

  /** Register a feedback Initiative the first time triage sees it (idempotent). */
  ensure(ownerEpoch: number, input: { initiativeId: string; clusterId: string; feedbackWorkKey: string; firstSeenAt: number; reportCount: number }): TriageRow {
    return this.fenced(ownerEpoch, () => {
      const now = this.now();
      this.db.prepare(`INSERT OR IGNORE INTO triage(initiative_id,cluster_id,feedback_work_key,state,first_seen_at,bound_report_count,created_at,updated_at)
        VALUES (?,?,?,'untriaged',?,?,?,?)`).run(clamp(input.initiativeId, 120), clamp(input.clusterId, 200), clamp(input.feedbackWorkKey, 200),
        input.firstSeenAt, Math.max(0, Math.trunc(input.reportCount)), now, now);
      return this.get(input.initiativeId)!;
    });
  }

  /** Re-queue for triage (floor 10 is enforced by the caller; `exempt` marks the throttle-exempt first stale-write re-triage). */
  requeue(ownerEpoch: number, initiativeId: string, reason: string, opts: { exempt?: boolean; truncatedRetry?: boolean; countThrottle?: boolean } = {}): void {
    this.fenced(ownerEpoch, () => {
      const now = this.now();
      this.db.prepare(`UPDATE triage SET state='queued', requeue_reason=?, requeue_exempt=?, truncated_retry=?,
        last_requeued_at=CASE WHEN ? THEN ? ELSE last_requeued_at END, updated_at=? WHERE initiative_id=?`)
        .run(clamp(reason, 120), opts.exempt ? 1 : 0, opts.truncatedRetry ? 1 : 0, opts.countThrottle === false ? 0 : 1, now, now, initiativeId);
    });
  }

  recordOverride(ownerEpoch: number, initiativeId: string, override: string): void {
    this.fenced(ownerEpoch, () => {
      this.db.prepare(`UPDATE triage SET operator_override=?, expected_initiative_status=NULL, updated_at=? WHERE initiative_id=?`)
        .run(clamp(override, 200), this.now(), initiativeId);
    });
  }

  /** Write one applied decision and its audit row; returns the decision sequence. */
  writeDecision(ownerEpoch: number, input: DecisionWrite): number {
    return this.fenced(ownerEpoch, () => {
      const prior = this.get(input.initiativeId);
      if (!prior) throw new DrainConflictError('triage row missing');
      const now = this.now();
      const holdCount = prior.holdCount + (input.state === 'hold' ? 1 : 0);
      const workSince = input.state === 'work' ? (prior.state === 'work' && prior.workSince ? prior.workSince : now) : null;
      // notifiedAt survives a re-triage that reaches the SAME state and reason as the previous
      // decision (the row itself reads 'queued' by now, so compare against the decision record).
      const previous = this.latestDecisionFor(input.initiativeId);
      const keepNotified = previous !== null && previous.disposition === input.state && previous.reason === clamp(input.reason, 80);
      this.db.prepare(`UPDATE triage SET state=?, reason=?, would_ignore_reason=?, severity=?, severity_raw=?, priority=?, confidence=?, effort=?,
        needs_spec=?, user_facing=?, summary=?, brief_json=?, duplicate_of=?, fixed_by=?, evidence_complete=?, rank_tier=?, rank_band=?,
        single_report_critical=?, floors_json=?, rule_default=?, bound_report_count=?, hold_count=?, next_review_at=?, decided_at=?,
        decided_tick=?, authority_generation=?, owner_epoch=?, packet_ref=?, correlation_id=?, requeue_exempt=0, requeue_reason=NULL,
        truncated_retry=0, expected_initiative_status=?, work_since=?, work_paused_ms=CASE WHEN ?='work' AND state='work' THEN work_paused_ms ELSE 0 END,
        work_paused_since=CASE WHEN ?='work' AND ? THEN COALESCE(CASE WHEN state='work' THEN work_paused_since END, ?) ELSE NULL END, notified_at=CASE WHEN ? THEN notified_at ELSE NULL END, updated_at=? WHERE initiative_id=?`).run(
        input.state, clamp(input.reason, 80), input.wouldIgnoreReason ? clamp(input.wouldIgnoreReason, 80) : null,
        input.severity, input.severity, input.priority, input.confidence, input.effort, input.needsSpec ? 1 : 0, input.userFacing ? 1 : 0,
        input.summary, JSON.stringify(input.brief), input.duplicateOf, input.fixedBy, input.evidenceComplete ? 1 : 0, input.rankTier, input.rankBand,
        input.singleReportCritical ? 1 : 0, JSON.stringify(input.floors.slice(0, 20)), input.ruleDefault, input.boundReportCount, holdCount,
        input.nextReviewAt, now, input.tickId, input.authorityGeneration, ownerEpoch, input.packetRef, input.correlationId,
        input.expectedInitiativeStatus, workSince, input.state, input.state, input.workClockPaused ? 1 : 0, now, keepNotified ? 1 : 0, now, input.initiativeId);
      // Duplicates feed their target's effective recurrence. Each source records what it has
      // applied, so a re-triage applies only the difference and a source that stops being a
      // duplicate (or points elsewhere) takes its contribution back.
      const appliedRow = this.db.prepare('SELECT dup_applied_target t, dup_applied_amount a FROM triage WHERE initiative_id=?').get(input.initiativeId) as { t: string | null; a: number };
      const prevTarget = appliedRow.t;
      const prevAmount = Number(appliedRow.a ?? 0);
      const newTarget = input.duplicateOf && input.duplicateReports && input.duplicateReports > 0 ? input.duplicateOf : null;
      const newAmount = newTarget ? Math.trunc(input.duplicateReports!) : 0;
      const adjust = (target: string, delta: number, countDelta: number) => {
        if (delta === 0 && countDelta === 0) return;
        this.db.prepare(`UPDATE triage SET duplicate_bonus=MAX(0, duplicate_bonus+?), applied_duplicate_count=MAX(0, applied_duplicate_count+?), updated_at=? WHERE cluster_id=?`)
          .run(delta, countDelta, now, target);
      };
      if (prevTarget && prevTarget === newTarget) adjust(prevTarget, newAmount - prevAmount, 0);
      else {
        if (prevTarget) adjust(prevTarget, -prevAmount, -1);
        if (newTarget) adjust(newTarget, newAmount, 1);
      }
      this.db.prepare('UPDATE triage SET dup_applied_target=?, dup_applied_amount=? WHERE initiative_id=?').run(newTarget, newAmount, input.initiativeId);
      const result = this.db.prepare(`INSERT INTO triage_decisions(initiative_id,cluster_id,model_disposition,disposition,reason,would_ignore,rule_default,shadow,floors_json,keyword_floor,packet_ref,correlation_id,bound_report_count,created_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(input.initiativeId, prior.clusterId, input.modelDisposition, input.state, clamp(input.reason, 80),
        input.wouldIgnore ? 1 : 0, input.ruleDefault, input.shadow ? 1 : 0, JSON.stringify(input.floors.slice(0, 20)), input.keywordFloor ? 1 : 0,
        input.packetRef, input.correlationId, input.boundReportCount, now);
      return Number(result.lastInsertRowid);
    });
  }

  /** Forget the expected Initiative status (used when mapping the decision onto the Initiative failed). Caller fences. */
  clearExpectedStatus(initiativeId: string): void {
    this.db.prepare('UPDATE triage SET expected_initiative_status=NULL, updated_at=? WHERE initiative_id=?').run(this.now(), initiativeId);
  }

  /** Accumulate paused time on the work-queue ceiling clock (executor unavailable). */
  pauseWorkClock(ownerEpoch: number, paused: boolean): void {
    this.fenced(ownerEpoch, () => {
      const now = this.now();
      if (paused) {
        this.db.prepare(`UPDATE triage SET work_paused_since=? WHERE state='work' AND work_paused_since IS NULL`).run(now);
      } else {
        this.db.prepare(`UPDATE triage SET work_paused_ms=work_paused_ms+(?-work_paused_since), work_paused_since=NULL WHERE state='work' AND work_paused_since IS NOT NULL`).run(now);
      }
    });
  }

  markNotified(ownerEpoch: number, initiativeIds: string[]): void {
    if (initiativeIds.length === 0) return;
    this.fenced(ownerEpoch, () => {
      const now = this.now();
      const stmt = this.db.prepare('UPDATE triage SET notified_at=? WHERE initiative_id=? AND notified_at IS NULL');
      for (const id of initiativeIds) stmt.run(now, id);
    });
  }

  /** Recent counted decisions for the brake (newest last) plus 24 h volume and the total. */
  brakeWindow(now = this.now()): { window: boolean[]; last24h: number; total: number } {
    const rows = this.db.prepare('SELECT would_ignore FROM triage_decisions ORDER BY sequence DESC LIMIT 100').all() as Array<{ would_ignore: number }>;
    const last24h = (this.db.prepare('SELECT COUNT(*) n FROM triage_decisions WHERE created_at > ?').get(now - 86_400_000) as { n: number }).n;
    const total = (this.db.prepare('SELECT COUNT(*) n FROM triage_decisions').get() as { n: number }).n;
    return { window: rows.reverse().map((row) => row.would_ignore === 1), last24h, total };
  }

  /** Ignore share of the first 100 decisions (the shadow-period baseline), once they exist. */
  baselineIgnoreShare(): number | null {
    const rows = this.db.prepare('SELECT would_ignore FROM triage_decisions ORDER BY sequence ASC LIMIT 100').all() as Array<{ would_ignore: number }>;
    if (rows.length < 100) return null;
    return rows.filter((row) => row.would_ignore === 1).length / rows.length;
  }

  decisionsSince(since: number): Array<{ sequence: number; initiativeId: string; clusterId: string; modelDisposition: string; disposition: string; reason: string; ruleDefault: string; shadow: boolean; keywordFloor: boolean; floors: string[]; packetRef: string | null; createdAt: number; wouldIgnore: boolean }> {
    return (this.db.prepare('SELECT * FROM triage_decisions WHERE created_at >= ? ORDER BY sequence').all(since) as Record<string, unknown>[]).map((row) => ({
      sequence: Number(row.sequence), initiativeId: String(row.initiative_id), clusterId: String(row.cluster_id),
      modelDisposition: String(row.model_disposition), disposition: String(row.disposition), reason: String(row.reason),
      ruleDefault: String(row.rule_default), shadow: row.shadow === 1, keywordFloor: row.keyword_floor === 1,
      floors: safeJson<string[]>(String(row.floors_json), []), packetRef: row.packet_ref === null ? null : String(row.packet_ref),
      createdAt: Number(row.created_at), wouldIgnore: row.would_ignore === 1,
    }));
  }

  latestDecisionFor(initiativeId: string): { sequence: number; disposition: string; reason: string; modelDisposition: string; shadow: boolean; createdAt: number } | null {
    const row = this.db.prepare('SELECT sequence,disposition,reason,model_disposition,shadow,created_at FROM triage_decisions WHERE initiative_id=? ORDER BY sequence DESC LIMIT 1')
      .get(initiativeId) as Record<string, unknown> | undefined;
    return row ? { sequence: Number(row.sequence), disposition: String(row.disposition), reason: String(row.reason), modelDisposition: String(row.model_disposition), shadow: row.shadow === 1, createdAt: Number(row.created_at) } : null;
  }

  recordGrade(ownerEpoch: number, input: { decisionSequence: number; rule: string; grade: GradeValue; strength: GradeStrength; disposition: string; shadow: boolean }): boolean {
    return this.fenced(ownerEpoch, () => this.db.prepare(`INSERT OR IGNORE INTO triage_grades(decision_sequence,rule,grade,strength,disposition,shadow,created_at) VALUES (?,?,?,?,?,?,?)`)
      .run(input.decisionSequence, clamp(input.rule, 80), input.grade, input.strength, input.disposition, input.shadow ? 1 : 0, this.now()).changes === 1);
  }

  gradeCounts(): Array<{ grade: GradeValue; strength: GradeStrength; disposition: string; shadow: boolean; n: number }> {
    return (this.db.prepare(`SELECT g.grade grade, g.strength strength, d.model_disposition disposition, g.shadow shadow, COUNT(*) n
      FROM triage_grades g JOIN triage_decisions d ON d.sequence=g.decision_sequence GROUP BY g.grade, g.strength, d.model_disposition, g.shadow`).all() as Array<Record<string, unknown>>)
      .map((row) => ({ grade: row.grade as GradeValue, strength: row.strength as GradeStrength, disposition: String(row.disposition), shadow: row.shadow === 1, n: Number(row.n) }));
  }

  /** hold/ignore decisions made before `before` that carry no quiet-30d grade yet (bounded). */
  quietGradeCandidates(before: number, limit: number): Array<{ sequence: number; clusterId: string; disposition: string; shadow: boolean; boundReportCount: number }> {
    return (this.db.prepare(`SELECT d.sequence, d.cluster_id, d.disposition, d.shadow, d.bound_report_count FROM triage_decisions d
      WHERE d.disposition IN ('hold','ignored') AND d.created_at < ?
      AND NOT EXISTS (SELECT 1 FROM triage_grades g WHERE g.decision_sequence=d.sequence AND g.rule='quiet-30d')
      ORDER BY d.sequence LIMIT ?`).all(before, limit) as Array<Record<string, unknown>>).map((row) => ({
      sequence: Number(row.sequence), clusterId: String(row.cluster_id), disposition: String(row.disposition),
      shadow: row.shadow === 1, boundReportCount: Number(row.bound_report_count),
    }));
  }

  /** Would-ignore decisions older than `before` with no medium/strong or sampled grade yet (a weak quiet-30d grade does not exclude one), oldest first — the weekly sample pool. */
  ungradedIgnoreDecisions(before: number, limit: number): Array<{ sequence: number; initiativeId: string; packetRef: string | null; shadow: boolean; disposition: string }> {
    return (this.db.prepare(`SELECT d.sequence, d.initiative_id, d.packet_ref, d.shadow, d.disposition FROM triage_decisions d
      WHERE d.would_ignore=1 AND d.created_at < ? AND NOT EXISTS (SELECT 1 FROM triage_grades g WHERE g.decision_sequence=d.sequence
        AND (g.rule='cross-family-sample' OR g.strength IN ('medium','strong')))
      ORDER BY d.sequence LIMIT ?`).all(before, limit) as Array<Record<string, unknown>>).map((row) => ({
      sequence: Number(row.sequence), initiativeId: String(row.initiative_id), packetRef: row.packet_ref === null ? null : String(row.packet_ref),
      shadow: row.shadow === 1, disposition: String(row.disposition),
    }));
  }

  /** Daily sub-cap counters (re-triage, second-opinion, grading). Returns false when the reservation would exceed `cap`. */
  reserveSubcap(ownerEpoch: number, kind: string, calls: number, cap: number, now = this.now()): boolean {
    const day = new Date(now).toISOString().slice(0, 10);
    return this.fenced(ownerEpoch, () => {
      const used = this.subcapUsed(kind, now);
      if (used + calls > cap) return false;
      this.db.prepare(`INSERT INTO triage_daily_usage(utc_day,kind,calls) VALUES (?,?,?) ON CONFLICT(utc_day,kind) DO UPDATE SET calls=calls+excluded.calls`)
        .run(day, kind, calls);
      return true;
    });
  }

  subcapUsed(kind: string, now = this.now()): number {
    const day = new Date(now).toISOString().slice(0, 10);
    const row = this.db.prepare('SELECT calls FROM triage_daily_usage WHERE utc_day=? AND kind=?').get(day, kind) as { calls: number } | undefined;
    return Number(row?.calls ?? 0);
  }

  // ── PIN plan/commit (§5, Frontloaded Decision 7) ─────────────────────────────

  createPlan(input: { action: string; payload: Record<string, unknown>; renderedText: string; ttlMs?: number }): { planId: string; nonce: string; expiresAt: number; renderedText: string } {
    const now = this.now();
    const planId = `triage-plan:${randomUUID()}`;
    const nonce = randomUUID().replace(/-/g, '') + randomUUID().replace(/-/g, '');
    const expiresAt = now + Math.max(60_000, Math.min(60 * 60_000, input.ttlMs ?? 15 * 60_000));
    this.db.prepare(`INSERT INTO triage_plans(plan_id,action,payload_json,rendered_text,nonce_hash,expires_at,created_at) VALUES (?,?,?,?,?,?,?)`)
      .run(planId, input.action, JSON.stringify(input.payload), input.renderedText, this.hashNonce(nonce), expiresAt, now);
    this.db.prepare('DELETE FROM triage_plans WHERE rowid IN (SELECT rowid FROM triage_plans WHERE expires_at < ? ORDER BY expires_at LIMIT 100)').run(now - 24 * 60 * 60_000);
    return { planId, nonce, expiresAt, renderedText: input.renderedText };
  }

  /** Single-use consumption of a plan: the nonce must match, unexpired, unused. */
  consumePlan(planId: string, nonce: string): { action: string; payload: Record<string, unknown>; renderedText: string } {
    return this.db.transaction(() => {
      const row = this.db.prepare('SELECT * FROM triage_plans WHERE plan_id=?').get(planId) as Record<string, unknown> | undefined;
      if (!row) throw new DrainConflictError('plan not found');
      if (row.used_at !== null) throw new DrainConflictError('plan already used');
      if (Number(row.expires_at) < this.now()) throw new DrainConflictError('plan expired');
      const candidate = Buffer.from(this.hashNonce(String(nonce ?? '')), 'hex');
      const stored = Buffer.from(String(row.nonce_hash), 'hex');
      if (candidate.length !== stored.length || !timingSafeEqual(candidate, stored)) throw new DrainConflictError('plan nonce does not match');
      this.db.prepare('UPDATE triage_plans SET used_at=? WHERE plan_id=?').run(this.now(), planId);
      return { action: String(row.action), payload: safeJson<Record<string, unknown>>(String(row.payload_json), {}), renderedText: String(row.rendered_text) };
    }).immediate();
  }

  private hashNonce(nonce: string): string { return createHmac('sha256', this.hmacKey).update(`triage-plan:${nonce}`).digest('hex'); }

  /** Stable short reference for a packet file. */
  static packetRef(tickId: string, initiativeId: string): string {
    return `pkt-${createHash('sha256').update(`${tickId}:${initiativeId}`).digest('hex').slice(0, 24)}`;
  }
}

function safeJson<T>(raw: string, fallback: T): T {
  try { return JSON.parse(raw) as T; } catch { return fallback; }
}

function fromRow(row: Record<string, unknown>): TriageRow {
  const num = (v: unknown): number | null => (v === null || v === undefined ? null : Number(v));
  const bool = (v: unknown): boolean | null => (v === null || v === undefined ? null : Number(v) === 1);
  return {
    initiativeId: String(row.initiative_id), clusterId: String(row.cluster_id), feedbackWorkKey: String(row.feedback_work_key),
    state: row.state as TriageState, reason: String(row.reason ?? ''), wouldIgnoreReason: row.would_ignore_reason === null ? null : String(row.would_ignore_reason),
    severity: (row.severity ?? null) as TriageSeverity | null, severityRaw: (row.severity_raw ?? null) as TriageSeverity | null,
    priority: num(row.priority), confidence: num(row.confidence), effort: row.effort === null ? null : String(row.effort),
    needsSpec: bool(row.needs_spec), userFacing: bool(row.user_facing), summary: row.summary === null ? null : String(row.summary),
    brief: row.brief_json ? safeJson<TriageBrief | null>(String(row.brief_json), null) : null,
    duplicateOf: row.duplicate_of === null ? null : String(row.duplicate_of), fixedBy: row.fixed_by === null ? null : String(row.fixed_by),
    evidenceComplete: bool(row.evidence_complete), rankTier: num(row.rank_tier), rankBand: num(row.rank_band),
    singleReportCritical: Number(row.single_report_critical) === 1, duplicateBonus: Number(row.duplicate_bonus ?? 0),
    firstSeenAt: Number(row.first_seen_at), floors: safeJson<string[]>(String(row.floors_json ?? '[]'), []),
    ruleDefault: (row.rule_default ?? null) as TriageDisposition | null, boundReportCount: Number(row.bound_report_count ?? 0),
    holdCount: Number(row.hold_count ?? 0), nextReviewAt: num(row.next_review_at), notifiedAt: num(row.notified_at),
    decidedAt: num(row.decided_at), decidedTick: row.decided_tick === null ? null : String(row.decided_tick),
    authorityGeneration: num(row.authority_generation), ownerEpoch: num(row.owner_epoch),
    packetRef: row.packet_ref === null ? null : String(row.packet_ref), correlationId: row.correlation_id === null ? null : String(row.correlation_id),
    lastRequeuedAt: num(row.last_requeued_at), requeueExempt: Number(row.requeue_exempt) === 1,
    requeueReason: row.requeue_reason === null ? null : String(row.requeue_reason), truncatedRetry: Number(row.truncated_retry) === 1,
    operatorOverride: row.operator_override === null ? null : String(row.operator_override),
    expectedInitiativeStatus: row.expected_initiative_status === null ? null : String(row.expected_initiative_status),
    workSince: num(row.work_since), workPausedMs: Number(row.work_paused_ms ?? 0), workPausedSince: num(row.work_paused_since),
    createdAt: Number(row.created_at), updatedAt: Number(row.updated_at),
  };
}
