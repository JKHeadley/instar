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

export interface LocalOwnerTicket {
  ticket: string;
  expiresAt: string;
  failures: number;
  /**
   * Owner devices this ticket may replace: earlier keys this Mac's own app enrolled, whose key the app
   * no longer holds (`instar install --app-ticket --replace-app-key`). The route revokes exactly these,
   * and only when each is bound to this machine, then enrolls the new key.
   */
  replaces?: string[];
}

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
export function writeLocalOwnerTicket(stateDir: string, now: number = Date.now(), replaces: string[] = []): string {
  const ticket = crypto.randomBytes(32).toString('base64url');
  writeAtomic0600(localOwnerTicketPath(stateDir), {
    ticket, expiresAt: new Date(now + LOCAL_OWNER_TICKET_TTL_MS).toISOString(), failures: 0,
    ...(replaces.length ? { replaces } : {}),
  } satisfies LocalOwnerTicket);
  return ticket;
}

export function readLocalOwnerTicket(stateDir: string): LocalOwnerTicket | null {
  let raw: string;
  try { raw = fs.readFileSync(localOwnerTicketPath(stateDir), 'utf-8'); } catch { return null; } // @silent-fallback-ok — no readable ticket means no route (404), the designed answer
  try {
    const t = JSON.parse(raw) as Partial<LocalOwnerTicket>;
    if (typeof t.ticket !== 'string' || typeof t.expiresAt !== 'string' || !Number.isFinite(Date.parse(t.expiresAt))) return null;
    const replaces = Array.isArray(t.replaces) ? t.replaces.filter((x): x is string => typeof x === 'string') : [];
    return { ticket: t.ticket, expiresAt: t.expiresAt, failures: typeof t.failures === 'number' ? t.failures : 0, ...(replaces.length ? { replaces } : {}) };
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
  const plan = appTicketPlan(stateDir, publicKey, { replace: false, machineId: null });
  return 'refusal' in plan ? plan.refusal : null;
}

export const REPLACE_HINT = "If that was this Mac's Instar app and it no longer has its key, run this again with --replace-app-key.";

/**
 * This machine's id, from the agent's own machine identity file. The install command and the local-owner
 * route both use it, so a ticket planned here and the server that redeems it agree on the machine even
 * when multi-machine coordination is off (a single-Mac agent, the Mac app's normal case).
 */
export function ownMachineId(stateDir: string): string | null {
  try {
    const id = JSON.parse(fs.readFileSync(path.join(stateDir, 'machine', 'identity.json'), 'utf-8')) as { machineId?: unknown };
    return typeof id.machineId === 'string' && id.machineId ? id.machineId : null;
  } catch { return null; } // @silent-fallback-ok — no identity means a replace is refused in plain words
}

/**
 * appTicketRefusal, plus the replace path: with `replace`, earlier keys this Mac's own app enrolled
 * (a `local-install` owner bound to `machineId`) may be replaced. Anything else still refuses: a key
 * enrolled from another computer, an owner the app did not create, or an unknown machine id.
 * Only the agent's own user can run this: it reads and writes the agent's 0600 files.
 */
export function appTicketPlan(stateDir: string, publicKey: string, opts: { replace: boolean; machineId: string | null }): { refusal: string } | { replaces: string[] } {
  let keyHash: string;
  try { keyHash = deviceKeyHashOf(publicKey); } catch { return { refusal: 'That is not a device key.' }; } // @silent-fallback-ok — reported to the caller as a refusal
  const ledgerFile = path.join(stateDir, DEVICE_KEY_LEDGER_FILE);
  let lines: string[] = [];
  // @silent-fallback-ok — no ledger file yet means no device has ever been enrolled; any other read error refuses below
  try { lines = fs.readFileSync(ledgerFile, 'utf-8').split('\n').filter((l) => l.trim()); } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') return { refusal: 'The agent\'s device record could not be read.' };
  }
  const activations: Array<{ keyHash: string; deviceId: string; approvedVia?: string; machineId?: string }> = [];
  const revoked = new Set<string>();
  for (const line of lines) {
    let r: { type?: string; keyHash?: string; deviceId?: string; approvedVia?: string; machineId?: string };
    try { r = JSON.parse(line); } catch { continue; } // @silent-fallback-ok — a torn last line is skipped, as the ledger reader does
    if (r.type === 'activation' && r.keyHash && r.deviceId) activations.push({ keyHash: r.keyHash, deviceId: r.deviceId, approvedVia: r.approvedVia, machineId: r.machineId });
    if (r.type === 'revocation' && r.keyHash && r.deviceId) revoked.add(`${r.keyHash}|${r.deviceId}`);
  }
  const others = activations.filter((a) => a.approvedVia === 'local-install' && a.keyHash !== keyHash && !revoked.has(`${a.keyHash}|${a.deviceId}`));
  const registryFile = path.join(stateDir, 'state', 'mobile-devices.json');
  let devices: Array<{ id?: string; status?: string; role?: string; localBinding?: { machineId?: unknown } }> = [];
  try {
    const raw = JSON.parse(fs.readFileSync(registryFile, 'utf-8')) as { devices?: unknown };
    if (!Array.isArray(raw.devices)) return { refusal: 'The agent\'s device list could not be read.' };
    devices = raw.devices as typeof devices;
  } catch (err) { // @silent-fallback-ok — no device list yet is an empty list; any other read error refuses
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') return { refusal: 'The agent\'s device list could not be read.' };
  }
  if (devices.some((d) => d.status === 'active' && (d.role === undefined || d.role === 'owner') && !d.localBinding)) {
    return { refusal: 'This agent already has an owner device. Pair the app from that device.' };
  }
  if (!others.length) return { replaces: [] };
  if (!opts.replace) return { refusal: `Another app has already connected to this agent. ${REPLACE_HINT}` };
  if (!opts.machineId) return { refusal: "This computer's identity could not be read, so the earlier app connection can't be replaced." };
  const replaces: string[] = [];
  for (const a of others) {
    const d = devices.find((x) => x.id === a.deviceId);
    // A device bound to another machine, or an activation with no record that another machine signed
    // (an interrupted enrollment elsewhere), is not this Mac's to replace.
    if (d && d.localBinding && (d.localBinding.machineId === null || d.localBinding.machineId === undefined)) {
      return { refusal: 'The earlier app connection was made before this agent knew which computer it is on, so it cannot be replaced here. Remove that device from the agent first.' };
    }
    if (d ? (!d.localBinding || d.localBinding.machineId !== opts.machineId) : a.machineId !== opts.machineId) {
      return { refusal: 'Another computer\'s Instar app connected to this agent. Remove that device from the agent first.' };
    }
    if (!replaces.includes(a.deviceId)) replaces.push(a.deviceId);
  }
  return { replaces };
}
