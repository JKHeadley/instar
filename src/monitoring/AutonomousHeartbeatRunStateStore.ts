/**
 * Durable throttle ledger for AutonomousProgressHeartbeat.
 *
 * The heartbeat budget is a property of an autonomous RUN, not of the server
 * process observing it. This store therefore keys records by the stable run id
 * and commits a reservation before an outbound heartbeat is attempted. A
 * restart can lose a heartbeat (safe) but cannot reopen already-consumed budget.
 */
import fs from 'node:fs';
import path from 'node:path';
import { SafeFsExecutor } from '../core/SafeFsExecutor.js';

export interface AutonomousHeartbeatRunState {
  runId: string;
  topicId: number;
  runStartedAtMs: number;
  lastHeartbeatAt: number;
  count: number;
}

export interface AutonomousHeartbeatRunStateStoreLike {
  read(runId: string): AutonomousHeartbeatRunState | null;
  write(state: AutonomousHeartbeatRunState): void;
  retain(runIds: ReadonlySet<string>): void;
}

interface LedgerFile {
  version: 1;
  runs: Record<string, AutonomousHeartbeatRunState & { updatedAt: number }>;
}

const MAX_LEDGER_BYTES = 1_000_000;
const MAX_RUNS = 1_000;
const INACTIVE_RETENTION_MS = 7 * 24 * 60 * 60_000;

function validState(value: unknown, runId: string): value is AutonomousHeartbeatRunState & { updatedAt: number } {
  if (!value || typeof value !== 'object') return false;
  const state = value as Record<string, unknown>;
  return state.runId === runId
    && typeof state.topicId === 'number' && Number.isSafeInteger(state.topicId)
    && typeof state.runStartedAtMs === 'number' && Number.isFinite(state.runStartedAtMs)
    && typeof state.lastHeartbeatAt === 'number' && Number.isFinite(state.lastHeartbeatAt) && state.lastHeartbeatAt >= 0
    && typeof state.count === 'number' && Number.isSafeInteger(state.count) && state.count >= 0
    && typeof state.updatedAt === 'number' && Number.isFinite(state.updatedAt) && state.updatedAt >= 0;
}

export class AutonomousHeartbeatRunStateStore implements AutonomousHeartbeatRunStateStoreLike {
  private ledger: LedgerFile | null = null;

  constructor(private readonly filePath: string, private readonly now: () => number = Date.now) {}

  read(runId: string): AutonomousHeartbeatRunState | null {
    const state = this.load().runs[runId];
    if (!state) return null;
    const { updatedAt: _updatedAt, ...copy } = state;
    return copy;
  }

  write(state: AutonomousHeartbeatRunState): void {
    if (!validState({ ...state, updatedAt: this.now() }, state.runId)) {
      throw new Error('invalid-autonomous-heartbeat-run-state');
    }
    const ledger = this.load();
    const before = { ...ledger.runs };
    ledger.runs[state.runId] = { ...state, updatedAt: this.now() };
    if (Object.keys(ledger.runs).length > MAX_RUNS) {
      ledger.runs = before;
      throw new Error('autonomous-heartbeat-ledger-run-cap-reached');
    }
    try {
      this.persist(ledger);
    } catch (err) {
      ledger.runs = before;
      throw err;
    }
  }

  retain(runIds: ReadonlySet<string>): void {
    const ledger = this.load();
    const before = { ...ledger.runs };
    let changed = false;
    const cutoff = this.now() - INACTIVE_RETENTION_MS;
    for (const [runId, state] of Object.entries(ledger.runs)) {
      // A single transient empty/partial run scan must never erase the cap and
      // backoff. Only records absent long past the maximum normal run window
      // are eligible for cleanup; the hard file/run bounds fail closed.
      if (!runIds.has(runId) && state.updatedAt < cutoff) {
        delete ledger.runs[runId];
        changed = true;
      }
    }
    if (changed) {
      try {
        this.persist(ledger);
      } catch (err) {
        ledger.runs = before;
        throw err;
      }
    }
  }

  private load(): LedgerFile {
    if (this.ledger) return this.ledger;
    if (!fs.existsSync(this.filePath)) {
      this.ledger = { version: 1, runs: {} };
      return this.ledger;
    }
    const stat = fs.statSync(this.filePath);
    if (stat.size > MAX_LEDGER_BYTES) throw new Error('autonomous-heartbeat-ledger-too-large');
    const parsed = JSON.parse(fs.readFileSync(this.filePath, 'utf8')) as Partial<LedgerFile>;
    if (parsed.version !== 1 || !parsed.runs || typeof parsed.runs !== 'object' || Array.isArray(parsed.runs)) {
      throw new Error('invalid-autonomous-heartbeat-ledger');
    }
    for (const [runId, state] of Object.entries(parsed.runs)) {
      if (!validState(state, runId)) throw new Error('invalid-autonomous-heartbeat-ledger-record');
    }
    this.ledger = parsed as LedgerFile;
    return this.ledger;
  }

  private persist(ledger: LedgerFile): void {
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    const tmp = `${this.filePath}.${process.pid}.tmp`;
    try {
      fs.writeFileSync(tmp, JSON.stringify(ledger, null, 2), { mode: 0o600 });
      fs.renameSync(tmp, this.filePath);
    } catch (err) {
      try {
        SafeFsExecutor.safeUnlinkSync(tmp, { operation: 'AutonomousHeartbeatRunStateStore.persist:cleanup-tmp' });
      } catch { /* @silent-fallback-ok — best-effort cleanup; canonical file is unchanged and the next write reuses this bounded temp path */ }
      throw err;
    }
  }
}
