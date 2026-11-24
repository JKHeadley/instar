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

interface FileId { ino: number; dev: number }

type ReadResult = { ok: true; c: StoredCredential; id: FileId } | { ok: false; reason: 'none' | 'unreadable' | 'unsafe-file' | 'malformed'; id?: FileId };

/**
 * Reads the credential through one handle and returns that handle still OPEN (the caller closes it
 * after any removal): while it is open the checked file's inode cannot be freed and handed to a newer
 * file, so the inode comparison in `claimIfSame` cannot match a replacement.
 */
function read(stateDir: string): { r: ReadResult; fd: number | null } {
  const file = ceremonyCredentialPath(stateDir);
  let fd: number;
  try { fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0) | (fs.constants.O_NONBLOCK ?? 0)); } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    // @silent-fallback-ok — no file is no credential; a link (ELOOP) is an unsafe file; anything else refuses
    return { r: { ok: false, reason: code === 'ENOENT' ? 'none' : code === 'ELOOP' ? 'unsafe-file' : 'unreadable' }, fd: null };
  }
  try { return { r: readOpen(fd), fd }; } catch {
    try { fs.closeSync(fd); } catch { /* @silent-fallback-ok — closing a read-only handle; nothing to report */ }
    return { r: { ok: false, reason: 'unreadable' }, fd: null }; // @silent-fallback-ok — an unreadable handle refuses
  }
}

function readOpen(fd: number): ReadResult {
  // The OPEN handle is checked before any byte is read, so the file checked is the file read (no window
  // between a path check and a path read). O_NOFOLLOW refuses a link at the last path part; O_NONBLOCK
  // keeps a FIFO planted at the path from blocking the open.
  {
    const st = fs.fstatSync(fd);
    // Only a regular file with one name, that only the agent's own user can read or write. A link, a
    // second name for another file, or a file another user could have written is never a credential.
    const id: FileId = { ino: st.ino, dev: st.dev };
    if (!st.isFile() || st.nlink !== 1 || (st.mode & 0o077) !== 0 || (typeof process.getuid === 'function' && st.uid !== process.getuid())) return { ok: false, reason: 'unsafe-file', id };
    if (st.size > 4096) return { ok: false, reason: 'malformed', id };
    let text: string;
    try { text = fs.readFileSync(fd, 'utf-8'); } catch { return { ok: false, reason: 'unreadable' }; } // @silent-fallback-ok — an unreadable handle refuses
    try {
      const c = JSON.parse(text) as Partial<StoredCredential>;
      if (c.version !== 1 || typeof c.hash !== 'string' || !/^[0-9a-f]{64}$/.test(c.hash) || typeof c.machineId !== 'string' || !c.machineId
        || typeof c.expiresAt !== 'string' || !Number.isFinite(Date.parse(c.expiresAt)) || typeof c.scope !== 'string') return { ok: false, reason: 'malformed', id };
      return { ok: true, id, c: { version: 1, scope: c.scope as CeremonyScope, hash: c.hash, machineId: c.machineId, createdAt: String(c.createdAt ?? ''), expiresAt: c.expiresAt, failures: typeof c.failures === 'number' ? c.failures : 0 } };
    } catch { return { ok: false, reason: 'malformed', id }; } // @silent-fallback-ok — an unparseable file is no credential (refused)
  }
}

/**
 * Wrong tries, by credential hash. Never written into the credential file (the mint command may be
 * replacing it at that moment): kept in this process and in a sibling file, so a restart does not give
 * the same credential three more tries. The sibling file names the hash it counts for, so a newer
 * credential (another hash) starts at zero; the mint command never touches it.
 */
// Named under the credential's own name, so the never-written-over-HTTP prefix rule (keyMaterialPaths.ts) covers it.
export const CEREMONY_TRIES_FILE = 'state/ceremony-credential.json.tries';
const wrongTries = new Map<string, number>();

function persistedTries(stateDir: string, hash: string): number {
  try {
    const t = JSON.parse(fs.readFileSync(path.join(stateDir, CEREMONY_TRIES_FILE), 'utf-8')) as { hash?: unknown; failures?: unknown };
    return t.hash === hash && typeof t.failures === 'number' && Number.isFinite(t.failures) ? t.failures : 0;
  } catch { return 0; } // @silent-fallback-ok — no count file is no counted tries; the in-memory count still applies
}

/** Records the count; false when it could not be written (the caller then removes the credential: fail closed). */
function recordTries(stateDir: string, hash: string, failures: number): boolean {
  const file = path.join(stateDir, CEREMONY_TRIES_FILE);
  const tmp = `${file}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    fs.writeFileSync(tmp, `${JSON.stringify({ hash, failures })}\n`, { mode: 0o600 });
    fs.renameSync(tmp, file);
    return true;
  } catch { // @silent-fallback-ok — reported to the caller, which removes the credential
    try { SafeFsExecutor.safeUnlinkSync(tmp, { operation: 'ceremony credential tries tmp' }); } catch { /* @silent-fallback-ok — tmp may not exist */ }
    return false;
  }
}

function forgetTries(stateDir: string, hash: string): void {
  wrongTries.delete(hash);
  if (persistedTries(stateDir, hash) === 0) return;
  try { SafeFsExecutor.safeUnlinkSync(path.join(stateDir, CEREMONY_TRIES_FILE), { operation: 'ceremony credential tries spent' }); } catch { /* @silent-fallback-ok — a stale count names a spent hash and is never matched again */ }
}

/**
 * Takes the credential file out of its path ONLY if it is still the file that was checked (same inode),
 * by renaming it aside: one rename succeeds, so two spenders cannot both take it, and a newer credential
 * minted meanwhile is put back untouched. Returns the aside path to delete, or null when the file at the
 * path is no longer the one checked (or is gone).
 */
function claimIfSame(stateDir: string, id: FileId | undefined): string | null {
  if (!id) return null;
  const file = ceremonyCredentialPath(stateDir);
  const aside = `${file}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.claimed`;
  try { fs.renameSync(file, aside); } catch { return null; } // @silent-fallback-ok — gone already (another spender took it): not ours to remove
  let same = false;
  try { const st = fs.lstatSync(aside); same = st.ino === id.ino && st.dev === id.dev; } catch { same = false; } // @silent-fallback-ok — unreadable aside is treated as not ours and put back below
  if (same) return aside;
  // A newer credential: back where it was, unless an even newer one is there now (link refuses to overwrite).
  try { fs.linkSync(aside, file); } catch { /* @silent-fallback-ok — a newer one is already in place; this one is dropped below */ }
  removeAside(aside, 'put back (a newer credential)');
  return null;
}

function removeAside(aside: string, why: string): boolean {
  try { SafeFsExecutor.safeUnlinkSync(aside, { operation: `ceremony credential ${why}` }); return true; } catch { return false; } // @silent-fallback-ok — the caller fails closed on false
}

/** Is the checked credential (same inode) still at its path? */
function stillAtPath(stateDir: string, id: FileId | undefined): boolean {
  if (!id) return false;
  try { const st = fs.lstatSync(ceremonyCredentialPath(stateDir)); return st.ino === id.ino && st.dev === id.dev; } catch (err) {
    // @silent-fallback-ok — gone is not at its path; any other error is treated as still there (its count is kept)
    return (err as NodeJS.ErrnoException).code !== 'ENOENT';
  }
}

/**
 * Removes the checked credential (and only it). Returns whether it is out of its path. Its count of wrong
 * tries is forgotten ONLY then: a removal that failed leaves the credential usable, so its count stays
 * (GPT review 4).
 */
function removeChecked(stateDir: string, id: FileId | undefined, why: string, hash?: string): boolean {
  const aside = claimIfSame(stateDir, id);
  if (aside) removeAside(aside, why);
  const gone = !stillAtPath(stateDir, id);
  if (hash && gone) forgetTries(stateDir, hash);
  return gone;
}

/**
 * Checks a presented credential and, when it is right, spends it (takes it out of its path, then
 * deletes it) before returning. Fails closed: no file, an unsafe or unparseable file, another machine's,
 * another ceremony's, a lapsed one, or a wrong one is refused. A wrong one costs a try (the third
 * removes it); a lapsed, unsafe, unparseable or other machine's file is removed. Every removal acts only
 * on the file that was checked (a credential minted meanwhile is never removed or overwritten), and a
 * spend succeeds only for the one caller whose rename took the file.
 */
export function spendCeremonyCredential(stateDir: string, presented: unknown, opts: { scope: CeremonyScope; machineId: string | null; now?: number }): { ok: true } | { ok: false; reason: CeremonyRefusal } {
  const { r, fd } = read(stateDir);
  try { return spendRead(stateDir, r, presented, opts); } finally {
    // Closed only after any removal: the checked inode stays allocated until then (see `read`).
    if (fd !== null) try { fs.closeSync(fd); } catch { /* @silent-fallback-ok — closing a read-only handle; nothing to report */ }
  }
}

function spendRead(stateDir: string, r: ReadResult, presented: unknown, opts: { scope: CeremonyScope; machineId: string | null; now?: number }): { ok: true } | { ok: false; reason: CeremonyRefusal } {
  if (!r.ok) {
    if (r.reason === 'unsafe-file' || r.reason === 'malformed') removeChecked(stateDir, r.id, `refused (${r.reason})`);
    return { ok: false, reason: r.reason };
  }
  const c = r.c;
  const now = opts.now ?? Date.now();
  // The lapse time is trusted only up to the credential's own life: a stored time further out than
  // that (a hand edit, a restored or older file) is treated as lapsed.
  const created = Date.parse(c.createdAt);
  const expires = Date.parse(c.expiresAt);
  if (!Number.isFinite(created) || expires - created > CEREMONY_CREDENTIAL_TTL_MS || now > expires || now < created - CLOCK_ALLOWANCE_MS) {
    removeChecked(stateDir, r.id, 'lapsed', c.hash); return { ok: false, reason: 'expired' };
  }
  if (!opts.machineId || c.machineId !== opts.machineId) { removeChecked(stateDir, r.id, 'refused (another machine)', c.hash); return { ok: false, reason: 'wrong-machine' }; }
  // Another ceremony's credential is left for that ceremony.
  if (c.scope !== opts.scope) return { ok: false, reason: 'wrong-scope' };
  const given = typeof presented === 'string' && presented.length <= 128 ? presented : '';
  const a = Buffer.from(sha(given), 'hex');
  const b = Buffer.from(c.hash, 'hex');
  const counted = Math.max(c.failures, wrongTries.get(c.hash) ?? 0, persistedTries(stateDir, c.hash));
  // A credential that already used its tries is refused whatever is presented (its removal may have failed).
  if (counted >= CEREMONY_CREDENTIAL_MAX_FAILURES) {
    removeChecked(stateDir, r.id, 'three wrong tries', c.hash);
    return { ok: false, reason: 'wrong' };
  }
  if (!given.startsWith(PREFIX) || !crypto.timingSafeEqual(a, b)) {
    const failures = counted + 1;
    wrongTries.set(c.hash, failures);
    // A count that cannot be kept across a restart is not kept at all: the credential is removed.
    const kept = failures < CEREMONY_CREDENTIAL_MAX_FAILURES && recordTries(stateDir, c.hash, failures);
    if (!kept) {
      const gone = removeChecked(stateDir, r.id, failures >= CEREMONY_CREDENTIAL_MAX_FAILURES ? 'three wrong tries' : 'wrong try (count not kept)', c.hash);
      // Neither kept nor removed: refused from now on in this process (terminal in memory).
      if (!gone) wrongTries.set(c.hash, CEREMONY_CREDENTIAL_MAX_FAILURES);
    }
    return { ok: false, reason: 'wrong' };
  }
  // Spent means taken: only the caller whose rename moved THIS file aside succeeds, and only once it is deleted.
  const aside = claimIfSame(stateDir, r.id);
  if (!aside) return { ok: false, reason: 'none' };
  forgetTries(stateDir, c.hash);
  if (!removeAside(aside, 'spent')) return { ok: false, reason: 'unreadable' };
  return { ok: true };
}
