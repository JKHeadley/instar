/**
 * TaskFlow SQLite store.
 *
 * Single-writer (the instar server process). Wraps mutations in
 * `BEGIN IMMEDIATE` so the read-then-write check-and-discriminate sequence
 * inside each operation is consistent.
 *
 * No JSONL dual-write — SQLite WAL is the durability journal (see spec §
 * Storage and Concurrency, "DR and audit trail").
 */

import fs from 'node:fs';
import path from 'node:path';
import {
  TaskFlowRecord,
  TaskFlowStatus,
  WaitJson,
  RequesterOrigin,
  SupersededRef,
  TaskNotifyPolicy,
  MAX_BUSY_RETRIES,
  BUSY_BASE_DELAY_MS,
  BUSY_CAP_DELAY_MS,
} from './task-flow-types.js';

type Database = import('better-sqlite3').Database;

interface FlowRow {
  flow_id: string;
  owner_key: string;
  controller_id: string;
  controller_instance_id: string;
  controller_heartbeat_at: number;
  revision: number;
  status: string;
  notify_policy: string;
  goal: string;
  current_step: string | null;
  state_json: string | null;
  wait_json: string | null;
  wait_instance_id: string | null;
  wait_started_at: number | null;
  wait_kind: string | null;
  cancel_requested_at: number | null;
  cancel_requested_by: string | null;
  created_at: number;
  updated_at: number;
  ended_at: number | null;
  superseded_by: string | null;
  privacy_scope: string | null;
  requester_origin: string | null;
}

export interface StoreOpenOptions {
  dbPath: string;
}

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS flows (
  flow_id TEXT PRIMARY KEY,
  owner_key TEXT NOT NULL,
  controller_id TEXT NOT NULL,
  controller_instance_id TEXT NOT NULL,
  controller_heartbeat_at INTEGER NOT NULL,
  revision INTEGER NOT NULL,
  status TEXT NOT NULL,
  notify_policy TEXT NOT NULL,
  goal TEXT NOT NULL,
  current_step TEXT,
  state_json TEXT,
  wait_json TEXT,
  wait_instance_id TEXT,
  wait_started_at INTEGER,
  wait_kind TEXT,
  cancel_requested_at INTEGER,
  cancel_requested_by TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  ended_at INTEGER,
  superseded_by TEXT,
  privacy_scope TEXT,
  requester_origin TEXT
);
CREATE INDEX IF NOT EXISTS flows_status_updated_at  ON flows (status, updated_at);
CREATE INDEX IF NOT EXISTS flows_controller_status  ON flows (controller_id, status);
CREATE INDEX IF NOT EXISTS flows_owner_key          ON flows (owner_key);
CREATE INDEX IF NOT EXISTS flows_wait_instance_id   ON flows (wait_instance_id) WHERE wait_instance_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS flows_wait_kind_started  ON flows (wait_kind, wait_started_at) WHERE status='waiting';
CREATE INDEX IF NOT EXISTS flows_running_heartbeat  ON flows (controller_heartbeat_at) WHERE status='running';

CREATE TABLE IF NOT EXISTS flow_create_idem (
  controller_id TEXT NOT NULL,
  owner_key TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  flow_id TEXT NOT NULL,
  PRIMARY KEY (controller_id, owner_key, idempotency_key)
);
`;

export class TaskFlowStore {
  private db!: Database;
  private opened = false;

  constructor(private readonly opts: StoreOpenOptions) {}

  async open(): Promise<void> {
    if (this.opened) return;
    let BetterSqlite3: any;
    try {
      BetterSqlite3 = await import('better-sqlite3');
    } catch {
      throw new Error('TaskFlowStore requires better-sqlite3. Run: npm install better-sqlite3');
    }
    const Constructor = BetterSqlite3.default || BetterSqlite3;
    const dbDir = path.dirname(this.opts.dbPath);
    if (!fs.existsSync(dbDir)) fs.mkdirSync(dbDir, { recursive: true });
    this.db = Constructor(this.opts.dbPath) as Database;
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('busy_timeout = 30000');
    this.db.pragma('synchronous = NORMAL');
    this.db.pragma('foreign_keys = ON');
    this.db.exec(SCHEMA_SQL);
    this.opened = true;
  }

  close(): void {
    if (this.opened) {
      this.db.close();
      this.opened = false;
    }
  }

  rawDb(): Database {
    return this.db;
  }

  // ───────────── helpers ─────────────

  private rowToRecord(r: FlowRow): TaskFlowRecord {
    const rec: TaskFlowRecord = {
      flowId: r.flow_id,
      ownerKey: r.owner_key,
      controllerId: r.controller_id,
      controllerInstanceId: r.controller_instance_id,
      controllerHeartbeatAt: r.controller_heartbeat_at,
      revision: r.revision,
      status: r.status as TaskFlowStatus,
      notifyPolicy: JSON.parse(r.notify_policy) as TaskNotifyPolicy,
      goal: r.goal,
      createdAt: r.created_at,
      updatedAt: r.updated_at,
    };
    if (r.current_step !== null) rec.currentStep = r.current_step;
    if (r.state_json !== null) rec.stateJson = JSON.parse(r.state_json);
    if (r.wait_json !== null) rec.waitJson = JSON.parse(r.wait_json) as WaitJson;
    if (r.wait_instance_id !== null) rec.waitInstanceId = r.wait_instance_id;
    if (r.wait_started_at !== null) rec.waitStartedAt = r.wait_started_at;
    if (r.cancel_requested_at !== null) rec.cancelRequestedAt = r.cancel_requested_at;
    if (r.cancel_requested_by !== null)
      rec.cancelRequestedBy = JSON.parse(r.cancel_requested_by) as RequesterOrigin;
    if (r.ended_at !== null) rec.endedAt = r.ended_at;
    if (r.superseded_by !== null)
      rec.supersededBy = JSON.parse(r.superseded_by) as SupersededRef;
    if (r.privacy_scope !== null) rec.privacyScope = r.privacy_scope as TaskFlowRecord['privacyScope'];
    if (r.requester_origin !== null)
      rec.requesterOrigin = JSON.parse(r.requester_origin) as RequesterOrigin;
    return rec;
  }

  /**
   * Run a write closure inside `BEGIN IMMEDIATE` with retry-on-busy.
   * Returns the closure's result.
   */
  async withWriteTransaction<T>(fn: () => T): Promise<T> {
    let attempt = 0;
    let lastErr: unknown;
    while (attempt <= MAX_BUSY_RETRIES) {
      try {
        const txn = this.db.transaction(fn);
        // exclusive=false, immediate=true matches BEGIN IMMEDIATE behavior.
        return (txn as any).immediate();
      } catch (err: any) {
        lastErr = err;
        if (err?.code === 'SQLITE_BUSY' && attempt < MAX_BUSY_RETRIES) {
          const delay = Math.min(BUSY_BASE_DELAY_MS * Math.pow(2, attempt), BUSY_CAP_DELAY_MS);
          await new Promise((r) => setTimeout(r, delay));
          attempt++;
          continue;
        }
        throw err;
      }
    }
    throw lastErr;
  }

  // ───────────── reads ─────────────

  getFlow(flowId: string): TaskFlowRecord | null {
    const row = this.db
      .prepare('SELECT * FROM flows WHERE flow_id = ?')
      .get(flowId) as FlowRow | undefined;
    return row ? this.rowToRecord(row) : null;
  }

  getFlowMeta(flowId: string): { revision: number; status: TaskFlowStatus; endedAt: number | null } | null {
    const row = this.db
      .prepare('SELECT revision, status, ended_at FROM flows WHERE flow_id = ?')
      .get(flowId) as { revision: number; status: string; ended_at: number | null } | undefined;
    if (!row) return null;
    return { revision: row.revision, status: row.status as TaskFlowStatus, endedAt: row.ended_at };
  }

  findIdempotent(
    controllerId: string,
    ownerKey: string,
    idempotencyKey: string
  ): TaskFlowRecord | null {
    const row = this.db
      .prepare(
        `SELECT f.* FROM flows f
         JOIN flow_create_idem i ON i.flow_id = f.flow_id
         WHERE i.controller_id = ? AND i.owner_key = ? AND i.idempotency_key = ?`
      )
      .get(controllerId, ownerKey, idempotencyKey) as FlowRow | undefined;
    return row ? this.rowToRecord(row) : null;
  }

  /**
   * Find a waiting `reply` flow for a (controllerId, channel, threadId, peer)
   * tuple — used by setFlowWaiting collision detection AND by MessageRouter.
   */
  findWaitingReplyByTarget(args: {
    channel: string;
    threadId: string;
    peer: string;
    controllerId?: string;
  }): TaskFlowRecord[] {
    const params: any[] = [args.channel, args.threadId, args.peer];
    let sql = `SELECT * FROM flows WHERE status='waiting' AND wait_kind='reply'
      AND json_extract(wait_json, '$.channel') = ?
      AND json_extract(wait_json, '$.threadId') = ?
      AND json_extract(wait_json, '$.peer') = ?`;
    if (args.controllerId) {
      sql += ' AND controller_id = ?';
      params.push(args.controllerId);
    }
    const rows = this.db.prepare(sql).all(...params) as FlowRow[];
    return rows.map((r) => this.rowToRecord(r));
  }

  findWaitingByCorrelation(args: {
    waitKind: 'external-call' | 'cross-agent-callback';
    correlationId: string;
  }): TaskFlowRecord[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM flows WHERE status='waiting' AND wait_kind = ?
           AND json_extract(wait_json, '$.correlationId') = ?`
      )
      .all(args.waitKind, args.correlationId) as FlowRow[];
    return rows.map((r) => this.rowToRecord(r));
  }

  findWaitingDue(nowMs: number): TaskFlowRecord[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM flows WHERE status='waiting' AND wait_kind='scheduled-tick'
           AND CAST(json_extract(wait_json, '$.dueAt') AS INTEGER) <= ?`
      )
      .all(nowMs) as FlowRow[];
    return rows.map((r) => this.rowToRecord(r));
  }

  findSweeperCandidates(): TaskFlowRecord[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM flows
         WHERE status='running' OR (status='waiting' AND wait_kind != 'scheduled-tick')`
      )
      .all() as FlowRow[];
    return rows.map((r) => this.rowToRecord(r));
  }

  // ───────────── writes ─────────────

  insertFlow(rec: TaskFlowRecord, idempotencyKey: string): void {
    const stmt = this.db.prepare(
      `INSERT INTO flows (
        flow_id, owner_key, controller_id, controller_instance_id, controller_heartbeat_at,
        revision, status, notify_policy, goal, current_step, state_json, wait_json,
        wait_instance_id, wait_started_at, wait_kind, cancel_requested_at, cancel_requested_by,
        created_at, updated_at, ended_at, superseded_by, privacy_scope, requester_origin
      ) VALUES (
        @flow_id, @owner_key, @controller_id, @controller_instance_id, @controller_heartbeat_at,
        @revision, @status, @notify_policy, @goal, @current_step, @state_json, @wait_json,
        @wait_instance_id, @wait_started_at, @wait_kind, @cancel_requested_at, @cancel_requested_by,
        @created_at, @updated_at, @ended_at, @superseded_by, @privacy_scope, @requester_origin
      )`
    );
    stmt.run({
      flow_id: rec.flowId,
      owner_key: rec.ownerKey,
      controller_id: rec.controllerId,
      controller_instance_id: rec.controllerInstanceId,
      controller_heartbeat_at: rec.controllerHeartbeatAt,
      revision: rec.revision,
      status: rec.status,
      notify_policy: JSON.stringify(rec.notifyPolicy),
      goal: rec.goal,
      current_step: rec.currentStep ?? null,
      state_json: rec.stateJson === undefined ? null : JSON.stringify(rec.stateJson),
      wait_json: rec.waitJson ? JSON.stringify(rec.waitJson) : null,
      wait_instance_id: rec.waitInstanceId ?? null,
      wait_started_at: rec.waitStartedAt ?? null,
      wait_kind: rec.waitJson?.kind ?? null,
      cancel_requested_at: rec.cancelRequestedAt ?? null,
      cancel_requested_by: rec.cancelRequestedBy
        ? JSON.stringify(rec.cancelRequestedBy)
        : null,
      created_at: rec.createdAt,
      updated_at: rec.updatedAt,
      ended_at: rec.endedAt ?? null,
      superseded_by: rec.supersededBy ? JSON.stringify(rec.supersededBy) : null,
      privacy_scope: rec.privacyScope ?? null,
      requester_origin: rec.requesterOrigin ? JSON.stringify(rec.requesterOrigin) : null,
    });
    this.db
      .prepare(
        `INSERT INTO flow_create_idem (controller_id, owner_key, idempotency_key, flow_id)
         VALUES (?, ?, ?, ?)`
      )
      .run(rec.controllerId, rec.ownerKey, idempotencyKey, rec.flowId);
  }

  /**
   * OCC patch: sets every column on the row to match `next`, gated on
   * `expectedRevision`. Returns the number of rows updated.
   */
  patchFlowOcc(next: TaskFlowRecord, expectedRevision: number): number {
    const result = this.db
      .prepare(
        `UPDATE flows SET
           controller_instance_id = @controller_instance_id,
           controller_heartbeat_at = @controller_heartbeat_at,
           revision = @revision,
           status = @status,
           notify_policy = @notify_policy,
           goal = @goal,
           current_step = @current_step,
           state_json = @state_json,
           wait_json = @wait_json,
           wait_instance_id = @wait_instance_id,
           wait_started_at = @wait_started_at,
           wait_kind = @wait_kind,
           cancel_requested_at = @cancel_requested_at,
           cancel_requested_by = @cancel_requested_by,
           updated_at = @updated_at,
           ended_at = @ended_at,
           superseded_by = @superseded_by,
           privacy_scope = @privacy_scope,
           requester_origin = @requester_origin
         WHERE flow_id = @flow_id AND revision = @expected_revision`
      )
      .run({
        flow_id: next.flowId,
        expected_revision: expectedRevision,
        controller_instance_id: next.controllerInstanceId,
        controller_heartbeat_at: next.controllerHeartbeatAt,
        revision: next.revision,
        status: next.status,
        notify_policy: JSON.stringify(next.notifyPolicy),
        goal: next.goal,
        current_step: next.currentStep ?? null,
        state_json: next.stateJson === undefined ? null : JSON.stringify(next.stateJson),
        wait_json: next.waitJson ? JSON.stringify(next.waitJson) : null,
        wait_instance_id: next.waitInstanceId ?? null,
        wait_started_at: next.waitStartedAt ?? null,
        wait_kind: next.waitJson?.kind ?? null,
        cancel_requested_at: next.cancelRequestedAt ?? null,
        cancel_requested_by: next.cancelRequestedBy
          ? JSON.stringify(next.cancelRequestedBy)
          : null,
        updated_at: next.updatedAt,
        ended_at: next.endedAt ?? null,
        superseded_by: next.supersededBy ? JSON.stringify(next.supersededBy) : null,
        privacy_scope: next.privacyScope ?? null,
        requester_origin: next.requesterOrigin ? JSON.stringify(next.requesterOrigin) : null,
      });
    return result.changes;
  }

  /**
   * Cheap pingFlow update — does NOT bump revision. Returns rows updated (0 or 1).
   */
  pingFlowRow(args: {
    flowId: string;
    controllerInstanceId: string;
    controllerHeartbeatAt: number;
    updatedAt: number;
  }): number {
    return this.db
      .prepare(
        `UPDATE flows SET
           controller_instance_id = @cii,
           controller_heartbeat_at = @hb,
           updated_at = @ua
         WHERE flow_id = @flow_id AND status = 'running'`
      )
      .run({
        flow_id: args.flowId,
        cii: args.controllerInstanceId,
        hb: args.controllerHeartbeatAt,
        ua: args.updatedAt,
      }).changes;
  }
}
