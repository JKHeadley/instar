/**
 * The device-key ledger (docs/specs/mobile-native-conversations.md §4.6, §4.8).
 *
 * `<stateDir>/mobile-device-key-ledger.jsonl`: append-only, never pruned. Rows are keyed by the
 * full `keyHash` (sha256 of the phone's public key):
 *   activation  {type:'activation', keyHash, publicKey, deviceId, host, approvedVia, activatedAt, machineId, signerKeyHash, sig}
 *   revocation  {type:'revocation', keyHash, deviceId, revokedAt, machineId, signerKeyHash, sig}
 * Each row is signed by the writing machine's identity key and names that key (`signerKeyHash`).
 * The ledger GRANTS NOTHING: device authentication stays machine-bound (mobile-device-keys §4).
 * It exists so a stored app message can be re-checked later, on any machine, against the keys
 * that were active when it was accepted.
 *
 * WRITERS (no route accepts rows): the device registry's activation and revocation paths
 * (ledger row FIRST, registry second), the boot reconciliation below, and replication — which
 * accepts a peer's row only when its signature verifies under the pinned identity key of the
 * machine it names.
 *
 * RECONCILIATION (every boot) repairs each event independently: a registry device (active or
 * revoked) with no activation row gets one (its recorded approval method, `telegram-dm` for
 * devices approved before this change); a revoked registry device with no revocation row gets
 * one carrying the registry's `revokedAt`; a revocation row whose device is still active in the
 * registry completes the revocation there (the ledger row is the recorded intent).
 */
import fs from 'node:fs';
import path from 'node:path';
import {
  deviceKeyHashOf, ledgerRowPayload, ledgerViewKey, readJsonlLines, verifyMachineSignature,
  type LedgerKey, type LedgerView, type MachineKeyLookup, type MachineSigner,
} from './AppRecordSignatures.js';
import type { DeviceRecord, DeviceRegistry } from './MobileDeviceKeys.js';

export const DEVICE_KEY_LEDGER_FILE = 'mobile-device-key-ledger.jsonl';

export interface ActivationRow {
  type: 'activation'; keyHash: string; publicKey: string; deviceId: string; host: string;
  approvedVia: string; activatedAt: string; machineId: string; signerKeyHash: string; sig: string;
}
export interface RevocationRow {
  type: 'revocation'; keyHash: string; deviceId: string; revokedAt: string; machineId: string; signerKeyHash: string; sig: string;
}
export type LedgerRow = ActivationRow | RevocationRow;

const str = (v: unknown, max: number): string | null => (typeof v === 'string' && v.length > 0 && v.length <= max ? v : null);
const isoOk = (v: string | null): v is string => !!v && Number.isFinite(Date.parse(v));

/** Validate a row's SHAPE (not its signature): exact fields, and keyHash = sha256(publicKey). */
export function validateLedgerRow(raw: unknown): LedgerRow | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  const keyHash = str(r.keyHash, 64);
  const deviceId = str(r.deviceId, 128);
  const machineId = str(r.machineId, 128);
  const signerKeyHash = str(r.signerKeyHash, 64);
  const sig = str(r.sig, 512);
  if (!keyHash || !/^[0-9a-f]{64}$/.test(keyHash) || !deviceId || !machineId || !signerKeyHash || !sig) return null;
  if (r.type === 'activation') {
    const publicKey = str(r.publicKey, 256);
    const host = str(r.host, 256);
    const approvedVia = str(r.approvedVia, 32);
    const activatedAt = str(r.activatedAt, 64);
    if (!publicKey || !host || !approvedVia || !isoOk(activatedAt)) return null;
    try { if (deviceKeyHashOf(publicKey) !== keyHash) return null; } catch { return null; } // @silent-fallback-ok — an undecodable key is an invalid row
    return { type: 'activation', keyHash, publicKey, deviceId, host, approvedVia, activatedAt, machineId, signerKeyHash, sig };
  }
  if (r.type === 'revocation') {
    const revokedAt = str(r.revokedAt, 64);
    if (!isoOk(revokedAt)) return null;
    return { type: 'revocation', keyHash, deviceId, revokedAt, machineId, signerKeyHash, sig };
  }
  return null;
}

/**
 * The replication record key of a row: one record per (type, keyHash, deviceId, writing machine).
 * The device id is part of it, so a key re-paired under a new device id is a separate record and
 * never overwrites (or is dropped as a duplicate of) the earlier pairing's row.
 */
export function ledgerRowId(row: Pick<LedgerRow, 'type' | 'keyHash' | 'deviceId' | 'machineId'>): string {
  return `${row.type}:${row.keyHash}:${row.deviceId}:${row.machineId}`;
}

/**
 * Merge rows into one view per pairing (keyHash + deviceId): the earliest activation, the
 * earliest revocation. A key paired twice (another machine, or re-paired after its revoked
 * record was pruned) keeps a separate lifetime per device id.
 */
export function mergeLedgerRows(rows: ReadonlyArray<LedgerRow>): Map<string, LedgerKey> {
  const view = new Map<string, LedgerKey>();
  const revocations = new Map<string, string>();
  for (const r of rows) {
    const k = ledgerViewKey(r.keyHash, r.deviceId);
    if (r.type === 'activation') {
      const cur = view.get(k);
      if (!cur || r.activatedAt < cur.activatedAt) {
        view.set(k, { keyHash: r.keyHash, publicKey: r.publicKey, deviceId: r.deviceId, host: r.host, approvedVia: r.approvedVia, activatedAt: r.activatedAt, revokedAt: null });
      }
    } else {
      const cur = revocations.get(k);
      if (!cur || r.revokedAt < cur) revocations.set(k, r.revokedAt);
    }
  }
  for (const [k, at] of revocations) { const v = view.get(k); if (v) v.revokedAt = at; }
  return view;
}

export interface MobileDeviceKeyLedgerOptions {
  stateDir: string;
  signer: MachineSigner;
  keyLookup: MachineKeyLookup;
  /** Called after a LOCAL row committed (the replication emit hook). Never for a replicated row. */
  onLocalAppend?: (row: LedgerRow) => void;
  reportDegradation?: (what: string, detail: string) => void;
  now?: () => number;
}

export class MobileDeviceKeyLedger {
  readonly file: string;
  private cache: { size: number; mtimeMs: number; rows: LedgerRow[] } | null = null;
  private onLocalAppend: ((row: LedgerRow) => void) | undefined;

  constructor(private readonly opts: MobileDeviceKeyLedgerOptions) {
    this.file = path.join(opts.stateDir, DEVICE_KEY_LEDGER_FILE);
    this.onLocalAppend = opts.onLocalAppend;
  }

  setReplicationHook(hook: ((row: LedgerRow) => void) | undefined): void { this.onLocalAppend = hook; }

  /** Every valid row on disk (throws when the file cannot be read). Unparseable lines are skipped. */
  rows(): LedgerRow[] {
    let st: fs.Stats | null = null;
    try { st = fs.statSync(this.file); } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw err;
    }
    if (this.cache && this.cache.size === st.size && this.cache.mtimeMs === st.mtimeMs) return this.cache.rows;
    const rows: LedgerRow[] = [];
    for (const line of readJsonlLines(this.file)) {
      let parsed: unknown;
      try { parsed = JSON.parse(line); } catch { continue; } // @silent-fallback-ok — a torn final line was never a committed row
      const row = validateLedgerRow(parsed);
      if (row) rows.push(row);
    }
    this.cache = { size: st.size, mtimeMs: st.mtimeMs, rows };
    return rows;
  }

  /** The merged view for verification, or null when the ledger cannot be read (verdict `unknown`). */
  view(): LedgerView {
    try { return mergeLedgerRows(this.rows()); } catch (err) {
      // @silent-fallback-ok — not silent: reported through the reportDegradation callback (DegradationReporter in production); the caller reads null as "couldn't check"
      this.opts.reportDegradation?.('MobileDeviceKeyLedger', `the device-key ledger could not be read (${err instanceof Error ? err.message : String(err)}); signed messages read "couldn't check"`);
      return null;
    }
  }

  private has(row: Pick<LedgerRow, 'type' | 'keyHash' | 'deviceId' | 'machineId'>): boolean {
    const id = ledgerRowId(row);
    return this.rows().some((r) => ledgerRowId(r) === id);
  }

  private hasType(type: LedgerRow['type'], keyHash: string, deviceId: string): boolean {
    return this.rows().some((r) => r.type === type && r.keyHash === keyHash && r.deviceId === deviceId);
  }

  /** Durable append: the line is written and the file fsynced before this returns. */
  private appendLine(row: LedgerRow): void {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const created = !fs.existsSync(this.file);
    const fd = fs.openSync(this.file, 'a', 0o600); /* state-registry: mobile-device-key-ledger */
    try {
      // A torn final line (a crash mid-write) must not fuse with this row: start on a fresh line.
      const size = fs.fstatSync(fd).size;
      let prefix = '';
      if (size > 0) {
        const last = Buffer.alloc(1);
        const rfd = fs.openSync(this.file, 'r');
        try { fs.readSync(rfd, last, 0, 1, size - 1); } finally { fs.closeSync(rfd); }
        if (last[0] !== 0x0a) prefix = '\n';
      }
      fs.writeSync(fd, `${prefix}${JSON.stringify(row)}\n`);
      fs.fsyncSync(fd);
    } finally { fs.closeSync(fd); }
    if (created) {
      try { const dfd = fs.openSync(path.dirname(this.file), 'r'); try { fs.fsyncSync(dfd); } finally { fs.closeSync(dfd); } } catch { /* @silent-fallback-ok — some filesystems refuse a directory fsync; the file itself was fsynced */ }
    }
    this.cache = null;
  }

  private signRow<T extends Omit<LedgerRow, 'machineId' | 'signerKeyHash' | 'sig'>>(unsigned: T): LedgerRow {
    const machineId = this.opts.signer.machineId();
    // The signed bytes cover machineId and signerKeyHash too, so sign over the completed row.
    const signerKeyHash = this.opts.signer.signerKeyHash();
    const body = { ...unsigned, machineId, signerKeyHash } as Record<string, unknown>;
    const s = this.opts.signer.sign(ledgerRowPayload(body));
    if (s.signerKeyHash !== signerKeyHash || s.machineId !== machineId) throw new Error('the machine signing key changed while a ledger row was being signed; try again');
    return { ...body, sig: s.sig } as unknown as LedgerRow;
  }

  private appendLocal(row: LedgerRow): LedgerRow {
    this.appendLine(row);
    try { this.onLocalAppend?.(row); } catch { /* @silent-fallback-ok — replication emit is best-effort; the local commit landed and boot re-reads the file */ }
    return row;
  }

  /** The activation row for a device about to become active (written BEFORE the registry). */
  recordActivation(device: Pick<DeviceRecord, 'id' | 'publicKey' | 'host'>, approvedVia: string, activatedAt: string): LedgerRow | null {
    if (!device.publicKey || !device.host) return null;
    const keyHash = deviceKeyHashOf(device.publicKey);
    if (this.hasType('activation', keyHash, device.id)) return null;
    return this.appendLocal(this.signRow({ type: 'activation', keyHash, publicKey: device.publicKey, deviceId: device.id, host: device.host, approvedVia, activatedAt } as Omit<ActivationRow, 'machineId' | 'signerKeyHash' | 'sig'>));
  }

  /** The revocation row (written BEFORE the registry). */
  recordRevocation(device: Pick<DeviceRecord, 'id' | 'publicKey'>, revokedAt: string): LedgerRow | null {
    if (!device.publicKey) return null;
    const keyHash = deviceKeyHashOf(device.publicKey);
    if (this.hasType('revocation', keyHash, device.id)) return null;
    return this.appendLocal(this.signRow({ type: 'revocation', keyHash, deviceId: device.id, revokedAt } as Omit<RevocationRow, 'machineId' | 'signerKeyHash' | 'sig'>));
  }

  /**
   * A row received by replication: accepted only when its shape is valid AND its signature
   * verifies under the pinned identity key of the machine it names. Returns what happened.
   */
  ingestReplicated(raw: unknown): 'accepted' | 'duplicate' | 'invalid' | 'bad-signature' | 'unverifiable' {
    const row = validateLedgerRow(raw);
    if (!row) return 'invalid';
    const atMs = Date.parse(row.type === 'activation' ? row.activatedAt : row.revokedAt);
    const v = verifyMachineSignature(this.opts.keyLookup, row, ledgerRowPayload(row as unknown as Record<string, unknown>), atMs);
    if (v === 'bad') return 'bad-signature';
    if (v === 'unknown') return 'unverifiable';
    if (this.has(row)) return 'duplicate';
    this.appendLine(row);
    return 'accepted';
  }

  /**
   * Boot reconciliation between the ledger and the device registry (both directions, each event
   * independently). Idempotent. Returns what it repaired.
   */
  reconcile(registry: DeviceRegistry): { backfilledActivations: number; backfilledRevocations: number; completedRevocations: number } {
    const out = { backfilledActivations: 0, backfilledRevocations: 0, completedRevocations: 0 };
    const devices = registry.list();
    for (const d of devices) {
      if (!d.publicKey || !d.host || (d.status !== 'active' && d.status !== 'revoked')) continue;
      const keyHash = deviceKeyHashOf(d.publicKey);
      if (!this.hasType('activation', keyHash, d.id)) {
        // A device revoked before it was ever approved has no activation to record.
        if (d.status === 'active' || d.approvedAt) {
          this.recordActivation(d, d.approvedVia ?? 'telegram-dm', d.approvedAt ?? d.pairedAt);
          out.backfilledActivations++;
        }
      }
      if (d.status === 'revoked' && !this.hasType('revocation', keyHash, d.id)) {
        this.recordRevocation(d, d.revokedAt ?? new Date((this.opts.now ?? Date.now)()).toISOString());
        out.backfilledRevocations++;
      }
    }
    // A revocation the registry missed (crash between the two writes, or a peer's row for a key held here).
    // Matched on key AND device id, so a key re-paired under a new device id is never revoked by its old pairing's row.
    const revoked = new Map<string, string>();
    for (const r of this.rows()) {
      if (r.type !== 'revocation') continue;
      const k = ledgerViewKey(r.keyHash, r.deviceId);
      if (!revoked.has(k) || r.revokedAt < revoked.get(k)!) revoked.set(k, r.revokedAt);
    }
    for (const d of devices) {
      if (!d.publicKey || d.status === 'revoked') continue;
      const at = revoked.get(ledgerViewKey(deviceKeyHashOf(d.publicKey), d.id));
      if (!at) continue;
      if (registry.revoke(d.id, at)) out.completedRevocations++;
    }
    return out;
  }
}
