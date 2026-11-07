/**
 * AttributionAudit — the daily report. Spec section 5.
 *
 * It reads in-scope notes and writes NOTHING to any note: fixing one is a session's job, so every
 * correction passes the write gate like any other edit, and a wrong model pick can never appear as
 * a verified citation. A block's hash covers its heading and neighbouring lines, so a changed heading
 * re-checks the lines under it, and is stored only after a successful judgment, so a failure is
 * re-checked. One machine runs it at a time through the lease.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { SafeFsExecutor } from '../SafeFsExecutor.js';
import { neverReachedItsTarget, type AttributionLedger } from './AttributionLedger.js';
import type { CheckContext, CheckResult, ClaimFinding } from './AttributionService.js';
import { withoutManagedRegion } from './attributionScope.js';
import { mightCreditSomeone } from './prefilter.js';

export const AUDIT_BUDGET = { newBlocks: 20, sampled: 10, retries: 10 } as const;
export type AuditSlice = keyof typeof AUDIT_BUDGET;

const DAY_MS = 24 * 60 * 60_000;
const HOUR_MS = 60 * 60_000;
const MAX_RETRY_INTERVAL_MS = 30 * DAY_MS;
const BREAKER_AFTER_FAILURES = 3;
const REPORT_LIMIT = 200;

export interface AuditBlock { file: string; hash: string; text: string; firstLine: string }

export interface AuditRetry { file?: string; text: string; surface: string; intervalMs: number; nextAt: number; failedMachines?: string[]; ref?: string }

export interface AuditState {
  blocks: Record<string, string>;
  retries: Record<string, AuditRetry>;
  /** Oldest `unchecked` row already re-judged, so each is judged once. */
  uncheckedCursor: string;
  /** Rows newer than this have not had their read-back yet. */
  readbackCursor: string;
  /** Memory-route and peer-message rows newer than this are not in a report yet. */
  reportCursor: string;
  sampleCursor: number;
  consecutiveFailures: number;
  breakerUntil: number;
  nextRunAt: number;
  lastRunAt: string | null;
}

export interface ReportItem {
  file?: string;
  person: string | null;
  claim: string;
  reason?: string;
  ref?: unknown;
  outcome?: string;
  suggestions?: unknown[];
}

export interface AuditReport {
  generatedAt: string;
  machine: string;
  unsourced: ReportItem[];
  falseCitations: ReportItem[];
  /** Not on any live machine. A retired machine cannot be ruled out, so this never says false. */
  notFoundOnLiveMachines: ReportItem[];
  cannotCheckNow: ReportItem[];
  notWritten: ReportItem[];
  lineageChanges: ReportItem[];
  backlog: { size: number; oldestAgeHours: number | null };
  filter: { sampled: number; misses: number; estimatedMissRate: number | null };
  calls: Record<AuditSlice, number>;
}

export interface AuditDeps {
  stateDir: string;
  machine: string;
  listFiles: () => string[];
  check: (text: string, context: CheckContext, slice: AuditSlice) => Promise<CheckResult>;
  firstCommitHolding?: (file: string, line: string) => Promise<string | null>;
  ledger: AttributionLedger;
  knownPeople: () => string[];
  holdsLease: () => boolean;
  /** Whether the whole audit is allowed to run at all: false when the feature is switched off. */
  isEnabled: () => boolean;
  report: (detail: { reason: string; impact: string }) => void;
  /** Applied to any note or message text this writes to its own files. */
  scrub?: (text: string) => string;
  counters?: { sample: (miss: boolean) => void };
  suggest?: (item: ReportItem) => Promise<unknown[]>;
  now?: () => number;
  /** Judge calls spent this run on a slice. A check can take several, and the budget counts calls. */
  callsUsed?: (slice: AuditSlice) => number;
  /** Resets per-run budgets and retries anything pending before the run starts. */
  beforeRun?: () => Promise<void>;
  /** The machines answering right now: a citation waiting on one of them is retried at once. */
  machinesAnswering?: () => Promise<string[]>;
}

const FRESH_STATE: AuditState = {
  blocks: {}, retries: {}, uncheckedCursor: '', readbackCursor: '', reportCursor: '', sampleCursor: 0,
  consecutiveFailures: 0, breakerUntil: 0, nextRunAt: 0, lastRunAt: null,
};

const FALSE_CITATION = new Set(['quote-not-in-record', 'date-mismatch', 'record-not-theirs', 'identity-unverified', 'relayed', 'overstated', 'later-than-claim']);

/**
 * The brake on a failing audit: doubling from an hour up to a day, then a 24h breaker that re-opens
 * for one try at a time. However long the model stays down, this is at most about one run a day.
 */
export function nextAuditAfterFailure(consecutiveFailures: number, now: number): { nextRunAt: number; breakerUntil: number } {
  if (consecutiveFailures >= BREAKER_AFTER_FAILURES) return { nextRunAt: now + DAY_MS, breakerUntil: now + DAY_MS };
  return { nextRunAt: now + Math.min(HOUR_MS * 2 ** (consecutiveFailures - 1), DAY_MS), breakerUntil: 0 };
}

/** A note split into blocks, each hashed with its heading and the lines either side. */
export function splitBlocks(file: string, text: string): AuditBlock[] {
  const lines = text.split('\n');
  const blocks: AuditBlock[] = [];
  let heading = '';
  let start = -1;
  const close = (end: number) => {
    if (start < 0) return;
    const body = lines.slice(start, end).join('\n');
    const before = lines[start - 2] ?? '';
    const after = lines[end + 1] ?? '';
    const hash = crypto.createHash('sha256').update(`${heading}\n${before}\n${body}\n${after}`).digest('hex');
    const headed = heading ? `${heading}\n${body}` : body;
    blocks.push({ file, hash, text: headed, firstLine: lines[start] });
    start = -1;
  };
  lines.forEach((line, i) => {
    if (/^#{1,6}\s/.test(line)) { close(i); heading = line; return; }
    if (!line.trim()) { close(i); return; }
    if (start < 0) start = i;
  });
  close(lines.length);
  return blocks;
}

/* @self-action-controller: attribution-audit-retry */
export class AttributionAudit {
  private readonly stateFile: string;
  private readonly reportFile: string;
  private state: AuditState;
  private timer: ReturnType<typeof setInterval> | null = null;
  private running: Promise<AuditReport | null> | null = null;

  constructor(private readonly deps: AuditDeps) {
    this.stateFile = path.join(deps.stateDir, 'attribution', 'audit-state.json');
    this.reportFile = path.join(deps.stateDir, 'attribution', 'report.json');
    this.state = this.loadState();
  }

  start(): void {
    if (this.timer) return;
    // The first look waits a minute: a server that is coming up has better things to do.
    const look = () => {
      this.tick().catch((err: unknown) => {
        this.deps.report({ reason: `The audit run threw: ${err instanceof Error ? err.message : String(err)}`, impact: 'The attribution report did not update this run. Writes and sends are unaffected.' });
      });
    };
    const first = setTimeout(look, 60_000);
    first.unref?.();
    this.timer = setInterval(look, HOUR_MS);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  snapshot(): Pick<AuditState, 'consecutiveFailures' | 'breakerUntil' | 'nextRunAt' | 'lastRunAt'> & { retries: number } {
    const { consecutiveFailures, breakerUntil, nextRunAt, lastRunAt } = this.state;
    return { consecutiveFailures, breakerUntil, nextRunAt, lastRunAt, retries: Object.keys(this.state.retries).length };
  }

  readReport(): AuditReport | null {
    try {
      return JSON.parse(fs.readFileSync(this.reportFile, 'utf8')) as AuditReport;
    } catch {
      return null;
    }
  }

  /** The hourly look. It runs only when due, only on the lease holder, only past the breaker. */
  async tick(): Promise<AuditReport | null> {
    const now = this.now();
    if (!this.deps.isEnabled() || !this.deps.holdsLease()) return null;
    if (now < this.state.breakerUntil || now < this.state.nextRunAt) return null;
    return this.run();
  }

  /** A run. Passing `files` audits those only, for POST /attribution/audit. */
  run(files?: string[]): Promise<AuditReport | null> {
    if (this.running) return this.running;
    this.running = this.runOnce(files).finally(() => { this.running = null; });
    return this.running;
  }

  private async runOnce(onlyFiles?: string[]): Promise<AuditReport | null> {
    const now = this.now();
    const calls: Record<AuditSlice, number> = { newBlocks: 0, sampled: 0, retries: 0 };
    const items: Array<ReportItem & { finding: ClaimFinding }> = [];
    let attempted = 0;
    let succeeded = 0;
    const previous = this.readReport();
    await this.deps.beforeRun?.().catch(() => {});
    const used = (slice: AuditSlice) => this.deps.callsUsed?.(slice) ?? calls[slice];

    const judge = async (text: string, context: CheckContext, slice: AuditSlice, file?: string): Promise<CheckResult | null> => {
      if (used(slice) >= AUDIT_BUDGET[slice]) return null;
      calls[slice] += 1;
      attempted += 1;
      const result = await this.deps.check(text, { ...context, existingMarkers: true }, slice);
      // No findings and no verdict from the model reads `unchecked` with an empty list.
      if (result.verdict === 'unchecked' && result.findings.length === 0) return result;
      succeeded += 1;
      for (const finding of result.findings) {
        items.push({ file, person: finding.person, claim: finding.span, reason: finding.reason, ref: finding.ref, outcome: finding.outcome, finding });
      }
      return result;
    };

    const scheduleRetry = (key: string, retry: Omit<AuditRetry, 'intervalMs' | 'nextAt'>) => {
      const prior = this.state.retries[key];
      const intervalMs = Math.min((prior?.intervalMs ?? DAY_MS / 2) * 2, MAX_RETRY_INTERVAL_MS);
      this.state.retries[key] = { ...retry, text: this.scrub(retry.text), intervalMs, nextAt: now + intervalMs };
    };

    const handled = (key: string, block: { file?: string; text: string; surface: string }, result: CheckResult) => {
      const unsure = result.findings.filter((f) => f.outcome === 'unreachable' || f.outcome === 'unverifiable' || f.verdict === 'unchecked');
      if (unsure.length) {
        scheduleRetry(key, { file: block.file, text: block.text, surface: block.surface, failedMachines: [...new Set(unsure.flatMap((f) => f.failed ?? []))] });
      } else {
        delete this.state.retries[key];
      }
    };

    const notWritten = this.readBack(now);

    const files = onlyFiles ?? this.deps.listFiles();
    const blocks = this.readBlocks(files);
    const current = new Set(blocks.map((block) => block.hash));
    const unseen = blocks.filter((block) => this.state.blocks[`${block.file}#${block.hash}`] === undefined);
    const people = this.deps.knownPeople();
    const passes = unseen.filter((block) => mightCreditSomeone(block.text, people));
    const skipped = unseen.filter((block) => !mightCreditSomeone(block.text, people));

    // Memory first, then the blocks waiting longest. Every block starts in the same run, so the
    // file's age stands in for the oldest-unchecked order.
    const age = (file: string) => { try { return fs.statSync(file).mtimeMs; } catch { return 0; } };
    const isMemory = (file: string) => /MEMORY\.md$|agent-memory|\/memory\//.test(file);
    passes.sort((a, b) => Number(isMemory(b.file)) - Number(isMemory(a.file)) || age(a.file) - age(b.file));

    for (const block of passes) {
      const key = `${block.file}#${block.hash}`;
      const rowTime = await this.deps.firstCommitHolding?.(block.file, block.firstLine) ?? undefined;
      const result = await judge(block.text, { surface: 'audit', path: block.file, firstSeen: rowTime ?? null, ...(rowTime ? { rowTime } : {}) }, 'newBlocks', block.file);
      if (result === null) break;
      if (result.verdict === 'unchecked' && result.findings.length === 0) continue;
      this.state.blocks[key] = new Date(now).toISOString();
      handled(key, { file: block.file, text: block.text, surface: 'audit' }, result);
    }

    // A rotating sample of what the filter skipped: this is what makes its miss rate measurable.
    if (skipped.length) {
      for (let taken = 0; taken < Math.min(AUDIT_BUDGET.sampled, skipped.length); taken += 1) {
        const block = skipped[(this.state.sampleCursor + taken) % skipped.length];
        const key = `${block.file}#${block.hash}`;
        const result = await judge(block.text, { surface: 'audit', path: block.file, firstSeen: null }, 'sampled', block.file);
        if (result === null) break;
        if (result.verdict === 'unchecked' && result.findings.length === 0) continue;
        this.state.blocks[key] = new Date(now).toISOString();
        this.deps.counters?.sample(result.findings.length > 0);
      }
      this.state.sampleCursor = (this.state.sampleCursor + AUDIT_BUDGET.sampled) % Math.max(skipped.length, 1);
    }

    // Retries: uncertain outcomes regardless of hash, at once when a machine that was down returns.
    const waitingOnAMachine = Object.values(this.state.retries).some((retry) => retry.failedMachines?.length);
    const cameBack = new Set(waitingOnAMachine ? await this.deps.machinesAnswering?.().catch(() => []) : []);
    const dueRetries = Object.entries(this.state.retries)
      .filter(([, retry]) => retry.nextAt <= now || (retry.failedMachines ?? []).some((machine) => cameBack.has(machine)))
      .sort(([, a], [, b]) => a.nextAt - b.nextAt);
    for (const [key, retry] of dueRetries) {
      const result = await judge(retry.text, { surface: 'audit', path: retry.file, firstSeen: null }, 'retries', retry.file);
      if (result === null) break;
      if (result.verdict === 'unchecked' && result.findings.length === 0) continue;
      handled(key, { file: retry.file, text: retry.text, surface: retry.surface }, result);
    }

    // Unchecked rows from any surface hold their text, so messages and memory submissions are
    // re-judged too, oldest first within the budget.
    const unchecked = this.deps.ledger.rows().filter((row) => row.verdict === 'unchecked' && row.context && row.ts > this.state.uncheckedCursor);
    for (const row of unchecked) {
      const result = await judge(row.context!.text, { surface: 'audit', path: row.path, firstSeen: null, recentConversation: row.context!.recentConversation }, 'retries', row.path);
      if (result === null) break;
      if (result.verdict === 'unchecked' && result.findings.length === 0) break;
      this.state.uncheckedCursor = row.ts;
    }

    // A block no longer in a file needs no hash. A partial run over named files keeps the rest.
    if (!onlyFiles) {
      for (const key of Object.keys(this.state.blocks)) {
        if (!current.has(key.slice(key.lastIndexOf('#') + 1))) delete this.state.blocks[key];
      }
    }

    const failedRun = attempted > 0 && succeeded === 0;
    this.finishRun(failedRun, now);

    // Memory routes and peer messages warn rather than refuse, so the report is where they surface.
    const fromRoutes = this.routeFindings();
    const report = this.buildReport([...items, ...fromRoutes], notWritten, previous, unseen.length - calls.newBlocks - calls.sampled, calls, now);
    for (const item of report.unsourced.slice(0, 3)) {
      if (this.deps.suggest && used('retries') < AUDIT_BUDGET.retries) {
        item.suggestions = await this.deps.suggest(item).catch(() => []);
      }
    }
    report.calls = { newBlocks: used('newBlocks'), sampled: used('sampled'), retries: used('retries') };
    this.writeJson(this.reportFile, report);
    this.saveState();
    return report;
  }

  private routeFindings(): Array<ReportItem & { finding: ClaimFinding }> {
    const found: Array<ReportItem & { finding: ClaimFinding }> = [];
    let newest = this.state.reportCursor;
    for (const row of this.deps.ledger.rows()) {
      if (row.ts <= this.state.reportCursor || (row.surface !== 'memory-route' && row.surface !== 'threadline')) continue;
      if (row.ts > newest) newest = row.ts;
      if (row.verdict === 'pass' || row.verdict === 'unchecked') continue;
      const finding: ClaimFinding = { span: row.claim, person: row.person, verdict: 'refuse', relation: row.relation };
      found.push({ file: row.path ?? row.surface, person: row.person, claim: row.claim, reason: row.verdict, ref: row.ref, finding });
    }
    this.state.reportCursor = newest;
    return found;
  }

  /** A write that passed the gate and then failed is rare. The read-back marks its row. */
  private readBack(now: number): ReportItem[] {
    const notWritten: ReportItem[] = [];
    const ageLimit = new Date(now - 60_000).toISOString();
    let newest = this.state.readbackCursor;
    const rows = this.deps.ledger.rows();
    for (const row of rows) {
      if (row.surface !== 'note-write' || !row.path || row.ts <= this.state.readbackCursor || row.ts > ageLimit) continue;
      if (row.ts > newest) newest = row.ts;
      if (neverReachedItsTarget(row)) continue;
      let text: string;
      try {
        text = fs.readFileSync(row.path, 'utf8');
      } catch {
        text = '';
      }
      if (text.includes(row.claim)) continue;
      // A later edit may have replaced the words on purpose: its row carries this one as parent.
      if (rows.some((later) => later.parentClaimId === row.claimId)) continue;
      const { id: _id, ts: _ts, machineId: _machine, ...rest } = row;
      this.deps.ledger.record({ ...rest, verdict: 'not-written', reason: 'The text is not in the file.' });
      notWritten.push({ file: row.path, person: row.person, claim: row.claim, reason: 'not-written' });
    }
    this.state.readbackCursor = newest;
    return notWritten;
  }

  private finishRun(failedRun: boolean, now: number): void {
    this.state.lastRunAt = new Date(now).toISOString();
    if (!failedRun) {
      this.state.consecutiveFailures = 0;
      this.state.breakerUntil = 0;
      this.state.nextRunAt = now + DAY_MS;
      return;
    }
    this.state.consecutiveFailures += 1;
    const next = nextAuditAfterFailure(this.state.consecutiveFailures, now);
    this.state.nextRunAt = next.nextRunAt;
    this.state.breakerUntil = next.breakerUntil;
    if (next.breakerUntil) {
      this.deps.report({ reason: `${this.state.consecutiveFailures} audit runs failed in a row`, impact: 'The attribution report stopped updating for 24 hours. Writes and sends are unaffected.' });
    }
  }

  private buildReport(items: Array<ReportItem & { finding: ClaimFinding }>, notWritten: ReportItem[], previous: AuditReport | null, waiting: number, calls: Record<AuditSlice, number>, now: number): AuditReport {
    const plain = (item: ReportItem & { finding: ClaimFinding }): ReportItem => {
      const { finding: _finding, ...rest } = item;
      return rest;
    };
    const merge = (fresh: ReportItem[], old: ReportItem[] | undefined): ReportItem[] => {
      const seen = new Set<string>();
      const out: ReportItem[] = [];
      for (const item of [...fresh, ...(old ?? [])]) {
        const clean = { ...item, claim: this.scrub(item.claim) };
        const key = `${clean.file ?? ''}|${clean.claim}`;
        if (seen.has(key)) continue;
        seen.add(key);
        out.push(clean);
      }
      return out.slice(0, REPORT_LIMIT);
    };
    const rowsWithNoGate = this.deps.ledger.rows().filter((row) => row.verdict === 'unchecked' && row.context && row.ts > this.state.uncheckedCursor);
    const oldestUnchecked = rowsWithNoGate[0]?.ts;
    const lineageRows = this.deps.ledger.rows().filter((row) => row.linkedBy === 'judge' && row.verdict === 'later-than-claim');
    const sampled = this.sampleStats?.() ?? { sampled: 0, misses: 0 };
    return {
      generatedAt: new Date(now).toISOString(),
      machine: this.deps.machine,
      unsourced: merge(items.filter((i) => i.reason === 'unsourced' || i.reason === 'promoted-unsourced').map(plain), previous?.unsourced),
      falseCitations: merge(items.filter((i) => i.reason !== undefined && FALSE_CITATION.has(i.reason)).map(plain), previous?.falseCitations),
      notFoundOnLiveMachines: merge(items.filter((i) => i.outcome === 'not-found').map(plain), previous?.notFoundOnLiveMachines),
      cannotCheckNow: merge(items.filter((i) => i.outcome === 'unverifiable' || i.outcome === 'unreachable').map(plain), previous?.cannotCheckNow),
      notWritten: merge(notWritten, previous?.notWritten),
      lineageChanges: lineageRows.slice(-REPORT_LIMIT).map((row) => ({ person: row.person, claim: row.claim, reason: row.verdict, ref: row.ref })),
      backlog: {
        size: Math.max(0, waiting) + rowsWithNoGate.length,
        oldestAgeHours: oldestUnchecked ? Math.round((now - Date.parse(oldestUnchecked)) / HOUR_MS) : null,
      },
      filter: { ...sampled, estimatedMissRate: sampled.sampled ? sampled.misses / sampled.sampled : null },
      calls,
    };
  }

  /** Set by the runtime: the sample's running totals from the persisted counters. */
  sampleStats?: () => { sampled: number; misses: number };

  private readBlocks(files: string[]): AuditBlock[] {
    const blocks: AuditBlock[] = [];
    for (const file of files) {
      try {
        blocks.push(...splitBlocks(file, withoutManagedRegion(file, fs.readFileSync(file, 'utf8'))));
      } catch {
        // @silent-fallback-ok — a note that vanished between the listing and the read has nothing to audit.
      }
    }
    return blocks;
  }

  private scrub(text: string): string {
    return this.deps.scrub?.(text) ?? text;
  }

  private now(): number {
    return this.deps.now?.() ?? Date.now();
  }

  private loadState(): AuditState {
    try {
      return { ...FRESH_STATE, ...(JSON.parse(fs.readFileSync(this.stateFile, 'utf8')) as Partial<AuditState>) };
    } catch {
      return { ...FRESH_STATE, blocks: {}, retries: {} };
    }
  }

  private saveState(): void {
    this.writeJson(this.stateFile, this.state);
  }

  private writeJson(file: string, value: unknown): void {
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    SafeFsExecutor.atomicWriteJsonSync(file, value, { operation: 'attribution-audit', mode: 0o600 });
  }
}
