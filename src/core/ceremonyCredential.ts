/**
 * The one-time ceremony credential for the Instar app on the agent's own computer (identity A5,
 * condition 1; docs/specs/identity-security-piece3e-same-network-first-phone.md §4.6).
 *
 * An agent made by the Windows or Linux app has a dashboard PIN made at random that nobody is told,
 * so the owner cannot pass the PIN check of "Add your phone". A5 lets the app on the agent's own
 * computer be the local surface instead: for each setup, the app runs a command INSIDE the agent's
 * own system (on Windows, a command inside WSL, as the agent's user), and that command makes a
 * single-use credential for that one ceremony. Its rules:
 *
 *  - Made only by running `instar mobile ceremony-credential` as the agent's own user: it writes the
 *    agent's 0600 state file directly. No route mints one, and the file is key material (never served,
 *    written, backed up or synced over HTTP), so nothing on the network can make one.
 *  - Only its SHA-256 is on disk; the secret is printed once to the command's output for the app to
 *    use at once. A later reader of the file (a backup, another program) learns nothing usable.
 *  - Single use: the first accepted presentation deletes it. Three wrong presentations delete it.
 *    It lapses after 10 minutes. Making a new one replaces the old one.
 *  - Bound to this machine (the machine id it was made under) and to one ceremony ("phone-setup").
 *  - What it opens, and when, is decided by the route (src/server/phoneSetupRoutes.ts), not here.
 *
 * Checking is synchronous from read to delete, so two requests in this process cannot both spend it.
 *
 * Linux and macOS only (where agents run, including inside WSL): it requires a 0600 file owned by the
 * agent's user. On native Windows file modes read as 0666, so every credential is refused there. That
 * is the intended failure: do not loosen the check to make it pass on Windows.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { SafeFsExecutor } from './SafeFsExecutor.js';

export const CEREMONY_CREDENTIAL_FILE = 'state/ceremony-credential.json';
export const CEREMONY_CREDENTIAL_TTL_MS = 10 * 60_000;
export const CEREMONY_CREDENTIAL_MAX_FAILURES = 3;
/** A made-at time this far in the future (clock drift) is still accepted; further is refused. */
const CLOCK_ALLOWANCE_MS = 60_000;
/** The ceremonies a credential may be made for. 3b adds the recovery screens. */
export const CEREMONY_SCOPES = ['phone-setup'] as const;
export type CeremonyScope = typeof CEREMONY_SCOPES[number];
const PREFIX = 'icc1_';

interface StoredCredential {
  version: 1;
  scope: CeremonyScope;
  hash: string;
  machineId: string;
  createdAt: string;
  expiresAt: string;
  failures: number;
}

export type CeremonyRefusal = 'none' | 'unreadable' | 'unsafe-file' | 'expired' | 'wrong-machine' | 'wrong-scope' | 'wrong' | 'malformed';

/** `stateDir` is the agent's `.instar` folder (the server's `config.stateDir`). */
export function ceremonyCredentialPath(stateDir: string): string {
  return path.join(stateDir, CEREMONY_CREDENTIAL_FILE);
}

const sha = (s: string): string => crypto.createHash('sha256').update(s).digest('hex');

function writeAtomic0600(file: string, body: StoredCredential): void {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(body)}\n`, { mode: 0o600 });
  fs.renameSync(tmp, file);
}

export function removeCeremonyCredential(stateDir: string, why: string): void {
  try { SafeFsExecutor.safeUnlinkSync(ceremonyCredentialPath(stateDir), { operation: `ceremony credential ${why}` }); } catch { /* @silent-fallback-ok — already gone is the goal */ }
}

/**
 * Makes a fresh credential over any old one and returns it. Run by the agent's own user, on the
 * agent's own computer; the caller checks the machine id is known (no id, no credential).
 */
export function mintCeremonyCredential(stateDir: string, opts: { scope: CeremonyScope; machineId: string; now?: number }): { credential: string; expiresAt: string } {
  if (!CEREMONY_SCOPES.includes(opts.scope)) throw new Error(`unknown ceremony: ${String(opts.scope)}`);
  if (!opts.machineId) throw new Error('no machine id');
  const now = opts.now ?? Date.now();
  const credential = `${PREFIX}${crypto.randomBytes(32).toString('base64url')}`;
  const expiresAt = new Date(now + CEREMONY_CREDENTIAL_TTL_MS).toISOString();
  writeAtomic0600(ceremonyCredentialPath(stateDir), {
    version: 1, scope: opts.scope, hash: sha(credential), machineId: opts.machineId,
    createdAt: new Date(now).toISOString(), expiresAt, failures: 0,
  });
  return { credential, expiresAt };
}

function read(stateDir: string): { ok: true; c: StoredCredential } | { ok: false; reason: 'none' | 'unreadable' | 'unsafe-file' | 'malformed' } {
  const file = ceremonyCredentialPath(stateDir);
  let st: fs.Stats;
  try { st = fs.lstatSync(file); } catch (err) {
    return { ok: false, reason: (err as NodeJS.ErrnoException).code === 'ENOENT' ? 'none' : 'unreadable' }; // @silent-fallback-ok — no file is no credential; anything else refuses
  }
  // Only a regular file that only the agent's own user can read or write. A link, or a file another
  // user could have written, is never a credential.
  if (!st.isFile() || (st.mode & 0o077) !== 0 || (typeof process.getuid === 'function' && st.uid !== process.getuid())) return { ok: false, reason: 'unsafe-file' };
  try {
    const c = JSON.parse(fs.readFileSync(file, 'utf-8')) as Partial<StoredCredential>;
    if (c.version !== 1 || typeof c.hash !== 'string' || !/^[0-9a-f]{64}$/.test(c.hash) || typeof c.machineId !== 'string' || !c.machineId
      || typeof c.expiresAt !== 'string' || !Number.isFinite(Date.parse(c.expiresAt)) || typeof c.scope !== 'string') return { ok: false, reason: 'malformed' };
    return { ok: true, c: { version: 1, scope: c.scope as CeremonyScope, hash: c.hash, machineId: c.machineId, createdAt: String(c.createdAt ?? ''), expiresAt: c.expiresAt, failures: typeof c.failures === 'number' ? c.failures : 0 } };
  } catch { return { ok: false, reason: 'malformed' }; } // @silent-fallback-ok — an unparseable file is no credential (refused)
}

/**
 * Checks a presented credential and, when it is right, spends it (deletes the file) before returning.
 * Fails closed: no file, an unsafe or unparseable file, another machine's, another ceremony's, a lapsed
 * one, or a wrong one is refused. A wrong one costs a try (the third deletes it); a lapsed, unsafe,
 * unparseable or other machine's file is deleted. Synchronous from read to delete.
 */
export function spendCeremonyCredential(stateDir: string, presented: unknown, opts: { scope: CeremonyScope; machineId: string | null; now?: number }): { ok: true } | { ok: false; reason: CeremonyRefusal } {
  const r = read(stateDir);
  if (!r.ok) {
    if (r.reason === 'unsafe-file' || r.reason === 'malformed') removeCeremonyCredential(stateDir, `refused (${r.reason})`);
    return { ok: false, reason: r.reason };
  }
  const c = r.c;
  const now = opts.now ?? Date.now();
  // The lapse time is trusted only up to the credential's own life: a stored time further out than
  // that (a hand edit, a restored or older file) is treated as lapsed.
  const created = Date.parse(c.createdAt);
  const expires = Date.parse(c.expiresAt);
  if (!Number.isFinite(created) || expires - created > CEREMONY_CREDENTIAL_TTL_MS || now > expires || now < created - CLOCK_ALLOWANCE_MS) {
    removeCeremonyCredential(stateDir, 'lapsed'); return { ok: false, reason: 'expired' };
  }
  if (!opts.machineId || c.machineId !== opts.machineId) { removeCeremonyCredential(stateDir, 'refused (another machine)'); return { ok: false, reason: 'wrong-machine' }; }
  // Another ceremony's credential is left for that ceremony.
  if (c.scope !== opts.scope) return { ok: false, reason: 'wrong-scope' };
  const given = typeof presented === 'string' && presented.length <= 128 ? presented : '';
  const a = Buffer.from(sha(given), 'hex');
  const b = Buffer.from(c.hash, 'hex');
  if (!given.startsWith(PREFIX) || !crypto.timingSafeEqual(a, b)) {
    const failures = c.failures + 1;
    // Only the credential that was checked: if a new one was made meanwhile, it is left untouched.
    const still = read(stateDir);
    if (still.ok && still.c.hash === c.hash) {
      if (failures >= CEREMONY_CREDENTIAL_MAX_FAILURES) removeCeremonyCredential(stateDir, 'three wrong tries');
      else writeAtomic0600(ceremonyCredentialPath(stateDir), { ...c, failures });
    }
    return { ok: false, reason: 'wrong' };
  }
  removeCeremonyCredential(stateDir, 'spent');
  // Spent means gone: if the delete did not happen, the credential is not accepted.
  if (fs.existsSync(ceremonyCredentialPath(stateDir))) return { ok: false, reason: 'unreadable' };
  return { ok: true };
}
