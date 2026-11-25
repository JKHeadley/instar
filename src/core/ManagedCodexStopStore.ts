import type { Database } from 'better-sqlite3';
import { decideManagedCodexStop } from './ManagedCodexStopDecision.js';
import type { ManagedStopEnrollment, ManagedStopInput } from './ManagedCodexStopDecision.js';

const RELEASED_WORK_PREFIX = 'released-launch:';

export interface OrdinaryWorkHost {
  machineId: string;
  osBootId: string;
}

export interface OrdinaryWorkProcess {
  pid: number;
  procStart: number | null;
  startedAt: string;
}

interface Claim {
  enrollment: ManagedStopEnrollment;
  roundKey?: string;
  osBootId?: string;
  rebootBudgetScope?: string;
  actionOpen: boolean;
  paused: boolean;
}

export type ManagedStopCallback = Omit<ManagedStopInput, 'actionOpen' | 'paused'>;
export type ManagedStopVerifiedFacts = Omit<ManagedStopCallback, 'sessionId' | 'enabled'>;

/** Local authority for newly admitted managed actions in the one-member slice. */
export class ManagedCodexStopStore {
  constructor(private readonly db: Database) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS managed_codex_work_claims (
        work_key TEXT PRIMARY KEY,
        session_id TEXT NOT NULL UNIQUE,
        claim_json TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS managed_codex_reboot_budget ON managed_codex_work_claims (
        json_extract(claim_json, '$.rebootBudgetScope'),
        json_extract(claim_json, '$.enrollment.machineId'),
        json_extract(claim_json, '$.enrollment.ownerEpoch')
      );
      CREATE TABLE IF NOT EXISTS ordinary_project_work_fences (
        work_key TEXT PRIMARY KEY,
        execution_id TEXT,
        worker_json TEXT,
        host_json TEXT
      );
      CREATE TABLE IF NOT EXISTS managed_codex_native_bindings (
        launch_id TEXT PRIMARY KEY,
        native_session_id TEXT NOT NULL UNIQUE
      );
    `);
    this.db.transaction(() => {
      const columns = db.pragma('table_info(ordinary_project_work_fences)') as Array<{ name: string }>;
      if (!columns.some(column => column.name === 'worker_json')) {
        db.exec('ALTER TABLE ordinary_project_work_fences ADD COLUMN worker_json TEXT');
      }
      if (!columns.some(column => column.name === 'host_json')) {
        db.exec('ALTER TABLE ordinary_project_work_fences ADD COLUMN host_json TEXT');
      }
    }).immediate();
  }

  reserve(workKey: string, input: Pick<ManagedStopEnrollment, 'sessionId' | 'machineId' | 'ownerEpoch' | 'remaining'>, roundKey?: string, osBootId?: string): boolean {
    if (!workKey || workKey.startsWith(RELEASED_WORK_PREFIX) || !input.sessionId || !input.machineId
      || !Number.isSafeInteger(input.ownerEpoch) || input.ownerEpoch < 0
      || !Number.isSafeInteger(input.remaining) || input.remaining < 0) return false;
    return this.db.transaction(() => {
      if (this.hasEnrollment(input.sessionId)) return false;
      const host = osBootId ? { machineId: input.machineId, osBootId } : undefined;
      if (this.hasOrdinaryFence(workKey) || (roundKey && this.hasOrdinaryFence(roundKey))) return false;
      const scope = roundKey ?? workKey;
      if (host && validHost(host)) this.retireManagedAfterHostReboot(scope, workKey, host, input.ownerEpoch);
      if (roundKey && this.hasWorkClaim(roundKey)) return false;
      const previousBudget = this.db.prepare(`
        SELECT MIN(json_extract(claim_json, '$.enrollment.remaining')) AS remaining
        FROM managed_codex_work_claims
        WHERE json_extract(claim_json, '$.rebootBudgetScope') = ?
          AND json_extract(claim_json, '$.enrollment.machineId') = ?
          AND json_extract(claim_json, '$.enrollment.ownerEpoch') = ?
      `).get(scope, input.machineId, input.ownerEpoch) as { remaining: number | null };
      const remaining = Math.min(input.remaining, previousBudget.remaining ?? input.remaining);
      return this.db.prepare('INSERT OR IGNORE INTO managed_codex_work_claims VALUES (?, ?, ?)')
        .run(workKey, input.sessionId, JSON.stringify({
          enrollment: { ...input, launchId: input.sessionId, remaining, state: 'pending', issuedCycles: [] }, actionOpen: true, paused: false, roundKey, osBootId,
        } satisfies Claim)).changes === 1;
    }).immediate();
  }

  /** Claims remain exclusive while a past worker could still actuate. */
  hasWorkClaim(workKey: string): boolean {
    return this.db.prepare(`
      SELECT 1 FROM managed_codex_work_claims
      WHERE work_key = ? OR (json_extract(claim_json, '$.roundKey') = ? AND instr(work_key, ?) <> 1)
    `).get(workKey, workKey, RELEASED_WORK_PREFIX) !== undefined;
  }

  /** Reserve every item before an ordinary process can start. */
  reserveOrdinaryWork(workKeys: readonly string[], executionId: string, host?: OrdinaryWorkHost): boolean {
    if (!executionId || workKeys.length === 0) return false;
    return this.db.transaction(() => {
      const keys = [...new Set(workKeys)];
      if (keys.some(key => !key || this.hasWorkClaim(key) || this.hasOrdinaryFence(key))) return false;
      const write = this.db.prepare(`
        INSERT INTO ordinary_project_work_fences (work_key, execution_id, host_json) VALUES (?, ?, ?)
        ON CONFLICT(work_key) DO UPDATE SET execution_id = excluded.execution_id, worker_json = NULL, host_json = excluded.host_json
      `);
      const hostJson = host && validHost(host) ? JSON.stringify(host) : null;
      for (const key of keys) write.run(key, executionId, hostJson);
      return true;
    }).immediate();
  }

  /** Record identity only for the execution that still owns the fence. */
  recordOrdinaryProcess(executionId: string, worker: OrdinaryWorkProcess): boolean {
    if (!Number.isSafeInteger(worker.pid) || worker.pid <= 0) return false;
    return this.db.prepare(`
      UPDATE ordinary_project_work_fences SET worker_json = ?
      WHERE execution_id = ? AND worker_json IS NULL
    `).run(JSON.stringify(worker), executionId).changes > 0;
  }

  /** Caller has confirmed this exact execution never started or has stopped. */
  settleOrdinaryWork(executionId: string): void {
    this.db.prepare('UPDATE ordinary_project_work_fences SET execution_id = NULL, worker_json = NULL, host_json = NULL WHERE execution_id = ?')
      .run(executionId);
  }

  /** The same physical host has rebooted since this work was reserved. */
  settleOrdinaryWorkAfterHostReboot(workKey: string, current: OrdinaryWorkHost): boolean {
    if (!validHost(current)) return false;
    return this.db.transaction(() => {
      const row = this.db.prepare(`
        SELECT execution_id, host_json FROM ordinary_project_work_fences
        WHERE work_key = ? AND execution_id IS NOT NULL
      `).get(workKey) as { execution_id: string; host_json: string | null } | undefined;
      if (!row?.host_json) return false;

      let previous: OrdinaryWorkHost;
      try {
        previous = JSON.parse(row.host_json);
      } catch {
        return false;
      }
      if (!validHost(previous) || previous.machineId !== current.machineId
        || previous.osBootId.toLowerCase() === current.osBootId.toLowerCase()) return false;
      this.settleOrdinaryWork(row.execution_id);
      return true;
    }).immediate();
  }

  private hasOrdinaryFence(workKey: string): boolean {
    return this.db.prepare('SELECT 1 FROM ordinary_project_work_fences WHERE work_key = ? AND execution_id IS NOT NULL')
      .get(workKey) !== undefined;
  }

  activate(sessionId: string): boolean {
    return this.change(sessionId, claim => claim.enrollment.state === 'pending'
      ? { ...claim, enrollment: { ...claim.enrollment, state: 'active' } }
      : claim);
  }

  /** Bind the verified native identity after the reserved launch establishes ownership. */
  bindNative(launchId: string, nativeSessionId: string, homeIdentity?: string): boolean {
    if (!nativeSessionId || launchId === nativeSessionId) return false;
    return this.db.transaction(() => {
      const claim = this.read(launchId);
      if (!claim || claim.enrollment.state !== 'pending'
        || !claim.actionOpen || claim.paused || this.hasEnrollment(nativeSessionId)) return false;

      this.db.prepare('INSERT INTO managed_codex_native_bindings VALUES (?, ?)').run(launchId, nativeSessionId);
      this.write(launchId, {
        ...claim,
        enrollment: { ...claim.enrollment, sessionId: nativeSessionId, homeIdentity, state: 'active' },
      });
      return true;
    }).immediate();
  }

  private retireManagedAfterHostReboot(scope: string, workKey: string, current: OrdinaryWorkHost, ownerEpoch: number): void {
    const rows = this.db.prepare(`
      SELECT session_id, claim_json FROM managed_codex_work_claims
      WHERE instr(work_key, ?) <> 1 AND (work_key = ? OR json_extract(claim_json, '$.roundKey') = ?)
      LIMIT 2
    `).all(RELEASED_WORK_PREFIX, scope, scope) as Array<{ session_id: string; claim_json: string }>;
    if (rows.length !== 1) return;
    const row = rows[0];
    const target = this.db.prepare('SELECT session_id FROM managed_codex_work_claims WHERE work_key = ?')
      .get(workKey) as { session_id: string } | undefined;
    if (target && target.session_id !== row.session_id) return;
    const claim = JSON.parse(row.claim_json) as Claim;
    if (claim.enrollment.machineId !== current.machineId || claim.enrollment.ownerEpoch !== ownerEpoch
      || !claim.osBootId || !validHost({ machineId: claim.enrollment.machineId, osBootId: claim.osBootId })
      || claim.osBootId.toLowerCase() === current.osBootId.toLowerCase()
      || claim.paused || (!claim.actionOpen && claim.enrollment.state !== 'retired')) return;
    this.retireAndFree(row.session_id, { ...claim, rebootBudgetScope: scope });
  }

  /** Free the work key and retain the non-actuating launch identity. */
  releaseUnstarted(launchId: string): boolean {
    return this.db.transaction(() => {
      const claim = this.read(launchId);
      if (claim?.enrollment.state !== 'pending') return false;
      return this.retireAndFree(launchId, claim);
    }).immediate();
  }

  private retireAndFree(launchId: string, claim: Claim): boolean {
    const retired: Claim = {
      ...claim, actionOpen: false, enrollment: { ...claim.enrollment, state: 'retired' },
    };
    return this.db.prepare('UPDATE managed_codex_work_claims SET work_key = ?, claim_json = ? WHERE session_id = ?')
      .run(RELEASED_WORK_PREFIX + launchId, JSON.stringify(retired), launchId).changes === 1;
  }

  /** Keep an aborted launch classified as managed without issuing a directive. */
  abortPending(launchId: string): boolean {
    return this.change(launchId, claim => claim.enrollment.state === 'pending'
      ? { ...claim, actionOpen: false, enrollment: { ...claim.enrollment, state: 'retired' } }
      : claim);
  }

  pause(sessionId: string): boolean {
    return this.change(sessionId, claim => claim.paused ? claim : { ...claim, paused: true });
  }

  complete(sessionId: string): boolean {
    return this.change(sessionId, claim => claim.actionOpen ? { ...claim, actionOpen: false } : claim);
  }

  decide(callback: ManagedStopCallback) {
    return this.decideVerified(callback.sessionId, callback.enabled, () => callback);
  }

  /**
   * Read the enrollment, verify against that snapshot and consume the result
   * under the same write lock that orders pause and one-time issuance.
   */
  decideVerified(
    sessionId: string,
    enabled: boolean,
    verify: (enrollment: ManagedStopEnrollment) => ManagedStopVerifiedFacts | undefined,
  ) {
    return this.db.transaction(() => {
      const launchId = this.launchIdFor(sessionId);
      const claim = launchId === undefined ? undefined : this.read(launchId);
      if (!claim || launchId === undefined) return { managed: false } as const;
      if (claim.enrollment.state !== 'active' || claim.enrollment.sessionId !== sessionId) {
        return { managed: true, directive: undefined } as const;
      }

      const verified = verify(claim.enrollment);
      if (!verified) return { managed: true, directive: undefined } as const;
      const decision = decideManagedCodexStop(claim.enrollment, {
        ...verified, sessionId, enabled, actionOpen: claim.actionOpen, paused: claim.paused,
      });
      if (decision.enrollment !== claim.enrollment) {
        const rolloutFileKey = claim.enrollment.rolloutFileKey
          ?? claim.enrollment.outstanding?.boundary?.fileKey
          ?? (decision.directive ? verified.boundary?.fileKey : undefined);
        this.write(launchId, { ...claim, enrollment: { ...decision.enrollment, rolloutFileKey } });
      }
      return { managed: true, directive: decision.directive } as const;
    }).immediate();
  }

  hasEnrollment(sessionId: string): boolean {
    return this.launchIdFor(sessionId) !== undefined;
  }

  private change(sessionId: string, transition: (claim: Claim) => Claim): boolean {
    return this.db.transaction(() => {
      const current = this.read(sessionId);
      if (!current) return false;
      const updated = transition(current);
      if (updated === current) return false;
      this.write(sessionId, updated);
      return true;
    }).immediate();
  }

  private launchIdFor(sessionId: string): string | undefined {
    const row = this.db.prepare(`
      SELECT session_id AS launch_id FROM managed_codex_work_claims WHERE session_id = ?
      UNION ALL
      SELECT launch_id FROM managed_codex_native_bindings WHERE native_session_id = ?
    `).get(sessionId, sessionId) as { launch_id: string } | undefined;
    return row?.launch_id;
  }

  private read(sessionId: string): Claim | undefined {
    const row = this.db.prepare('SELECT claim_json FROM managed_codex_work_claims WHERE session_id = ?')
      .get(sessionId) as { claim_json: string } | undefined;
    return row && JSON.parse(row.claim_json) as Claim;
  }

  private write(sessionId: string, claim: Claim): void {
    this.db.prepare('UPDATE managed_codex_work_claims SET claim_json = ? WHERE session_id = ?')
      .run(JSON.stringify(claim), sessionId);
  }
}

function validHost(host: OrdinaryWorkHost | null): boolean {
  return typeof host?.machineId === 'string' && host.machineId.length > 0
    && typeof host.osBootId === 'string'
    && /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(host.osBootId);
}
