import { createHash, randomBytes } from 'node:crypto';

export interface DashboardOperatorSessionStoreOptions {
  now?: () => number;
  ttlMs?: number;
  maxSessions?: number;
}

/** Short-lived proof that a dashboard caller recently passed the operator PIN. */
export class DashboardOperatorSessionStore {
  private readonly now: () => number;
  private readonly ttlMs: number;
  private readonly maxSessions: number;
  private readonly sessions = new Map<string, number>();

  constructor(options: DashboardOperatorSessionStoreOptions = {}) {
    this.now = options.now ?? Date.now;
    this.ttlMs = options.ttlMs ?? 15 * 60_000;
    this.maxSessions = options.maxSessions ?? 128;
    if (!Number.isSafeInteger(this.ttlMs) || this.ttlMs < 60_000 || this.ttlMs > 60 * 60_000) {
      throw new Error('dashboard-operator-session-invalid-ttl');
    }
    if (!Number.isSafeInteger(this.maxSessions) || this.maxSessions < 1 || this.maxSessions > 1_024) {
      throw new Error('dashboard-operator-session-invalid-capacity');
    }
  }

  issue(): { token: string; expiresAt: string } {
    this.prune();
    while (this.sessions.size >= this.maxSessions) {
      const oldest = this.sessions.keys().next().value as string | undefined;
      if (!oldest) break;
      this.sessions.delete(oldest);
    }
    const token = randomBytes(32).toString('base64url');
    const expiresAtMs = this.now() + this.ttlMs;
    this.sessions.set(this.digest(token), expiresAtMs);
    return { token, expiresAt: new Date(expiresAtMs).toISOString() };
  }

  verify(token: string | undefined): boolean {
    if (!token || token.length > 256) return false;
    const key = this.digest(token);
    const expiresAt = this.sessions.get(key);
    if (expiresAt === undefined) return false;
    if (expiresAt <= this.now()) {
      this.sessions.delete(key);
      return false;
    }
    return true;
  }

  clear(): void { this.sessions.clear(); }

  private prune(): void {
    const now = this.now();
    for (const [key, expiresAt] of this.sessions) {
      if (expiresAt <= now) this.sessions.delete(key);
    }
  }

  private digest(token: string): string {
    return createHash('sha256').update(token).digest('hex');
  }
}
