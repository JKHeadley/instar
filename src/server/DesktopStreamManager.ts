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
  captureEncrypted(): Promise<Buffer>;
  decryptCommand(record: Buffer): { type: 'stop' | 'ping' | 'input'; action?: DesktopInput };
  input(action: DesktopInput): Promise<void>;
  revoke(): Promise<void>;
  release(): void;
}

export type DesktopStreamAdmission = (request: IncomingMessage) => Promise<DesktopStreamSession>;

const FRAME_INTERVAL_MS = 500;
const MAX_BUFFERED_BYTES = 1_000_024;
const MAX_FRAME_BYTES = 625_000;
const VIDEO_BYTES_PER_SECOND = 625_000; // 5 Mbps per host
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
    let inputChain = Promise.resolve();
    let queuedInputs = 0;
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
          const frame = await session.captureEncrypted();
          await session.assertActive();
          const now = Date.now();
          videoBudget = Math.min(MAX_FRAME_BYTES,
            videoBudget + Math.max(0, now - lastBudgetAt) * VIDEO_BYTES_PER_SECOND / 1000);
          lastBudgetAt = now;
          if (!closed && frame.length >= 28 && frame.length <= MAX_FRAME_BYTES
            && frame.length <= videoBudget
            && ws.bufferedAmount + frame.length <= MAX_BUFFERED_BYTES) {
            videoBudget -= frame.length;
            ws.send(frame, { binary: true }, error => { if (error) close(); });
          }
        }
      } catch { close(); return; }
      if (!closed) {
        timer = setTimeout(() => { void nextFrame(); }, FRAME_INTERVAL_MS);
        timer.unref?.();
      }
    };
    ws.on('message', (data, isBinary) => {
      queuedInputs++;
      if (queuedInputs > 8) { close(); return; }
      inputChain = inputChain.then(async () => {
        if (closed || !isBinary || !Buffer.isBuffer(data) || data.length > 4_096) { close(); return; }
        try {
          await session.assertActive();
          if (closed) return;
          const command = session.decryptCommand(data);
          if (command.type === 'stop') {
            await session.revoke();
            close();
          } else if (command.type === 'ping') {
            lastActivity = Date.now();
          } else if (command.type === 'input' && command.action) {
            await session.input(command.action);
            lastActivity = Date.now();
          } else close();
        } catch { close(); }
      }).catch(close).finally(() => { queuedInputs--; });
    });
    ws.on('close', close);
    ws.on('error', close);
    void nextFrame();
  }
}
