import { createHash, randomBytes } from 'node:crypto';
import { isIP } from 'node:net';
import { performance } from 'node:perf_hooks';
import { normalizeHostedRelayHostname } from './clientHello.js';

const codeAgeMs = 10 * 60_000;
const attemptWindowMs = 60_000;
const maxAttemptsPerAddress = 10;
const codeCapacity = 1024;
const addressCapacity = 4096;
const codePattern = /^[A-Za-z0-9_-]{32}$/;
const digest = (code: string) => createHash('sha256').update(code).digest('hex');

function addressKey(address: string): string | undefined {
  const kind = isIP(address);
  if (kind === 4) return address;
  if (kind !== 6 || address.includes('%')) return undefined;
  const host = new URL('http://[' + address + ']/').hostname;
  const mapped = /^\[::ffff:([a-f0-9]{1,4}):([a-f0-9]{1,4})\]$/.exec(host);
  if (!mapped) return host;
  const high = Number.parseInt(mapped[1], 16), low = Number.parseInt(mapped[2], 16);
  return [high >> 8, high & 255, low >> 8, low & 255].join('.');
}

/** Process-local, disposable rendezvous storage. Only an authenticated
 * registration handler may issue codes. The registrar must never reuse an
 * assignment digest after relinquishing a name. Redeem takes the transport-observed
 * address, never a caller-supplied forwarding header. */
export class HostedRelayRendezvous {
  private readonly codes = new Map<string, { hostname: string; assignment: string; expiresAt: number }>();
  private readonly addresses = new Map<string, { attempts: number; expiresAt: number }>();

  constructor(private readonly currentAssignment: (hostname: string) => string | undefined,
    private readonly now: () => number = () => performance.now()) {}

  issue(hostname: string, authorizedAssignment: string): { code: string; expiresInSeconds: number } | undefined {
    const name = normalizeHostedRelayHostname(hostname);
    const now = this.now();
    this.prune(this.codes, now);
    if (!name || !/^[a-f0-9]{64}$/.test(authorizedAssignment) || this.codes.size >= codeCapacity
      || !this.assignmentMatches(name, authorizedAssignment)) return undefined;
    const code = randomBytes(24).toString('base64url');
    const key = digest(code);
    if (this.codes.has(key)) return undefined;
    this.codes.set(key, { hostname: name, assignment: authorizedAssignment, expiresAt: now + codeAgeMs });
    return { code, expiresInSeconds: codeAgeMs / 1000 };
  }

  redeem(address: string, code: unknown): { hostname: string } | undefined {
    const peer = addressKey(address);
    const now = this.now();
    this.prune(this.addresses, now);
    if (!peer || !this.admit(peer, now)) return undefined;
    this.prune(this.codes, now);
    if (typeof code !== 'string' || !codePattern.test(code)) return undefined;
    const key = digest(code);
    const entry = this.codes.get(key);
    if (!entry) return undefined;
    this.codes.delete(key);
    return this.assignmentMatches(entry.hostname, entry.assignment) ? { hostname: entry.hostname } : undefined;
  }

  private assignmentMatches(hostname: string, assignment: string): boolean {
    try { return this.currentAssignment(hostname) === assignment; }
    catch { return false; } // @silent-fallback-ok — unreadable assignments cannot issue or redeem a locator
  }

  private admit(peer: string, now: number): boolean {
    const existing = this.addresses.get(peer);
    if (existing) {
      if (existing.attempts >= maxAttemptsPerAddress) return false;
      existing.attempts++;
    } else {
      if (this.addresses.size >= addressCapacity) return false;
      this.addresses.set(peer, { attempts: 1, expiresAt: now + attemptWindowMs });
    }
    return true;
  }

  private prune<T extends { expiresAt: number }>(entries: Map<string, T>, now: number): void {
    for (const [key, entry] of entries) {
      if (entry.expiresAt > now) break;
      entries.delete(key);
    }
  }
}
