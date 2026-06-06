/**
 * PendingInjectStore — durable record of in-flight initial-message injects.
 *
 * THE GAP THIS CLOSES (finding 8d300555, 2026-06-06): when a session is
 * spawned with an initial message, the inject happens AFTER an async
 * readiness wait (codex can take tens of seconds to boot). That pending
 * inject was process-local state — a server restart in the window between
 * spawn and inject silently dropped the user's message. The live incident:
 * the auto-updater's scheduled restart (60s delay) killed the server while
 * the fresh-spawned codex session was still booting; tmux survived showing
 * an idle prompt, the bootstrap file sat unconsumed on disk, the operator
 * waited 50+ minutes, and nothing anywhere knew a message had been lost.
 *
 * The store is one JSON file per pending inject, keyed by tmux session name,
 * under `<stateDir>/pending-injects/`. Records are written at spawn time and
 * cleared ONLY after the inject actually runs. Boot-time recovery
 * (SessionManager.recoverPendingInjects) sweeps survivors: a still-alive
 * session gets the message re-delivered through the normal readiness path; a
 * dead session is reported loudly (DegradationReporter) and expired — never
 * silently dropped.
 *
 * Delivery semantics are deliberately AT-LEAST-ONCE: if the server dies
 * after the inject but before the clear, the next boot re-injects a
 * duplicate. A duplicated message to an agent session is recoverable noise;
 * a silently dropped user message is not.
 */
import fs from 'node:fs';
import path from 'node:path';
import { SafeFsExecutor } from './SafeFsExecutor.js';

export interface PendingInjectRecord {
  /** tmux session name the inject targets (also the record's key). */
  tmuxSession: string;
  /** The message queued for injection (may be a bootstrap-file pointer). */
  initialMessage: string;
  /** Telegram topic the message belongs to, when known. */
  telegramTopicId?: number;
  /** ISO timestamp the record was written (spawn time). */
  createdAt: string;
}

export class PendingInjectStore {
  private dir: string;

  constructor(stateDir: string) {
    this.dir = path.join(stateDir, 'pending-injects');
  }

  /** Key → filename. tmux session names are already shell-safe, but clamp anyway. */
  private fileFor(tmuxSession: string): string {
    const safe = tmuxSession.replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 200);
    return path.join(this.dir, `${safe}.json`);
  }

  /** Write (or overwrite) the pending record for a session. Never throws —
   *  a failed durability write must not block the spawn itself. */
  record(entry: Omit<PendingInjectRecord, 'createdAt'> & { createdAt?: string }): void {
    try {
      fs.mkdirSync(this.dir, { recursive: true });
      const full: PendingInjectRecord = {
        tmuxSession: entry.tmuxSession,
        initialMessage: entry.initialMessage,
        ...(entry.telegramTopicId !== undefined ? { telegramTopicId: entry.telegramTopicId } : {}),
        createdAt: entry.createdAt ?? new Date().toISOString(),
      };
      fs.writeFileSync(this.fileFor(entry.tmuxSession), JSON.stringify(full, null, 2));
    } catch (err) {
      console.warn(`[PendingInjectStore] record failed for "${entry.tmuxSession}" (non-fatal): ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  /** Remove the record after a verified inject. Never throws. */
  clear(tmuxSession: string): void {
    try {
      SafeFsExecutor.safeUnlinkSync(this.fileFor(tmuxSession), {
        operation: 'PendingInjectStore.clear',
      });
    } catch (err) {
      if ((err as NodeJS.ErrnoException)?.code !== 'ENOENT') {
        // Already-cleared (ENOENT) is the expected no-op; anything else is
        // non-fatal — a stale record is re-examined (and expired) by the next
        // boot sweep, so we report rather than throw into the inject path.
        console.warn(`[PendingInjectStore] clear failed for "${tmuxSession}" (non-fatal): ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }

  /** All surviving records (corrupt files are skipped, reported via return). */
  list(): { records: PendingInjectRecord[]; corrupt: string[] } {
    const records: PendingInjectRecord[] = [];
    const corrupt: string[] = [];
    let files: string[] = [];
    try {
      files = fs.readdirSync(this.dir).filter((f) => f.endsWith('.json'));
    } catch {
      return { records, corrupt }; // no dir yet → nothing pending
    }
    for (const f of files) {
      try {
        const parsed = JSON.parse(fs.readFileSync(path.join(this.dir, f), 'utf8'));
        if (
          parsed && typeof parsed === 'object' &&
          typeof parsed.tmuxSession === 'string' &&
          typeof parsed.initialMessage === 'string' &&
          typeof parsed.createdAt === 'string'
        ) {
          records.push(parsed as PendingInjectRecord);
        } else {
          corrupt.push(f);
        }
      } catch {
        corrupt.push(f);
      }
    }
    return { records, corrupt };
  }
}

export interface PendingInjectSweepDeps {
  sessionAlive(tmuxSession: string): boolean;
  /** Re-deliver through the normal readiness path; resolves once injected (or throws). */
  redeliver(record: PendingInjectRecord): Promise<void>;
  /** Loud reporting for the cases recovery cannot fix on its own. */
  reportLoss(record: PendingInjectRecord, reason: string): void;
  now?: () => number;
  /** Records older than this are expired (reported, not re-injected). Default 6h. */
  maxAgeMs?: number;
}

export interface PendingInjectSweepResult {
  redelivered: string[];
  expired: string[];
  deadSession: string[];
  failed: string[];
}

/**
 * Boot-time recovery over surviving records. Decision per record:
 *  - older than maxAge       → expire + reportLoss (stale enough that re-injecting
 *                              mid-conversation would confuse more than help)
 *  - tmux session still alive → redeliver via the readiness path, clear on success
 *  - tmux session gone        → reportLoss + clear (the bridge respawns on the
 *                              user's next message; the loss is now VISIBLE)
 */
export async function sweepPendingInjects(
  store: PendingInjectStore,
  deps: PendingInjectSweepDeps,
): Promise<PendingInjectSweepResult> {
  const result: PendingInjectSweepResult = { redelivered: [], expired: [], deadSession: [], failed: [] };
  const now = deps.now ?? (() => Date.now());
  const maxAgeMs = deps.maxAgeMs ?? 6 * 60 * 60 * 1000;
  const { records, corrupt } = store.list();
  for (const f of corrupt) {
    console.warn(`[PendingInjectStore] corrupt pending-inject file skipped: ${f}`);
  }

  for (const record of records) {
    const age = now() - Date.parse(record.createdAt);
    if (!Number.isFinite(age) || age > maxAgeMs) {
      deps.reportLoss(record, `record expired (age ${Math.round(age / 60000)}m > ${Math.round(maxAgeMs / 60000)}m)`);
      store.clear(record.tmuxSession);
      result.expired.push(record.tmuxSession);
      continue;
    }
    if (!deps.sessionAlive(record.tmuxSession)) {
      deps.reportLoss(record, 'target tmux session no longer exists');
      store.clear(record.tmuxSession);
      result.deadSession.push(record.tmuxSession);
      continue;
    }
    try {
      await deps.redeliver(record);
      store.clear(record.tmuxSession);
      result.redelivered.push(record.tmuxSession);
    } catch (err) {
      // Keep the record — the NEXT boot retries. Failing loudly beats dropping.
      deps.reportLoss(record, `redeliver failed: ${err instanceof Error ? err.message : String(err)}`);
      result.failed.push(record.tmuxSession);
    }
  }
  return result;
}
