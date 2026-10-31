/** Peer-owned, advisory diagnosis child. Full verification preempts it. */
import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { SafeFsExecutor } from '../core/SafeFsExecutor.js';
import { diagnosisKey, type DiagnosisIdentity, type DiagnosisMode } from './failedFileDiagnosis.js';
import { diagnosisImportRefusal, parseDiagnosisPeerRequest, type DiagnosisPeerAnswer, type DiagnosisPeerRequest } from './failedFileDiagnosisPeer.js';
import { ATTEMPT_ID_RE } from './record.js';
import type { DiagnosisMarker } from './failedFileDiagnosisStore.js';
import type { ChildHandle, LocalVerifyServiceSeams } from './LocalVerifyService.js';
import { failedFileRunPaths, type FailedFileRunInput, type FailedFileRunResult } from './runFailedFileDiagnosis.js';

interface PeerCurrent { request: DiagnosisPeerRequest; pid: number | null; startedAt: number; inputPath: string; resultPath: string }
interface PeerDone { attemptId: string; answer: DiagnosisPeerAnswer; at: number }
interface PeerState { v: 1; current: PeerCurrent | null; results: PeerDone[]; tombstones: Array<{ attemptId: string; at: number }> }
const RETAIN_MS = 14 * 24 * 60 * 60_000;
const MAX_RESULTS = 200;
const MAX_RUN_MS = 15 * 60_000;

export interface FailedFileDiagnosisPeerConfig {
  stateDir: string; agentHome: string; repo: string; remoteUrl: string; machineId: string;
  verifierVersion: string; policyHash: string; nodePath: string; childEntry: string;
  protectedList: readonly string[]; baseEnv: NodeJS.ProcessEnv;
}

export interface FailedFileDiagnosisPeerDeps {
  now(): number;
  mode(): DiagnosisMode;
  fullVerifyBusy(): boolean;
  updatePending(): boolean;
  prView(pr: number): Promise<{ headRefOid: string; baseRefName: string } | null>;
  baseHead(ref: string): Promise<string | null>;
  isPrOpen(pr: number): Promise<boolean | null>;
  currentLease(): { holdsLease: boolean; holderMachineId: string | null; leaseEpoch: number | null };
  spawnRun: LocalVerifyServiceSeams['spawnRun'];
  isGroupAlive: LocalVerifyServiceSeams['isGroupAlive'];
  killGroup: LocalVerifyServiceSeams['killGroup'];
  readProcessArgs: LocalVerifyServiceSeams['readProcessArgs'];
  audit(event: Record<string, unknown>): void;
}

function identityOf(req: DiagnosisPeerRequest): DiagnosisIdentity {
  return { repo: req.repo, pr: req.pr, headSha: req.headSha, baseSha: req.baseSha,
    baseRefName: req.baseRefName, verifierVersion: req.verifierVersion,
    policyHash: req.policyHash, failedFiles: req.failedFiles };
}

export class FailedFileDiagnosisPeerService {
  private readonly statePath: string;
  private readonly runsDir: string;
  private state: PeerState = { v: 1, current: null, results: [], tombstones: [] };
  private preempting: Promise<boolean> | null = null;

  constructor(private readonly cfg: FailedFileDiagnosisPeerConfig, private readonly deps: FailedFileDiagnosisPeerDeps) {
    this.statePath = path.join(cfg.stateDir, 'state', 'local-verify', 'failed-file-diagnosis-peer.json');
    this.runsDir = path.join(cfg.stateDir, 'state', 'local-verify', 'diagnosis-runs');
    if (fs.existsSync(this.statePath)) {
      let doc: unknown;
      try { doc = JSON.parse(fs.readFileSync(this.statePath, 'utf8')); } catch { throw new Error('failed-file diagnosis peer state unreadable'); }
      const s = doc as PeerState;
      if (!s || s.v !== 1 || !Array.isArray(s.results) || !Array.isArray(s.tombstones)
        || s.results.length > MAX_RESULTS || s.tombstones.length > MAX_RESULTS
        || s.current !== null && (!s.current || !parseDiagnosisPeerRequest(s.current.request)
          || !(s.current.pid === null || Number.isSafeInteger(s.current.pid) && s.current.pid > 0)
          || !Number.isFinite(s.current.startedAt)
          || s.current.inputPath !== path.join(this.runsDir, `${s.current.request.attemptId}.input.json`)
          || s.current.resultPath !== path.join(this.runsDir, `${s.current.request.attemptId}.result.json`))
        || !s.tombstones.every((t) => t && typeof t.attemptId === 'string' && ATTEMPT_ID_RE.test(t.attemptId) && Number.isFinite(t.at))
        || !s.results.every((r) => r && typeof r.attemptId === 'string' && ATTEMPT_ID_RE.test(r.attemptId)
          && Number.isFinite(r.at) && r.answer?.attemptId === r.attemptId)) throw new Error('failed-file diagnosis peer state unreadable');
      this.state = s;
    }
  }

  private persist(): void {
    const now = this.deps.now();
    this.state.results = this.state.results.filter((r) => now - r.at <= RETAIN_MS).slice(-MAX_RESULTS);
    this.state.tombstones = this.state.tombstones.filter((r) => now - r.at <= RETAIN_MS).slice(-MAX_RESULTS);
    fs.mkdirSync(path.dirname(this.statePath), { recursive: true });
    const tmp = `${this.statePath}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(this.state), { mode: 0o600 }); /* state-registry: local-verify-failed-file-diagnosis-peer */
    fs.renameSync(tmp, this.statePath);
  }

  private removeScratch(current: PeerCurrent): void {
    const files = [current.inputPath, `${current.inputPath}.pid`, current.resultPath,
      path.join(this.runsDir, `${current.request.attemptId}.log`)];
    for (const file of files) {
      try { SafeFsExecutor.safeRmSync(file, { force: true, operation: 'local-verify:diagnosis-scratch' }); }
      catch (error) { this.deps.audit({ event: 'failed-file-diagnosis-scratch-removal-failed',
        attemptId: current.request.attemptId, detail: String(error).slice(0, 160) }); }
    }
  }

  private async recoverSpawnPid(current: PeerCurrent): Promise<number | null | 'unknown'> {
    const pidFile = `${current.inputPath}.pid`;
    if (fs.existsSync(pidFile)) {
      try {
        const pid = Number(fs.readFileSync(pidFile, 'utf8').trim());
        return Number.isSafeInteger(pid) && pid > 0 ? pid : 'unknown';
      } catch { return 'unknown'; }
    }
    // Before the child writes its PID it has not created a worktree. A scan
    // closes the tiny window where it was spawned but has not run its first line.
    const output = await new Promise<string | null>((resolve) => {
      execFile('ps', ['-A', '-o', 'pid=,pgid=,command='], { encoding: 'utf8', timeout: 2_000 },
        (error, stdout) => resolve(error ? null : stdout));
    });
    if (output === null) return 'unknown';
    const token = `--attempt-token ${current.request.attemptId}`;
    const matches = output.split('\n').map((line) => line.trim().match(/^(\d+)\s+(\d+)\s+(.+)$/))
      .filter((m): m is RegExpMatchArray => !!m && m[3].includes(this.cfg.childEntry) && m[3].includes(token));
    if (matches.length > 1 || matches.some((m) => Number(m[1]) !== Number(m[2]))) return 'unknown';
    return matches.length === 1 ? Number(matches[0][1]) : null;
  }

  private async removeAttemptTree(current: PeerCurrent): Promise<boolean> {
    const paths = failedFileRunPaths(this.cfg.agentHome, current.request.attemptId);
    try {
      if (fs.existsSync(paths.shortTemps)) {
        if (!fs.lstatSync(paths.shortTemps).isDirectory()
          || fs.readFileSync(path.join(paths.shortTemps, '.owner'), 'utf8') !== current.request.attemptId) return false;
        await SafeFsExecutor.safeRm(paths.shortTemps, { recursive: true, force: true,
          operation: 'local-verify:diagnosis-short-temp-cleanup' });
      }
      await SafeFsExecutor.safeRm(paths.root, { recursive: true, force: true,
        localVerifyScopeOk: { verifyRoot: paths.verifyRoot }, operation: 'local-verify:diagnosis-attempt-cleanup' });
      return true;
    } catch (error) {
      this.deps.audit({ event: 'failed-file-diagnosis-attempt-cleanup-failed',
        attemptId: current.request.attemptId, detail: String(error).slice(0, 160) });
      return false;
    }
  }

  /** A restart never resumes a diagnostic child as authoritative; it tombstones and reaps it. */
  async boot(): Promise<void> {
    if (this.state.current) await this.preempt('restart');
  }

  busy(): boolean { return this.state.current !== null || this.preempting !== null; }
  status() { return { enabled: this.deps.mode() === 'auto', busy: this.busy() || this.deps.fullVerifyBusy() || this.deps.updatePending(),
    verifierVersion: this.cfg.verifierVersion, policyHash: this.cfg.policyHash }; }

  result(attemptId: string): { state: 'unknown' | 'running' } | { state: 'done'; answer: DiagnosisPeerAnswer } {
    if (this.state.current?.request.attemptId === attemptId) return { state: 'running' };
    const done = this.state.results.find((r) => r.attemptId === attemptId);
    return done ? { state: 'done', answer: done.answer } : { state: 'unknown' };
  }

  async accept(value: unknown, ctx: { holdsLease: boolean; holderMachineId: string | null; leaseEpoch: number | null }): Promise<{ accepted: boolean; reason?: string }> {
    const req = parseDiagnosisPeerRequest(value);
    if (!req) return { accepted: false, reason: 'invalid-request' };
    if (req.repo !== this.cfg.repo || req.verifierVersion !== this.cfg.verifierVersion || req.policyHash !== this.cfg.policyHash)
      return { accepted: false, reason: 'verifier-or-policy-mismatch' };
    if (ctx.holdsLease || !ctx.holderMachineId || ctx.holderMachineId !== req.coordinatorMachineId || ctx.leaseEpoch !== req.leaseEpoch)
      return { accepted: false, reason: 'lease-mismatch' };
    if (this.state.current?.request.attemptId === req.attemptId || this.state.results.some((r) => r.attemptId === req.attemptId))
      return { accepted: true };
    if (this.state.tombstones.some((r) => r.attemptId === req.attemptId)) return { accepted: false, reason: 'attempt-tombstoned' };
    if (this.deps.mode() !== 'auto') return { accepted: false, reason: 'disabled' };
    if (this.busy() || this.deps.fullVerifyBusy() || this.deps.updatePending()) return { accepted: false, reason: 'busy' };
    const [view, base, open] = await Promise.all([
      this.deps.prView(req.pr).catch(() => null), this.deps.baseHead(req.baseRefName).catch(() => null),
      this.deps.isPrOpen(req.pr).catch(() => null),
    ]);
    if (open !== true || !view || view.headRefOid !== req.headSha || view.baseRefName !== req.baseRefName || base !== req.baseSha)
      return { accepted: false, reason: 'head-base-or-target-moved' };
    const liveLease = this.deps.currentLease();
    if (liveLease.holdsLease || liveLease.holderMachineId !== req.coordinatorMachineId || liveLease.leaseEpoch !== req.leaseEpoch)
      return { accepted: false, reason: 'lease-mismatch' };
    if (this.busy() || this.deps.fullVerifyBusy() || this.deps.updatePending() || this.deps.mode() !== 'auto')
      return { accepted: false, reason: 'busy' };
    fs.mkdirSync(this.runsDir, { recursive: true });
    const inputPath = path.join(this.runsDir, `${req.attemptId}.input.json`);
    const resultPath = path.join(this.runsDir, `${req.attemptId}.result.json`);
    const logFile = path.join(this.runsDir, `${req.attemptId}.log`);
    const input: FailedFileRunInput = { request: req, agentHome: this.cfg.agentHome, remoteUrl: this.cfg.remoteUrl,
      baseEnv: this.cfg.baseEnv, peerMachineId: this.cfg.machineId, protectedList: this.cfg.protectedList };
    fs.writeFileSync(inputPath, JSON.stringify(input), { mode: 0o600 });
    this.state.current = { request: req, pid: null, startedAt: this.deps.now(), inputPath, resultPath };
    this.persist(); // durable intent before spawn
    let child: ChildHandle;
    try {
      child = this.deps.spawnRun({ command: this.cfg.nodePath,
        args: [this.cfg.childEntry, '--input', inputPath, '--result', resultPath, '--attempt-token', req.attemptId],
        env: this.cfg.baseEnv, logFile });
    } catch (error) {
      this.complete(req, this.inconclusive(req, `spawn-error:${String(error).slice(0, 80)}`));
      return { accepted: true };
    }
    this.state.current.pid = child.pid;
    this.persist();
    void child.exited.then(() => this.settle(req.attemptId)).catch(() => this.settle(req.attemptId));
    this.deps.audit({ event: 'failed-file-diagnosis-peer-started', attemptId: req.attemptId, pr: req.pr });
    return { accepted: true };
  }

  private inconclusive(req: DiagnosisPeerRequest, reason: string): DiagnosisPeerAnswer {
    return { attemptId: req.attemptId, identity: identityOf(req), peerMachineId: this.cfg.machineId,
      coordinatorMachineId: req.coordinatorMachineId, leaseEpoch: req.leaseEpoch, classification: 'inconclusive', files: [],
      machineMinutes: Math.min(15, Math.max(0, this.deps.now() - (this.state.current?.startedAt ?? this.deps.now())) / 60_000),
      reason: reason.slice(0, 160) };
  }

  private complete(req: DiagnosisPeerRequest, answer: DiagnosisPeerAnswer): void {
    const current = this.state.current;
    if (current?.request.attemptId !== req.attemptId) return;
    this.state.current = null;
    this.state.results.push({ attemptId: req.attemptId, answer, at: this.deps.now() });
    this.persist();
    this.removeScratch(current);
    this.deps.audit({ event: 'failed-file-diagnosis-peer-finished', attemptId: req.attemptId,
      classification: answer.classification });
  }

  private async settle(attemptId: string): Promise<void> {
    const current = this.state.current;
    if (!current || current.request.attemptId !== attemptId) return;
    if (current.pid !== null && this.deps.isGroupAlive(current.pid)) {
      await this.preempt('workers-after-child-exit');
      return;
    }
    let run: FailedFileRunResult | { kind: 'crash'; reason: string } | null = null;
    try { run = JSON.parse(fs.readFileSync(current.resultPath, 'utf8')) as FailedFileRunResult | { kind: 'crash'; reason: string }; }
    catch { /* missing child result */ }
    // Even a child crash can leave installed worktrees behind. Confirmed group
    // exit is the point at which cleanup may safely reclaim the whole attempt.
    if (!await this.removeAttemptTree(current)) return;
    let answer = this.inconclusive(current.request, run?.kind === 'unsafe-cleanup' ? run.reason : 'child-crash');
    if (run?.kind === 'done') {
      const marker: DiagnosisMarker = { key: diagnosisKey(identityOf(current.request)), identity: identityOf(current.request),
        attemptId, peerMachineId: this.cfg.machineId, leaseEpoch: current.request.leaseEpoch,
        state: 'running', createdAt: current.startedAt, updatedAt: current.startedAt };
      const refusal = diagnosisImportRefusal(run.answer, marker, { holdsLease: true,
        leaseEpoch: current.request.leaseEpoch, coordinatorMachineId: current.request.coordinatorMachineId,
        verifierVersion: this.cfg.verifierVersion, policyHash: this.cfg.policyHash });
      if (!refusal) answer = run.answer;
    }
    this.complete(current.request, answer);
  }

  /** Called ahead of any full verify; unknown process identity keeps the peer blocked. */
  async preempt(reason = 'full-verify'): Promise<boolean> {
    if (this.preempting) return this.preempting;
    const current = this.state.current;
    if (!current) return true;
    this.preempting = (async () => {
      let pid = current.pid;
      if (pid === null) {
        const recovered = await this.recoverSpawnPid(current);
        if (recovered === 'unknown') return false;
        if (recovered === null) {
          if (fs.existsSync(failedFileRunPaths(this.cfg.agentHome, current.request.attemptId).root)) return false;
        } else {
          pid = recovered;
          current.pid = recovered;
          this.persist();
        }
      }
      if (pid !== null && this.deps.isGroupAlive(pid)) {
        const args = await this.deps.readProcessArgs(pid).catch(() => null);
        if (!args?.includes(`--attempt-token ${current.request.attemptId}`)) return false;
        this.deps.killGroup(pid, 'SIGTERM');
        await new Promise((resolve) => setTimeout(resolve, 1500));
        if (this.deps.isGroupAlive(pid)) this.deps.killGroup(pid, 'SIGKILL');
        if (this.deps.isGroupAlive(pid)) await new Promise((resolve) => setTimeout(resolve, 1500));
        if (this.deps.isGroupAlive(pid)) return false;
      }
      if (!await this.removeAttemptTree(current)) return false;
      this.state.tombstones.push({ attemptId: current.request.attemptId, at: this.deps.now() });
      this.state.current = null;
      this.persist();
      this.removeScratch(current);
      this.deps.audit({ event: 'failed-file-diagnosis-peer-preempted', attemptId: current.request.attemptId, reason });
      return true;
    })();
    try { return await this.preempting; } finally { this.preempting = null; }
  }

  async tick(): Promise<void> {
    const current = this.state.current;
    if (!current) return;
    if (this.deps.fullVerifyBusy() || this.deps.updatePending()
      || this.deps.now() - current.startedAt > MAX_RUN_MS) await this.preempt('capacity-or-deadline');
  }
}
