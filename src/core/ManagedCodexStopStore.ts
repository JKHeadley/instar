import type { Database } from 'better-sqlite3';
import { decideManagedCodexStop } from './ManagedCodexStopDecision.js';
import type { ManagedStopEnrollment, ManagedStopInput } from './ManagedCodexStopDecision.js';

interface Claim {
  enrollment: ManagedStopEnrollment;
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
      CREATE TABLE IF NOT EXISTS managed_codex_native_bindings (
        launch_id TEXT PRIMARY KEY,
        native_session_id TEXT NOT NULL UNIQUE
      );
    `);
  }

  reserve(workKey: string, input: Pick<ManagedStopEnrollment, 'sessionId' | 'machineId' | 'ownerEpoch' | 'remaining'>): boolean {
    if (!workKey || !input.sessionId || !input.machineId
      || !Number.isSafeInteger(input.ownerEpoch) || input.ownerEpoch < 0
      || !Number.isSafeInteger(input.remaining) || input.remaining < 0) return false;
    return this.db.transaction(() => {
      if (this.hasEnrollment(input.sessionId)) return false;
      return this.db.prepare('INSERT OR IGNORE INTO managed_codex_work_claims VALUES (?, ?, ?)')
        .run(workKey, input.sessionId, JSON.stringify({
          enrollment: { ...input, state: 'pending', issuedCycles: [] }, actionOpen: true, paused: false,
        } satisfies Claim)).changes === 1;
    }).immediate();
  }

  activate(sessionId: string): boolean {
    return this.change(sessionId, claim => claim.enrollment.state === 'pending'
      ? { ...claim, enrollment: { ...claim.enrollment, state: 'active' } }
      : claim);
  }

  /** Bind the verified native identity after the reserved launch establishes ownership. */
  bindNative(launchId: string, nativeSessionId: string): boolean {
    if (!nativeSessionId || launchId === nativeSessionId) return false;
    return this.db.transaction(() => {
      const claim = this.read(launchId);
      if (!claim || claim.enrollment.state !== 'pending'
        || !claim.actionOpen || claim.paused || this.hasEnrollment(nativeSessionId)) return false;

      this.db.prepare('INSERT INTO managed_codex_native_bindings VALUES (?, ?)').run(launchId, nativeSessionId);
      this.write(launchId, {
        ...claim,
        enrollment: { ...claim.enrollment, sessionId: nativeSessionId, state: 'active' },
      });
      return true;
    }).immediate();
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
        this.write(launchId, { ...claim, enrollment: decision.enrollment });
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
