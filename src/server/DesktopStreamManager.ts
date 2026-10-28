/** A bounded desktop WebSocket transport. Admission is supplied by the target's
 * operator-grant authority; no ordinary dashboard token can open this stream. */
import type { IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';
import { WebSocket, WebSocketServer } from 'ws';
import type { DesktopInput } from '../core/DesktopHost.js';

export interface DesktopStreamSession {
  grantId: string;
  /** Point-of-use grant, lease, revocation and OS-session check. */
  assertActive(): Promise<void>;
  captureEncrypted(): Promise<Buffer | null>;
  /** Commit the latest frame only after ws.send accepts it into the bounded queue. */
  frameQueued?(): void;
  decryptCommand(record: Buffer): { type: 'stop' | 'ping' | 'input'; action?: DesktopInput };
  input(action: DesktopInput): Promise<void>;
  revoke(): Promise<void>;
  release(reason?: 'transport-lost' | 'terminal'): void;
}

export type DesktopStreamAdmission = (request: IncomingMessage) => Promise<DesktopStreamSession>;

const FRAME_INTERVAL_MS = 50;
const MAX_BUFFERED_BYTES = 1_000_024;
const MAX_FRAME_BYTES = 625_000;
const VIDEO_BYTES_PER_SECOND = 1_250_000; // 10 Mbps per host
const IDLE_MS = 2 * 60_000;
const HELD_INPUT_LIVENESS_MS = 5_000;

export class DesktopStreamManager {
  private readonly wss = new WebSocketServer({ noServer: true, maxPayload: 4_096, perMessageDeflate: false });
  private readonly sockets = new Map<string, WebSocket>();
  private readonly terminalGrants = new Set<string>();
  private shuttingDown = false;

  constructor(private readonly admit: DesktopStreamAdmission,
    private readonly heldInputLivenessMs = HELD_INPUT_LIVENESS_MS) {}

  async handleUpgrade(request: IncomingMessage, socket: Duplex, head: Buffer): Promise<void> {
    let session: DesktopStreamSession;
    try { session = await this.admit(request); }
    catch {
      socket.write('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
      socket.destroy();
      return;
    }
    if (socket.destroyed) { session.release(); return; }
    try {
      this.wss.handleUpgrade(request, socket, head, ws => this.serve(ws, session));
    } catch {
      session.release('terminal');
      socket.destroy();
    }
  }

  /** Called after a target-confirmed revocation or local kill switch. */
  closeGrant(grantId: string): void {
    const socket = this.sockets.get(grantId);
    if (socket) { this.terminalGrants.add(grantId); socket.terminate(); }
  }

  closeAll(): void {
    this.shuttingDown = true;
    for (const ws of this.sockets.values()) ws.terminate();
    this.wss.close();
  }

  private serve(ws: WebSocket, session: DesktopStreamSession): void {
    const prior = this.sockets.get(session.grantId);
    if (prior) prior.terminate();
    this.sockets.set(session.grantId, ws);
    let closed = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let lastActivity = Date.now();
    let videoBudget = MAX_FRAME_BYTES;
    let lastBudgetAt = Date.now();
    const pendingInputs: Array<{ type: 'input'; action: DesktopInput }> = [];
    let drainingInputs = false;
    let captureFailures = 0;
    let heldButton: 'left' | 'right' | null = null;
    let holdTimer: ReturnType<typeof setTimeout> | undefined;
    const refreshHoldLease = () => {
      if (!heldButton) return;
      if (holdTimer) clearTimeout(holdTimer);
      // A half-open browser can leave a mouse button held even while the
      // target still thinks the WebSocket is connected. An authenticated ping
      // every second keeps legitimate long drags alive; missing liveness
      // revokes the grant and cancelInput posts the native release.
      holdTimer = setTimeout(() => close('input-hold-lost'), this.heldInputLivenessMs);
      holdTimer.unref?.();
    };
    const close = (reason = 'unknown') => {
      if (closed) return;
      closed = true;
      // Reason code only: never log the grant, operator, screen, or input.
      console.warn(`[DesktopStream] closed: ${reason}`);
      if (timer) clearTimeout(timer);
      if (holdTimer) clearTimeout(holdTimer);
      if (this.sockets.get(session.grantId) === ws) this.sockets.delete(session.grantId);
      const terminal = this.shuttingDown || this.terminalGrants.delete(session.grantId);
      session.release(!terminal && reason === 'transport-lost' ? 'transport-lost' : 'terminal');
      ws.terminate();
    };
    const nextFrame = async () => {
      if (closed) return;
      if (Date.now() - lastActivity >= IDLE_MS) { close('idle'); return; }
      try {
        await session.assertActive();
        if (closed) return;
        // A slow browser never causes a queue of screen images to accumulate.
        if (ws.bufferedAmount < MAX_BUFFERED_BYTES) {
          let frame: Buffer | null;
          try {
            frame = await session.captureEncrypted();
            captureFailures = 0;
          } catch {
            // A single ScreenCaptureKit timeout is a lost frame. Admission and
            // OS readiness are checked again on the next tick; revocation
            // itself closes this socket through closeGrant immediately.
            if (++captureFailures >= 3) { close('capture-failed'); return; }
            timer = setTimeout(() => { void nextFrame(); }, FRAME_INTERVAL_MS);
            timer.unref?.();
            return;
          }
          await session.assertActive();
          const now = Date.now();
          videoBudget = Math.min(MAX_FRAME_BYTES,
            videoBudget + Math.max(0, now - lastBudgetAt) * VIDEO_BYTES_PER_SECOND / 1000);
          lastBudgetAt = now;
          if (!closed && frame && frame.length >= 28 && frame.length <= MAX_FRAME_BYTES
            && frame.length <= videoBudget
            && ws.bufferedAmount + frame.length <= MAX_BUFFERED_BYTES) {
            videoBudget -= frame.length;
            ws.send(frame, { binary: true }, error => { if (error) close('transport-lost'); });
            session.frameQueued?.();
          }
        }
      } catch { close('authority-failed'); return; }
      if (!closed) {
        timer = setTimeout(() => { void nextFrame(); }, FRAME_INTERVAL_MS);
        timer.unref?.();
      }
    };
    const drainInputs = async () => {
      if (drainingInputs) return;
      drainingInputs = true;
      try {
        while (!closed && pendingInputs.length > 0) {
          const command = pendingInputs.shift()!;
          await session.assertActive();
          if (closed) return;
          await session.input(command.action);
          if (command.action.kind === 'buttonDown') heldButton = command.action.button;
          if (command.action.kind === 'buttonUp') {
            heldButton = null;
            if (holdTimer) { clearTimeout(holdTimer); holdTimer = undefined; }
          } else refreshHoldLease();
          lastActivity = Date.now();
        }
      } catch { close('input-failed'); }
      finally { drainingInputs = false; }
    };
    ws.on('message', (data, isBinary) => {
      if (closed || !isBinary || !Buffer.isBuffer(data) || data.length > 4_096) { close('protocol'); return; }
      let command: ReturnType<DesktopStreamSession['decryptCommand']>;
      try { command = session.decryptCommand(data); }
      catch { close('decrypt-failed'); return; }
      if (command.type === 'stop') {
        pendingInputs.length = 0;
        void session.revoke().then(() => close('stop'), () => close('stop-error'));
        return;
      }
      if (command.type === 'ping') { lastActivity = Date.now(); refreshHoldLease(); return; }
      if (command.type !== 'input' || !command.action) { close('protocol'); return; }
      const last = pendingInputs.at(-1);
      if (command.action.kind === 'move' && last?.action.kind === 'move') {
        last.action = command.action;
      } else if (command.action.kind === 'scroll' && last?.action.kind === 'scroll') {
        last.action = { kind: 'scroll',
          dx: Math.max(-1_000, Math.min(1_000, last.action.dx + command.action.dx)),
          dy: Math.max(-1_000, Math.min(1_000, last.action.dy + command.action.dy)) };
      } else if (pendingInputs.length < 32) {
        pendingInputs.push({ type: 'input', action: command.action });
      } else if (command.action.kind !== 'move') {
        // Discrete commands cannot be dropped or reordered. Refuse an abusive
        // producer rather than accumulate unbounded clicks or keystrokes.
        close('input-overflow');
        return;
      }
      void drainInputs();
    });
    ws.on('close', code => close(!this.shuttingDown && code === 1006 ? 'transport-lost' : `socket-close-${code}`));
    // ws also emits parser and maxPayload errors here. A close-only 1006 is
    // transport loss; an error event is terminal unless a bounded send failed.
    ws.on('error', () => close('socket-error'));
    void nextFrame();
  }
}
