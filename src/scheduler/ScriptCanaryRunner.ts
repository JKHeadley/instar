/**
 * ScriptCanaryRunner — the daily must-fail canaries for converted script jobs
 * (docs/specs/job-cost-reduction.md §5.6.4, Layer 3).
 *
 * A model reading run summaries cannot prove that a check is able to fail: a
 * working check and a broken one that always reports success print the same
 * thing. So once a day per machine, each converted script job is run against a
 * loopback stub that answers with that script's must-fail fixture, and the run
 * must print `JOB_RESULT failed` (or its expected `JOB_ANOMALY` lines).
 *
 * Who can start it: ONLY the scheduler, through `tick()`. There is no enable
 * flag on purpose — nothing in a job manifest, the config or the environment
 * switches canaries on or changes what they run. The arguments passed to each
 * script come from the table in this file, never from the job definition, and
 * the canary environment variable is set on the child only.
 *
 * Isolation (per script, see CANARY_SPECS):
 *   - every server call goes to a 127.0.0.1 stub on an ephemeral port;
 *   - prober scripts get `--prober <stub>` that exits with one of the real
 *     prober's exit codes, so the real prober never runs;
 *   - health-check gets `--disk-free-override`, so a real disk reading never
 *     decides a canary;
 *   - canary runs are never queued for triage and never handed to ordinary
 *     script-run observers (runScriptCanary in JobScheduler owns that).
 *
 * Results: each run is recorded in THIS machine's run history (trigger
 * `script-canary`) and audited in logs/job-anomaly.jsonl with its runId. Failed
 * canaries raise ONE attention item per machine (conditionKey
 * `script-canary:<machineId>`), refreshed as the failing list changes and
 * cleared when every canary passes. It never writes cluster-shared job state,
 * so it works on standbys too.
 */

import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import type { JobDefinition } from '../core/types.js';
import { SafeFsExecutor } from '../core/SafeFsExecutor.js';
import type { ParsedAnomaly, ParsedScriptRun } from './jobScriptProtocol.js';

/** JobDefinition plus the script-runner fields Builder A adds to the shared type. */
export type ScriptJobLike = JobDefinition & {
  runner?: 'script';
  scriptSupervision?: 'triage' | 'deterministic';
};

export type FloorVerdict = 'needs_session' | 'routine';

export interface CanaryFixture {
  status: number;
  body: string;
  contentType?: string;
}

/** One canary invocation of a script. */
export interface CanaryVariant {
  /** Stable name shown in run history and the audit row. */
  name: string;
  fixture: CanaryFixture;
  /** Extra per-script flags (besides --canary and --server-url). */
  flags?: string[];
  /** When set, a stub prober exiting with this code is passed as --prober. */
  proberExitCode?: number;
  /** What the run must show. */
  expect: { result?: 'failure' | 'skipped'; anomalies?: string[] };
  /** Feed this variant's reasons into the real episode code (health-check). */
  episode?: boolean;
  /** Triage-floor assertions in audit-only mode (triage-class scripts only). */
  floor?: Array<{ consecutiveFailures: number; expect: FloorVerdict }>;
}

const SERVER_500: CanaryFixture = { status: 500, body: '{"error":"canary fixture: internal error"}' };
const MALFORMED: CanaryFixture = { status: 200, body: '{"canary": not json', contentType: 'application/json' };

/** A degraded authed /health: every recoverable reason plus a feature degradation. */
const DEGRADED_HEALTH: CanaryFixture = {
  status: 200,
  body: JSON.stringify({
    status: 'degraded',
    llmReliability: { status: 'degraded' },
    sessions: { active: 10, max: 10 },
    degradationFeatures: ['canary-fixture'],
    degradationSummary: ['canary fixture degradation'],
  }),
};

/** A reminder pass whose retries are exhausted (the critical reason). */
const REMINDER_GAVE_UP: CanaryFixture = {
  status: 200,
  body: JSON.stringify({ enabled: true, dryRun: false, sent: 0, gaveUp: 2, pending: 0, undelivered: 2 }),
};

/** The ordinary must-fail pair every script gets unless its spec says otherwise. */
function standardVariants(floor?: CanaryVariant['floor']): CanaryVariant[] {
  return [
    { name: 'server-500', fixture: SERVER_500, expect: { result: 'failure' }, ...(floor ? { floor } : {}) },
    { name: 'malformed-body', fixture: MALFORMED, expect: { result: 'failure' } },
  ];
}

/** A triage-class first failure is routine; a second consecutive one asks for a session. */
const FAILURE_FLOOR: CanaryVariant['floor'] = [
  { consecutiveFailures: 0, expect: 'routine' },
  { consecutiveFailures: 1, expect: 'needs_session' },
];

/** Prober scripts: one run per real prober exit code, mapped as the script's test pins. */
function proberVariants(codes: Array<{ code: number; expect: 'failure' | 'skipped' }>): CanaryVariant[] {
  return [
    ...standardVariants().map(v => ({ ...v, proberExitCode: 0 })),
    ...codes.map(c => ({
      name: `prober-exit-${c.code}`,
      fixture: { status: 200, body: '{}' },
      proberExitCode: c.code,
      expect: { result: c.expect },
    })),
  ];
}

/**
 * Per-script canary table. A converted job with no entry here gets the
 * standard pair (500 and malformed body, both must fail). The prober exit-code
 * mappings mirror each script's own unit-test mapping table; a mismatch shows
 * as a failing canary, never a silent pass.
 */
export const CANARY_SPECS: Readonly<Record<string, () => CanaryVariant[]>> = {
  'health-check': () => [
    { name: 'server-500', fixture: SERVER_500, flags: ['--disk-free-override', '50'], expect: { result: 'failure' }, floor: FAILURE_FLOOR },
    {
      name: 'degraded-disk-critical', fixture: DEGRADED_HEALTH, flags: ['--disk-free-override', '3'],
      expect: { anomalies: ['disk-critical', 'llm-unreliable', 'degradation:canary-fixture'] },
      episode: true,
      floor: [{ consecutiveFailures: 0, expect: 'needs_session' }],
    },
    {
      name: 'degraded-recoverable-only', fixture: DEGRADED_HEALTH, flags: ['--disk-free-override', '50'],
      expect: { anomalies: ['llm-unreliable', 'degradation:canary-fixture'] },
      floor: [{ consecutiveFailures: 0, expect: 'routine' }],
    },
  ],
  'commitment-checkin-reminder': () => [
    ...standardVariants(FAILURE_FLOOR),
    {
      name: 'undelivered-reminders', fixture: REMINDER_GAVE_UP,
      expect: { anomalies: ['undelivered-reminders'] },
      floor: [{ consecutiveFailures: 0, expect: 'needs_session' }],
    },
  ],
  'doorway-scan': () => proberVariants([{ code: 1, expect: 'failure' }]),
  'stall-matrix-live-check': () => proberVariants([{ code: 1, expect: 'failure' }, { code: 2, expect: 'skipped' }]),
  'routing-price-refresh': () => proberVariants([{ code: 1, expect: 'failure' }]),
  'routing-price-web-verify': () => proberVariants([{ code: 1, expect: 'failure' }]),
};

export function canaryVariantsFor(job: ScriptJobLike): CanaryVariant[] {
  const spec = CANARY_SPECS[job.slug];
  const variants = spec ? spec() : standardVariants();
  // Floor assertions apply to triage-class scripts only; a deterministic
  // script's verdict is the whole answer and is never triaged.
  if (job.scriptSupervision !== 'triage') return variants.map(({ floor: _floor, ...v }) => v);
  if (!spec) return standardVariants(FAILURE_FLOOR);
  return variants;
}

export interface CanaryClock {
  now(): number;
  advance(ms: number): void;
}

export interface EpisodeHarnessResult {
  ok: boolean;
  /** Plain-English names of the transitions that did not happen as expected. */
  failures: string[];
}

export interface CanaryAttentionItem {
  id: string;
  conditionKey: string;
  title: string;
  summary: string;
  priority: 'HIGH';
  source: 'agent';
  category: string;
}

export interface ScriptCanaryRunnerDeps {
  scheduler: {
    listScriptJobs(): JobDefinition[];
    runScriptCanary(slug: string, opts: { serverUrl: string; extraArgs?: string[]; env?: Record<string, string> }): Promise<{ parsed: ParsedScriptRun; exitCode: number; stdout: string }>;
  };
  history: {
    recordStart(opts: { slug: string; sessionId: string; trigger: string }): string;
    recordCompletion(opts: { runId: string; result: 'success' | 'failure' | 'timeout'; error?: string; outputSummary?: string }): void;
  };
  machineId: string;
  /** The agent's state dir (.instar): the once-a-day marker lives under state/. */
  stateDir: string;
  /** logs/job-anomaly.jsonl lives under this directory. */
  logsDir: string;
  raiseAttention(item: CanaryAttentionItem): void | Promise<unknown>;
  clearAttention(conditionKey: string, resolution: string): void;
  /** Builder D: drives the real episode code under the `canary:<runId>:` namespace. */
  episodeHarness?: (runId: string, reasons: ParsedAnomaly[], clock: CanaryClock) => Promise<EpisodeHarnessResult> | EpisodeHarnessResult;
  /** Builder E: the deterministic triage floor, called in audit-only mode. */
  floorFn?: (input: { slug: string; runId: string; parsed: ParsedScriptRun; consecutiveFailures: number; mode: 'audit-only' }) => FloorVerdict | string;
  now?: () => number;
  /** Minimum gap between daily passes (default 24 h). */
  intervalMs?: number;
}

export interface CanaryVariantOutcome {
  slug: string;
  variant: string;
  runId: string;
  passed: boolean;
  /** Plain reasons, empty when passed. */
  problems: string[];
}

export interface CanaryPassReport {
  ranAt: string;
  outcomes: CanaryVariantOutcome[];
  failingSlugs: string[];
}

const DAY_MS = 24 * 60 * 60 * 1000;
const MARKER_FILE = 'script-canary-last-run.json';

export const scriptCanaryConditionKey = (machineId: string): string => `script-canary:${machineId}`;

export class ScriptCanaryRunner {
  private readonly d: ScriptCanaryRunnerDeps;
  private running = false;
  /** Failing slugs at the last pass; null = unknown (fresh process). */
  private lastFailing: string[] | null = null;

  constructor(deps: ScriptCanaryRunnerDeps) {
    this.d = deps;
  }

  private now(): number { return (this.d.now ?? Date.now)(); }

  private markerPath(): string { return path.join(this.d.stateDir, 'state', MARKER_FILE); }

  private lastRunAt(): number | null {
    try {
      const raw = JSON.parse(fs.readFileSync(this.markerPath(), 'utf-8')) as { lastRunAt?: string };
      const t = raw.lastRunAt ? Date.parse(raw.lastRunAt) : NaN;
      return Number.isFinite(t) ? t : null;
    } catch {
      // @silent-fallback-ok — a missing/corrupt marker means "never ran": run now.
      return null;
    }
  }

  private writeMarker(at: number): void {
    try {
      fs.mkdirSync(path.dirname(this.markerPath()), { recursive: true });
      fs.writeFileSync(this.markerPath(), JSON.stringify({ lastRunAt: new Date(at).toISOString() }));
    } catch (err) {
      // @silent-fallback-ok: failure to write the cadence marker is logged; the next tick retries the canary.
      console.warn('[ScriptCanaryRunner] could not write the daily marker:', err instanceof Error ? err.message : String(err));
    }
  }

  /**
   * Called from the scheduler's tick. Runs the daily pass when due. This is
   * the only entry point that starts canaries.
   */
  async tick(): Promise<CanaryPassReport | null> {
    if (this.running) return null;
    const last = this.lastRunAt();
    const interval = this.d.intervalMs ?? DAY_MS;
    if (last !== null && this.now() - last < interval) return null;
    const jobs = this.d.scheduler.listScriptJobs() as ScriptJobLike[];
    if (jobs.length === 0) return null;
    this.running = true;
    try {
      this.writeMarker(this.now());
      return await this.runPass(jobs);
    } finally {
      this.running = false;
    }
  }

  private async runPass(jobs: ScriptJobLike[]): Promise<CanaryPassReport> {
    const outcomes: CanaryVariantOutcome[] = [];
    for (const job of jobs) {
      for (const variant of canaryVariantsFor(job)) {
        outcomes.push(await this.runVariant(job, variant));
      }
    }
    const failingSlugs = [...new Set(outcomes.filter(o => !o.passed).map(o => o.slug))].sort();
    this.reportToAttention(failingSlugs, outcomes);
    return { ranAt: new Date(this.now()).toISOString(), outcomes, failingSlugs };
  }

  private async runVariant(job: ScriptJobLike, variant: CanaryVariant): Promise<CanaryVariantOutcome> {
    const runId = this.d.history.recordStart({ slug: job.slug, sessionId: 'script-canary', trigger: 'script-canary' });
    const problems: string[] = [];
    let stub: { url: string; close(): Promise<void> } | null = null;
    let proberDir: string | null = null;
    let parsed: ParsedScriptRun | null = null;
    try {
      stub = await startFixtureStub(variant.fixture);
      const extraArgs = ['--canary', ...(variant.flags ?? [])];
      if (variant.proberExitCode !== undefined) {
        proberDir = fs.mkdtempSync(path.join(os.tmpdir(), 'instar-canary-prober-'));
        extraArgs.push('--prober', writeStubProber(proberDir, variant.proberExitCode));
      }
      const res = await this.d.scheduler.runScriptCanary(job.slug, {
        serverUrl: stub.url,
        extraArgs,
        env: { INSTAR_SCRIPT_CANARY: '1' },
      });
      parsed = res.parsed;
      problems.push(...checkExpectation(variant, res.parsed));
      if (variant.episode) problems.push(...(await this.checkEpisode(runId, res.parsed)));
      if (variant.floor && job.scriptSupervision === 'triage') problems.push(...this.checkFloor(job.slug, runId, res.parsed, variant.floor));
    } catch (err) {
      problems.push(`canary could not run: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      if (stub) await stub.close().catch(() => { /* @silent-fallback-ok — stub already closed */ });
      if (proberDir) {
        try { SafeFsExecutor.safeRmSync(proberDir, { recursive: true, force: true, operation: 'ScriptCanaryRunner: remove stub prober' }); }
        catch { /* @silent-fallback-ok — tmpdir cleanup is best-effort */ }
      }
    }
    const passed = problems.length === 0;
    this.d.history.recordCompletion({
      runId,
      result: passed ? 'success' : 'failure',
      ...(passed ? {} : { error: problems.join('; ').slice(0, 500) }),
      outputSummary: `canary ${variant.name}: ${parsed ? `${parsed.result} ${parsed.summary}`.slice(0, 300) : 'no result'}`,
    });
    this.audit({ runId, slug: job.slug, variant: variant.name, passed, problems });
    return { slug: job.slug, variant: variant.name, runId, passed, problems };
  }

  private async checkEpisode(runId: string, parsed: ParsedScriptRun): Promise<string[]> {
    if (!this.d.episodeHarness) return ['episode harness not wired, so the episode transitions were not checked'];
    let t = this.now();
    const clock: CanaryClock = { now: () => t, advance: (ms) => { t += ms; } };
    try {
      const r = await this.d.episodeHarness(runId, parsed.anomalies, clock);
      return r.ok ? [] : r.failures.map(f => `episode: ${f}`);
    } catch (err) {
      return [`episode harness threw: ${err instanceof Error ? err.message : String(err)}`];
    }
  }

  private checkFloor(slug: string, runId: string, parsed: ParsedScriptRun, cases: NonNullable<CanaryVariant['floor']>): string[] {
    if (!this.d.floorFn) return ['triage floor not wired, so the floor verdicts were not checked'];
    const problems: string[] = [];
    for (const c of cases) {
      try {
        const got = this.d.floorFn({ slug, runId, parsed, consecutiveFailures: c.consecutiveFailures, mode: 'audit-only' });
        if (got !== c.expect) problems.push(`floor gave ${String(got)} (expected ${c.expect}) at ${c.consecutiveFailures} prior failures`);
      } catch (err) {
        problems.push(`floor threw: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    return problems;
  }

  private audit(row: { runId: string; slug: string; variant: string; passed: boolean; problems: string[] }): void {
    try {
      fs.mkdirSync(this.d.logsDir, { recursive: true });
      fs.appendFileSync(path.join(this.d.logsDir, 'job-anomaly.jsonl'), JSON.stringify({
        ts: new Date(this.now()).toISOString(), kind: 'script-canary', machineId: this.d.machineId, ...row,
      }) + '\n');
    } catch (err) {
      console.warn('[ScriptCanaryRunner] audit write failed:', err instanceof Error ? err.message : String(err));
    }
  }

  private reportToAttention(failingSlugs: string[], outcomes: CanaryVariantOutcome[]): void {
    const conditionKey = scriptCanaryConditionKey(this.d.machineId);
    const prev = this.lastFailing;
    this.lastFailing = failingSlugs;
    if (failingSlugs.length === 0) {
      if (prev === null || prev.length > 0) {
        try { this.d.clearAttention(conditionKey, 'cleared: every script-job canary passed'); }
        catch (err) { console.warn('[ScriptCanaryRunner] attention clear failed:', err instanceof Error ? err.message : String(err)); }
      }
      return;
    }
    if (prev !== null && prev.join(',') === failingSlugs.join(',')) return;
    const lines = failingSlugs.map(slug => {
      const first = outcomes.find(o => o.slug === slug && !o.passed);
      return `- ${slug}: ${first?.problems[0] ?? 'failed'}`;
    });
    try {
      void Promise.resolve(this.d.raiseAttention({
        id: `script-canary-${this.d.machineId}`,
        conditionKey,
        title: `A scheduled job's safety check failed on this machine (${failingSlugs.length})`,
        summary: `The daily must-fail check showed that these jobs may no longer report a real failure:\n${lines.join('\n')}\nDetails are in each job's run history.`,
        priority: 'HIGH',
        source: 'agent',
        category: 'script-canary',
      })).catch((err: unknown) => console.warn('[ScriptCanaryRunner] attention raise failed:', err instanceof Error ? err.message : String(err)));
    } catch (err) {
      console.warn('[ScriptCanaryRunner] attention raise failed:', err instanceof Error ? err.message : String(err));
    }
  }
}

/** Did the run show what the variant demands? Returns the plain problems. */
export function checkExpectation(variant: CanaryVariant, parsed: ParsedScriptRun): string[] {
  const problems: string[] = [];
  if (variant.expect.result && parsed.result !== variant.expect.result) {
    const why = parsed.reasonCode === 'script-untrusted' ? ' (script failed its hash check)' : '';
    problems.push(`printed ${parsed.result}${why}, expected ${variant.expect.result}`);
  }
  for (const kind of variant.expect.anomalies ?? []) {
    if (!parsed.anomalies.some(a => a.kind === kind)) problems.push(`missing anomaly ${kind}`);
  }
  return problems;
}

/** Start a loopback stub that answers every request with the fixture. */
export function startFixtureStub(fixture: CanaryFixture): Promise<{ url: string; close(): Promise<void> }> {
  return new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      req.resume();
      res.writeHead(fixture.status, { 'Content-Type': fixture.contentType ?? 'application/json' });
      res.end(fixture.body);
    });
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address() as AddressInfo;
      resolve({
        url: `http://127.0.0.1:${addr.port}`,
        close: () => new Promise<void>((r) => { server.closeAllConnections?.(); server.close(() => r()); }),
      });
    });
  });
}

/** A stub prober that exits with the given code (shebang + mode 755: runnable directly or via node). */
export function writeStubProber(dir: string, exitCode: number): string {
  const file = path.join(dir, `stub-prober-exit-${exitCode}.mjs`);
  fs.writeFileSync(file, `#!/usr/bin/env node\nprocess.exit(${Math.trunc(exitCode)});\n`, { mode: 0o755 });
  return file;
}
