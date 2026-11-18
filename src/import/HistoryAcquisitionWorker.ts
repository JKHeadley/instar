/* @self-action-controller: history-acquisition-notice-retry */
import { randomUUID } from 'node:crypto';
import { Readable } from 'node:stream';
import path from 'node:path';
import { AcquisitionWorkerLease } from './AcquisitionWorkerLease.js';
import { AcquisitionArchives } from './archiveStaging.js';
import { receiveExportDelivery, type DeliveryDeps } from './exportDelivery.js';
import { HistoryAcquisitionStore, type OwnerChat, type AcquisitionJob, type ExportAccount, type Provider } from './HistoryAcquisition.js';
import { ImportedHistoryStore } from './ImportedHistoryStore.js';
import { ZipRefused } from './safeZip.js';
import { previewExport, applyExport, type ImportPreview } from './importExport.js';
import { requestPersonalExport, observePersonalExport } from './personalExportDriver.js';

/** Installed on the machine with the explicitly granted mailbox and dedicated browser.
 * A provider enters the desktop capability only after a real acquisition has been proven there. */
export interface AcquisitionConnection {
  available(owner: string, machine: string): readonly Provider[];
  accounts(chat: OwnerChat, provider: Provider): readonly ExportAccount[];
  /** Resolve only an existing operation-specific grant. No ambient credential lookup. */
  delivery(job: AcquisitionJob): Omit<DeliveryDeps<{ sha256: string; size: number }>, 'stage' | 'signal'> | undefined;
}

export interface WorkerOptions {
  stateDir: string;
  /** Runtime authority: local native owner still controls this private conversation. Required even on recovery. */
  authorized: (chat: OwnerChat) => boolean;
  browserDir?: string;
  connection: AcquisitionConnection;
  request?: typeof requestPersonalExport;
  observe?: typeof observePersonalExport;
  now?: () => number;
}
export type AcquisitionNotice = { chat: OwnerChat; id: string; noticeId: string; text: string };
type Outcome = { phase: AcquisitionJob['phase']; attention?: string; noticeDelivery?: 'exhausted' };
const APPROVAL_TTL = 30 * 60_000;

export class HistoryAcquisitionWorker {
  private timer?: NodeJS.Timeout;
  private ticking = false;
  private operations = 0;
  private closing = false;
  private onIdle?: () => void;
  private closeResult?: Promise<void>;
  private readonly lease: AcquisitionWorkerLease;
  private readonly jobs: HistoryAcquisitionStore;
  private readonly archives: AcquisitionArchives;
  private readonly busyProfiles = new Set<string>();
  private readonly active = new Map<string, AbortController>();
  private readonly approvals = new Map<string, { id: string; digest: string; expires: number }>();
  private readonly now: () => number;
  private readonly browserDir: string;
  constructor(private readonly options: WorkerOptions) {
    this.now = options.now ?? Date.now;
    this.browserDir = options.browserDir ?? path.join(options.stateDir, 'scripts', 'browser');
    this.lease = new AcquisitionWorkerLease(options.stateDir);
    let opened: HistoryAcquisitionStore | undefined;
    try {
      this.jobs = opened = new HistoryAcquisitionStore(options.stateDir, this.now);
      this.archives = new AcquisitionArchives(options.stateDir);
      this.jobs.recoverInterruptedApplies();
      this.archives.recover(id => this.jobs.keepArchive(id));
    } catch (error) {
      opened?.close();
      this.lease.close();
      throw error;
    }
  }

  providers(owner: string, machine: string): Provider[] {
    return [...new Set(this.options.connection.available(owner, machine))].filter(p => p === 'claude' || p === 'chatgpt');
  }

  accounts(chat: OwnerChat, provider: Provider): readonly ExportAccount[] {
    return this.options.authorized(chat) && this.providers(chat.owner, chat.machine).includes(provider)
      ? this.options.connection.accounts(chat, provider).filter(a => a.provider === provider && a.workspace === 'personal') : [];
  }

  async start(chat: OwnerChat, provider: Provider, accountEmail: string, requestId: string) {
    const matches = this.accounts(chat, provider).filter(a => a.expectedEmail.toLowerCase() === accountEmail.trim().toLowerCase());
    if (matches.length !== 1) throw new Error('account-unavailable');
    const job = this.jobs.start(chat, matches[0], requestId);
    return { id: job.id, ...await this.step(chat, job.id) };
  }

  status(chat: OwnerChat, id: string): Outcome {
    this.requireOwner(chat);
    const job = this.jobs.read(chat, id);
    if (!job) throw new Error('unknown-export');
    if (job.phase === 'expired') this.archives.discard(id);
    const attention = this.jobs.attentionFor(job);
    return {phase:job.phase, ...(attention ? {attention} : {}),
      ...(this.jobs.noticeExhausted(chat,id) ? {noticeDelivery:'exhausted' as const} : {})};
  }

  async step(chat: OwnerChat, id: string): Promise<Outcome> {
    return this.tracked(() => this.stepInner(chat, id));
  }

  private async stepInner(chat: OwnerChat, id: string): Promise<Outcome> {
    this.requireOwner(chat);
    const job = this.jobs.read(chat, id);
    if (!job) throw new Error('unknown-export');
    if (this.active.has(id) || !['ready', 'submitting', 'waiting'].includes(job.phase)) return this.status(chat, id);
    if (this.busyProfiles.has(job.profileId)) return { ...this.status(chat, id), attention: 'browser-in-use' };
    this.busyProfiles.add(job.profileId);
    const control = new AbortController();
    this.active.set(id, control);
    const observedStatus = (reason?: string): Outcome => {
      this.requireOwner(chat);
      const current = this.jobs.read(chat, id);
      if (!current) throw new Error('unknown-export');
      this.jobs.recordAttention(current, reason);
      return this.status(chat, id);
    };
    try {
      if (job.phase !== 'ready' && !this.jobs.claimObservation(chat, id)) return this.status(chat, id);
      // Recheck grant and availability before touching either the provider or a mailbox.
      const accountIsCurrent = () => this.accounts(chat, job.provider).some(account =>
        account.profileId === job.profileId && account.expectedEmail.trim().toLowerCase() === job.expectedEmail);
      if (!accountIsCurrent()) {
        return observedStatus('verify-account');
      }
      const delivery = this.options.connection.delivery(job);
      if (!delivery) return observedStatus('mail-access');
      const options = {
        browserDir: this.browserDir,
        signal: control.signal,
        authorized: () => !this.closing && this.options.authorized(chat) && accountIsCurrent()
          && Boolean(this.options.connection.delivery(job)),
      };
      if (job.phase === 'ready') {
        let refused: 'mail-access' | 'verify-account' | undefined;
        const out = await (this.options.request ?? requestPersonalExport)(job, {
          ...options, reserveSubmission: async () => {
            if (control.signal.aborted || !this.options.authorized(chat)) return false;
            if (!accountIsCurrent()) refused = 'verify-account';
            else if (!this.options.connection.delivery(job)) refused = 'mail-access';
            return !refused && this.jobs.reserveSubmission(chat, id);
          },
        });
        this.requireOwner(chat);
        if (out.status === 'acknowledged') this.jobs.acknowledge(chat, id);
        return observedStatus(refused ?? (out.status === 'needs-attention' ? out.reason : undefined));
      }
      // A restart after publishing the file but before recording its preview needs no second download.
      let staged = this.archives.hasArchive(id);
      if (!staged) {
        if (job.phase === 'submitting') {
          const observed = await (this.options.observe ?? observePersonalExport)(job, options);
          if (observed.status === 'acknowledged') this.jobs.acknowledge(chat, id);
        }
        if (control.signal.aborted) return this.status(chat, id);
        this.requireOwner(chat);
        if (!accountIsCurrent()) return observedStatus('verify-account');
        const currentDelivery = this.options.connection.delivery(job);
        if (!currentDelivery) return observedStatus('mail-access');
        const receipt = await receiveExportDelivery({ jobId: id, provider: job.provider, account: job.expectedEmail, workspace: 'personal', requestedAt: job.requestedAt! }, {
          ...currentDelivery, signal: control.signal,
          stage: (bytes, signal) => { this.requireOwner(chat); return this.archives.stage(id, Readable.from(bytes), signal); },
        });
        if (receipt.kind === 'refused' && receipt.reason === 'invalid-archive') throw new ZipRefused('invalid-archive');
        if (receipt.kind !== 'staged') return observedStatus('reason' in receipt ? receipt.reason : undefined);
        staged = true;
      }
      if (staged) {
        const digest = await this.archives.readSnapshot(id, async (file, receipt) => {
          const preview = await previewExport(file, job);
          if (preview.from !== job.provider) throw new Error('wrong-export-provider');
          return receipt.sha256;
        });
        this.requireOwner(chat);
        if (!this.jobs.review(chat, id, digest) && !this.jobs.keepArchive(id)) this.archives.discard(id);
      }
      return observedStatus();
    } catch (error) {
      if (error instanceof ZipRefused) {
        this.requireOwner(chat);
        this.jobs.rejectArchive(chat, id);
        this.archives.discard(id);
        return this.status(chat, id);
      }
      throw error;
    } finally {
      this.active.delete(id);
      this.busyProfiles.delete(job.profileId);
    }
  }

  /** A newly opened worker never inherits a previous process's permission to apply. */
  async preview(chat: OwnerChat, id: string): Promise<{ preview: ImportPreview; confirmation: string }> {
    return this.tracked(() => this.previewInner(chat, id));
  }

  private async previewInner(chat: OwnerChat, id: string): Promise<{ preview: ImportPreview; confirmation: string }> {
    this.requireOwner(chat);
    const job = this.jobs.read(chat, id);
    if (!job || job.phase !== 'review') throw new Error('preview-unavailable');
    const preview = await this.archives.readSnapshot(id, async (file, receipt) => {
      if (receipt.sha256 !== job.previewDigest) throw new Error('archive-changed');
      const summary = await previewExport(file, job);
      if (summary.from !== job.provider) throw new Error('wrong-export-provider');
      return summary;
    });
    if (this.status(chat, id).phase !== 'review') throw new Error('preview-unavailable');
    for (const [key, value] of this.approvals) if (value.id === id || value.expires <= this.now()) this.approvals.delete(key);
    const confirmation = randomUUID();
    this.approvals.set(confirmation, { id, digest: job.previewDigest!, expires: this.now() + APPROVAL_TTL });
    return { preview, confirmation };
  }

  async apply(chat: OwnerChat, id: string, confirmation: string) {
    return this.tracked(() => this.applyInner(chat, id, confirmation));
  }

  private async applyInner(chat: OwnerChat, id: string, confirmation: string) {
    this.requireOwner(chat);
    const job = this.jobs.read(chat, id);
    if (job?.phase !== 'review') throw new Error('fresh-preview-required');
    const ok = this.approvals.get(confirmation);
    if (!ok || ok.id !== id || ok.expires <= this.now()) throw new Error('fresh-preview-required');
    const result = await this.archives.readSnapshot(id, async (file, receipt) => {
      if (receipt.sha256 !== ok.digest) throw new Error('archive-changed');
      let began = false;
      try {
        return await applyExport(file, new ImportedHistoryStore(this.options.stateDir), () => {
          this.requireOwner(chat);
          if (this.approvals.get(confirmation) !== ok || ok.expires <= this.now() || !this.jobs.beginApply(chat, id, ok.digest)) {
            throw new Error('fresh-preview-required');
          }
          began = true;
          this.approvals.delete(confirmation);
        }, job);
      } catch (error) {
        // Existing importer deduplicates by source IDs. Only the owner can initiate a fresh apply.
        if (began) this.jobs.requestReviewAfterInterruptedApply(chat, id);
        throw error;
      }
    });
    if (!this.jobs.finishApply(chat, id)) throw new Error('apply-outcome-unknown');
    this.archives.discard(id);
    return result;
  }

  cancel(chat: OwnerChat, id: string): boolean {
    this.requireOwner(chat);
    if (!this.jobs.cancel(chat, id)) return false;
    this.active.get(id)?.abort();
    this.archives.discard(id);
    return true;
  }

  async poll(report: (id: string, result: Outcome) => void): Promise<void> {
    for (const job of this.jobs.due()) {
      if (!this.options.authorized(job)) {
        if (this.jobs.cancel(job, job.id)) this.archives.discard(job.id);
        continue;
      }
      try { report(job.id, await this.step(job, job.id)); }
      catch { if (this.options.authorized(job)) report(job.id, { ...this.status(job, job.id), attention: 'export-check-failed' }); }
    }
  }

  private requireOwner(chat: OwnerChat): void {
    if (this.closing || !this.options.authorized(chat)) throw new Error('owner-chat-unavailable');
  }

  latest(chat: OwnerChat) { this.requireOwner(chat); return this.jobs.latest(chat); }

  private async tracked<T>(work: () => Promise<T>): Promise<T> {
    if (this.closing) throw new Error('worker-stopping');
    this.operations++;
    try { return await work(); } finally {
      if (--this.operations === 0) this.onIdle?.();
    }
  }

  startPolling(publish: (notice: AcquisitionNotice) => Promise<void> | void, cleanupOnly = false): void {
    if (this.timer || this.closing) return;
    const tick = async () => {
      if (this.ticking || this.closing) return;
      this.ticking = true;
      try {
        await this.tracked(async () => {
          this.archives.recover(id => this.jobs.keepArchive(id));
          if (cleanupOnly) {
            this.jobs.restoreNotices(); // Expire rows even when no archive directory exists.
            return;
          }
          await this.poll((id, outcome) => {
            if (outcome.phase === 'cancelled') return;
            if (outcome.attention || outcome.phase === 'review' || outcome.phase === 'waiting') {
              this.jobs.note(id, outcome.attention ? 'attention' : outcome.phase);
            }
          });
          this.jobs.restoreNotices();
          for (const row of this.jobs.pendingNotices()) {
            if (this.closing) break;
            if (!this.options.authorized(row)) {
              if (this.jobs.cancel(row, row.id)) this.archives.discard(row.id);
              this.jobs.delivered(row.id, row.sequence);
              continue;
            }
            const texts: Record<string, string> = {
              review: 'Your history export arrived. Open this conversation to preview it and decide what to copy.',
              waiting: 'Your provider accepted the export request. I’ll check for its arrival.',
              expired: 'The history export expired. You can start another import in this conversation.',
              rejected: 'I couldn’t verify that archive for the selected personal account. I discarded it. You can start a new import here.',
              attention: 'Your history import needs attention. Open this conversation to check its current step.',
            };
            if (!this.jobs.reserveNotice(row.id,row.sequence)) continue;
            try {
              await publish({
                chat: { owner: row.owner, machine: row.machine, conversation: row.conversation }, id: row.id,
                noticeId: row.id + '-' + row.sequence, text: texts[row.lastKind]
              });
              this.jobs.delivered(row.id, row.sequence);
            } catch { /* This reservation survives failure. Other owners' notices can still publish on this tick. */ }
          }
          const exhausted = this.jobs.takeExhaustionWarnings();
          for (let i = 0; i < exhausted; i++) {
            console.warn('[history-acquisition] Progress delivery could not be confirmed after its final attempt. Status remains available in the private chat.');
          }
        });
      } catch {
        // Never print a transport error (it can contain a signed URL). Durable notices retry next tick.
        if (!this.closing) console.warn('[history-acquisition] poll or notice delivery failed; will retry');
      } finally { this.ticking = false; }
    };
    this.timer = setInterval(() => { void tick(); }, 60_000);
    this.timer.unref();
    void tick();
  }

  close(): Promise<void> {
    if (this.closeResult) return this.closeResult;
    this.closing = true;
    clearInterval(this.timer);
    for (const controller of this.active.values()) controller.abort();
    this.closeResult = new Promise<void>(resolve => {
      const finish = () => { try { this.jobs.close(); } finally { this.lease.close(); resolve(); } };
      if (this.operations === 0) finish(); else this.onIdle = finish;
    });
    return this.closeResult;
  }
}
