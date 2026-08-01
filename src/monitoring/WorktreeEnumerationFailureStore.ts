/**
 * Fixed-cardinality durable history for worktree-guard enumeration failures.
 *
 * Only historical count/time survive restart. The current pass outcome stays
 * process-local so `/guards` never presents a stale failure as a live verdict.
 */
import fs from 'node:fs';
import path from 'node:path';
import { SafeFsExecutor } from '../core/SafeFsExecutor.js';
import type {
  WorktreeEnumerationFailureHistory,
  WorktreeEnumerationFailureHistoryPort,
} from './worktreeEnumeration.js';

export type WorktreeEnumerationGuardKey = 'agent-worktree-reaper' | 'orphaned-work-sentinel';

interface LedgerFile {
  version: 1;
  guards: Partial<Record<WorktreeEnumerationGuardKey, WorktreeEnumerationFailureHistory>>;
}

const MAX_LEDGER_BYTES = 16_384;
const EMPTY_HISTORY: WorktreeEnumerationFailureHistory = {
  enumerationFailures: 0,
  lastEnumerationFailureAt: null,
};

function validHistory(value: unknown): value is WorktreeEnumerationFailureHistory {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const history = value as Record<string, unknown>;
  return typeof history.enumerationFailures === 'number'
    && Number.isSafeInteger(history.enumerationFailures)
    && history.enumerationFailures >= 0
    && (history.lastEnumerationFailureAt === null
      || (typeof history.lastEnumerationFailureAt === 'number'
        && Number.isFinite(history.lastEnumerationFailureAt)
        && history.lastEnumerationFailureAt >= 0));
}

export class WorktreeEnumerationFailureStore {
  private ledger: LedgerFile | null = null;

  constructor(private readonly filePath: string) {}

  forGuard(key: WorktreeEnumerationGuardKey): WorktreeEnumerationFailureHistoryPort {
    return {
      load: () => this.read(key),
      recordFailure: (at) => this.recordFailure(key, at),
    };
  }

  read(key: WorktreeEnumerationGuardKey): WorktreeEnumerationFailureHistory {
    const history = this.load().guards[key] ?? EMPTY_HISTORY;
    return { ...history };
  }

  recordFailure(key: WorktreeEnumerationGuardKey, at: number): WorktreeEnumerationFailureHistory {
    if (!Number.isFinite(at) || at < 0) throw new Error('invalid-worktree-enumeration-failure-time');
    const ledger = this.load();
    const previous = ledger.guards[key] ?? EMPTY_HISTORY;
    const next: WorktreeEnumerationFailureHistory = {
      enumerationFailures: Math.min(Number.MAX_SAFE_INTEGER, previous.enumerationFailures + 1),
      lastEnumerationFailureAt: at,
    };
    ledger.guards[key] = next;
    try {
      this.persist(ledger);
    } catch (err) {
      ledger.guards[key] = previous.enumerationFailures === 0 && previous.lastEnumerationFailureAt === null
        ? undefined
        : previous;
      throw err;
    }
    return { ...next };
  }

  private load(): LedgerFile {
    if (this.ledger) return this.ledger;
    if (!fs.existsSync(this.filePath)) {
      this.ledger = { version: 1, guards: {} };
      return this.ledger;
    }
    const stat = fs.statSync(this.filePath);
    if (stat.size > MAX_LEDGER_BYTES) throw new Error('worktree-enumeration-failure-ledger-too-large');
    const parsed = JSON.parse(fs.readFileSync(this.filePath, 'utf8')) as Partial<LedgerFile>;
    if (parsed.version !== 1 || !parsed.guards || typeof parsed.guards !== 'object' || Array.isArray(parsed.guards)) {
      throw new Error('invalid-worktree-enumeration-failure-ledger');
    }
    const allowed = new Set<WorktreeEnumerationGuardKey>(['agent-worktree-reaper', 'orphaned-work-sentinel']);
    for (const [key, value] of Object.entries(parsed.guards)) {
      if (!allowed.has(key as WorktreeEnumerationGuardKey) || !validHistory(value)) {
        throw new Error('invalid-worktree-enumeration-failure-ledger-record');
      }
    }
    this.ledger = parsed as LedgerFile;
    return this.ledger;
  }

  private persist(ledger: LedgerFile): void {
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    const tmp = `${this.filePath}.${process.pid}.tmp`;
    try {
      fs.writeFileSync(tmp, `${JSON.stringify(ledger, null, 2)}\n`, { mode: 0o600 });
      fs.renameSync(tmp, this.filePath);
    } catch (err) {
      try {
        SafeFsExecutor.safeUnlinkSync(tmp, { operation: 'WorktreeEnumerationFailureStore.persist:cleanup-tmp' });
      } catch { /* @silent-fallback-ok — bounded temp cleanup only; canonical ledger is unchanged */ }
      throw err;
    }
  }
}
