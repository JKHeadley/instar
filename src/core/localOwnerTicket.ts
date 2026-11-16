/**
 * The one-time local ticket for the Mac app's first owner device (docs/specs/mac-app-creates-agent.md
 * §A). Written by the installer (owner-slot with `forApp`, or `instar install --app-ticket`) into the
 * agent's own state folder with mode 0600; read and consumed by POST /mobile/local-owner-device.
 * Reading it proves the caller runs as the user who owns this agent's files.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { deviceKeyHashOf } from './AppRecordSignatures.js';
import { DEVICE_KEY_LEDGER_FILE } from './MobileDeviceKeyLedger.js';
import { SafeFsExecutor } from './SafeFsExecutor.js';

export const LOCAL_OWNER_TICKET_FILE = 'local-owner-ticket.json';
export const LOCAL_OWNER_TICKET_TTL_MS = 30 * 60_000;
export const LOCAL_OWNER_MAX_FAILURES = 3;

export interface LocalOwnerTicket { ticket: string; expiresAt: string; failures: number }

/** `stateDir` is the agent's `.instar` folder (the server's `config.stateDir`). */
export function localOwnerTicketPath(stateDir: string): string {
  return path.join(stateDir, 'state', LOCAL_OWNER_TICKET_FILE);
}

function writeAtomic0600(file: string, body: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(body)}\n`, { mode: 0o600 });
  fs.renameSync(tmp, file);
}

/** Writes a fresh ticket over any old one. Returns the ticket. */
export function writeLocalOwnerTicket(stateDir: string, now: number = Date.now()): string {
  const ticket = crypto.randomBytes(32).toString('base64url');
  writeAtomic0600(localOwnerTicketPath(stateDir), { ticket, expiresAt: new Date(now + LOCAL_OWNER_TICKET_TTL_MS).toISOString(), failures: 0 } satisfies LocalOwnerTicket);
  return ticket;
}

export function readLocalOwnerTicket(stateDir: string): LocalOwnerTicket | null {
  let raw: string;
  try { raw = fs.readFileSync(localOwnerTicketPath(stateDir), 'utf-8'); } catch { return null; } // @silent-fallback-ok — no readable ticket means no route (404), the designed answer
  try {
    const t = JSON.parse(raw) as Partial<LocalOwnerTicket>;
    if (typeof t.ticket !== 'string' || typeof t.expiresAt !== 'string' || !Number.isFinite(Date.parse(t.expiresAt))) return null;
    return { ticket: t.ticket, expiresAt: t.expiresAt, failures: typeof t.failures === 'number' ? t.failures : 0 };
  } catch { return null; } // @silent-fallback-ok — an unparseable ticket is no ticket (404)
}

export function removeLocalOwnerTicket(stateDir: string): void {
  try { SafeFsExecutor.safeUnlinkSync(localOwnerTicketPath(stateDir), { operation: 'local owner ticket consumed or expired' }); } catch { /* @silent-fallback-ok — already gone */ }
}

/** Records one more wrong ticket; the third deletes the file. */
export function noteLocalOwnerTicketFailure(stateDir: string, t: LocalOwnerTicket): void {
  const failures = t.failures + 1;
  if (failures >= LOCAL_OWNER_MAX_FAILURES) { removeLocalOwnerTicket(stateDir); return; }
  writeAtomic0600(localOwnerTicketPath(stateDir), { ...t, failures });
}

/** Constant-time comparison of two secrets of any length. */
export function sameLocalOwnerTicket(a: string, b: string): boolean {
  return crypto.timingSafeEqual(crypto.createHash('sha256').update(a).digest(), crypto.createHash('sha256').update(b).digest());
}

/**
 * Why `instar install --app-ticket --key <publicKey>` must not write a ticket, or null when it may
 * (§A "Fresh ticket"): a different key already enrolled through the app (a non-revoked
 * `local-install` activation row for another key), or an active owner device that the app did not
 * create. Unreadable files refuse, so a damaged state never reads as "nobody enrolled".
 */
export function appTicketRefusal(stateDir: string, publicKey: string): string | null {
  let keyHash: string;
  try { keyHash = deviceKeyHashOf(publicKey); } catch { return 'That is not a device key.'; } // @silent-fallback-ok — reported to the caller as a refusal
  const ledgerFile = path.join(stateDir, DEVICE_KEY_LEDGER_FILE);
  let lines: string[] = [];
  try { lines = fs.readFileSync(ledgerFile, 'utf-8').split('\n').filter((l) => l.trim()); } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') return 'The agent\'s device record could not be read.';
  }
  const activations: Array<{ keyHash: string; deviceId: string; approvedVia?: string }> = [];
  const revoked = new Set<string>();
  for (const line of lines) {
    let r: { type?: string; keyHash?: string; deviceId?: string; approvedVia?: string };
    try { r = JSON.parse(line); } catch { continue; } // @silent-fallback-ok — a torn last line is skipped, as the ledger reader does
    if (r.type === 'activation' && r.keyHash && r.deviceId) activations.push({ keyHash: r.keyHash, deviceId: r.deviceId, approvedVia: r.approvedVia });
    if (r.type === 'revocation' && r.keyHash && r.deviceId) revoked.add(`${r.keyHash}|${r.deviceId}`);
  }
  if (activations.some((a) => a.approvedVia === 'local-install' && a.keyHash !== keyHash && !revoked.has(`${a.keyHash}|${a.deviceId}`))) {
    return 'Another app has already connected to this agent.';
  }
  const registryFile = path.join(stateDir, 'state', 'mobile-devices.json');
  let devices: Array<{ status?: string; role?: string; localBinding?: unknown }> = [];
  try {
    const raw = JSON.parse(fs.readFileSync(registryFile, 'utf-8')) as { devices?: unknown };
    if (!Array.isArray(raw.devices)) return 'The agent\'s device list could not be read.';
    devices = raw.devices as typeof devices;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') return 'The agent\'s device list could not be read.';
  }
  if (devices.some((d) => d.status === 'active' && (d.role === undefined || d.role === 'owner') && !d.localBinding)) {
    return 'This agent already has an owner device. Pair the app from that device.';
  }
  return null;
}
