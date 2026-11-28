/**
 * The one-time local dashboard link (docs/specs/identity-security-piece1a-local-link.md).
 *
 * Machine-local store of link tickets, their exchange challenges and the local credentials a
 * redeemed link creates. Written only by the server process (the CLI mints through the server),
 * so a short busy timeout is enough and the synchronous driver never blocks the event loop for
 * long. Every check that decides a binding runs inside one transaction.
 *
 * Signal vs. Authority: nothing here decides a person's identity. A credential proves only that a
 * link minted by this agent's OS account on this machine was redeemed through its loopback within
 * the ticket's lifetime. `startedBy` is recorded as a signal and read by no gate.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import type { Database as BetterSqliteDatabase } from 'better-sqlite3';
import { registerSqliteHandle } from './SqliteRegistry.js';

export const LOCAL_ACCESS_AUDIENCE = 'instar-local-access-v1';
export const LOCAL_ACCESS_DIR = 'local-access';
export const TICKET_LIFETIME_MS = 15 * 60_000;
export const CHALLENGE_LIFETIME_MS = 60_000;
export const MAX_UNREDEEMED_TICKETS = 10;
export const MAX_LIVE_CREDENTIALS = 10;
export const MAX_REQUEST_BYTES = 8 * 1024;
export const MAX_OPEN_CHALLENGES_PER_TICKET = 8;

export type StartedBy = 'terminal' | 'session';
export type ChallengeKind = 'exchange' | 'use';

export interface MintResult { id: string; secret: string; expiresAt: number; launchName: string; endedLaunchNames: string[] }

export interface CredentialRow {
  credentialId: string;
  ticketId: string;
  keyThumbprint: string;
  publicKey: string;
  origin: string;
  expiresAt: number;
}

export type ExchangeOutcome =
  | { ok: true; credential: CredentialRow; repeated: boolean; endedLaunchNames: string[] }
  | { ok: false; reason: 'unknown-ticket' | 'expired' | 'revoked' | 'bad-secret' | 'bad-challenge' | 'bad-signature' | 'origin-mismatch' | 'bound-to-other-key' };

export type ChallengeOutcome =
  | { ok: true; challenge: string; expiresAt: number }
  | { ok: false; reason: 'unknown-ticket' | 'unknown-credential' | 'expired' | 'revoked' | 'origin-mismatch' | 'bound-to-other-key' | 'too-many-challenges' | 'bad-secret' };

const sha256 = (s: string | Buffer): string => crypto.createHash('sha256').update(s).digest('hex');
const rand = (bytes: number): string => crypto.randomBytes(bytes).toString('base64url');
const sameHex = (a: string, b: string): boolean => {
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(Buffer.from(a, 'hex'), Buffer.from(b, 'hex'));
};

/** What the page sends to ask for an exchange challenge: proves it holds the secret without sending it. */
export function challengeSecretProof(secret: string): string {
  return sha256(`instar-local-challenge-v1\n${secret}`);
}

/** The text a browser signs to redeem a ticket. */
export function exchangeText(agentName: string, ticketId: string, challenge: string, origin: string): string {
  return `instar-local-exchange-v1\n${agentName}\n${ticketId}\n${challenge}\n${origin}`;
}

/** The text a browser signs to use its credential for one action. */
export function useText(agentName: string, credentialId: string, action: string, challenge: string, origin: string, methodPath: string): string {
  return `instar-local-use-v1\n${agentName}\n${credentialId}\n${action}\n${challenge}\n${origin}\n${methodPath}`;
}

/** Thumbprint of a raw (65-byte, uncompressed, base64url) P-256 public key. */
export function keyThumbprint(publicKey: string): string {
  return sha256(Buffer.from(publicKey, 'base64url'));
}

/**
 * Prepare the private directory: 0700, owned by this user, not a symlink. Refuses anything else
 * rather than repairing it, so a planted directory is never trusted.
 */
export function ensurePrivateDir(dir: string): void {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const st = fs.lstatSync(dir);
  const uid = process.getuid?.();
  if (!st.isDirectory() || st.isSymbolicLink() || (uid !== undefined && st.uid !== uid)) throw new Error('local-access-dir-ownership-invalid');
  if (st.mode & 0o077) fs.chmodSync(dir, 0o700);
}

/** Refuse a symlinked or foreign-owned file (absent is fine). */
function checkPrivateFile(file: string): void {
  let st: fs.Stats;
  try { st = fs.lstatSync(file); } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw err;
  }
  const uid = process.getuid?.();
  if (!st.isFile() || st.isSymbolicLink() || (uid !== undefined && st.uid !== uid)) throw new Error('local-access-file-ownership-invalid');
  if (st.mode & 0o077) fs.chmodSync(file, 0o600);
}

export interface LocalAccessStoreOptions {
  /** `<stateDir>/local-access`. */
  dir: string;
  agentName: string;
  now?: () => number;
}

export class LocalAccessStore {
  private readonly db: BetterSqliteDatabase;
  private readonly now: () => number;
  private readonly unregister: () => void;
  readonly agentName: string;

  constructor(opts: LocalAccessStoreOptions) {
    this.now = opts.now ?? Date.now;
    this.agentName = opts.agentName;
    ensurePrivateDir(opts.dir);
    const file = path.join(opts.dir, 'tickets.db');
    for (const f of [file, `${file}-wal`, `${file}-shm`]) checkPrivateFile(f);
    const fd = fs.openSync(file, fs.constants.O_CREAT | fs.constants.O_RDWR | fs.constants.O_NOFOLLOW, 0o600);
    fs.closeSync(fd);
    this.db = new Database(file);
    this.unregister = registerSqliteHandle(() => this.close());
    try {
      this.db.pragma('busy_timeout = 250');
      this.db.pragma('journal_mode = WAL');
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS tickets (
          id TEXT PRIMARY KEY, secret_digest TEXT NOT NULL, challenge_digest TEXT NOT NULL, origin TEXT NOT NULL,
          started_by TEXT NOT NULL, created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL, state TEXT NOT NULL,
          key_thumbprint TEXT, launch_name TEXT);
        CREATE TABLE IF NOT EXISTS nonces (nonce TEXT PRIMARY KEY, until INTEGER NOT NULL);
        CREATE TABLE IF NOT EXISTS challenges (
          challenge TEXT PRIMARY KEY, kind TEXT NOT NULL, subject TEXT NOT NULL, key_thumbprint TEXT NOT NULL,
          action TEXT, expires_at INTEGER NOT NULL);
        CREATE TABLE IF NOT EXISTS credentials (
          id TEXT PRIMARY KEY, ticket_id TEXT UNIQUE NOT NULL, key_thumbprint TEXT NOT NULL, public_key TEXT NOT NULL,
          origin TEXT NOT NULL, expires_at INTEGER NOT NULL);
        CREATE INDEX IF NOT EXISTS challenges_subject ON challenges(subject);
      `);
    } catch (err) { this.close(); throw err; }
  }

  close(): void {
    try { if (this.db.open) this.db.close(); } catch { /* @silent-fallback-ok — closing twice is harmless */ }
    this.unregister();
  }

  /**
   * Mint a ticket. At the unredeemed cap the oldest unredeemed ticket is revoked, so repeated
   * clicks never lock the person out. Never refused for capacity. Returns the launch names of
   * tickets that ended, for the caller to delete after the transaction commits.
   */
  mint(opts: { origin: string; startedBy: StartedBy }): MintResult {
    const now = this.now();
    return this.db.transaction((): MintResult => {
      const endedLaunchNames: string[] = this.pruneInTx(now);
      const unredeemed = this.db.prepare("SELECT id, launch_name FROM tickets WHERE state = 'minted' AND expires_at > ? ORDER BY created_at ASC, rowid ASC").all(now) as Array<{ id: string; launch_name: string | null }>;
      for (const t of unredeemed.slice(0, Math.max(0, unredeemed.length - MAX_UNREDEEMED_TICKETS + 1))) {
        this.db.prepare("UPDATE tickets SET state = 'revoked', launch_name = NULL WHERE id = ?").run(t.id);
        this.db.prepare('DELETE FROM challenges WHERE subject = ?').run(t.id);
        if (t.launch_name) endedLaunchNames.push(t.launch_name);
      }
      const id = rand(16);
      const secret = rand(32);
      const launchName = rand(16);
      const expiresAt = now + TICKET_LIFETIME_MS;
      this.db.prepare("INSERT INTO tickets (id, secret_digest, challenge_digest, origin, started_by, created_at, expires_at, state, launch_name) VALUES (?,?,?,?,?,?,?, 'minted', ?)")
        .run(id, sha256(secret), challengeSecretProof(secret), opts.origin, opts.startedBy, now, expiresAt, launchName);
      return { id, secret, expiresAt, launchName, endedLaunchNames };
    })();
  }

  /**
   * At server start: revoke every unredeemed ticket and every open challenge, so a link minted
   * before a restart never works after it. Bound credentials stay. Returns launch names to delete.
   */
  revokeUnredeemedAtStart(): string[] {
    return this.db.transaction((): string[] => {
      const rows = this.db.prepare("SELECT launch_name FROM tickets WHERE state = 'minted' AND launch_name IS NOT NULL").all() as Array<{ launch_name: string }>;
      this.db.prepare("UPDATE tickets SET state = 'revoked', launch_name = NULL WHERE state = 'minted'").run();
      this.db.prepare('DELETE FROM challenges').run();
      return rows.map((r) => r.launch_name);
    })();
  }

  /** The launch name of a live unredeemed ticket, cleared so it is deleted once (first accepted challenge). */
  takeLaunchName(ticketId: string): string | null {
    const t = this.ticket(ticketId);
    if (!t || !t.launch_name || t.state !== 'minted') return null;
    this.db.prepare('UPDATE tickets SET launch_name = NULL WHERE id = ?').run(t.id);
    return t.launch_name;
  }

  /** Remember a mint request nonce until `until`; false if it was already seen (a replay). */
  rememberNonce(nonce: string, until: number): boolean {
    if (typeof nonce !== 'string' || !/^[A-Za-z0-9_-]{16,64}$/.test(nonce)) return false;
    const now = this.now();
    return this.db.transaction((): boolean => {
      this.db.prepare('DELETE FROM nonces WHERE until <= ?').run(now);
      if (this.db.prepare('SELECT 1 FROM nonces WHERE nonce = ?').get(nonce)) return false;
      this.db.prepare('INSERT INTO nonces (nonce, until) VALUES (?, ?)').run(nonce, until);
      return true;
    })();
  }

  /** A single-use challenge for redeeming a ticket with one key. Unknown ids allocate nothing. */
  exchangeChallenge(opts: { ticketId: string; secretProof: string; publicKey: string; origin: string }): ChallengeOutcome {
    const now = this.now();
    return this.db.transaction((): ChallengeOutcome => {
      const t = this.ticket(opts.ticketId);
      if (!t) return { ok: false, reason: 'unknown-ticket' };
      if (typeof opts.secretProof !== 'string' || !/^[0-9a-f]{64}$/.test(opts.secretProof) || !sameHex(opts.secretProof, t.challenge_digest)) return { ok: false, reason: 'bad-secret' };
      if (t.state === 'revoked') return { ok: false, reason: 'revoked' };
      if (t.expires_at <= now) return { ok: false, reason: 'expired' };
      if (t.origin !== opts.origin) return { ok: false, reason: 'origin-mismatch' };
      const kt = keyThumbprint(opts.publicKey);
      if (t.key_thumbprint && t.key_thumbprint !== kt) return { ok: false, reason: 'bound-to-other-key' };
      return this.issueChallenge('exchange', t.id, kt, null, now, t.expires_at);
    })();
  }

  /**
   * Redeem: in one transaction check the ticket, the secret, the challenge and the signature,
   * consume the challenge, bind the key and create one credential. A same-key repeat returns
   * the same credential; a different key after binding changes nothing.
   */
  exchange(opts: { ticketId: string; secret: string; publicKey: string; challenge: string; origin: string; verify: (text: string) => boolean }): ExchangeOutcome {
    const now = this.now();
    return this.db.transaction((): ExchangeOutcome => {
      const t = this.ticket(opts.ticketId);
      if (!t) return { ok: false, reason: 'unknown-ticket' };
      if (t.state === 'revoked') return { ok: false, reason: 'revoked' };
      if (t.expires_at <= now) return { ok: false, reason: 'expired' };
      if (t.origin !== opts.origin) return { ok: false, reason: 'origin-mismatch' };
      if (typeof opts.secret !== 'string' || !sameHex(sha256(opts.secret), t.secret_digest)) return { ok: false, reason: 'bad-secret' };
      const kt = keyThumbprint(opts.publicKey);
      if (t.key_thumbprint && t.key_thumbprint !== kt) return { ok: false, reason: 'bound-to-other-key' };
      const c = this.db.prepare("SELECT * FROM challenges WHERE challenge = ? AND kind = 'exchange'").get(opts.challenge) as { subject: string; key_thumbprint: string; expires_at: number } | undefined;
      if (!c || c.subject !== t.id || c.key_thumbprint !== kt || c.expires_at <= now) return { ok: false, reason: 'bad-challenge' };
      if (!opts.verify(exchangeText(this.agentName, t.id, opts.challenge, t.origin))) return { ok: false, reason: 'bad-signature' };
      this.db.prepare('DELETE FROM challenges WHERE challenge = ?').run(opts.challenge);
      const existing = this.db.prepare('SELECT * FROM credentials WHERE ticket_id = ?').get(t.id) as RawCredential | undefined;
      if (existing) return { ok: true, credential: toCredential(existing), repeated: true, endedLaunchNames: [] };
      // Redeemed, but its credential has ended (expired or evicted): a retry never revives it.
      if (t.state === 'redeemed') return { ok: false, reason: 'revoked' };
      const live = this.db.prepare('SELECT id FROM credentials WHERE expires_at > ? ORDER BY expires_at ASC, rowid ASC').all(now) as Array<{ id: string }>;
      for (const c of live.slice(0, Math.max(0, live.length - MAX_LIVE_CREDENTIALS + 1))) {
        this.db.prepare('DELETE FROM challenges WHERE subject = ?').run(c.id);
        this.db.prepare('DELETE FROM credentials WHERE id = ?').run(c.id);
      }
      const endedLaunchNames = t.launch_name ? [t.launch_name] : [];
      this.db.prepare("UPDATE tickets SET state = 'redeemed', key_thumbprint = ?, launch_name = NULL WHERE id = ?").run(kt, t.id);
      const credentialId = rand(16);
      this.db.prepare('INSERT INTO credentials (id, ticket_id, key_thumbprint, public_key, origin, expires_at) VALUES (?,?,?,?,?,?)')
        .run(credentialId, t.id, kt, opts.publicKey, t.origin, t.expires_at);
      return { ok: true, credential: { credentialId, ticketId: t.id, keyThumbprint: kt, publicKey: opts.publicKey, origin: t.origin, expiresAt: t.expires_at }, repeated: false, endedLaunchNames };
    })();
  }

  /** A single-use challenge for one use of a live credential. */
  useChallenge(opts: { credentialId: string; action: string; origin: string }): ChallengeOutcome {
    const now = this.now();
    return this.db.transaction((): ChallengeOutcome => {
      const c = this.credential(opts.credentialId);
      if (!c) return { ok: false, reason: 'unknown-credential' };
      if (c.expires_at <= now) return { ok: false, reason: 'expired' };
      if (c.origin !== opts.origin) return { ok: false, reason: 'origin-mismatch' };
      return this.issueChallenge('use', c.id, c.key_thumbprint, opts.action, now, c.expires_at);
    })();
  }

  /**
   * Verify one use: a live credential, its single-use challenge for exactly this action, and the
   * signature by the bound key. Consumes the challenge. Returns the credential, or null.
   */
  verifyUse(opts: { credentialId: string; action: string; challenge: string; origin: string; methodPath: string; verify: (publicKey: string, text: string) => boolean }): CredentialRow | null {
    const now = this.now();
    return this.db.transaction((): CredentialRow | null => {
      const cred = this.credential(opts.credentialId);
      if (!cred || cred.expires_at <= now || cred.origin !== opts.origin) return null;
      const ch = this.db.prepare("SELECT * FROM challenges WHERE challenge = ? AND kind = 'use'").get(opts.challenge) as { subject: string; key_thumbprint: string; action: string | null; expires_at: number } | undefined;
      if (!ch || ch.subject !== cred.id || ch.action !== opts.action || ch.expires_at <= now) return null;
      this.db.prepare('DELETE FROM challenges WHERE challenge = ?').run(opts.challenge);
      if (!opts.verify(cred.public_key, useText(this.agentName, cred.id, opts.action, opts.challenge, cred.origin, opts.methodPath))) return null;
      return toCredential(cred);
    })();
  }

  /** Delete expired rows; returns launch names of tickets that ended unredeemed, for deletion. */
  prune(): string[] {
    const now = this.now();
    return this.db.transaction(() => this.pruneInTx(now))();
  }

  /** Launch names still owned by a live unredeemed ticket (the start-up sweep keeps only these). */
  liveLaunchNames(): Set<string> {
    const now = this.now();
    return new Set((this.db.prepare("SELECT launch_name FROM tickets WHERE state = 'minted' AND expires_at > ? AND launch_name IS NOT NULL").all(now) as Array<{ launch_name: string }>).map((r) => r.launch_name));
  }

  counts(): { unredeemed: number; liveCredentials: number; challenges: number } {
    const now = this.now();
    const one = (sql: string): number => (this.db.prepare(sql).get(now) as { n: number }).n;
    return {
      unredeemed: one("SELECT COUNT(*) AS n FROM tickets WHERE state = 'minted' AND expires_at > ?"),
      liveCredentials: one('SELECT COUNT(*) AS n FROM credentials WHERE expires_at > ?'),
      challenges: one('SELECT COUNT(*) AS n FROM challenges WHERE expires_at > ?'),
    };
  }

  private issueChallenge(kind: ChallengeKind, subject: string, kt: string, action: string | null, now: number, ceiling: number): ChallengeOutcome {
    this.db.prepare('DELETE FROM challenges WHERE expires_at <= ?').run(now);
    if (kind === 'exchange') {
      // One open exchange challenge per ticket and key: a new request for the SAME key replaces its own.
      // Use challenges are not replaced, so several tabs never cancel each other (the per-subject cap bounds them).
      const sameKey = this.db.prepare("SELECT challenge FROM challenges WHERE subject = ? AND key_thumbprint = ? AND kind = 'exchange'").all(subject, kt) as Array<{ challenge: string }>;
      for (const c of sameKey) this.db.prepare('DELETE FROM challenges WHERE challenge = ?').run(c.challenge);
    }
    const open = (this.db.prepare('SELECT COUNT(*) AS n FROM challenges WHERE subject = ?').get(subject) as { n: number }).n;
    if (open >= MAX_OPEN_CHALLENGES_PER_TICKET) return { ok: false, reason: 'too-many-challenges' };
    const challenge = rand(32);
    const expiresAt = Math.min(now + CHALLENGE_LIFETIME_MS, ceiling);
    this.db.prepare('INSERT INTO challenges (challenge, kind, subject, key_thumbprint, action, expires_at) VALUES (?,?,?,?,?,?)').run(challenge, kind, subject, kt, action, expiresAt);
    return { ok: true, challenge, expiresAt };
  }

  private pruneInTx(now: number): string[] {
    const ended = this.db.prepare("SELECT launch_name FROM tickets WHERE expires_at <= ? AND launch_name IS NOT NULL").all(now) as Array<{ launch_name: string }>;
    this.db.prepare('DELETE FROM tickets WHERE expires_at <= ?').run(now);
    this.db.prepare('DELETE FROM credentials WHERE expires_at <= ?').run(now);
    this.db.prepare('DELETE FROM challenges WHERE expires_at <= ?').run(now);
    this.db.prepare('DELETE FROM nonces WHERE until <= ?').run(now);
    return ended.map((r) => r.launch_name);
  }

  private ticket(id: string): RawTicket | undefined {
    if (typeof id !== 'string' || !/^[A-Za-z0-9_-]{16,64}$/.test(id)) return undefined;
    return this.db.prepare('SELECT * FROM tickets WHERE id = ?').get(id) as RawTicket | undefined;
  }

  private credential(id: string): RawCredential | undefined {
    if (typeof id !== 'string' || !/^[A-Za-z0-9_-]{16,64}$/.test(id)) return undefined;
    return this.db.prepare('SELECT * FROM credentials WHERE id = ?').get(id) as RawCredential | undefined;
  }
}

interface RawTicket { id: string; secret_digest: string; challenge_digest: string; origin: string; started_by: string; created_at: number; expires_at: number; state: string; key_thumbprint: string | null; launch_name: string | null }
interface RawCredential { id: string; ticket_id: string; key_thumbprint: string; public_key: string; origin: string; expires_at: number }

function toCredential(r: RawCredential): CredentialRow {
  return { credentialId: r.id, ticketId: r.ticket_id, keyThumbprint: r.key_thumbprint, publicKey: r.public_key, origin: r.origin, expiresAt: r.expires_at };
}
