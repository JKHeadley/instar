import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import type { AppRemovalCreationAdmission } from './AppRemovalCreationProof.js';
import { isAppConversationKey } from './appConversationText.js';
import { MACHINE_ID_PATTERN } from './IdentityStore.js';
import { SafeFsExecutor } from './SafeFsExecutor.js';

export interface CustodyRecord {
  version: 1;
  conversationKey: string;
  creationEventId: string;
  custodianMachineId: string;
  admission?: AppRemovalCreationAdmission;
}

type CustodyObservation = { kind: 'recorded'; record: CustodyRecord }
  | { kind: 'unrecorded' }
  | { kind: 'unavailable' };

export function isAppRemovalReadCustodyRecord(value: unknown, key: string): value is CustodyRecord {
  if (!value || typeof value !== 'object') return false;
  const row = value as Partial<CustodyRecord>;
  return row.version === 1 && row.conversationKey === key
    && typeof row.creationEventId === 'string' && /^[A-Za-z0-9._:-]{1,128}$/.test(row.creationEventId)
    && typeof row.custodianMachineId === 'string' && row.custodianMachineId !== 'local'
    && MACHINE_ID_PATTERN.test(row.custodianMachineId);
}

function validAdmission(value: unknown, machine: string): value is AppRemovalCreationAdmission {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const row = value as Partial<AppRemovalCreationAdmission>;
  const proof = row.proof;
  return Object.keys(row).length === 4 && row.authenticatedSender === machine
    && typeof row.admittedAtMs === 'number' && Number.isSafeInteger(row.admittedAtMs) && row.admittedAtMs > 0
    && typeof row.historyRevision === 'string' && /^[A-Za-z0-9._:-]{1,128}$/.test(row.historyRevision)
    && !!proof && Object.keys(proof).length === 5 && proof.version === 1 && proof.machineId === machine
    && Number.isSafeInteger(proof.claimedTimeMs) && proof.claimedTimeMs > 0
    && typeof proof.signerKeyHash === 'string' && /^[a-f0-9]{64}$/.test(proof.signerKeyHash)
    && typeof proof.sig === 'string' && /^[A-Za-z0-9+/_=-]{1,128}$/.test(proof.sig);
}

/** Local immutable retention evidence. Its absence is never authority to serve a legacy read. */
export class AppRemovalReadCustody {
  private readonly directory: string;

  constructor(stateDir: string) {
    this.directory = path.join(stateDir, 'state', 'app-removal-read-custody');
  }

  observe(conversationKey: string): CustodyObservation {
    if (!isAppConversationKey(conversationKey)) return { kind: 'unavailable' };
    try {
      const record = this.read(conversationKey);
      return record ? { kind: 'recorded', record } : { kind: 'unrecorded' };
    } catch {
      return { kind: 'unavailable' }; // @silent-fallback-ok — unreadable evidence never grants custody
    }
  }

  /** Persist previously established creation evidence. No write flag or lease can replace this binding. */
  record(
    conversationKey: string,
    creation: { eventId: string; machineId: string },
    admission?: AppRemovalCreationAdmission,
  ): boolean {
    const input: CustodyRecord = {
      version: 1, conversationKey, creationEventId: creation.eventId, custodianMachineId: creation.machineId,
      ...(admission ? { admission } : {}),
    };
    if (!isAppConversationKey(conversationKey) || !isAppRemovalReadCustodyRecord(input, conversationKey)
      || (admission && !validAdmission(admission, creation.machineId))) return false;
    const file = this.file(conversationKey);
    const pending = path.join(this.directory, `.${crypto.randomUUID()}.pending`);
    let createdPending = false;
    try {
      const parent = path.dirname(this.directory);
      const root = path.dirname(parent);
      this.requireDirectory(root);
      this.ensureDirectory(parent);
      this.ensureDirectory(this.directory);
      const fd = fs.openSync(pending, 'wx', 0o600);
      createdPending = true;
      try {
        fs.writeFileSync(fd, JSON.stringify(input));
        fs.fsyncSync(fd);
      } finally {
        fs.closeSync(fd);
      }
      try {
        fs.linkSync(pending, file);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      }
      const retained = this.read(conversationKey);
      if (retained?.creationEventId !== input.creationEventId || retained.custodianMachineId !== input.custodianMachineId
        || (admission && !isDeepStrictEqual(retained.admission, admission))) return false;
      this.discardPending(pending);
      createdPending = false;
      for (const directory of [this.directory, parent, root]) {
        const handle = fs.openSync(directory, fs.constants.O_RDONLY);
        try { fs.fsyncSync(handle); } finally { fs.closeSync(handle); }
      }
      return true;
    } catch {
      return false; // @silent-fallback-ok — a failed retention write cannot enable removal
    } finally {
      if (createdPending) {
        try { this.discardPending(pending); } catch { /* @silent-fallback-ok — a failed record already returned false */ }
      }
    }
  }

  private discardPending(file: string): void {
    SafeFsExecutor.safeUnlinkSync(file, { operation: 'AppRemovalReadCustody:discard-pending' });
  }

  private file(key: string): string {
    return path.join(this.directory, `${key}.json`);
  }

  private ensureDirectory(directory: string): void {
    try {
      fs.mkdirSync(directory, { mode: 0o700 });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    }
    this.requireDirectory(directory);
  }

  private requireDirectory(directory: string): void {
    if (!fs.lstatSync(directory).isDirectory()) throw new Error('custody directory unavailable');
  }

  private read(key: string): CustodyRecord | null {
    const file = this.file(key);
    let handle: number;
    try {
      const parent = path.dirname(this.directory);
      this.requireDirectory(path.dirname(parent));
      this.requireDirectory(parent);
      this.requireDirectory(this.directory);
      handle = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw error;
    }
    try {
      const stat = fs.fstatSync(handle);
      if (!stat.isFile() || stat.size > 1024) throw new Error('custody record unavailable');
      const bytes = Buffer.alloc(stat.size + 1);
      const count = fs.readSync(handle, bytes, 0, bytes.length, 0);
      const current = fs.lstatSync(file);
      if (count !== stat.size || current.ino !== stat.ino || current.dev !== stat.dev
        || current.size !== stat.size || current.ctimeMs !== stat.ctimeMs) throw new Error('custody record changed');
      const record: unknown = JSON.parse(bytes.toString('utf8', 0, count));
      if (!isAppRemovalReadCustodyRecord(record, key)
        || (Object.hasOwn(record, 'admission') && !validAdmission(record.admission, record.custodianMachineId)))
        throw new Error('custody record invalid');
      return record;
    } finally {
      fs.closeSync(handle);
    }
  }
}
