import { fork, type ChildProcess } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { type BrowserCanary, type PreparedBrowserChild, type TelegramBrowserDriver } from './BrowserTypes.js';
import { TelegramRpcRefusal } from './TelegramBrowserBroker.js';

/** Explicit enrollment only; browser cookies are never converted into an MTProto session. */
export interface MtprotoEnrollment {
  apiId: number;
  apiHash: string;
  sessionString: string;
  expectedAccountId: string;
}
export class EnrolledMtprotoDriver implements TelegramBrowserDriver {
  private readonly child: ChildProcess;
  private sequence = 0;
  private closed = false;
  private readonly pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
  private readonly ready: Promise<unknown>;
  private readonly exited: Promise<void>;
  constructor(enrollment: MtprotoEnrollment) {
    if (!Number.isSafeInteger(enrollment.apiId) || enrollment.apiId < 1 || !/^[a-f0-9]{32}$/i.test(enrollment.apiHash)
      || !enrollment.sessionString || !/^[1-9][0-9]*$/.test(enrollment.expectedAccountId)) throw new Error('mtproto-enrollment-required');
    this.child = fork(fileURLToPath(new URL('./EnrolledMtprotoWorker.js', import.meta.url)), [], {
      stdio: ['ignore', 'ignore', 'ignore', 'ipc'], execArgv: [], serialization: 'json',
    });
    this.exited = new Promise(resolve => {
      const failed = () => { this.closed = true; for (const p of this.pending.values()) p.reject(new Error('mtproto-worker-exited')); this.pending.clear(); resolve(); };
      this.child.once('exit', failed); this.child.once('error', failed);
    });
    this.child.on('message', (message: unknown) => {
      const m = message as { id?: number; result?: unknown; refusalCode?: number; failed?: boolean };
      const pending = this.pending.get(m.id!);
      if (!pending) return;
      this.pending.delete(m.id!);
      if (typeof m.refusalCode === 'number') pending.reject(new TelegramRpcRefusal(m.refusalCode));
      else if (m.failed) pending.reject(new Error('mtproto-worker-failed'));
      else pending.resolve(m.result);
    });
    // Enrollment travels only on the private inherited IPC descriptor, never argv or a log.
    this.ready = this.request('enroll', enrollment);
    void this.ready.catch(() => this.close());
  }
  private request(op: string, value?: unknown): Promise<unknown> {
    if (this.closed) return Promise.reject(new Error('mtproto-worker-closed'));
    const id = ++this.sequence;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.child.send({ id, op, value }, error => { if (error) { this.pending.delete(id); reject(new Error('mtproto-ipc-failed')); } });
    });
  }
  async canary(): Promise<BrowserCanary> { await this.ready; return await this.request('canary') as BrowserCanary; }
  async readSnapshot(): Promise<{ text: string; accountId: string }> {
    const canary = await this.canary();
    if (!canary.supported) throw new Error('mtproto-account-mismatch');
    return { text: 'Enrolled MTProto account connected.', accountId: canary.accountId };
  }
  async invoke(child: Readonly<PreparedBrowserChild>): Promise<unknown> { await this.ready; return this.request('invoke', child); }
  async close(): Promise<void> {
    if (!this.closed) { this.closed = true; this.child.kill('SIGKILL'); }
    await this.exited;
  }
}
