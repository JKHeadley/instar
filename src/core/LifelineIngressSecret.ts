/**
 * Lifeline ingress secret — the proof that a request on the two internal
 * Telegram routes came from the lifeline (or the server itself), not from an
 * agent session holding the ordinary Bearer token.
 *
 * Spec: docs/specs/telegram-internal-route-lifeline-secret.md
 *
 * The secret is 32 random bytes, hex-encoded, in a 0600 file under the agent
 * state dir. Whichever of the lifeline / server starts first creates it; the
 * other reads it. It lives in the FILE and in a module-private variable of the
 * two processes — it is never written to `process.env`, so a session spawned
 * by the server (which inherits the server's environment) cannot receive it
 * that way.
 *
 * Honest limit: every process here runs as one OS user. This is a cooperative
 * boundary. It stops a session forging a message or a button tap with the
 * token it normally holds; it does not stop a session that deliberately reads
 * the file.
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { SafeFsExecutor } from './SafeFsExecutor.js';

/** stateDir-relative path of the secret file (listed in KEY_MATERIAL_PATHS). */
export const LIFELINE_INGRESS_SECRET_RELPATH = path.join('state', 'lifeline-ingress-secret');

/** Request header carrying the secret (lower-case: the form Express exposes). */
export const LIFELINE_SECRET_HEADER = 'x-instar-lifeline-secret';

/**
 * Request header naming a caller that is NOT the lifeline. The server's own
 * re-injection call sets it to `server-self` so its (valid) requests are not
 * counted as evidence that the running lifeline sends the secret.
 */
export const LIFELINE_INGRESS_CALLER_HEADER = 'x-instar-ingress-caller';
export const LIFELINE_INGRESS_CALLER_SERVER_SELF = 'server-self';

const SECRET_HEX_RE = /^[0-9a-f]{64}$/;

export function lifelineIngressSecretPath(stateDir: string): string {
  return path.join(stateDir, LIFELINE_INGRESS_SECRET_RELPATH);
}

type SecretRead =
  | { kind: 'ok'; value: string }
  | { kind: 'absent' }
  | { kind: 'malformed' }
  | { kind: 'error'; error: unknown };

/**
 * Read the file and say WHICH of four things happened. "Could not read it"
 * (EACCES, EIO, a transient fault) is deliberately distinct from "absent" and
 * from "present but not a secret": only the last two may lead to a new value
 * being written. A good secret must never be replaced because of a read fault.
 */
function readSecretFile(stateDir: string): SecretRead {
  let raw: string;
  try {
    raw = fs.readFileSync(lifelineIngressSecretPath(stateDir), 'utf-8').trim();
  } catch (err) {
    // @silent-fallback-ok — classified, not swallowed: the caller decides.
    return (err as NodeJS.ErrnoException).code === 'ENOENT' ? { kind: 'absent' } : { kind: 'error', error: err };
  }
  return SECRET_HEX_RE.test(raw) ? { kind: 'ok', value: raw } : { kind: 'malformed' };
}

/** Read the secret without creating it. Null when absent, unreadable or malformed. */
export function readLifelineIngressSecret(stateDir: string): string | null {
  const r = readSecretFile(stateDir);
  return r.kind === 'ok' ? r.value : null;
}

/**
 * Read-or-create the secret. Creation is atomic AND exclusive: the full value
 * is written to a private temp file and then hard-linked to the final name.
 * `link` fails with EEXIST when another process won the race, and a reader can
 * never observe a half-written file. A file that was READ SUCCESSFULLY and is
 * not a secret is replaced (rename over); the other process picks the new
 * value up by re-reading. A file that could not be read is never replaced —
 * this throws instead.
 */
export function ensureLifelineIngressSecret(stateDir: string): string {
  const first = readSecretFile(stateDir);
  if (first.kind === 'ok') return first.value;
  if (first.kind === 'error') throw first.error;

  const finalPath = lifelineIngressSecretPath(stateDir);
  fs.mkdirSync(path.dirname(finalPath), { recursive: true });
  const value = crypto.randomBytes(32).toString('hex');
  const tmpPath = `${finalPath}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`;
  try {
    fs.writeFileSync(tmpPath, value, { mode: 0o600, flag: 'wx' });
    fs.chmodSync(tmpPath, 0o600); // umask-proof
    try {
      fs.linkSync(tmpPath, finalPath);
      return value;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
      const again = readSecretFile(stateDir);
      if (again.kind === 'ok') return again.value; // the other process won
      if (again.kind === 'error') throw again.error;
      // Present, readable, and not a secret (link is atomic, so this is not a
      // half-written racing file): replace it.
      fs.renameSync(tmpPath, finalPath);
      return value;
    }
  } finally {
    try {
      if (fs.existsSync(tmpPath)) {
        SafeFsExecutor.safeUnlinkSync(tmpPath, { operation: 'src/core/LifelineIngressSecret.ts:ensure-tmp-cleanup' });
      }
    } catch {
      // @silent-fallback-ok — best-effort removal of our own private temp file;
      // the secret itself was already published (or the publish already threw).
    }
  }
}

/** Constant-time comparison. Hashing first removes the length side channel. */
export function lifelineSecretMatches(presented: unknown, expected: string | null): boolean {
  if (typeof presented !== 'string' || presented.length === 0 || !expected) return false;
  const a = crypto.createHash('sha256').update(presented).digest();
  const b = crypto.createHash('sha256').update(expected).digest();
  return crypto.timingSafeEqual(a, b);
}

/** After a failed load, wait this long before touching the filesystem again. */
export const SECRET_LOAD_BACKOFF_MS = 30_000;

/**
 * Process-private holder. `get()` loads (and if needed creates) the secret
 * once and keeps it in memory. `reload()` re-reads the file for the case where
 * the other process replaced it — and keeps the last good value when the
 * re-read fails, so a read fault can never turn a working check into "nobody
 * can be verified". A failed first load is retried at most every 30 s.
 */
export class LifelineIngressSecretHolder {
  private value: string | null = null;
  private lastFailureAt = 0;
  private failures = 0;

  constructor(private readonly stateDir: string, private readonly now: () => number = Date.now) {}

  get(): string | null {
    if (this.value) return this.value;
    if (this.lastFailureAt !== 0 && this.now() - this.lastFailureAt < SECRET_LOAD_BACKOFF_MS) return null;
    return this.reload();
  }

  /** Is the FILE readable as a secret right now? A read — never a create, never the cache. */
  fileReadable(): boolean {
    return readLifelineIngressSecret(this.stateDir) !== null;
  }

  /**
   * When the secret file was written (ms), or null if it cannot be read. It
   * is created the first time this feature runs on a machine and only ever
   * replaced when malformed, so it dates the feature's arrival on this disk
   * independently of the guard's own state file.
   */
  fileMtimeMs(): number | null {
    try {
      return fs.statSync(lifelineIngressSecretPath(this.stateDir)).mtimeMs;
    } catch {
      // @silent-fallback-ok — unknown; the caller falls back to its own clock.
      return null;
    }
  }

  /** Does this process hold a secret in memory (whatever the file says now)? */
  get held(): boolean {
    return this.value !== null;
  }

  /** Consecutive failed loads since the last success (0 = healthy). */
  get failedLoads(): number {
    return this.failures;
  }

  reload(): string | null {
    try {
      this.value = ensureLifelineIngressSecret(this.stateDir);
      this.lastFailureAt = 0;
      this.failures = 0;
    } catch {
      // @silent-fallback-ok — keep the last good value; the guard counts
      // `secret-unavailable` and reports when there has never been one.
      this.lastFailureAt = this.now();
      this.failures++;
    }
    return this.value;
  }
}

const sharedHolders = new Map<string, LifelineIngressSecretHolder>();

/**
 * One holder per state dir per process. The server's guard and the server's
 * own re-injection call share it, so they can never disagree about the value.
 */
export function sharedLifelineIngressSecretHolder(stateDir: string): LifelineIngressSecretHolder {
  const key = path.resolve(stateDir);
  let holder = sharedHolders.get(key);
  if (!holder) {
    holder = new LifelineIngressSecretHolder(stateDir);
    sharedHolders.set(key, holder);
  }
  return holder;
}
