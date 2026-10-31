/** Lease-holder-only, advisory failed-file diagnosis dispatcher and result journal. */
import crypto from 'node:crypto';
import { diagnosisCandidate, diagnosisKey, type DiagnosisIdentity, type DiagnosisMode } from './failedFileDiagnosis.js';
import { diagnosisImportRefusal, type DiagnosisPeerClient, type DiagnosisPeerRequest } from './failedFileDiagnosisPeer.js';
import { DIAGNOSIS_LIMITS, FailedFileDiagnosisStore, type DiagnosisMarker } from './failedFileDiagnosisStore.js';
import { parsePeers } from './peer.js';
import type { LocalVerifyRecord } from './record.js';

export interface FailedFileDiagnosisCoordinatorDeps {
  now(): number;
  mode(): unknown;
  holdsLease(): boolean;
  leaseEpoch(): number | null;
  peers(): unknown;
  /** A queued/running full verify always wins the peer's capacity. */
  fullVerifyWaiting(): boolean;
  prView(pr: number): Promise<{ headRefOid: string; baseRefName: string } | null>;
  baseHead(baseRefName: string): Promise<string | null>;
  isPrOpen(pr: number): Promise<boolean | null>;
  client: DiagnosisPeerClient;
  audit(event: Record<string, unknown>): void;
}

export class FailedFileDiagnosisCoordinator {
  private readonly store: FailedFileDiagnosisStore | null;
  private running = false;
  private readonly observed = new Set<string>();

  constructor(private readonly cfg: { stateDir: string; repo: string; machineId: string; verifierVersion: string; policyHash: string },
    private readonly deps: FailedFileDiagnosisCoordinatorDeps) {
    try { this.store = new FailedFileDiagnosisStore(cfg.stateDir); }
    catch (error) {
      this.store = null;
      deps.audit({ event: 'failed-file-diagnosis-store-unreadable', detail: String(error).slice(0, 160) });
    }
  }

  mode(): DiagnosisMode {
    let value: unknown;
    try { value = this.deps.mode(); } catch { return 'off'; }
    return this.store && (value === 'observe' || value === 'auto') ? value : 'off';
  }

  summary() {
    const rows = this.store?.list() ?? [];
    return { mode: this.mode(), storeReady: this.store !== null,
      pending: rows.filter((r) => r.state !== 'done').length,
      completed: rows.filter((r) => r.state === 'done').length,
      machineMinutes: rows.reduce((n, r) => n + (r.result?.machineMinutes ?? 0), 0) };
  }

  forRecord(record: LocalVerifyRecord): DiagnosisMarker | null {
    const candidate = diagnosisCandidate(record);
    return candidate ? this.store?.get(diagnosisKey(candidate)) ?? null : null;
  }

  private async isCurrent(identity: DiagnosisIdentity): Promise<boolean> {
    const [view, base, open] = await Promise.all([
      this.deps.prView(identity.pr).catch(() => null),
      this.deps.baseHead(identity.baseRefName).catch(() => null),
      this.deps.isPrOpen(identity.pr).catch(() => null),
    ]);
    return open === true && view?.headRefOid === identity.headSha
      && view.baseRefName === identity.baseRefName && base === identity.baseSha;
  }

  /** One bounded action per service tick; never runs on the HTTP request path. */
  /* @self-action-controller: local-verify-failed-file-diagnosis */
  async tick(records: readonly LocalVerifyRecord[]): Promise<void> {
    if (this.running || !this.store) return;
    this.running = true;
    try { await this.tickOnce(records); }
    catch (error) { this.deps.audit({ event: 'failed-file-diagnosis-tick-error', detail: String(error).slice(0, 160) }); }
    finally { this.running = false; }
  }

  private async tickOnce(records: readonly LocalVerifyRecord[]): Promise<void> {
    const store = this.store!;
    const now = this.deps.now();
    store.expire(now);
    if (!this.deps.holdsLease()) {
      for (const m of store.list().filter((r) => r.state !== 'done')) store.inconclusive(m.key, m.attemptId, 'lease-lost', now);
      return;
    }
    const active = store.list().find((r) => r.state !== 'done');
    if (active) { await this.poll(active, records); return; }
    const mode = this.mode();
    if (mode === 'off') return;
    // A full verify takes precedence, even when a peer has spare CPU right now.
    if (this.deps.fullVerifyWaiting()) return;
    const eligible = records
      .map((record) => ({ record, identity: diagnosisCandidate(record) }))
      .filter((x): x is { record: LocalVerifyRecord; identity: NonNullable<typeof x.identity> } => x.identity !== null)
      // A retained red record cannot start a fresh episode after its marker
      // ages out of the bounded journal. Only fresh failures are candidates.
      .filter((x) => { const finished = Date.parse(x.record.finishedAt);
        return Number.isFinite(finished) && finished <= now + 5 * 60_000
          && now - finished <= DIAGNOSIS_LIMITS.maxCandidateAgeMs; })
      .filter((x) => x.identity.repo === this.cfg.repo && x.identity.verifierVersion === this.cfg.verifierVersion
        && x.identity.policyHash === this.cfg.policyHash && !store.get(diagnosisKey(x.identity)))
      .sort((a, b) => a.record.finishedAt.localeCompare(b.record.finishedAt));
    if (!eligible.length) return;
    let identity: DiagnosisIdentity | null = null;
    for (const candidate of eligible) {
      if (await this.isCurrent(candidate.identity)) { identity = candidate.identity; break; }
    }
    if (!identity) return;
    const key = diagnosisKey(identity);
    if (mode === 'observe') {
      if (!this.observed.has(key)) {
        this.observed.add(key);
        if (this.observed.size > 200) this.observed.delete(this.observed.values().next().value as string);
        this.deps.audit({ event: 'failed-file-diagnosis-observed', pr: identity.pr, headSha: identity.headSha,
          files: identity.failedFiles, maxMachineMinutes: DIAGNOSIS_LIMITS.maxRunMs / 60_000 });
      }
      return;
    }
    const peers = parsePeers(this.deps.peers(), this.cfg.machineId);
    for (const peer of peers) {
      const status = await this.deps.client.status(peer);
      if (!status || !status.enabled || status.busy || status.verifierVersion !== this.cfg.verifierVersion
        || status.policyHash !== this.cfg.policyHash) continue;
      if (!this.deps.holdsLease() || this.deps.fullVerifyWaiting()) return;
      if (!await this.isCurrent(identity)) return;
      const attemptId = crypto.randomBytes(16).toString('hex');
      const epoch = this.deps.leaseEpoch();
      const marker = store.reserve(identity, attemptId, peer.machineId, epoch, this.deps.now());
      if (!marker) return;
      const request: DiagnosisPeerRequest = { ...identity, attemptId, coordinatorMachineId: this.cfg.machineId, leaseEpoch: epoch };
      const answer = await this.deps.client.diagnose(peer, request);
      if (!this.deps.holdsLease() || this.deps.leaseEpoch() !== epoch) {
        store.inconclusive(marker.key, attemptId, 'lease-moved', this.deps.now());
      } else if (answer?.accepted) {
        store.accepted(marker.key, attemptId, this.deps.now());
        this.deps.audit({ event: 'failed-file-diagnosis-started', pr: identity.pr, attemptId, peer: peer.machineId });
      } else if (answer?.reason === 'busy') {
        // The peer did no work, but a stale idle status could otherwise cause
        // this self-triggered coordinator to dispatch the same key every tick.
        // Persist a terminal advisory result so pressure settles after one RPC.
        store.inconclusive(marker.key, attemptId, 'peer-busy', this.deps.now());
      } else {
        store.inconclusive(marker.key, attemptId, answer?.reason ?? 'transport-error', this.deps.now());
      }
      return; // one peer and one attempt for this key
    }
  }

  private async poll(marker: DiagnosisMarker, records: readonly LocalVerifyRecord[]): Promise<void> {
    const store = this.store!;
    const peer = parsePeers(this.deps.peers(), this.cfg.machineId).find((p) => p.machineId === marker.peerMachineId);
    if (!peer) { store.inconclusive(marker.key, marker.attemptId, 'peer-unconfigured', this.deps.now()); return; }
    const [view, base, open] = await Promise.all([
      this.deps.prView(marker.identity.pr).catch(() => null),
      this.deps.baseHead(marker.identity.baseRefName).catch(() => null),
      this.deps.isPrOpen(marker.identity.pr).catch(() => null),
    ]);
    if (!this.deps.holdsLease() || this.deps.leaseEpoch() !== marker.leaseEpoch) {
      store.inconclusive(marker.key, marker.attemptId, 'lease-moved', this.deps.now()); return;
    }
    if (open === false || view && (view.headRefOid !== marker.identity.headSha || view.baseRefName !== marker.identity.baseRefName)
      || base && base !== marker.identity.baseSha) {
      store.inconclusive(marker.key, marker.attemptId, 'head-base-or-target-moved', this.deps.now()); return;
    }
    if (!view || open === null || !base) return; // uncertainty waits only until the 15-minute marker deadline
    const response = await this.deps.client.result(peer, marker.attemptId);
    if (!response || response.state === 'unknown') {
      store.inconclusive(marker.key, marker.attemptId, response ? 'peer-lost-attempt' : 'transport-error', this.deps.now());
      return;
    }
    if (response.state === 'running') return;
    if (!await this.isCurrent(marker.identity)) {
      store.inconclusive(marker.key, marker.attemptId, 'head-base-or-target-moved', this.deps.now());
      return;
    }
    const refusal = diagnosisImportRefusal(response.answer, marker, {
      holdsLease: this.deps.holdsLease(), leaseEpoch: this.deps.leaseEpoch(), coordinatorMachineId: this.cfg.machineId,
      verifierVersion: this.cfg.verifierVersion, policyHash: this.cfg.policyHash,
    });
    if (refusal) { store.inconclusive(marker.key, marker.attemptId, refusal, this.deps.now()); return; }
    const origin = records.find((r) => r.repo === marker.identity.repo && r.pr === marker.identity.pr
      && r.headSha === marker.identity.headSha && r.baseSha === marker.identity.baseSha
      && r.baseRefName === marker.identity.baseRefName);
    const main = origin ? records.filter((r) => r.kind === 'main' && r.headSha === marker.identity.baseSha
      && r.machineId === origin.machineId).sort((a, b) => b.finishedAt.localeCompare(a.finishedAt))[0] : null;
    const files = response.answer.files.map((row) => ({ file: row.file, originalPr: 'assertion-fail' as const,
      peerPr: row.peerPr, peerBase: row.peerBase,
      ...(main ? { latestMainOnOrigin: main.outcome === 'success' ? 'pass' as const : 'unknown' as const } : {}) }));
    store.finish(marker.key, marker.attemptId, {
      classification: response.answer.classification, files,
      machineMinutes: response.answer.machineMinutes, ...(response.answer.reason ? { reason: response.answer.reason } : {}),
    }, this.deps.now());
    this.deps.audit({ event: 'failed-file-diagnosis-done', pr: marker.identity.pr, attemptId: marker.attemptId,
      classification: response.answer.classification, machineMinutes: response.answer.machineMinutes });
  }
}
