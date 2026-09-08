// Governed by: Telegram Message Origin Is Mandatory; Its Display Is Optional
// (docs/STANDARDS-REGISTRY.md). Recording and presentation are independent.
import { verifyMessage } from '../../core/agentSignatureProvenance.js';
import { randomUUID } from 'node:crypto';
import type { BrowserRecoveryAction, BrowserRecoveryDecision } from './OriginBrowserRecovery.js';
import {
  browserOperationDigest, browserPeerMatches, canonicalBrowserJson, correlateBrowserReceipt,
  validBrowserMessageId, type BrowserCanary, type BrowserOutcome, type PreparedBrowserChild,
  type TelegramBrowserDriver,
} from './BrowserTypes.js';

export class TelegramRpcRefusal extends Error {
  constructor(readonly code: number) { super('telegram-rpc-refusal'); }
}
export interface TelegramBrowserBrokerOptions {
  driverFactory: () => Promise<TelegramBrowserDriver>;
  /** MUST check the sole durable outbox claim fence, digest, full destination and live authority.
   * Called again after canary awaits, immediately before transport invocation. */
  authorizePreparedChild: (child: Readonly<PreparedBrowserChild>) => Promise<boolean>;
  resolveAgentPublicKey: (agentId: string) => Buffer | null | undefined;
  /** Registry ownership + old MCP session revocation + permitted receipt canary activation gate. */
  isProfileExclusivelyOwned: () => boolean;
  clockSkewMs: () => number | null;
  onHeld?: (reason: string, buildId?: string) => void;
  now?: () => number;
  maxOperationMs?: number;
  recovery?: (action: BrowserRecoveryAction) => Promise<BrowserRecoveryDecision>;
}

/** Narrow server-only transport. The outbox, never this class, decides retries. */
export class TelegramBrowserBroker {
  private driver?: TelegramBrowserDriver;
  private starting?: Promise<TelegramBrowserDriver>;
  private driverGeneration = 0;
  private queued = 0;
  private unsupportedCanaries = 0;
  private lastUnsupportedBuild?: string;
  private tail: Promise<unknown> = Promise.resolve();
  private held: string | null = null;
  private lastCanary?: BrowserCanary;
  private lastCanaryAt: number | null = null;
  private closed = false;
  private recoveryFence = '';
  private readonly now: () => number;
  constructor(private readonly options: TelegramBrowserBrokerOptions) { this.now = options.now ?? Date.now; }

  readStatus(): { held: string | null; canary?: BrowserCanary; canaryObservedAt: number | null; closed: boolean; publicTransportAlternative: boolean } {
    return { held: this.held, canaryObservedAt: this.lastCanaryAt, ...(this.lastCanary ? { canary: { ...this.lastCanary } } : {}), closed: this.closed,
      publicTransportAlternative: this.unsupportedCanaries >= 2 };
  }
  async readSnapshot(): Promise<{ text: string; accountId: string }> {
    return this.readDriver(driver => driver.readSnapshot());
  }
  async resolvePeer(destination: import('./BrowserTypes.js').BrowserDestination): Promise<{ [key: string]: import('./BrowserTypes.js').BrowserJson }> {
    const copy = structuredClone(destination);
    return this.readDriver(driver => {
      if (!driver.resolvePeer) throw new Error('browser-peer-resolver-unavailable');
      return driver.resolvePeer(copy);
    });
  }
  private async readDriver<T>(read: (driver: TelegramBrowserDriver) => Promise<T>): Promise<T> {
    return this.enqueue(async () => {
      if (this.closed || !this.options.isProfileExclusivelyOwned()) throw new Error('browser-profile-unavailable');
      let timer: NodeJS.Timeout | undefined;
      try {
        return await Promise.race([(async () => {
          const snapshot = await read(await this.getDriver());
          if (this.closed || !this.options.isProfileExclusivelyOwned()) throw new Error('browser-profile-unavailable');
          return snapshot;
        })(), new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('browser-read-deadline')), this.options.maxOperationMs ?? 60_000); })]);
      } catch (error) { await this.closeDriver(); throw error; }
      finally { if (timer) clearTimeout(timer); }
    });
  }
  private enqueue<T>(work: () => Promise<T>): Promise<T> {
    if (this.closed) return Promise.reject(new Error('browser-closed'));
    if (this.queued >= 32) return Promise.reject(new Error('browser-operation-capacity'));
    this.queued++;
    const operation = this.tail.then(work).finally(() => { this.queued--; });
    this.tail = operation.catch(() => undefined);
    return operation;
  }
  executePreparedChild(input: PreparedBrowserChild): Promise<BrowserOutcome> {
    // Copy before the first await; a caller cannot mutate the sealed request during the canary.
    let child: PreparedBrowserChild;
    try { child = JSON.parse(canonicalBrowserJson(input)) as PreparedBrowserChild; }
    catch { return Promise.resolve({ state: 'known-failed', reason: 'invalid-prepared-child' }); }
    return this.enqueue(() => this.execute(child));
  }
  private async getDriver(freshCanaryRetry = false): Promise<TelegramBrowserDriver> {
    if (this.closed) throw new Error('browser-closed');
    if (this.driver) return this.driver;
    if (this.starting) return this.starting;
    if (this.options.recovery && !freshCanaryRetry) {
      const fence = randomUUID();
      const result = await this.options.recovery({ kind: 'begin', fence });
      this.unsupportedCanaries = result.state.failedBuilds.length;
      if (!result.allowed) throw new Error('browser-recovery-cooldown');
      this.recoveryFence = fence;
    }
    const generation = this.driverGeneration;
    const starting = this.options.driverFactory().then(async driver => {
      if (this.closed || generation !== this.driverGeneration) {
        await driver.close();
        throw new Error('browser-startup-retired');
      }
      this.driver = driver;
      return driver;
    });
    this.starting = starting;
    try { return await starting; }
    finally { if (this.starting === starting) this.starting = undefined; }
  }
  private notifyHeld(reason: string): void {
    try { this.options.onHeld?.(reason, this.lastCanary?.buildId); }
    catch { /* Advisory failure must not turn a held request into execution authority. Status retains the hold. */ }
  }
  private reject(reason: string): BrowserOutcome {
    this.held = reason;
    this.notifyHeld(reason);
    return { state: 'known-failed', reason };
  }
  private valid(child: PreparedBrowserChild): string | null {
    if (this.closed) return 'browser-closed';
    if (!this.options.isProfileExclusivelyOwned()) return 'browser-profile-not-exclusive';
    const skew = this.options.clockSkewMs();
    if (skew === null || !Number.isFinite(skew) || Math.abs(skew) > 60_000) return 'clock-skew-unavailable';
    if (!Number.isSafeInteger(child.deadlineMs) || child.deadlineMs <= this.now()) return 'dispatch-expired';
    if (!child.childId || !child.originId || !child.claimFence || !/^[1-9][0-9]*$/.test(child.accountId)) return 'invalid-prepared-child';
    if (!['messages.sendMessage', 'messages.editMessage'].includes(child.method)) return 'unsupported-authorship-form';
    if (browserOperationDigest(child.method, child.args) !== child.digest) return 'sealed-digest-mismatch';
    if (!browserPeerMatches(child.args.peer, child.destination)) return 'destination-mismatch';
    if (child.destination.topicId !== undefined) {
      if (!validBrowserMessageId(child.destination.topicId)) return 'destination-mismatch';
      if (child.method === 'messages.sendMessage') {
        const reply = child.args.reply_to;
        if (!reply || typeof reply !== 'object' || Array.isArray(reply)
          || (reply.top_msg_id !== child.destination.topicId && reply.reply_to_msg_id !== child.destination.topicId)) return 'destination-mismatch';
      }
    }
    if (child.method === 'messages.sendMessage') {
      if (typeof child.args.random_id !== 'string' || !/^-?[1-9][0-9]*$/.test(child.args.random_id)) return 'invalid-random-id';
      const id = BigInt(child.args.random_id);
      if (id < -(1n << 63n) || id > (1n << 63n) - 1n) return 'invalid-random-id';
    } else if (!validBrowserMessageId(child.args.id)) return 'invalid-message-id';
    if (typeof child.args.message !== 'string') return 'unsupported-authorship-form';
    const verdict = verifyMessage({ raw: child.args.message, expectedTopicId: child.expectedAspTopicId,
      resolvePublicKey: id => id === child.expectedAgentId ? this.options.resolveAgentPublicKey(id) : null,
      nowSeconds: Math.floor(this.now() / 1000) });
    if (verdict.classification !== 'agent-verified') return 'invalid-authorship-signature';
    if (verdict.timestamp * 1000 > this.now() + 60_000 || this.now() >= (verdict.timestamp + 780) * 1000
      || child.deadlineMs > (verdict.timestamp + 780) * 1000) return 'authorship-dispatch-expired';
    return null;
  }
  private async execute(child: PreparedBrowserChild): Promise<BrowserOutcome> {
    let problem: string | null;
    try { problem = this.valid(child); } catch { problem = 'invalid-prepared-child'; }
    if (problem) return this.reject(problem);
    let invoked = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let expired = false;
    const budget = Math.min(child.deadlineMs - this.now(), this.options.maxOperationMs ?? 60_000);
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => { expired = true; reject(new Error('dispatch-deadline')); }, Math.max(1, budget));
    });
    try {
      const work = async (): Promise<BrowserOutcome> => {
        let driver = await this.getDriver();
        for (let attempt = 0; attempt < 2; attempt++) {
          if (expired || this.closed) { await this.closeDriver(); return this.reject('dispatch-expired'); }
          this.lastCanary = await driver.canary();
          this.lastCanaryAt = this.options.now?.() ?? Date.now();
          if (expired || this.closed) return this.reject('dispatch-expired');
          if (this.lastCanary.supported) { this.unsupportedCanaries = 0; this.lastUnsupportedBuild = undefined; }
          else if (this.lastCanary.buildId !== this.lastUnsupportedBuild) {
            this.unsupportedCanaries++;
            this.lastUnsupportedBuild = this.lastCanary.buildId;
          }
          const reason = !this.lastCanary.supported ? 'unsupported-browser-build'
            : this.lastCanary.accountId !== child.accountId ? 'browser-account-mismatch' : null;
          if (!reason) {
            if (this.options.recovery && !(await this.options.recovery({ kind: 'success', fence: this.recoveryFence })).allowed) {
              await this.closeDriver(); return this.reject('browser-recovery-fence-lost');
            }
            break;
          }
          if (this.options.recovery) {
            const result = await this.options.recovery({ kind: 'failure', fence: this.recoveryFence,
              buildId: this.lastCanary.buildId, final: attempt === 1 });
            this.unsupportedCanaries = result.state.failedBuilds.length;
            if (!result.allowed) { await this.closeDriver(); return this.reject('browser-recovery-fence-lost'); }
          }
          await this.closeDriver();
          if (attempt === 1) return this.reject(reason);
          // One fresh process and read-only canary before any possible write.
          driver = await this.getDriver(true);
        }
        if (!await this.options.authorizePreparedChild(child)) return this.reject('prepared-child-not-authorized');
        const changed = this.valid(child);
        if (expired || changed) return this.reject(changed ?? 'dispatch-expired');
        invoked = true;
        const result = await driver.invoke(child);
        if (expired) return { state: 'outcome-unknown', reason: 'dispatch-deadline' };
        const receipt = correlateBrowserReceipt(child, result);
        if (!receipt) return { state: 'outcome-unknown', reason: 'uncorrelated-server-result' };
        this.held = null;
        return { state: 'accepted', receipt };
      };
      const result = await Promise.race([work(), timeout]);
      if (result.state === 'outcome-unknown') { this.held = result.reason; await this.closeDriver(); this.notifyHeld(result.reason); }
      return result;
    } catch (error) {
      await this.closeDriver();
      const refusal = error instanceof TelegramRpcRefusal && [400, 401, 403, 404, 406, 420].includes(error.code);
      const reason = expired ? 'dispatch-deadline' : refusal ? 'telegram-rpc-refused'
        : error instanceof Error && error.message === 'browser-recovery-cooldown' ? error.message : 'browser-transport-failed';
      this.held = reason;
      this.notifyHeld(reason);
      return { state: invoked && !refusal ? 'outcome-unknown' : 'known-failed', reason };
    } finally { if (timer) clearTimeout(timer); }
  }
  private async closeDriver(): Promise<void> {
    this.driverGeneration++;
    const driver = this.driver;
    this.driver = undefined;
    if (driver) await driver.close();
  }
  async close(): Promise<void> { this.closed = true; await this.closeDriver(); }
}
