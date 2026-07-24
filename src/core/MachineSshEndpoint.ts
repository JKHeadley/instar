import fs from 'node:fs';
import net from 'node:net';
import { verify } from 'node:crypto';
import { Server, utils, type Connection } from 'ssh2';
import type { SshPeerAdmission, SshPeerAdmissionStore } from './SshPeerAdmissionStore.js';

export interface SshRpcChallenge {
  nonce: string;
  pairingEpoch: number;
  observerBootId: string;
  clientGeneration: number;
  hostGeneration: number;
}

export interface SshRpcResponse extends SshRpcChallenge {
  machineId: string;
  sourceClientKeyFingerprint: string;
  machineFingerprint: string;
  signature: string;
}

export interface MachineSshEndpointOptions {
  hostPrivateKeyPath: string;
  hostPrivateKeyPaths?: string[];
  admissionStore: SshPeerAdmissionStore;
  machineId: string;
  machineFingerprint: string;
  hostGeneration: number;
  respond: (challenge: SshRpcChallenge, admission: SshPeerAdmission) => SshRpcResponse;
  maxFrameBytes?: number;
}

/** Restricted SSH server: public-key auth plus the `instar-rpc` subsystem only. */
export class MachineSshEndpoint {
  private server: Server | null = null;
  private sockets = new Set<Connection>();
  private socketsByMachine = new Map<string, Set<Connection>>();
  private handshakesBySource = new Map<string, number>();
  private requestBuckets = new Map<string, { tokens: number; refilledAt: number }>();
  private seenNonces = new Map<string, number>();
  constructor(private readonly options: MachineSshEndpointOptions) {}

  async listen(host: string, port: number): Promise<{ host: string; port: number }> {
    if (!isPrivateHost(host)) throw new Error('ssh-public-bind-refused');
    const maxFrame = this.options.maxFrameBytes ?? 64 * 1024;
    this.server = new Server({
      hostKeys: (this.options.hostPrivateKeyPaths ?? [this.options.hostPrivateKeyPath]).map(file => fs.readFileSync(file)),
      algorithms: {
        serverHostKey: ['ssh-ed25519'],
        kex: ['curve25519-sha256', 'curve25519-sha256@libssh.org'],
        cipher: ['chacha20-poly1305@openssh.com', 'aes256-gcm@openssh.com', 'aes128-gcm@openssh.com'],
      },
    }, client => {
      const source = String((client as unknown as { _sock?: { remoteAddress?: string } })._sock?.remoteAddress ?? 'unknown');
      const sourceHandshakes = this.handshakesBySource.get(source) ?? 0;
      if (this.sockets.size >= 32 || sourceHandshakes >= 4) { client.end(); return; }
      this.handshakesBySource.set(source, sourceHandshakes + 1);
      let admission: SshPeerAdmission | null = null;
      let attempts = 0;
      const deadline = setTimeout(() => client.end(), 10_000);
      let idle = setTimeout(() => client.end(), 30_000);
      const touch = () => { clearTimeout(idle); idle = setTimeout(() => client.end(), 30_000); };
      this.sockets.add(client);
      client.on('authentication', ctx => {
        attempts += 1;
        if (attempts > 3 || ctx.method !== 'publickey') return ctx.reject();
        const candidate = this.options.admissionStore.authenticate(ctx.key.data);
        if (!candidate) return ctx.reject();
        if (ctx.signature) {
          const signature = ctx.signature;
          const blob = ctx.blob;
          if (!blob) return ctx.reject();
          const parsed = utils.parseKey(ctx.key.data);
          if (parsed instanceof Error || !verify(null, blob, parsed.getPublicPEM(), signature)) return ctx.reject();
        }
        admission = candidate;
        const active = this.socketsByMachine.get(candidate.machineId)?.size ?? 0;
        if (active >= 2) return ctx.reject();
        ctx.accept();
      });
      client.on('ready', () => {
        clearTimeout(deadline);
        touch();
        if (admission) {
          const set = this.socketsByMachine.get(admission.machineId) ?? new Set<Connection>();
          set.add(client);
          this.socketsByMachine.set(admission.machineId, set);
        }
        client.on('session', accept => {
          const session = accept();
          session.on('pty', (_accept, reject) => reject());
          session.on('shell', (_accept, reject) => reject());
          session.on('exec', (_accept, reject) => reject());
          session.on('env', (_accept, reject) => reject());
          session.on('sftp', (_accept, reject) => reject());
          session.on('subsystem', (acceptSubsystem, reject, info) => {
            if (info.name !== 'instar-rpc' || !admission || !this.options.admissionStore.authenticate(Buffer.from(admission.publicKey.trim().split(/\s+/)[1] ?? '', 'base64'))) return reject();
            const stream = acceptSubsystem();
            let data = Buffer.alloc(0);
            stream.on('data', (chunk: Buffer) => {
              touch();
              data = Buffer.concat([data, chunk]);
              if (data.length > maxFrame) { stream.end(); client.end(); return; }
              const newline = data.indexOf(10);
              if (newline < 0) return;
              try {
                const challenge = validateChallenge(JSON.parse(data.subarray(0, newline).toString('utf8')));
                if (challenge.pairingEpoch !== admission!.pairingEpoch || challenge.clientGeneration !== admission!.clientGeneration || challenge.observerBootId !== admission!.observerBootId) throw new Error('stale-challenge');
                this.pruneNonces();
                if (this.seenNonces.has(challenge.nonce)) throw new Error('replayed-challenge');
                if (!this.takeRequestToken(admission!.machineId)) throw new Error('ssh-request-rate-limited');
                this.seenNonces.set(challenge.nonce, Date.now() + 300_000);
                const response = this.options.respond(challenge, admission!);
                const encoded = `${JSON.stringify(response)}\n`;
                if (Buffer.byteLength(encoded) > 256 * 1024) throw new Error('ssh-response-too-large');
                stream.end(encoded);
              } catch {
                // @silent-fallback-ok — malformed/replayed restricted RPC frames
                // are rejected by closing the stream; no command is executed.
                stream.end();
              }
            });
          });
        });
      });
      let removed = false;
      const remove = () => {
        if (removed) return;
        removed = true;
        clearTimeout(deadline);
        clearTimeout(idle);
        this.sockets.delete(client);
        const remaining = Math.max(0, (this.handshakesBySource.get(source) ?? 1) - 1);
        if (remaining === 0) this.handshakesBySource.delete(source); else this.handshakesBySource.set(source, remaining);
        if (admission) {
          const set = this.socketsByMachine.get(admission.machineId);
          set?.delete(client);
          if (set?.size === 0) this.socketsByMachine.delete(admission.machineId);
        }
      };
      client.on('close', remove);
      client.on('error', remove);
    });
    await new Promise<void>((resolve, reject) => this.server!.once('error', reject).listen(port, host, resolve));
    const address = this.server.address();
    return { host, port: typeof address === 'object' && address ? address.port : port };
  }

  async close(): Promise<void> {
    for (const socket of this.sockets) socket.end();
    await new Promise<void>(resolve => this.server?.close(() => resolve()) ?? resolve());
    this.server = null;
    this.socketsByMachine.clear();
  }

  /** Revocation is effective for both new authentication and live sessions. */
  revoke(machineId: string): void {
    this.options.admissionStore.revoke(machineId);
    for (const connection of this.socketsByMachine.get(machineId) ?? []) connection.end();
    this.socketsByMachine.delete(machineId);
  }

  activeSessionCount(machineId?: string): number {
    if (machineId) return this.socketsByMachine.get(machineId)?.size ?? 0;
    return [...this.socketsByMachine.values()].reduce((sum, set) => sum + set.size, 0);
  }

  private pruneNonces(now = Date.now()): void {
    for (const [nonce, expires] of this.seenNonces) if (expires <= now) this.seenNonces.delete(nonce);
  }

  private takeRequestToken(machineId: string, now = Date.now()): boolean {
    const current = this.requestBuckets.get(machineId) ?? { tokens: 10, refilledAt: now };
    const refill = Math.floor((now - current.refilledAt) / 1_000);
    if (refill > 0) { current.tokens = Math.min(10, current.tokens + refill); current.refilledAt = now; }
    if (current.tokens < 1) { this.requestBuckets.set(machineId, current); return false; }
    current.tokens -= 1;
    this.requestBuckets.set(machineId, current);
    return true;
  }
}

export function canonicalSshResponse(response: Omit<SshRpcResponse, 'signature'>): string {
  return JSON.stringify({
    nonce: response.nonce,
    pairingEpoch: response.pairingEpoch,
    observerBootId: response.observerBootId,
    clientGeneration: response.clientGeneration,
    hostGeneration: response.hostGeneration,
    machineId: response.machineId,
    sourceClientKeyFingerprint: response.sourceClientKeyFingerprint,
    machineFingerprint: response.machineFingerprint,
  });
}

function validateChallenge(value: unknown): SshRpcChallenge {
  if (!value || typeof value !== 'object') throw new Error('invalid-challenge');
  const row = value as Record<string, unknown>;
  if (typeof row.nonce !== 'string' || row.nonce.length < 16 || row.nonce.length > 256) throw new Error('invalid-nonce');
  for (const key of ['pairingEpoch', 'clientGeneration', 'hostGeneration']) if (!Number.isSafeInteger(row[key]) || Number(row[key]) < 1) throw new Error(`invalid-${key}`);
  if (typeof row.observerBootId !== 'string' || row.observerBootId.length > 128) throw new Error('invalid-observer');
  return row as unknown as SshRpcChallenge;
}

function isPrivateHost(host: string): boolean {
  if (host === 'localhost' || host === '::1' || host.startsWith('127.')) return true;
  if (net.isIP(host) === 4) {
    const [a, b] = host.split('.').map(Number);
    return a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127);
  }
  return false;
}
