import type { Database } from 'better-sqlite3';
import { decideManagedCodexStop } from './ManagedCodexStopDecision.js';
import type { ManagedStopEnrollment, ManagedStopInput } from './ManagedCodexStopDecision.js';

interface Claim {
  enrollment: ManagedStopEnrollment;
  actionOpen: boolean;
  paused: boolean;
}

export type ManagedStopCallback = Omit<ManagedStopInput, 'actionOpen' | 'paused'>;

/** Local authority for newly admitted managed actions in the one-member slice. */
export class ManagedCodexStopStore {
  constructor(private readonly db: Database) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS managed_codex_work_claims (
        work_key TEXT PRIMARY KEY,
        session_id TEXT NOT NULL UNIQUE,
        claim_json TEXT NOT NULL
      );
    `);
  }

  reserve(workKey: string, input: Pick<ManagedStopEnrollment, 'sessionId' | 'machineId' | 'ownerEpoch' | 'remaining'>): boolean {
    if (!workKey || !input.sessionId || !input.machineId
      || !Number.isSafeInteger(input.ownerEpoch) || input.ownerEpoch < 0
      || !Number.isSafeInteger(input.remaining) || input.remaining < 0) return false;
    return this.db.prepare('INSERT OR IGNORE INTO managed_codex_work_claims VALUES (?, ?, ?)')
      .run(workKey, input.sessionId, JSON.stringify({
        enrollment: { ...input, state: 'pending', issuedCycles: [] }, actionOpen: true, paused: false,
      } satisfies Claim)).changes === 1;
  }

  activate(sessionId: string): boolean {
    return this.change(sessionId, claim => claim.enrollment.state === 'pending'
      ? { ...claim, enrollment: { ...claim.enrollment, state: 'active' } }
      : claim);
  }

  pause(sessionId: string): boolean {
    return this.change(sessionId, claim => claim.paused ? claim : { ...claim, paused: true });
  }

  complete(sessionId: string): boolean {
    return this.change(sessionId, claim => claim.actionOpen ? { ...claim, actionOpen: false } : claim);
  }

  hasEnrollment(sessionId: string): boolean {
    return this.db.prepare('SELECT 1 FROM managed_codex_work_claims WHERE session_id = ?').get(sessionId) !== undefined;
  }

  decide(callback: ManagedStopCallback) {
    return this.db.transaction(() => {
      const claim = this.read(callback.sessionId);
      if (!claim) return { managed: false } as const;

      const decision = decideManagedCodexStop(claim.enrollment, {
        ...callback, actionOpen: claim.actionOpen, paused: claim.paused,
      });
      if (decision.enrollment !== claim.enrollment) {
        this.write(callback.sessionId, { ...claim, enrollment: decision.enrollment });
      }
      return { managed: true, directive: decision.directive } as const;
    }).immediate();
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
