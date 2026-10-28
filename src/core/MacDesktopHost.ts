/** Local macOS capture/input process. The remote-grant target must authorize
 * every call before reaching this port; the native process has no listener. */
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { DesktopHost, DesktopInput, DesktopProbe } from './DesktopHost.js';

export type MacDesktopInput = DesktopInput;
export type MacDesktopProbe = DesktopProbe;

const FRAME_LIMIT = 625_000;
const MODULE_DIR = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_HOST = path.basename(path.dirname(MODULE_DIR)) === 'src'
  ? path.resolve(MODULE_DIR, '..', '..', 'dist', 'native', 'instar-desktop-host')
  : path.resolve(MODULE_DIR, '..', 'native', 'instar-desktop-host');

function validInput(action: MacDesktopInput): boolean {
  if (!action || typeof action !== 'object') return false;
  if (action.kind === 'move' || action.kind === 'click') {
    if (!Number.isFinite(action.x) || !Number.isFinite(action.y)
      || action.x < 0 || action.x > 1 || action.y < 0 || action.y > 1) return false;
    return action.kind === 'move' || action.button === 'left' || action.button === 'right';
  }
  if (action.kind === 'scroll') {
    return Number.isFinite(action.dx) && Number.isFinite(action.dy)
      && Math.abs(action.dx) <= 1_000 && Math.abs(action.dy) <= 1_000;
  }
  return action.kind === 'type' && typeof action.text === 'string'
    && action.text.length > 0 && action.text.length <= 1_024 && !action.text.includes('\0');
}

export class MacDesktopHost implements DesktopHost {
  private readonly inputChildren = new Set<{ kill(signal?: NodeJS.Signals): boolean }>();
  private indicatorChild: ChildProcessWithoutNullStreams | null = null;
  private inputStream: ChildProcessWithoutNullStreams | null = null;
  private captureStream: ChildProcessWithoutNullStreams | null = null;
  private captureReply = Buffer.alloc(0);
  private captureLastFrame: Buffer | null = null;
  private pendingCapture: { resolve(frame: Buffer): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout> } | null = null;
  private inputReply = '';
  private pendingInput: { resolve(): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout> } | null = null;
  constructor(private readonly binary = DEFAULT_HOST) {}

  /** Local kill switch: stop any native input still running when a grant ends. */
  cancelInput(): void {
    for (const child of this.inputChildren) child.kill('SIGKILL');
    this.inputStream?.kill('SIGKILL');
    this.inputStream = null;
    if (this.pendingInput) {
      clearTimeout(this.pendingInput.timer);
      this.pendingInput.reject(new Error('mac-desktop-host-input-cancelled'));
      this.pendingInput = null;
    }
    // A native click or Unicode key sequence can be interrupted between down
    // and up. Release held input after fencing the child processes.
    void this.run('release').catch(() => {});
  }

  private trustedBinary(): string {
    if (process.platform !== 'darwin') throw new Error('mac-desktop-host-platform-unavailable');
    const expectedDir = fs.realpathSync(path.dirname(DEFAULT_HOST));
    const resolved = fs.realpathSync(this.binary);
    if (path.dirname(resolved) !== expectedDir || !fs.statSync(resolved).isFile()) {
      throw new Error('mac-desktop-host-binary-untrusted');
    }
    return resolved;
  }

  /** Persistent local menu bar indicator. If it dies, access is revoked. */
  async startIndicator(onUnexpectedExit: () => void): Promise<void> {
    if (this.indicatorChild) throw new Error('mac-desktop-indicator-already-active');
    const child = spawn(this.trustedBinary(), ['indicator'], {
      stdio: ['pipe', 'pipe', 'pipe'], env: { PATH: '/usr/bin:/bin:/usr/sbin:/sbin' },
    });
    this.indicatorChild = child;
    await new Promise<void>((resolve, reject) => {
      let ready = false;
      let settled = false;
      let output = '';
      const fail = () => {
        if (settled) return;
        settled = true;
        if (this.indicatorChild === child) this.indicatorChild = null;
        child.kill('SIGKILL');
        reject(new Error('mac-desktop-indicator-unavailable'));
      };
      const timer = setTimeout(fail, 3_000);
      timer.unref?.();
      child.stderr.resume();
      child.stdout.on('data', (chunk: Buffer) => {
        output += chunk.toString('utf8');
        if (output.length > 128) { fail(); return; }
        if (!ready && output.includes('{"ready":true}')) {
          ready = true;
          settled = true;
          clearTimeout(timer);
          resolve();
        }
      });
      child.on('error', fail);
      child.stdin.on('error', fail);
      child.on('close', () => {
        clearTimeout(timer);
        if (!ready) fail();
        else if (this.indicatorChild === child) {
          this.indicatorChild = null;
          onUnexpectedExit();
        }
      });
    });
  }

  stopIndicator(): void {
    this.cancelCapture();
    const child = this.indicatorChild;
    this.indicatorChild = null;
    if (!child) return;
    child.stdin.end();
    child.kill('SIGKILL');
  }

  private async run(command: 'probe' | 'capture' | 'cursor' | 'input' | 'release', input?: Buffer): Promise<Buffer> {
    const resolved = this.trustedBinary();
    return new Promise<Buffer>((resolve, reject) => {
      const child = spawn(resolved, [command], { stdio: ['pipe', 'pipe', 'pipe'], env: { PATH: '/usr/bin:/bin:/usr/sbin:/sbin' } });
      if (command === 'input') this.inputChildren.add(child);
      const chunks: Buffer[] = [];
      const limit = command === 'capture' ? FRAME_LIMIT : 4_096;
      let size = 0;
      let settled = false;
      const fail = (reason: string) => {
        if (settled) return;
        settled = true;
        child.kill('SIGKILL');
        reject(new Error(reason));
      };
      const timer = setTimeout(() => fail('mac-desktop-host-timeout'), command === 'capture' ? 4_000 : 2_000);
      timer.unref?.();
      child.stdout.on('data', (chunk: Buffer) => {
        size += chunk.length;
        if (size > limit) fail('mac-desktop-host-output-limit');
        else chunks.push(chunk);
      });
      // Native diagnostics are deliberately discarded: input text and frame
      // bytes must never reach durable logs through an error path.
      child.stderr.resume();
      child.on('error', () => fail('mac-desktop-host-launch-failed'));
      child.stdin.on('error', () => fail('mac-desktop-host-unavailable'));
      child.on('close', code => {
        this.inputChildren.delete(child);
        clearTimeout(timer);
        if (settled) return;
        settled = true;
        if (code !== 0) reject(new Error('mac-desktop-host-unavailable'));
        else resolve(Buffer.concat(chunks));
      });
      child.stdin.end(input);
    });
  }

  async probe(): Promise<MacDesktopProbe> {
    const raw = await this.run('probe');
    let value: Partial<MacDesktopProbe>;
    try { value = JSON.parse(raw.toString('utf8')) as Partial<MacDesktopProbe>; }
    catch { throw new Error('mac-desktop-host-probe-invalid'); }
    if (typeof value.screenPermission !== 'boolean' || typeof value.inputPermission !== 'boolean'
      || typeof value.sessionActive !== 'boolean'
      || !Number.isSafeInteger(value.displayCount) || value.displayCount! < 0 || value.displayCount! > 16) {
      throw new Error('mac-desktop-host-probe-invalid');
    }
    return value as MacDesktopProbe;
  }

  async capture(): Promise<Buffer> {
    if (!this.captureStream) this.startCaptureStream();
    const child = this.captureStream!;
    if (this.pendingCapture) throw new Error('mac-desktop-host-capture-busy');
    const frame = await new Promise<Buffer>((resolve, reject) => {
      const timer = setTimeout(() => {
        if (this.pendingCapture?.timer !== timer) return;
        this.pendingCapture = null;
        if (this.captureStream === child) this.captureStream = null;
        child.kill('SIGKILL');
        reject(new Error('mac-desktop-host-capture-timeout'));
      }, 4_000);
      timer.unref?.();
      this.pendingCapture = { resolve, reject, timer };
      child.stdin.write('n', error => {
        if (error && this.pendingCapture?.timer === timer) {
          clearTimeout(timer);
          this.pendingCapture = null;
          if (this.captureStream === child) this.captureStream = null;
          child.kill('SIGKILL');
          reject(new Error('mac-desktop-host-capture-unavailable'));
        }
      });
    });
    if (frame.length < 4 || frame[0] !== 0xff || frame[1] !== 0xd8
      || frame[frame.length - 2] !== 0xff || frame[frame.length - 1] !== 0xd9) {
      throw new Error('mac-desktop-host-frame-invalid');
    }
    return frame;
  }

  private cancelCapture(): void {
    const child = this.captureStream;
    this.captureStream = null;
    if (this.pendingCapture) {
      clearTimeout(this.pendingCapture.timer);
      this.pendingCapture.reject(new Error('mac-desktop-host-capture-cancelled'));
      this.pendingCapture = null;
    }
    child?.stdin.end();
    child?.kill('SIGKILL');
    this.captureReply = Buffer.alloc(0);
    this.captureLastFrame = null;
  }

  private startCaptureStream(): void {
    const child = spawn(this.trustedBinary(), ['capture-stream'], {
      stdio: ['pipe', 'pipe', 'pipe'], env: { PATH: '/usr/bin:/bin:/usr/sbin:/sbin' },
    });
    this.captureStream = child;
    this.captureReply = Buffer.alloc(0);
    this.captureLastFrame = null;
    const fail = () => {
      if (this.captureStream !== child) return;
      this.captureStream = null;
      this.captureLastFrame = null;
      const pending = this.pendingCapture;
      this.pendingCapture = null;
      if (pending) {
        clearTimeout(pending.timer);
        pending.reject(new Error('mac-desktop-host-capture-unavailable'));
      }
      child.kill('SIGKILL');
    };
    child.stderr.resume();
    child.stdout.on('data', (chunk: Buffer) => {
      if (this.captureStream !== child) return;
      this.captureReply = Buffer.concat([this.captureReply, chunk]);
      if (this.captureReply.length > FRAME_LIMIT + 4) { fail(); return; }
      if (this.captureReply.length < 4) return;
      const size = this.captureReply.readUInt32BE(0);
      if ((size !== 0 && size < 4) || size > FRAME_LIMIT) { fail(); return; }
      if (this.captureReply.length < size + 4) return;
      const pending = this.pendingCapture;
      if (!pending || this.captureReply.length !== size + 4) { fail(); return; }
      const frame = size === 0 ? this.captureLastFrame : this.captureReply.subarray(4);
      if (!frame) { fail(); return; }
      if (size > 0) this.captureLastFrame = frame;
      this.captureReply = Buffer.alloc(0);
      this.pendingCapture = null;
      clearTimeout(pending.timer);
      pending.resolve(frame);
    });
    child.on('error', fail);
    child.stdin.on('error', fail);
    child.on('close', fail);
  }

  /** Local-only readback for the live input acceptance check. */
  async cursor(): Promise<{ x: number; y: number }> {
    const raw = await this.run('cursor');
    let value: { x?: unknown; y?: unknown };
    try { value = JSON.parse(raw.toString('utf8')) as { x?: unknown; y?: unknown }; }
    catch { throw new Error('mac-desktop-host-cursor-invalid'); }
    if (typeof value.x !== 'number' || typeof value.y !== 'number'
      || !Number.isFinite(value.x) || !Number.isFinite(value.y)) {
      throw new Error('mac-desktop-host-cursor-invalid');
    }
    return { x: value.x, y: value.y };
  }

  async input(action: MacDesktopInput): Promise<void> {
    if (!validInput(action)) throw new Error('mac-desktop-host-input-invalid');
    if (!this.inputStream) this.startInputStream();
    const child = this.inputStream!;
    if (this.pendingInput) throw new Error('mac-desktop-host-input-busy');
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        if (this.pendingInput?.timer !== timer) return;
        this.pendingInput = null;
        if (this.inputStream === child) this.inputStream = null;
        child.kill('SIGKILL');
        reject(new Error('mac-desktop-host-input-timeout'));
      }, 2_000);
      timer.unref?.();
      this.pendingInput = { resolve, reject, timer };
      child.stdin.write(JSON.stringify(action) + '\n', error => {
        if (error && this.pendingInput?.timer === timer) {
          clearTimeout(timer);
          this.pendingInput = null;
          if (this.inputStream === child) this.inputStream = null;
          child.kill('SIGKILL');
          reject(new Error('mac-desktop-host-input-unavailable'));
        }
      });
    });
  }

  private startInputStream(): void {
    const child = spawn(this.trustedBinary(), ['input-stream'], {
      stdio: ['pipe', 'pipe', 'pipe'], env: { PATH: '/usr/bin:/bin:/usr/sbin:/sbin' },
    });
    this.inputStream = child;
    this.inputReply = '';
    const fail = () => {
      // A killed old helper may emit close after a new grant has spawned its
      // replacement. Its late callbacks must never touch the new command.
      if (this.inputStream !== child) return;
      this.inputStream = null;
      const pending = this.pendingInput;
      if (pending) {
        this.pendingInput = null;
        clearTimeout(pending.timer);
        pending.reject(new Error('mac-desktop-host-input-unavailable'));
      }
      child.kill('SIGKILL');
    };
    child.stderr.resume();
    child.stdout.on('data', (chunk: Buffer) => {
      if (this.inputStream !== child) return;
      this.inputReply += chunk.toString('utf8');
      if (this.inputReply.length > 128) { child.kill('SIGKILL'); fail(); return; }
      const newline = this.inputReply.indexOf('\n');
      if (newline < 0) return;
      const reply = this.inputReply.slice(0, newline).trim();
      this.inputReply = this.inputReply.slice(newline + 1);
      const pending = this.pendingInput;
      if (!pending || reply !== '{"ok":true}' || this.inputReply.length > 0) {
        child.kill('SIGKILL'); fail(); return;
      }
      this.pendingInput = null;
      clearTimeout(pending.timer);
      pending.resolve();
    });
    child.on('error', fail);
    child.stdin.on('error', fail);
    child.on('close', fail);
  }
}
