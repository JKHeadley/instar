import type { IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';
import { WebSocket, WebSocketServer } from 'ws';
import { signRequest } from './machineAuth.js';

const MAX_FRAME_BYTES = 1_400_000;
const MAX_BUFFERED_BYTES = 1_600_000;

/** Byte-only relay. The browser and target share the AEAD key; the front never
 * decrypts display frames or input commands. */
export class DesktopMeshStreamRelay {
  private readonly wss = new WebSocketServer({ noServer: true, maxPayload: 4_096, perMessageDeflate: false });
  private readonly active = new Map<string, { browser: WebSocket; target: WebSocket }>();
  private readonly pending = new Map<string, Set<{ socket: Duplex; target: WebSocket; cancel: () => void }>>();
  private closed = false;

  constructor(private readonly selfMachineId: string, private readonly signingKeyPem: string) {}

  handleUpgrade(request: IncomingMessage, socket: Duplex, head: Buffer,
    requestId: string, ticket: string, peerUrl: string): void {
    if (this.closed) { socket.destroy(); return; }
    let parsed: URL;
    try { parsed = new URL(peerUrl); }
    catch { socket.destroy(); return; }
    const upstreamUrl = new URL('/desktop-stream', parsed);
    upstreamUrl.protocol = parsed.protocol === 'https:' ? 'wss:' : 'ws:';
    const target = new WebSocket(upstreamUrl, ['instar-desktop-v1', `ticket.${ticket}`], {
      origin: parsed.origin,
      headers: { ...signRequest(this.selfMachineId, this.signingKeyPem, {}) },
      perMessageDeflate: false, maxPayload: MAX_FRAME_BYTES,
      handshakeTimeout: 5_000,
    });
    let settled = false;
    let cancelled = false;
    const pendingEntry = { socket, target, cancel: () => {
      cancelled = true;
      socket.destroy();
      target.terminate();
    } };
    const entries = this.pending.get(requestId) ?? new Set<typeof pendingEntry>();
    entries.add(pendingEntry);
    this.pending.set(requestId, entries);
    const clearPending = () => {
      entries.delete(pendingEntry);
      if (entries.size === 0 && this.pending.get(requestId) === entries) this.pending.delete(requestId);
    };
    const fail = () => {
      if (settled) return;
      settled = true;
      clearPending();
      if (!socket.destroyed) {
        socket.write('HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\n\r\n');
        socket.destroy();
      }
      target.terminate();
    };
    target.once('error', fail);
    target.once('close', fail);
    target.once('open', () => {
      if (settled || cancelled || this.closed || socket.destroyed) { clearPending(); target.terminate(); return; }
      settled = true;
      try {
        this.wss.handleUpgrade(request, socket, head, browser => {
          clearPending();
          if (cancelled || this.closed) { browser.terminate(); target.terminate(); return; }
          const prior = this.active.get(requestId);
          if (prior) { prior.browser.terminate(); prior.target.terminate(); }
          this.active.set(requestId, { browser, target });
          let closed = false;
          const close = () => {
            if (closed) return;
            closed = true;
            if (this.active.get(requestId)?.browser === browser) this.active.delete(requestId);
            browser.terminate(); target.terminate();
          };
          browser.on('message', (data, binary) => {
            const bytes = Array.isArray(data) ? data.reduce((total, part) => total + part.byteLength, 0) : data.byteLength;
            if (!binary || bytes > 4_096 || target.readyState !== WebSocket.OPEN
              || target.bufferedAmount > MAX_BUFFERED_BYTES) { close(); return; }
            target.send(data, { binary: true }, error => { if (error) close(); });
          });
          target.on('message', (data, binary) => {
            const bytes = Array.isArray(data) ? data.reduce((total, part) => total + part.byteLength, 0) : data.byteLength;
            if (!binary || bytes > MAX_FRAME_BYTES || browser.readyState !== WebSocket.OPEN) { close(); return; }
            // H.264 reference frames cannot be dropped invisibly: the target
            // would keep encoding against a frame the browser never saw.
            // Closing forces the target's resume path to start with a keyframe.
            if (browser.bufferedAmount + bytes > MAX_BUFFERED_BYTES) { close(); return; }
            browser.send(data, { binary: true }, error => { if (error) close(); });
          });
          browser.on('close', close); browser.on('error', close);
          target.on('close', close); target.on('error', close);
        });
      } catch { clearPending(); target.terminate(); socket.destroy(); }
    });
  }

  closeRequest(requestId: string): void {
    const pending = this.pending.get(requestId);
    this.pending.delete(requestId);
    if (pending) for (const entry of pending) entry.cancel();
    const pair = this.active.get(requestId);
    this.active.delete(requestId);
    if (pair) { pair.browser.terminate(); pair.target.terminate(); }
  }

  close(): void {
    this.closed = true;
    for (const requestId of new Set([...this.active.keys(), ...this.pending.keys()])) this.closeRequest(requestId);
    this.wss.close();
  }
}
