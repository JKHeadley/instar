/**
 * Test helper: a phone on the same network (identity A4). It opens TLS to the agent's same-network
 * listener, checks the certificate's public-key hash against the one it "scanned", and only then
 * sends its HTTP request over that same connection. A mismatch stops before a byte is sent.
 */
import crypto from 'node:crypto';
import http from 'node:http';
import tls from 'node:tls';
import { canonicalString } from '../../src/core/MobileDeviceKeys.js';

export interface PinnedAnswer { status: number; json: Record<string, unknown>; peerPin: string }

export function pinOf(cert: crypto.X509Certificate): string {
  return crypto.createHash('sha256').update(cert.publicKey.export({ type: 'spki', format: 'der' })).digest('base64url');
}

export class PinMismatchError extends Error { constructor(readonly seen: string) { super('This is not your agent\'s computer.'); } }

export function pinnedRequest(opts: {
  port: number; address?: string; pin: string; method: 'GET' | 'POST'; path: string;
  headers?: Record<string, string>; body?: string; hostHeader?: string;
}): Promise<PinnedAnswer> {
  return new Promise((resolve, reject) => {
    const socket = tls.connect({ host: opts.address ?? '127.0.0.1', port: opts.port, rejectUnauthorized: false, minVersion: 'TLSv1.3' });
    socket.once('error', reject);
    socket.once('secureConnect', () => {
      const cert = socket.getPeerX509Certificate();
      const seen = cert ? pinOf(cert) : '';
      if (seen !== opts.pin) { socket.destroy(); reject(new PinMismatchError(seen)); return; }
      const req = http.request({
        method: opts.method, path: opts.path, createConnection: () => socket,
        headers: { Host: opts.hostHeader ?? `127.0.0.1:${opts.port}`, ...(opts.body !== undefined ? { 'Content-Type': 'application/json', 'Content-Length': String(Buffer.byteLength(opts.body)) } : {}), ...(opts.headers ?? {}) },
      }, (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => {
          let json: Record<string, unknown> = {};
          try { json = JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>; } catch { /* not JSON */ }
          socket.destroy();
          resolve({ status: res.statusCode ?? 0, json, peerPin: seen });
        });
      });
      req.once('error', reject);
      if (opts.body !== undefined) req.write(opts.body);
      req.end();
    });
  });
}

let lastTime = 0;
/** Device-signature headers for `host` (the address the phone stored, `<name>.local:<port>`). */
export function signedHeaders(dev: { sign: (m: string) => string }, deviceId: string, host: string, method: string, p: string, raw?: string): Record<string, string> {
  lastTime = Math.max(Date.now(), lastTime + 1);
  const time = String(lastTime);
  const sig = dev.sign(canonicalString(deviceId, host, method, p, time, raw === undefined ? undefined : Buffer.from(raw)));
  return { 'X-Instar-Device': deviceId, 'X-Instar-Device-Time': time, 'X-Instar-Device-Sig': sig };
}
