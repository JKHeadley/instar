import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

/** A target-local, short-lived session created only after the target accepts a
 * one-use operator assertion. No PIN or front dashboard token is stored here. */
export class DesktopDelegatedSessionStore {
  private readonly sessions = new Map<string, {
    browserKeyDigests: Set<string>;
    issuerMachineId: string;
    expiresAtMs: number;
    lastSeenAtMs: number;
  }>();

  constructor(private readonly now: () => number = Date.now) {}

  issue(issuerMachineId: string, browserPublicKey: string): { token: string; expiresAtMs: number } {
    this.sweep();
    if (this.sessions.size >= 4) throw new Error('desktop-session-capacity');
    const token = randomBytes(32).toString('base64url');
    const expiresAtMs = this.now() + 10 * 60_000;
    this.sessions.set(this.hash(token), {
      browserKeyDigests: new Set([this.hash(browserPublicKey)]), issuerMachineId,
      expiresAtMs, lastSeenAtMs: this.now(),
    });
    return { token, expiresAtMs };
  }

  verify(token: string, browserPublicKey: string): boolean {
    if (!token || !browserPublicKey) return false;
    const row = this.sessions.get(this.hash(token));
    if (!row || this.now() >= row.expiresAtMs || this.now() - row.lastSeenAtMs >= 20_000) return false;
    const received = Buffer.from(this.hash(browserPublicKey));
    return [...row.browserKeyDigests].some(digest => timingSafeEqual(received, Buffer.from(digest)));
  }

  belongsTo(token: string, issuerMachineId: string): boolean {
    const row = this.sessions.get(this.hash(token));
    return !!row && row.issuerMachineId === issuerMachineId
      && this.now() < row.expiresAtMs && this.now() - row.lastSeenAtMs < 20_000;
  }

  /** The desktop authority independently verifies the previous browser key's
   * signature before a resume activates this key. Keep at most three rotations. */
  allowResumeKey(token: string, issuerMachineId: string, browserPublicKey: string): boolean {
    if (!this.belongsTo(token, issuerMachineId) || !browserPublicKey || browserPublicKey.length > 512) return false;
    const row = this.sessions.get(this.hash(token))!;
    const digest = this.hash(browserPublicKey);
    if (row.browserKeyDigests.has(digest)) return true;
    if (row.browserKeyDigests.size >= 4) return false;
    row.browserKeyDigests.add(digest);
    return true;
  }

  /** A machine-authenticated front refreshes only while its PIN session remains
   * valid. This cannot extend the original ten-minute ceiling. */
  keepAlive(token: string, issuerMachineId: string): boolean {
    const row = this.sessions.get(this.hash(token));
    if (!row || row.issuerMachineId !== issuerMachineId || this.now() >= row.expiresAtMs
      || this.now() - row.lastSeenAtMs >= 20_000) return false;
    row.lastSeenAtMs = this.now();
    return true;
  }

  revoke(token: string): void { this.sessions.delete(this.hash(token)); }

  private sweep(): void {
    for (const [hash, row] of this.sessions) {
      if (this.now() >= row.expiresAtMs || this.now() - row.lastSeenAtMs >= 20_000) this.sessions.delete(hash);
    }
  }

  private hash(value: string): string { return createHash('sha256').update(value).digest('hex'); }
}
