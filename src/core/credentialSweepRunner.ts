/**
 * credentialSweepRunner — SEC-164 part 1 slice 1d: drives the sweeper (§4.3, §6). One instance per
 * server. Every `sweepIntervalSeconds` it lists the fixed set of files, sweeps those whose size or
 * modification time changed (or that still have unchecked bytes), paces the first pass by the machine's
 * load verdict, applies the brakes, writes the record and keeps the status the route reports.
 *
 * Machine-local by design (§7, machine-local-justification: hardware-bound-resource).
 */
import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import type { Database as BetterSqliteDatabase } from 'better-sqlite3';
import {
  listSweepTargets, sweepFile, fileUnchanged, bytesStillPending, reapplyIntent, neverTouchIdentities, hashedName, detectorRevision,
  firstPassBytesPerMinute, RETRY_MIN_MS, RETRY_MAX_MS, UNREADABLE_REPORT_MS, BREAKER_THROWS, BREAKER_COOLDOWN_MS,
  type FileState, type RootClass, type SweepTarget, type UnmeasuredReason, type WriteIntent, type ListTargetsInput,
} from './credentialSweeper.js';
import type { CredentialScrubMode } from './outputCredentialScrub.js';
import type { LoadVerdict } from './machineLoadReport.js';
import type { OwnCredentialMatcher } from '../messaging/outbound-credential-guard.js';

export interface SweepRunnerDeps {
  projectDir: string;
  stateDir: string;
  mode: () => CredentialScrubMode;
  intervalSeconds: () => number;
  loadVerdict: () => LoadVerdict;
  configHomes: () => string[];
  codexHome: () => string | null;
  ownCredentials: () => OwnCredentialMatcher | null;
  /** How many configured credentials are too short (under 12 characters) to match by exact value. */
  shortCredentialCount: () => number;
  /** The shared patterns' source text, so a pattern change changes the detector revision. */
  patternsSource: string;
  /** Reported once per episode through the degradation report. */
  report: (reason: string) => void;
  /** Evidence rows for the ladder: kinds and counts only. */
  evidence?: (kind: 'fired' | 'held' | 'error', reason: string, context: Record<string, string | number | boolean | null>) => void;
  now?: () => number;
}

interface RootStatus {
  filesChecked: number; filesChanged: number; masked: Record<string, number>; wouldMask: Record<string, number>;
  bytesPending: number;
}

export interface SweepStatus {
  mode: CredentialScrubMode;
  running: boolean;
  breakerOpenUntil: string | null;
  lastPassAt: string | null;
  firstPass: { done: boolean; bytesChecked: number; bytesTotal: number; heldByLoad: boolean; verdict: LoadVerdict };
  oldestUncheckedAgeSeconds: number | null;
  roots: Record<string, RootStatus>;
  unmeasured: Array<{ file: string; rootClass: RootClass; reason: UnmeasuredReason }>;
  shortCredentialsNotMatched: number;
  pendingIntents: number;
}

/** The most one pass reads, and the most one synchronous file call reads, on the shared event loop. */
export const PER_TICK_MAX_BYTES = 64 * 1024 * 1024;
export const PER_CALL_MAX_BYTES = 4 * 1024 * 1024;

const ROOTS: RootClass[] = ['claude-transcripts', 'codex-transcripts', 'logs', 'local-verify-logs', 'transcript-copies'];

export class CredentialSweepRunner {
  private db: BetterSqliteDatabase | null = null;
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  private throwsInARow = 0;
  private breakerOpenUntil = 0;
  private breakerReported = false;
  private readonly rootRetry = new Map<RootClass, { waitMs: number; nextAt: number; failingSince: number | null; reported: boolean }>();
  private readonly roots: Record<string, RootStatus> = {};
  private readonly unmeasured = new Map<string, { file: string; rootClass: RootClass; reason: UnmeasuredReason }>();
  private lastPassAt: number | null = null;
  private firstPassBytesTotal = 0;
  private firstPassBytesChecked = 0;
  private heldByLoad = false;
  private budgetWindow = { startedAt: 0, used: 0 };
  private readonly now: () => number;

  constructor(private readonly deps: SweepRunnerDeps) {
    this.now = deps.now ?? Date.now;
    for (const r of ROOTS) this.roots[r] = { filesChecked: 0, filesChanged: 0, masked: {}, wouldMask: {}, bytesPending: 0 };
  }

  private open(): BetterSqliteDatabase {
    if (this.db) return this.db;
    const dir = path.join(this.deps.stateDir, 'state', 'credential-scrub');
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    const db = new Database(path.join(dir, 'state.sqlite'));
    db.pragma('journal_mode = WAL');
    db.pragma('synchronous = FULL'); // an intent must be durable before its write
    db.exec(`CREATE TABLE IF NOT EXISTS files (path TEXT PRIMARY KEY, state TEXT NOT NULL);
             CREATE TABLE IF NOT EXISTS intents (id INTEGER PRIMARY KEY AUTOINCREMENT, intent TEXT NOT NULL);`);
    this.db = db;
    return db;
  }

  /** Re-apply interrupted writes, then start the interval. Never throws. */
  start(): void {
    try { this.recoverIntents(); } catch (err) { this.safeReport(`intent recovery failed: ${err instanceof Error ? err.name : 'error'}`); }
    const schedule = () => {
      const secs = Math.max(5, Math.min(3600, Number(this.deps.intervalSeconds()) || 15));
      this.timer = setTimeout(() => { void this.tick().finally(schedule); }, secs * 1000);
      this.timer.unref?.();
    };
    schedule();
  }

  stop(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    try { this.db?.close(); } catch { /* @silent-fallback-ok — closing on shutdown */ }
    this.db = null;
  }

  private recoverIntents(): void {
    const db = this.open();
    const rows = db.prepare('SELECT id, intent FROM intents').all() as Array<{ id: number; intent: string }>;
    for (const r of rows) {
      let i: WriteIntent;
      try { i = JSON.parse(r.intent) as WriteIntent; } catch { db.prepare('DELETE FROM intents WHERE id = ?').run(r.id); continue; }
      if (reapplyIntent(i, neverTouchIdentities(this.deps.projectDir, this.deps.stateDir))) db.prepare('DELETE FROM intents WHERE id = ?').run(r.id);
    }
  }

  /** One pass. Exposed for tests and the e2e check. Never throws. */
  async tick(): Promise<void> {
    if (this.running) return;
    const now = this.now();
    if (this.breakerOpenUntil > now) return;
    const mode = this.safeMode();
    if (mode === 'off') { this.lastPassAt = now; return; }
    this.running = true;
    try {
      await this.pass(mode, now);
      this.throwsInARow = 0;
      if (this.breakerReported && this.breakerOpenUntil <= now) this.breakerReported = false;
    } catch (err) {
      this.throwsInARow++;
      if (this.throwsInARow >= BREAKER_THROWS) {
        this.breakerOpenUntil = now + BREAKER_COOLDOWN_MS;
        this.throwsInARow = 0;
        if (!this.breakerReported) {
          this.breakerReported = true;
          this.safeReport(`the sweeper stopped after ${BREAKER_THROWS} failed passes (${err instanceof Error ? err.name : 'error'}); it retries in 30 minutes or after a restart`);
        }
      }
    } finally {
      this.running = false;
      this.lastPassAt = now;
    }
  }

  private async pass(mode: CredentialScrubMode, now: number): Promise<void> {
    const db = this.open();
    const own = this.safeOwn();
    const revision = detectorRevision(this.deps.patternsSource, own?.size ?? 0);
    const neverTouch = neverTouchIdentities(this.deps.projectDir, this.deps.stateDir);
    const input: ListTargetsInput = { projectDir: this.deps.projectDir, stateDir: this.deps.stateDir, configHomes: this.deps.configHomes(), codexHome: this.deps.codexHome() };
    const targets = listSweepTargets(input);
    const getState = db.prepare('SELECT state FROM files WHERE path = ?');
    const putState = db.prepare('INSERT INTO files (path, state) VALUES (?, ?) ON CONFLICT(path) DO UPDATE SET state = excluded.state');
    const addIntent = db.prepare('INSERT INTO intents (intent) VALUES (?)');
    const delIntent = db.prepare('DELETE FROM intents WHERE intent = ?');

    // Pace: the first-pass budget for this pass from the per-minute rate (§4.3).
    const verdict = this.safeVerdict();
    const perMinute = firstPassBytesPerMinute(verdict);
    if (now - this.budgetWindow.startedAt >= 60_000) this.budgetWindow = { startedAt: now, used: 0 };
    // The server's event loop is shared: at most PER_TICK_MAX_BYTES per pass, read in calls of at most
    // PER_CALL_MAX_BYTES with a yield between files, so no single synchronous stretch is long.
    let budget = Math.min(PER_TICK_MAX_BYTES, Number.isFinite(perMinute) ? Math.max(0, perMinute - this.budgetWindow.used) : PER_TICK_MAX_BYTES);

    for (const r of ROOTS) this.roots[r]!.bytesPending = 0;
    let totalBytes = 0; let checkedBytes = 0;
    const seen = new Set<string>();
    const byRoot = new Map<RootClass, SweepTarget[]>();
    for (const t of targets) { if (!byRoot.has(t.rootClass)) byRoot.set(t.rootClass, []); byRoot.get(t.rootClass)!.push(t); }

    for (const [rootClass, list] of byRoot) {
      const retry = this.rootRetry.get(rootClass);
      if (retry && retry.nextAt > now) continue;
      let rootFailed = false;
      for (const t of list) {
        seen.add(t.path);
        const row = getState.get(t.path) as { state: string } | undefined;
        let prev: FileState | null = null;
        if (row) { try { prev = JSON.parse(row.state) as FileState; } catch { prev = null; } }
        let st: fs.Stats | null = null;
        try { st = fs.lstatSync(t.path); } catch { st = null; }
        if (st) totalBytes += st.size;
        const unchanged = !!st && fileUnchanged(prev, st.size, st.mtimeMs)
          && prev!.revision === revision && (mode !== 'on' || prev!.mode === 'on');
        if (unchanged) { checkedBytes += st!.size; continue; }
        const { state, result } = sweepFile(t, prev, revision, mode, {
          apply: mode === 'on', own, neverTouch, now: this.now, budget: Math.max(0, Math.min(budget, PER_CALL_MAX_BYTES)),
          recordIntent: (i) => { addIntent.run(JSON.stringify(i)); },
          clearIntent: (i) => { delIntent.run(JSON.stringify(i)); },
        });
        const key = hashedName(t.path);
        if (result.skipped && result.skipped !== 'changed-during-write') {
          this.unmeasured.set(key, { file: key, rootClass, reason: result.skipped });
          if (result.skipped === 'unreadable') rootFailed = true;
        } else if (result.unmeasured > 0 || result.unscannable > 0) {
          this.unmeasured.set(key, { file: key, rootClass, reason: result.unmeasured > 0 ? 'integrity-bound' : 'unscannable' });
        } else {
          this.unmeasured.delete(key);
        }
        budget -= result.bytesRead;
        this.budgetWindow.used += result.bytesRead;
        const rs = this.roots[rootClass]!;
        rs.filesChecked++;
        if (result.masked > 0) {
          rs.filesChanged += mode === 'on' ? 1 : 0;
          const bucket = mode === 'on' ? rs.masked : rs.wouldMask;
          for (const [k, v] of Object.entries(result.kinds)) bucket[k] = (bucket[k] ?? 0) + v;
          this.writeRecord({ rootClass, file: key, mode, kinds: result.kinds, unmeasured: result.unmeasured, unscannable: result.unscannable });
          try {
            this.deps.evidence?.(mode === 'on' ? 'fired' : 'held', mode === 'on' ? 'sweeper: masked' : 'sweeper: would mask (dry run)',
              { path: 'sweeper', rootClass, masked: result.masked, kinds: Object.keys(result.kinds).join(',') });
          } catch { /* @silent-fallback-ok — evidence is a count; it never blocks the sweep */ }
        }
        if (state && state !== prev) putState.run(t.path, JSON.stringify(state));
        const pendingHere = st ? bytesStillPending(state, st.size, st.mtimeMs) : 0;
        checkedBytes += st ? st.size - pendingHere : 0;
        rs.bytesPending += pendingHere;
        if (result.bytesRead > 0) await new Promise<void>((resolve) => setImmediate(resolve));
      }
      this.noteRoot(rootClass, rootFailed, now);
    }
    // Prune deleted files.
    const all = db.prepare('SELECT path FROM files').all() as Array<{ path: string }>;
    const del = db.prepare('DELETE FROM files WHERE path = ?');
    for (const r of all) if (!seen.has(r.path)) del.run(r.path);
    this.heldByLoad = Number.isFinite(perMinute) && budget <= 0;
    this.firstPassBytesTotal = totalBytes;
    this.firstPassBytesChecked = checkedBytes;
  }

  private noteRoot(rootClass: RootClass, failed: boolean, now: number): void {
    const r = this.rootRetry.get(rootClass) ?? { waitMs: RETRY_MIN_MS, nextAt: 0, failingSince: null, reported: false };
    if (!failed) { this.rootRetry.set(rootClass, { waitMs: RETRY_MIN_MS, nextAt: 0, failingSince: null, reported: false }); return; }
    r.failingSince ??= now;
    r.nextAt = now + r.waitMs;
    r.waitMs = Math.min(RETRY_MAX_MS, r.waitMs * 2);
    if (!r.reported && now - r.failingSince >= UNREADABLE_REPORT_MS) {
      r.reported = true;
      this.safeReport(`the sweeper could not read part of its ${rootClass} for five minutes`);
    }
    this.rootRetry.set(rootClass, r);
  }

  private writeRecord(row: { rootClass: RootClass; file: string; mode: CredentialScrubMode; kinds: Record<string, number>; unmeasured: number; unscannable: number }): void {
    try {
      const p = path.join(this.deps.stateDir, 'logs', 'credential-scrub.jsonl');
      fs.mkdirSync(path.dirname(p), { recursive: true });
      fs.appendFileSync(p, JSON.stringify({ at: new Date(this.now()).toISOString(), ...row }) + '\n', { mode: 0o600 });
    } catch { /* @silent-fallback-ok — the record is a count; the status still shows it */ }
  }

  status(): SweepStatus {
    let pendingIntents = 0;
    try { pendingIntents = (this.open().prepare('SELECT COUNT(*) AS n FROM intents').get() as { n: number }).n; } catch { pendingIntents = -1; }
    const pending = Object.values(this.roots).reduce((a, r) => a + r.bytesPending, 0);
    return {
      mode: this.safeMode(),
      running: this.timer !== null,
      breakerOpenUntil: this.breakerOpenUntil > this.now() ? new Date(this.breakerOpenUntil).toISOString() : null,
      lastPassAt: this.lastPassAt ? new Date(this.lastPassAt).toISOString() : null,
      firstPass: { done: pending === 0 && this.lastPassAt !== null, bytesChecked: this.firstPassBytesChecked, bytesTotal: this.firstPassBytesTotal, heldByLoad: this.heldByLoad && pending > 0, verdict: this.safeVerdict() },
      oldestUncheckedAgeSeconds: pending > 0 && this.lastPassAt ? Math.round((this.now() - this.lastPassAt) / 1000) : null,
      roots: JSON.parse(JSON.stringify(this.roots)) as Record<string, RootStatus>,
      unmeasured: [...this.unmeasured.values()].slice(0, 200),
      shortCredentialsNotMatched: this.safeShort(),
      pendingIntents,
    };
  }

  private safeMode(): CredentialScrubMode { try { return this.deps.mode(); } catch { return 'off'; } } // @silent-fallback-ok — unreadable switch is off
  private safeVerdict(): LoadVerdict { try { return this.deps.loadVerdict(); } catch { return 'unknown'; } } // @silent-fallback-ok — unknown paces at the elevated rate
  private safeOwn(): OwnCredentialMatcher | null { try { return this.deps.ownCredentials(); } catch { return null; } } // @silent-fallback-ok — patterns alone still mask every wall kind
  private safeShort(): number { try { return this.deps.shortCredentialCount(); } catch { return 0; } } // @silent-fallback-ok — a count for the status only
  private safeReport(reason: string): void { try { this.deps.report(reason); } catch { /* @silent-fallback-ok — reporting never stops the sweep */ } }
}
