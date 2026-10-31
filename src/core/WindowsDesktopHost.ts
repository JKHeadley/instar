/** WSL-side adapter for the separately installed interactive Windows companion.
 * It never captures WSL's own display. The companion must authenticate every
 * local request and revoke on a lost heartbeat independently of this process. */
import { createHmac, createHash, randomBytes } from 'node:crypto';
import type { DesktopHost, DesktopInput, DesktopProbe } from './DesktopHost.js';

const FRAME_LIMIT = 1_250_000;
const JSON_LIMIT = 4_096;
const REQUEST_TIMEOUT_MS = 2_000;

export class WindowsDesktopHost implements DesktopHost {
  private indicatorActive = false;
  private indicatorLost: (() => void) | null = null;
  private heartbeat: ReturnType<typeof setInterval> | null = null;
  private generation = 0;
  private leaseId: string | null = null;
  private readonly pending = new Set<AbortController>();

  constructor(private readonly endpoint: string, private readonly secret: Buffer,
    private readonly send: typeof fetch = fetch) {
    const url = new URL(endpoint);
    if (url.protocol !== 'http:' || url.username || url.password || url.search || url.hash
      || url.pathname !== '/' || secret.length !== 32) {
      throw new Error('windows-desktop-companion-config-invalid');
    }
  }

  async probe(): Promise<DesktopProbe> {
    const data = await this.json('probe', {});
    if (typeof data.screenPermission !== 'boolean' || typeof data.inputPermission !== 'boolean'
      || typeof data.sessionActive !== 'boolean' || !Number.isSafeInteger(data.displayCount)
      || (data.displayCount as number) < 0 || (data.displayCount as number) > 16) {
      throw new Error('windows-desktop-probe-invalid');
    }
    return { screenPermission: data.screenPermission, inputPermission: data.inputPermission,
      sessionActive: data.sessionActive, displayCount: data.displayCount } as DesktopProbe;
  }

  async capture(): Promise<Buffer> {
    const frame = await this.call('capture', { leaseId: this.requireLease() }, FRAME_LIMIT, 'image/jpeg');
    if (frame.length < 4 || frame[0] !== 0xff || frame[1] !== 0xd8
      || frame[frame.length - 2] !== 0xff || frame[frame.length - 1] !== 0xd9) {
      throw new Error('windows-desktop-frame-invalid');
    }
    return frame;
  }

  async cursor(): Promise<{ x: number; y: number }> {
    const point = await this.json('cursor', { leaseId: this.requireLease() });
    if (typeof point.x !== 'number' || typeof point.y !== 'number'
      || !Number.isFinite(point.x) || !Number.isFinite(point.y)
      || point.x < 0 || point.x > 1 || point.y < 0 || point.y > 1) {
      throw new Error('windows-desktop-cursor-invalid');
    }
    return { x: point.x, y: point.y };
  }

  async input(action: DesktopInput): Promise<void> {
    const generation = this.generation;
    const reply = await this.json('input', { leaseId: this.requireLease(), action });
    if (generation !== this.generation || reply.ok !== true) throw new Error('windows-desktop-input-unconfirmed');
  }

  /** Stop the local input path synchronously, then ask the companion to release
   * held controls. Its own heartbeat deadline covers a lost IPC connection. */
  cancelInput(): void {
    this.generation++;
    for (const controller of this.pending) controller.abort();
    const leaseId = this.leaseId;
    if (!leaseId) return;
    void this.json('release', { leaseId }).catch(() => {
      // @silent-fallback-ok — local input is already blocked; companion's
      // independent heartbeat deadline releases controls if IPC has failed.
    });
  }

  async startIndicator(onUnexpectedExit: () => void): Promise<void> {
    if (this.indicatorActive || this.leaseId) throw new Error('windows-desktop-indicator-already-active');
    const leaseId = randomBytes(24).toString('base64url');
    this.leaseId = leaseId;
    let reply: Record<string, unknown>;
    try { reply = await this.json('start', { leaseId }); }
    catch (error) {
      if (this.leaseId === leaseId) {
        this.leaseId = null;
        void this.json('stop', { leaseId }).catch(() => {
          // @silent-fallback-ok — no local grant was admitted; the companion
          // independently expires a started lease without heartbeat.
        });
      }
      throw error;
    }
    if (this.leaseId !== leaseId || reply.ok !== true) {
      if (this.leaseId === leaseId) this.stopIndicator();
      throw new Error('windows-desktop-indicator-unconfirmed');
    }
    this.indicatorActive = true;
    this.indicatorLost = onUnexpectedExit;
    this.heartbeat = setInterval(() => {
      void this.json('heartbeat', { leaseId }).then(value => {
        if (this.leaseId !== leaseId) return;
        if (value.ok !== true) this.loseIndicator();
      }).catch(() => { if (this.leaseId === leaseId) this.loseIndicator(); });
    }, 2_000);
    this.heartbeat.unref?.();
  }

  stopIndicator(): void {
    const leaseId = this.leaseId;
    this.leaseId = null;
    this.indicatorActive = false;
    this.indicatorLost = null;
    if (this.heartbeat) clearInterval(this.heartbeat);
    this.heartbeat = null;
    if (!leaseId) return;
    void this.json('stop', { leaseId }).catch(() => {
      // @silent-fallback-ok — companion's heartbeat deadline is the second
      // independent stop path if it cannot hear the explicit Stop.
    });
  }

  private loseIndicator(): void {
    if (!this.indicatorActive) return;
    this.indicatorActive = false;
    if (this.heartbeat) clearInterval(this.heartbeat);
    this.heartbeat = null;
    this.cancelInput();
    this.indicatorLost?.();
    this.indicatorLost = null;
  }

  private requireLease(): string {
    if (!this.leaseId || !this.indicatorActive) throw new Error('windows-desktop-lease-unavailable');
    return this.leaseId;
  }

  private async json(op: string, payload: Record<string, unknown>): Promise<Record<string, unknown>> {
    const bytes = await this.call(op, payload, JSON_LIMIT, 'application/json');
    const parsed = JSON.parse(bytes.toString('utf8')) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('windows-desktop-reply-invalid');
    }
    return parsed as Record<string, unknown>;
  }

  private async call(op: string, payload: Record<string, unknown>, limit: number, contentType: string): Promise<Buffer> {
    const body = JSON.stringify(payload);
    if (Buffer.byteLength(body) > JSON_LIMIT) throw new Error('windows-desktop-command-too-large');
    const nonce = randomBytes(24).toString('base64url');
    const timestamp = String(Date.now());
    const digest = createHash('sha256').update(body).digest('hex');
    const mac = createHmac('sha256', this.secret)
      .update(`instar-windows-desktop-v1\n${op}\n${timestamp}\n${nonce}\n${digest}`)
      .digest('base64url');
    const controller = new AbortController();
    this.pending.add(controller);
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    try {
      const response = await this.send(`${this.endpoint}${op}`, {
        method: 'POST', body, redirect: 'manual', signal: controller.signal,
        headers: { 'Content-Type': 'application/json', 'X-Instar-Desktop-Time': timestamp,
          'X-Instar-Desktop-Nonce': nonce, 'X-Instar-Desktop-Mac': mac },
      });
      if (!response.ok || response.headers.get('content-type')?.split(';')[0] !== contentType) {
        throw new Error('windows-desktop-companion-refused');
      }
      const reader = response.body?.getReader();
      if (!reader) throw new Error('windows-desktop-reply-empty');
      const chunks: Uint8Array[] = [];
      let size = 0;
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > limit) { await reader.cancel(); throw new Error('windows-desktop-reply-too-large'); }
        chunks.push(value);
      }
      return Buffer.concat(chunks.map(chunk => Buffer.from(chunk)), size);
    } finally {
      clearTimeout(timer);
      this.pending.delete(controller);
    }
  }
}
