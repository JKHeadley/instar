/** Local macOS capture/input process. The remote-grant target must authorize
 * every call before reaching this port; the native process has no listener. */
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { validDesktopInput, type DesktopButton, type DesktopHost, type DesktopInput, type DesktopProbe } from './DesktopHost.js';
import { parseNativeH264, type DesktopH264Frame } from './DesktopVideo.js';
import type { DesktopSealedSecret } from './DesktopHost.js';

export type MacDesktopInput = DesktopInput;
export type MacDesktopProbe = DesktopProbe;

/** macOS checks permissions against the responsible process. `inherited` is
 * whichever program started this server's process tree; `own` is the helper
 * binary itself, which is the only one a boot-order race cannot change. */
type HelperIdentity = 'inherited' | 'own';
const HELPER_PATH = '/usr/bin:/bin:/usr/sbin:/sbin';
const OWN_PROBE_GRACE_MS = 30_000;

const FRAME_LIMIT = 1_250_000;
const MODULE_DIR = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_HOST = path.basename(path.dirname(MODULE_DIR)) === 'src'
  ? path.resolve(MODULE_DIR, '..', '..', 'dist', 'native', 'instar-desktop-host')
  : path.resolve(MODULE_DIR, '..', 'native', 'instar-desktop-host');

const validInput = validDesktopInput;

export class MacDesktopHost implements DesktopHost {
  private readonly inputChildren = new Set<{ kill(signal?: NodeJS.Signals): boolean }>();
  private indicatorChild: ChildProcessWithoutNullStreams | null = null;
  private inputStream: ChildProcessWithoutNullStreams | null = null;
  private readonly retiringInputStreams = new Set<ChildProcessWithoutNullStreams>();
  private readonly closedInputStreams = new WeakSet<ChildProcessWithoutNullStreams>();
  private captureStream: ChildProcessWithoutNullStreams | null = null;
  private captureMode: 'jpeg' | 'h264' | null = null;
  private captureReply = Buffer.alloc(0);
  private captureLastFrame: Buffer | null = null;
  private pendingCapture: { resolve(frame: Buffer): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout> } | null = null;
  private inputReply = '';
  private pendingInput: { resolve(reply: void | { refused: string }): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout> } | null = null;
  private lockedMode: { root: string; refuse: string[]; chime?: boolean } | null = null;
  private sealKeyHandler: ((key: string) => void) | null = null;
  private heldRemoteButton: DesktopButton | null = null;
  private readonly heldRemoteKeys = new Set<string>();
  private pendingControlAction: DesktopInput | null = null;
  private inputHelperLost = false;
  private inputFailureHandler: (() => void) | null = null;
  private inputGeneration = 0;
  private releaseBarrier: Promise<void> = Promise.resolve();
  private screenIdentity: HelperIdentity = 'inherited';
  private inputIdentity: HelperIdentity = 'inherited';
  private lastOwnProbe: { value: MacDesktopProbe; at: number } | null = null;
  constructor(private readonly binary = DEFAULT_HOST) {}

  setInputFailureHandler(handler: () => void): void { this.inputFailureHandler = handler; }
  setSealKeyHandler(handler: (key: string) => void): void { this.sealKeyHandler = handler; }

  /** Off means no helper is ever told, so every verb refuses at the shield. */
  setLockedMode(mode: { root: string; refuse: string[]; chime?: boolean } | null): void { this.lockedMode = mode; }

  /** Stop reaches a password send between characters. */
  abortInput(): void { this.inputStream?.stdin.write('{"kind":"abort"}\n'); }

  /** The seal key must exist before a sheet can open. */
  ensureInputStream(): void { if (!this.inputStream) this.startInputStream(); }

  /** One short-lived helper per change, so Node never holds the kernel lock. */
  async lockedOp(op: Record<string, unknown>): Promise<Record<string, unknown>> {
    if (!this.lockedRoot) throw new Error('mac-desktop-host-locked-unavailable');
    const raw = await this.run('state-op', Buffer.from(JSON.stringify({ root: this.lockedRoot, ...op })));
    try { return JSON.parse(raw.toString('utf8')) as Record<string, unknown>; }
    catch { throw new Error('mac-desktop-host-locked-invalid'); }
  }

  private lockedRoot: string | null = null;
  setLockedRoot(root: string): void { this.lockedRoot = root; }

  /** Detached into its own session, so nothing that kills Node reaches it. */
  async startRelockGuard(key: string): Promise<void> {
    if (!this.lockedRoot || !/^[a-f0-9-]{36}\.\d+$/.test(key)) throw new Error('mac-desktop-host-guard-invalid');
    const child = spawn(this.trustedBinary(), ['relock-guard', this.lockedRoot, key], {
      stdio: 'ignore', detached: true,
      env: { ...this.helperEnv('own'), INSTAR_DESKTOP_LOCKED_ROOT: this.lockedRoot },
    });
    child.on('error', () => { /* @silent-fallback-ok — no heartbeat follows, so typing stays refused and the sweep replaces it. */ });
    child.unref();
  }

  /** Local kill switch: stop any native input still running when a grant ends. */
  cancelInput(): Promise<void> {
    this.inputGeneration++;
    const priorInputStream = this.inputStream;
    const oldHelpers = new Set(this.retiringInputStreams);
    if (priorInputStream) oldHelpers.add(priorInputStream);
    const oldHelperExited = Promise.all([...oldHelpers].map(child => this.waitForInputExit(child))).then(() => {});
    // Prior cleanup may already be failed, but the old-helper exit promise
    // still needs its own rejection observer.
    void oldHelperExited.catch(() => { /* @silent-fallback-ok — releaseBarrier awaits this promise and fails new input closed. */ });
    const buttons = new Set<string>();
    const keys = new Set(this.heldRemoteKeys);
    if (this.heldRemoteButton) buttons.add(this.heldRemoteButton);
    if (this.pendingControlAction?.kind === 'buttonDown' || this.pendingControlAction?.kind === 'click') {
      buttons.add(this.pendingControlAction.button);
    }
    if (this.pendingControlAction?.kind === 'keyDown') keys.add(this.pendingControlAction.key);
    if (this.pendingControlAction?.kind === 'type') keys.add('a'); // Unicode CGEvent uses virtual key code 0.
    this.heldRemoteButton = null;
    this.heldRemoteKeys.clear();
    this.pendingControlAction = null;
    this.inputHelperLost = false;
    for (const child of this.inputChildren) child.kill('SIGKILL');
    for (const child of oldHelpers) child.kill('SIGKILL');
    this.inputStream = null;
    if (this.pendingInput) {
      clearTimeout(this.pendingInput.timer);
      this.pendingInput.reject(new Error('mac-desktop-host-input-cancelled'));
      this.pendingInput = null;
    }
    // The fallback releases only controls this grant successfully held (plus
    // an in-flight down whose acknowledgement may have been lost). It can
    // still overlap a local person's identical key; macOS has no ownership
    // token for a posted CGEvent.
    if (oldHelpers.size || buttons.size || keys.size) {
      const payload = buttons.size || keys.size
        ? Buffer.from(JSON.stringify({ buttons: [...buttons], keys: [...keys] })) : null;
      // A replacement grant cannot post input before the old grant's release
      // has completed. Keep a rejected barrier rejected: uncertain release
      // must fail subsequent input closed until this host is restarted.
      const pressedAs = this.inputIdentity;
      this.releaseBarrier = this.releaseBarrier.then(async () => {
        await oldHelperExited;
        if (payload) {
          const reply = await this.run('release', payload, pressedAs).catch(() => // @silent-fallback-ok — the other identity is the only remaining way to release held controls; its failure rejects the barrier.
            this.run('release', payload, pressedAs === 'own' ? 'inherited' : 'own'));
          if (reply.toString('utf8').trim() !== '{"ok":true}') {
            throw new Error('mac-desktop-host-release-invalid');
          }
        }
      });
      void this.releaseBarrier.catch(() => {
        console.warn('[MacDesktopHost] scoped input release unconfirmed');
      });
    }
    return this.releaseBarrier;
  }

  private waitForInputExit(child: ChildProcessWithoutNullStreams): Promise<void> {
    if (this.closedInputStreams.has(child)) return Promise.resolve();
    return new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('mac-desktop-host-input-exit-unconfirmed')), 2_000);
      timer.unref?.();
      child.once('close', () => { clearTimeout(timer); resolve(); });
      child.once('error', () => { clearTimeout(timer); reject(new Error('mac-desktop-host-input-exit-unconfirmed')); });
    });
  }

  private retireInputStream(child: ChildProcessWithoutNullStreams): void {
    if (!this.closedInputStreams.has(child)) this.retiringInputStreams.add(child);
  }

  private helperEnv(identity: HelperIdentity): NodeJS.ProcessEnv {
    const locked = this.lockedMode
      ? { INSTAR_DESKTOP_LOCKED: '1', INSTAR_DESKTOP_LOCKED_ROOT: this.lockedMode.root,
        INSTAR_DESKTOP_LOCKED_REFUSE: this.lockedMode.refuse.join(','),
        ...(this.lockedMode.chime ? { INSTAR_DESKTOP_LOCKED_CHIME: '1' } : {}) }
      : {};
    return identity === 'own'
      ? { PATH: HELPER_PATH, INSTAR_DESKTOP_OWN_IDENTITY: '1', ...locked }
      : { PATH: HELPER_PATH, ...locked };
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
      stdio: ['pipe', 'pipe', 'pipe'], env: this.helperEnv('inherited'),
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

  private async run(
    command: 'probe' | 'capture' | 'cursor' | 'input' | 'release' | 'request-permission' | 'state-op',
    input?: Buffer,
    identity: HelperIdentity = command === 'capture' ? this.screenIdentity
      : command === 'input' || command === 'release' ? this.inputIdentity : 'inherited',
  ): Promise<Buffer> {
    const resolved = this.trustedBinary();
    return new Promise<Buffer>((resolve, reject) => {
      const child = spawn(resolved, [command], { stdio: ['pipe', 'pipe', 'pipe'], env: this.helperEnv(identity) });
      if (command === 'input') this.inputChildren.add(child);
      const chunks: Buffer[] = [];
      const limit = command === 'capture' ? FRAME_LIMIT : command === 'state-op' ? 64_000 : 4_096;
      let size = 0;
      let settled = false;
      const fail = (reason: string) => {
        if (settled) return;
        settled = true;
        child.kill('SIGKILL');
        reject(new Error(reason));
      };
      const timer = setTimeout(() => fail('mac-desktop-host-timeout'),
        command === 'request-permission' ? 15_000 : command === 'capture' ? 4_000
          : command === 'state-op' ? 10_000 : 2_000);
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

  /** A permission is usable under either identity, and each is read per
   * capability: an existing inherited grant keeps working until this Mac grants
   * the helper directly, and the helper's own grant wins from then on. */
  async probe(): Promise<MacDesktopProbe> {
    const inherited = await this.probeAs('inherited');
    // Grants are rechecked every 500 ms, so one slow helper start must not read
    // as a lost grant and revoke a live session.
    const own = await this.probeAs('own').then(value => {
      this.lastOwnProbe = { value, at: Date.now() };
      return value;
    }).catch(() => { // @silent-fallback-ok — own-identity trouble leaves the inherited reading intact.
      const recent = this.lastOwnProbe && Date.now() - this.lastOwnProbe.at < OWN_PROBE_GRACE_MS;
      return recent ? this.lastOwnProbe!.value : null;
    });
    this.screenIdentity = own?.screenPermission ? 'own' : 'inherited';
    // Held controls must be released under the identity that pressed them.
    const inputLive = this.inputStream || this.retiringInputStreams.size
      || this.heldRemoteButton || this.heldRemoteKeys.size;
    if (!inputLive) this.inputIdentity = own?.inputPermission ? 'own' : 'inherited';
    return {
      ...inherited,
      screenPermission: inherited.screenPermission || !!own?.screenPermission,
      inputPermission: inherited.inputPermission || !!own?.inputPermission,
      screenGrant: own?.screenPermission ? 'own' : inherited.screenPermission ? 'inherited' : 'none',
      inputGrant: own?.inputPermission ? 'own' : inherited.inputPermission ? 'inherited' : 'none',
    };
  }

  /** Shows macOS's own prompts on the Mac and lists the helper in Privacy &
   * Security. Nothing is granted by this call; a person allows it there. */
  async requestPermission(): Promise<{ screenPermission: boolean; inputPermission: boolean }> {
    const raw = await this.run('request-permission', undefined, 'own');
    let value: { screenPermission?: unknown; inputPermission?: unknown };
    try { value = JSON.parse(raw.toString('utf8')) as typeof value; }
    catch { throw new Error('mac-desktop-host-request-invalid'); }
    if (typeof value.screenPermission !== 'boolean' || typeof value.inputPermission !== 'boolean') {
      throw new Error('mac-desktop-host-request-invalid');
    }
    return { screenPermission: value.screenPermission, inputPermission: value.inputPermission };
  }

  private async probeAs(identity: HelperIdentity): Promise<MacDesktopProbe> {
    const raw = await this.run('probe', undefined, identity);
    let value: Partial<MacDesktopProbe>;
    try { value = JSON.parse(raw.toString('utf8')) as Partial<MacDesktopProbe>; }
    catch { throw new Error('mac-desktop-host-probe-invalid'); }
    if (typeof value.screenPermission !== 'boolean' || typeof value.inputPermission !== 'boolean'
      || typeof value.sessionActive !== 'boolean'
      || ['consoleSessionPresent', 'onConsole', 'loginDone', 'screenLocked']
        .some(key => value[key as keyof MacDesktopProbe] !== undefined
          && typeof value[key as keyof MacDesktopProbe] !== 'boolean')
      || !Number.isSafeInteger(value.displayCount) || value.displayCount! < 0 || value.displayCount! > 16) {
      throw new Error('mac-desktop-host-probe-invalid');
    }
    return value as MacDesktopProbe;
  }

  private async capturePacket(mode: 'jpeg' | 'h264', forceKeyframe = false): Promise<Buffer> {
    if (this.captureMode !== mode) this.cancelCapture();
    const fresh = !this.captureStream;
    if (fresh) this.startCaptureStream(mode);
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
      child.stdin.write(mode === 'h264' && (forceKeyframe || fresh) ? 'k' : 'n', error => {
        if (error && this.pendingCapture?.timer === timer) {
          clearTimeout(timer);
          this.pendingCapture = null;
          if (this.captureStream === child) this.captureStream = null;
          child.kill('SIGKILL');
          reject(new Error('mac-desktop-host-capture-unavailable'));
        }
      });
    });
    return frame;
  }

  async capture(): Promise<Buffer> {
    const frame = await this.capturePacket('jpeg');
    if (frame.length < 4 || frame[0] !== 0xff || frame[1] !== 0xd8
      || frame[frame.length - 2] !== 0xff || frame[frame.length - 1] !== 0xd9) {
      throw new Error('mac-desktop-host-frame-invalid');
    }
    return frame;
  }

  async captureH264(forceKeyframe: boolean): Promise<DesktopH264Frame | null> {
    const packet = await this.capturePacket('h264', forceKeyframe);
    return packet.length ? parseNativeH264(packet) : null;
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
    this.captureMode = null;
  }

  private startCaptureStream(mode: 'jpeg' | 'h264'): void {
    const child = spawn(this.trustedBinary(), [mode === 'h264' ? 'capture-stream-h264' : 'capture-stream'], {
      stdio: ['pipe', 'pipe', 'pipe'], env: this.helperEnv(this.screenIdentity),
    });
    this.captureStream = child;
    this.captureMode = mode;
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
      const frame = size === 0
        ? (mode === 'h264' ? Buffer.alloc(0) : this.captureLastFrame)
        : this.captureReply.subarray(4);
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

  async input(action: MacDesktopInput): Promise<void | { refused: string }> {
    if (!validInput(action)) throw new Error('mac-desktop-host-input-invalid');
    // A press refused at the shield leaves no held state, so its release has
    // nothing to pair with. Under the flag that is a refused no-op, not a fault.
    if (this.lockedMode && ((action.kind === 'keyUp' && !this.heldRemoteKeys.has(action.key))
      || (action.kind === 'buttonUp' && this.heldRemoteButton !== action.button))) {
      return { refused: 'nothing-held' };
    }
    const generation = this.inputGeneration;
    try { await this.releaseBarrier; }
    catch { throw new Error('mac-desktop-host-release-unconfirmed'); }
    if (this.inputGeneration !== generation) throw new Error('mac-desktop-host-input-cancelled');
    if (this.pendingControlAction || this.retiringInputStreams.size || this.inputHelperLost) {
      throw new Error('mac-desktop-host-input-uncertain');
    }
    if ((action.kind === 'keyDown' && this.heldRemoteKeys.has(action.key))
      || (action.kind === 'keyUp' && !this.heldRemoteKeys.has(action.key))
      || (action.kind === 'buttonDown' && this.heldRemoteButton !== null)
      || (action.kind === 'buttonUp' && this.heldRemoteButton !== action.button)
      || (action.kind === 'click' && this.heldRemoteButton !== null)) {
      throw new Error('mac-desktop-host-input-transition-invalid');
    }
    if (!this.inputStream) this.startInputStream();
    const child = this.inputStream!;
    if (this.pendingInput) throw new Error('mac-desktop-host-input-busy');
    this.pendingControlAction = action;
    const reply = await this.sendInputLine(child, JSON.stringify(action), 2_000);
    if (this.inputGeneration !== generation) throw new Error('mac-desktop-host-input-cancelled');
    this.pendingControlAction = null;
    if (reply) return reply;
    if (action.kind === 'buttonDown') this.heldRemoteButton = action.button;
    if (action.kind === 'buttonUp') this.heldRemoteButton = null;
    if (action.kind === 'keyDown') this.heldRemoteKeys.add(action.key);
    if (action.kind === 'keyUp') this.heldRemoteKeys.delete(action.key);
  }

  /** Twenty seconds: it types one character at a time. Only sealed bytes pass. */
  async secretType(input: { requestId: string; key: string; secret: DesktopSealedSecret }): Promise<void | { refused: string }> {
    if (!this.lockedMode) throw new Error('mac-desktop-host-input-invalid');
    if (!this.inputStream) this.startInputStream();
    if (this.pendingInput) throw new Error('mac-desktop-host-input-busy');
    return this.sendInputLine(this.inputStream!, JSON.stringify({ kind: 'secretType', requestId: input.requestId,
      key: input.key, ...input.secret }), 20_000);
  }

  private sendInputLine(child: ChildProcessWithoutNullStreams, line: string, timeoutMs: number): Promise<void | { refused: string }> {
    return new Promise<void | { refused: string }>((resolve, reject) => {
      const timer = setTimeout(() => {
        if (this.pendingInput?.timer !== timer) return;
        this.pendingInput = null;
        if (this.inputStream === child) this.inputStream = null;
        this.retireInputStream(child);
        child.kill('SIGKILL');
        reject(new Error('mac-desktop-host-input-timeout'));
      }, timeoutMs);
      timer.unref?.();
      this.pendingInput = { resolve, reject, timer };
      child.stdin.write(line + '\n', error => {
        if (error && this.pendingInput?.timer === timer) {
          clearTimeout(timer);
          this.pendingInput = null;
          if (this.inputStream === child) this.inputStream = null;
          this.retireInputStream(child);
          child.kill('SIGKILL');
          reject(new Error('mac-desktop-host-input-unavailable'));
        }
      });
    });
  }

  private startInputStream(): void {
    const child = spawn(this.trustedBinary(), ['input-stream'], {
      stdio: ['pipe', 'pipe', 'pipe'], env: this.helperEnv(this.inputIdentity),
    });
    this.inputStream = child;
    this.inputReply = '';
    child.once('close', () => {
      this.closedInputStreams.add(child);
      this.retiringInputStreams.delete(child);
    });
    const fail = () => {
      // A killed old helper may emit close after a new grant has spawned its
      // replacement. Its late callbacks must never touch the new command.
      if (this.inputStream !== child) return;
      this.inputStream = null;
      this.retireInputStream(child);
      if (this.heldRemoteButton || this.heldRemoteKeys.size) this.inputHelperLost = true;
      const pending = this.pendingInput;
      if (pending) {
        this.pendingInput = null;
        clearTimeout(pending.timer);
        pending.reject(new Error('mac-desktop-host-input-unavailable'));
      }
      child.kill('SIGKILL');
      // A dead helper may have left a button or modifier down. Revoke the
      // owning grant immediately rather than waiting for the next command.
      void this.cancelInput();
      if (this.inputFailureHandler) this.inputFailureHandler();
      else this.inputHelperLost = true;
    };
    child.stderr.resume();
    child.stdout.on('data', (chunk: Buffer) => {
      if (this.inputStream !== child) return;
      this.inputReply += chunk.toString('utf8');
      if (this.inputReply.length > (this.lockedMode ? 512 : 128)) { child.kill('SIGKILL'); fail(); return; }
      for (;;) {
        const newline = this.inputReply.indexOf('\n');
        if (newline < 0) return;
        const reply = this.inputReply.slice(0, newline).trim();
        this.inputReply = this.inputReply.slice(newline + 1);
        if (this.lockedMode) {
          const seal = /^\{"sealKey":"([A-Za-z0-9+/=]{80,120})"\}$/.exec(reply);
          if (seal) { this.sealKeyHandler?.(seal[1]); continue; }
        }
        const refused = this.lockedMode ? /^\{"refused":"([a-z-]{1,40})"\}$/.exec(reply) : null;
        const pending = this.pendingInput;
        // Off keeps today's strict parse: exactly one reply, nothing after it.
        if (!pending || (reply !== '{"ok":true}' && !refused) || (!this.lockedMode && this.inputReply.length > 0)) {
          child.kill('SIGKILL'); fail(); return;
        }
        this.pendingInput = null;
        clearTimeout(pending.timer);
        pending.resolve(refused ? { refused: refused[1] } : undefined);
      }
    });
    child.on('error', fail);
    child.stdin.on('error', fail);
    child.on('close', fail);
  }
}
