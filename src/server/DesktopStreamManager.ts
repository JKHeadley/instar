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
  release(): void;
}

export type DesktopStreamAdmission = (request: IncomingMessage) => Promise<DesktopStreamSession>;

const FRAME_INTERVAL_MS = 50;
const MAX_BUFFERED_BYTES = 1_000_024;
const MAX_FRAME_BYTES = 625_000;
const VIDEO_BYTES_PER_SECOND = 1_250_000; // 10 Mbps per host
const IDLE_MS = 2 * 60_000;

export class DesktopStreamManager {
  private readonly wss = new WebSocketServer({ noServer: true, maxPayload: 4_096, perMessageDeflate: false });
  private readonly sockets = new Map<string, WebSocket>();

  constructor(private readonly admit: DesktopStreamAdmission) {}

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
      session.release();
      socket.destroy();
    }
  }

  /** Called after a target-confirmed revocation or local kill switch. */
  closeGrant(grantId: string): void {
    this.sockets.get(grantId)?.terminate();
  }

  closeAll(): void {
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
    const close = () => {
      if (closed) return;
      closed = true;
      if (timer) clearTimeout(timer);
      if (this.sockets.get(session.grantId) === ws) this.sockets.delete(session.grantId);
      session.release();
      ws.terminate();
    };
    const nextFrame = async () => {
      if (closed) return;
      if (Date.now() - lastActivity >= IDLE_MS) { close(); return; }
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
            if (++captureFailures >= 3) { close(); return; }
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
            ws.send(frame, { binary: true }, error => { if (error) close(); });
            session.frameQueued?.();
          }
        }
      } catch { close(); return; }
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
          lastActivity = Date.now();
        }
      } catch { close(); }
      finally { drainingInputs = false; }
    };
    ws.on('message', (data, isBinary) => {
      if (closed || !isBinary || !Buffer.isBuffer(data) || data.length > 4_096) { close(); return; }
      let command: ReturnType<DesktopStreamSession['decryptCommand']>;
      try { command = session.decryptCommand(data); }
      catch { close(); return; }
      if (command.type === 'stop') {
        pendingInputs.length = 0;
        void session.revoke().then(close, close);
        return;
      }
      if (command.type === 'ping') { lastActivity = Date.now(); return; }
      if (command.type !== 'input' || !command.action) { close(); return; }
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
        close();
        return;
      }
      void drainInputs();
    });
    ws.on('close', close);
    ws.on('error', close);
    void nextFrame();
  }
}
