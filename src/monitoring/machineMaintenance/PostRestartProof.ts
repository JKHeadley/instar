/**
 * Restart record and post-restart proof (docs/specs/machine-self-maintenance.md, Part D,
 * "Post-restart proof" and "Hand-run reboots"). CMT-1199, first slice.
 *
 * This slice restarts nothing. It does two things for EVERY boot of the machine, however
 * the restart happened:
 *
 *  1. Records it. The host's `restarts.jsonl` gets one `boot-observed` row per OS boot,
 *     attributed to a restart episode when one dispatched for that boot, otherwise
 *     `unattributed` (a person, a power cut, a session running the rule by hand). The OS
 *     boot time is the evidence, never the server's own uptime.
 *  2. Proves the machine came back. Before a boot, the maintainer keeps a baseline of what
 *     was working (desktop, logins, co-resident agents, tunnel). After a new boot it checks
 *     each row, five attempts over ten minutes, and compares with the baseline: a part that
 *     was already broken before the restart does not fail the proof.
 *
 * Self-heal per failing check and the operator notices ride with the actuator slice; here a
 * failed check is recorded and shown in `GET /machine-maintenance` under `restartProof`.
 * Only the host maintainer writes the host ledger; every agent proves its own server.
 */

import fs from 'node:fs';
import path from 'node:path';
import { atomicWriteFileSync } from '../../core/hostSemaphoreCore.js';
import type { HostMaintenanceStore, RestartLedgerRow } from './HostMaintenanceStore.js';
import { isPeerBooting } from '../../server/BootReadiness.js';

const MIN = 60_000;
/** A boot time this close to the last one is the same boot (clock read jitter). */
export const SAME_BOOT_SLACK_MS = 60_000;
export const PROOF_WINDOW_MS = 10 * MIN;
export const PROOF_ATTEMPTS = 5;
export const PROOF_ATTEMPT_GAP_MS = 2 * MIN;
/** How often the baseline is refreshed while the machine is up. */
export const BASELINE_EVERY_MS = 30 * MIN;
const TICK_MS = 60_000;

export type CheckState = 'pass' | 'fail' | 'not-applicable' | 'unknown';
export interface CheckResult { state: CheckState; reason: string; detail?: Record<string, string | number | boolean | null> }

export type ProofCheckName = 'restarted' | 'server' | 'lifeline' | 'relay' | 'tunnel' | 'desktop' | 'logins' | 'coResidentAgents';

/** What was working before the restart. Read back after it, so old breakage is not blamed on it. */
export interface Baseline {
  bootAt: number;
  at: number;
  desktopReady: boolean | null;
  screenPermission: boolean | null;
  signedOutLogins: number | null;
  tunnelConfigured: boolean | null;
  relayConnected: boolean | null;
  coResidentAgents: string[] | null;
}

export interface ProofReaders {
  serverHealth: () => Promise<CheckResult>;
  /** When the lifeline last proved itself to this server, or null if not this process. */
  lifelineProofAt: () => number | null;
  relay: () => Promise<CheckResult & { connected?: boolean | null }>;
  tunnel: () => Promise<CheckResult & { configured?: boolean | null }>;
  desktop: () => Promise<{ ready: boolean | null; screenPermission: boolean | null } | null>;
  signedOutLogins: () => Promise<number | null>;
  coResidentAgents: () => Promise<Array<{ name: string; healthy: boolean | null }> | null>;
}

export interface RestartProofRecord {
  bootAt: number;
  previousBootAt: number | null;
  attribution: string;
  startedAt: number;
  finishedAt: number | null;
  attempts: number;
  verdict: 'running' | 'passed' | 'failed' | 'no-baseline';
  baselineAt: number | null;
  checks: Partial<Record<ProofCheckName, CheckResult>>;
}

export interface PostRestartProofDeps {
  agentName: string;
  store: HostMaintenanceStore;
  readBootAt: () => Promise<number | null>;
  /** Whether this agent is the host maintainer right now (writes the host ledger). */
  isMaintainer: () => boolean;
  readers: ProofReaders;
  baselinePath: string;
  proofPath: string;
  logPath: string;
  enabled: () => boolean;
  now?: () => number;
  log?: (line: string) => void;
}

export class PostRestartProof {
  private readonly now: () => number;
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  private bootAt: number | null = null;
  private proof: RestartProofRecord | null = null;
  private nextAttemptAt = 0;
  private lastBaselineAt = 0;
  private lastError: string | null = null;

  constructor(private readonly deps: PostRestartProofDeps) {
    this.now = deps.now ?? Date.now;
    this.proof = readJson<RestartProofRecord>(deps.proofPath);
  }

  start(): void {
    if (this.timer) return;
    void this.tick();
    this.timer = setInterval(() => { void this.tick(); }, TICK_MS);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** One pass: notice a new boot, run a due proof attempt, refresh the baseline. Single-flight. */
  async tick(): Promise<void> {
    if (this.running || !this.deps.enabled()) return;
    this.running = true;
    try {
      const bootAt = await this.deps.readBootAt();
      if (bootAt === null) return;
      this.bootAt = bootAt;
      const now = this.now();
      if (!this.proof || this.proof.bootAt + SAME_BOOT_SLACK_MS < bootAt) this.beginProof(bootAt, now);
      if (this.proof && this.proof.verdict === 'running' && now >= this.nextAttemptAt) await this.attempt(now);
      // A baseline is only taken once this boot's proof has finished, so a half-recovered
      // machine is never recorded as the "before" state of the next restart.
      if (this.proof && this.proof.verdict !== 'running' && now - this.lastBaselineAt >= BASELINE_EVERY_MS) await this.takeBaseline(bootAt, now);
      this.lastError = null;
    } catch (err) {
      this.lastError = err instanceof Error ? err.message : String(err);
    } finally {
      this.running = false;
    }
  }

  private beginProof(bootAt: number, now: number): void {
    const observed = this.deps.isMaintainer() ? this.deps.store.observeBoot(bootAt, this.deps.agentName) : null;
    const baseline = readJson<Baseline>(this.deps.baselinePath);
    const previousBootAt = observed?.previousBootAt ?? baseline?.bootAt ?? this.proof?.bootAt ?? null;
    // First time this agent ever sees a boot: nothing to compare, and nothing restarted that it saw.
    const firstSeen = previousBootAt === null;
    const usable = baseline && baseline.bootAt + SAME_BOOT_SLACK_MS < bootAt ? baseline : null;
    this.proof = {
      bootAt,
      previousBootAt,
      attribution: observed?.row.attribution ?? (firstSeen ? 'first-seen' : 'not-maintainer'),
      startedAt: now,
      finishedAt: firstSeen ? now : null,
      attempts: 0,
      verdict: firstSeen ? 'no-baseline' : 'running',
      baselineAt: usable?.at ?? null,
      checks: {},
    };
    this.nextAttemptAt = now;
    this.persist();
    this.audit({ type: 'boot-observed', bootAt, previousBootAt, attribution: this.proof.attribution, baselineAt: this.proof.baselineAt });
  }

  private async attempt(now: number): Promise<void> {
    const p = this.proof!;
    const baseline = readJson<Baseline>(this.deps.baselinePath);
    const before = baseline && p.baselineAt !== null && baseline.at === p.baselineAt ? baseline : null;
    const checks = await runChecks(this.deps.readers, p, before);
    p.attempts += 1;
    p.checks = checks;
    const failing = Object.entries(checks).filter(([, c]) => c.state === 'fail').map(([k]) => k);
    const unknown = Object.entries(checks).filter(([, c]) => c.state === 'unknown').map(([k]) => k);
    const outOfTime = p.attempts >= PROOF_ATTEMPTS || now - p.startedAt >= PROOF_WINDOW_MS;
    if (failing.length === 0 && unknown.length === 0) {
      p.verdict = 'passed';
      p.finishedAt = now;
    } else if (outOfTime) {
      // An unread check is not a pass: past the bound it fails the proof with its reason.
      p.verdict = failing.length || unknown.length ? 'failed' : 'passed';
      p.finishedAt = now;
    }
    this.nextAttemptAt = now + PROOF_ATTEMPT_GAP_MS;
    this.persist();
    if (p.verdict !== 'running') {
      this.audit({ type: 'restart-proof', bootAt: p.bootAt, verdict: p.verdict, attempts: p.attempts, failing, unknown });
      this.deps.log?.(`restart proof for boot ${new Date(p.bootAt).toISOString()}: ${p.verdict}${failing.length ? ` (failing: ${failing.join(', ')})` : ''}${unknown.length ? ` (unread: ${unknown.join(', ')})` : ''}`);
    }
  }

  private async takeBaseline(bootAt: number, now: number): Promise<void> {
    const r = this.deps.readers;
    const [desktop, logins, tunnel, relay, agents] = await Promise.all([
      r.desktop().catch(() => null),
      r.signedOutLogins().catch(() => null),
      r.tunnel().catch(() => null),
      r.relay().catch(() => null),
      r.coResidentAgents().catch(() => null),
    ]);
    const baseline: Baseline = {
      bootAt,
      at: now,
      desktopReady: desktop?.ready ?? null,
      screenPermission: desktop?.screenPermission ?? null,
      signedOutLogins: logins,
      tunnelConfigured: tunnel?.configured ?? null,
      relayConnected: relay?.connected ?? null,
      coResidentAgents: agents ? agents.filter((a) => a.healthy === true).map((a) => a.name).sort() : null,
    };
    writeJson(this.deps.baselinePath, baseline);
    this.lastBaselineAt = now;
  }

  status(): Record<string, unknown> {
    const baseline = readJson<Baseline>(this.deps.baselinePath);
    return {
      bootAt: this.bootAt,
      lastProof: this.proof,
      baselineAt: baseline?.at ?? null,
      unattributedLast7Days: this.deps.store.readRestartRows().filter((r) => r.type === 'boot-observed' && r.attribution === 'unattributed' && this.now() - r.bootAt < 7 * 24 * 60 * MIN).length,
      lastError: this.lastError,
      limits: [
        'A failing check is recorded, not yet self-healed; the restart actuator slice adds one heal per check and the notices.',
        'Only the server, lifeline, relay, tunnel, desktop, logins and co-resident agents rows are proven; the sessions row arrives with planned-restart resume entries.',
      ],
    };
  }

  private persist(): void {
    if (this.proof) writeJson(this.deps.proofPath, this.proof);
  }

  private audit(entry: Record<string, unknown>): void {
    try {
      fs.mkdirSync(path.dirname(this.deps.logPath), { recursive: true });
      fs.appendFileSync(this.deps.logPath, JSON.stringify({ ts: new Date(this.now()).toISOString(), agent: this.deps.agentName, feature: 'restart-proof', ...entry }) + '\n');
    } catch { /* @silent-fallback-ok — the audit line is lost; the proof file still holds the record */ }
  }
}

/**
 * The server row from one read of this server's own `GET /health`. The server has come back
 * only when it answers 200 AND says it finished starting (`bootReadiness.state === 'ready'`).
 * While it is still starting (the boot beacon's 503, or a 200 still saying `starting`) the row
 * is unknown, so the next attempt reads it again; past the proof's bound an unknown row fails
 * the proof with this reason. Any other answer, or none, fails.
 */
export function serverHealthFromResponse(res: { status: number; headers?: { get(name: string): string | null } | null; body?: unknown } | null): CheckResult {
  if (!res) return { state: 'fail', reason: 'health-unreachable' };
  if (isPeerBooting(res)) return { state: 'unknown', reason: 'server-still-starting' };
  if (res.status !== 200) return { state: 'fail', reason: `health-${res.status}` };
  const boot = (res.body as { bootReadiness?: { state?: unknown } } | null | undefined)?.bootReadiness?.state;
  if (boot === 'ready') return { state: 'pass', reason: 'health-200-ready' };
  if (boot === 'starting') return { state: 'unknown', reason: 'server-still-starting' };
  return { state: 'unknown', reason: 'boot-state-unread' };
}

/** Each proof row against the baseline. Pure apart from the readers. */
export async function runChecks(r: ProofReaders, p: RestartProofRecord, before: Baseline | null): Promise<Partial<Record<ProofCheckName, CheckResult>>> {
  const safe = async <T>(fn: () => Promise<T>): Promise<T | null> => { try { return await fn(); } catch { return null; } };
  const out: Partial<Record<ProofCheckName, CheckResult>> = {};
  out.restarted = p.previousBootAt !== null && p.bootAt > p.previousBootAt + SAME_BOOT_SLACK_MS
    ? { state: 'pass', reason: 'os-boot-time-moved' }
    : { state: 'unknown', reason: 'no-earlier-boot-recorded' };
  out.server = (await safe(r.serverHealth)) ?? { state: 'unknown', reason: 'health-unread' };
  const proofAt = r.lifelineProofAt();
  out.lifeline = proofAt !== null && proofAt >= p.bootAt
    ? { state: 'pass', reason: 'lifeline-proved-this-boot' }
    : { state: 'fail', reason: 'no-lifeline-proof-this-boot' };
  out.relay = (await safe(r.relay)) ?? { state: 'unknown', reason: 'relay-unread' };
  out.tunnel = (await safe(r.tunnel)) ?? { state: 'unknown', reason: 'tunnel-unread' };

  const desktop = await safe(r.desktop);
  if (!desktop) out.desktop = { state: 'unknown', reason: 'desktop-unread' };
  else if (desktop.ready === true) out.desktop = desktop.screenPermission === false && before?.screenPermission === true
    ? { state: 'fail', reason: 'screen-permission-lost' }
    : { state: 'pass', reason: 'desktop-ready' };
  else if (before && before.desktopReady !== true) out.desktop = { state: 'not-applicable', reason: 'desktop-not-ready-before-restart' };
  else if (!before) out.desktop = { state: 'unknown', reason: 'desktop-not-ready-no-baseline' };
  else out.desktop = { state: 'fail', reason: 'desktop-ready-before-not-after' };

  const signedOut = await safe(r.signedOutLogins);
  if (signedOut === null) out.logins = { state: 'unknown', reason: 'logins-unread' };
  else if (!before || before.signedOutLogins === null) out.logins = { state: signedOut === 0 ? 'pass' : 'unknown', reason: signedOut === 0 ? 'all-signed-in' : 'no-baseline-to-compare', detail: { signedOut } };
  else out.logins = signedOut <= before.signedOutLogins
    ? { state: 'pass', reason: 'no-worse-than-before', detail: { signedOut, before: before.signedOutLogins } }
    : { state: 'fail', reason: 'more-signed-out-than-before', detail: { signedOut, before: before.signedOutLogins } };

  const agents = await safe(r.coResidentAgents);
  if (!agents) out.coResidentAgents = { state: 'unknown', reason: 'registry-unread' };
  else {
    const healthy = new Set(agents.filter((a) => a.healthy === true).map((a) => a.name));
    const expected = before?.coResidentAgents ?? null;
    const missing = expected ? expected.filter((n) => !healthy.has(n)) : agents.filter((a) => a.healthy !== true).map((a) => a.name);
    out.coResidentAgents = missing.length === 0
      ? { state: 'pass', reason: expected ? 'all-back' : 'all-registered-healthy', detail: { healthy: healthy.size } }
      : { state: 'fail', reason: 'agents-not-back', detail: { missing: missing.join(',') } };
  }
  return out;
}

function readJson<T>(file: string): T | null {
  try { return JSON.parse(fs.readFileSync(file, 'utf-8')) as T; } catch { return null; } // @silent-fallback-ok — absent or unreadable reads as no record
}

function writeJson(file: string, value: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  atomicWriteFileSync(file, JSON.stringify(value, null, 2), { mode: 0o644, operation: 'PostRestartProof.write' });
}

export type { RestartLedgerRow };

// ── Process-wide handles: the status route and the lifeline-proof route reach these. ──

let activeProof: PostRestartProof | null = null;
export function setActivePostRestartProof(p: PostRestartProof | null): void { activeProof = p; }
export function getActivePostRestartProof(): PostRestartProof | null { return activeProof; }

let lastLifelineProofAt: number | null = null;
/** Called when this agent's lifeline proves itself (verified) to this server process. */
export function noteLifelineProof(at: number = Date.now()): void { lastLifelineProofAt = at; }
export function lifelineProofAt(): number | null { return lastLifelineProofAt; }
