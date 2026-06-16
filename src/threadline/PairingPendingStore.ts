/**
 * PairingPendingStore — Machine-local 0600 store for pending-verification SAS words.
 *
 * Part of Secure A2A Verified Pairing (docs/specs/secure-a2a-verified-pairing.md).
 *
 * The SAS words + sasFingerprint for a pending verification are sensitive-but-
 * machine-local (FD4): they are bound to the machine-local handshake's ephemeral
 * shared secret and are NEVER replicated to peer machines. They live in a 0600
 * file SEPARATE from the (replicated) trust profile so the operator can re-read
 * the SAS after a restart. The record is DISCARDED the moment the pairing
 * transitions to `mutual-verified` or `verification-failed`.
 *
 * The SAS WORDS only ever exist here (and on the dashboard pairing panel); the
 * trust profile stores only the `sasFingerprint` (FD3), never the words.
 *
 * Storage: {stateDir}/threadline/pairing-pending.json (mode 0600).
 */

import fs from 'node:fs';
import path from 'node:path';
import { SafeFsExecutor } from '../core/SafeFsExecutor.js';

// ── Types ────────────────────────────────────────────────────────────

export interface PendingPairingRecord {
  /** Identifies THIS handshake instance (epoch binding, FD4). */
  pairingId: string;
  /** The peer's cryptographic fingerprint. */
  peerFp: string;
  /** The peer's Ed25519 identity public key (hex). */
  peerIdentityPub: string;
  /** The 6 SAS words (FD1/FD2) — sensitive, machine-local, never logged/replicated. */
  sasWords: string[];
  /** SAS fingerprint (FD3) — the value bound into the receipt + logged. */
  sasFingerprint: string;
  /** When this pending record was created (ISO-8601). */
  createdAt: string;
}

interface PendingFile {
  pending: Record<string, PendingPairingRecord>;
  updatedAt: string;
}

// ── Helpers ──────────────────────────────────────────────────────────

/** Atomic write with a restrictive 0600 mode on the final file (matches the secret posture). */
function atomicWrite0600(filePath: string, data: string): void {
  const tmpPath = `${filePath}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
  try {
    fs.writeFileSync(tmpPath, data, { mode: 0o600 });
    fs.renameSync(tmpPath, filePath);
    // renameSync preserves the tmp file's mode; assert 0600 on the final path too.
    try { fs.chmodSync(filePath, 0o600); } catch { /* best-effort */ }
  } catch (err) {
    try { SafeFsExecutor.safeUnlinkSync(tmpPath, { operation: 'src/threadline/PairingPendingStore.ts:atomicWrite0600' }); } catch { /* ignore */ }
    throw err;
  }
}

function safeJsonParse<T>(filePath: string, fallback: T): T {
  try {
    if (!fs.existsSync(filePath)) return fallback;
    return JSON.parse(fs.readFileSync(filePath, 'utf-8'));
  } catch {
    return fallback;
  }
}

// ── Implementation ───────────────────────────────────────────────────

export class PairingPendingStore {
  private readonly threadlineDir: string;
  private readonly storePath: string;
  private pending: Record<string, PendingPairingRecord>;

  constructor(options: { stateDir: string }) {
    this.threadlineDir = path.join(options.stateDir, 'threadline');
    fs.mkdirSync(this.threadlineDir, { recursive: true });
    this.storePath = path.join(this.threadlineDir, 'pairing-pending.json');
    this.pending = this.load();
  }

  /**
   * Record (or replace) the pending SAS for a peer. A new handshake (new
   * pairingId) simply overwrites the prior pending record for that peer.
   */
  put(record: PendingPairingRecord): void {
    this.pending[record.peerFp] = { ...record };
    this.save();
  }

  /** Read the pending record for a peer (incl. the SAS words). Null if none. */
  get(peerFp: string): PendingPairingRecord | null {
    return this.pending[peerFp] ?? null;
  }

  /** Discard the pending record for a peer (on transition to verified/failed). */
  discard(peerFp: string): void {
    if (this.pending[peerFp]) {
      delete this.pending[peerFp];
      this.save();
    }
  }

  /** List all peer fingerprints with a pending record. */
  listPeers(): string[] {
    return Object.keys(this.pending);
  }

  /** Force reload from disk. */
  reload(): void {
    this.pending = this.load();
  }

  // ── Private ────────────────────────────────────────────────────

  private load(): Record<string, PendingPairingRecord> {
    const data = safeJsonParse<PendingFile>(this.storePath, { pending: {}, updatedAt: '' });
    return data.pending ?? {};
  }

  private save(): void {
    try {
      const data: PendingFile = { pending: this.pending, updatedAt: new Date().toISOString() };
      atomicWrite0600(this.storePath, JSON.stringify(data, null, 2));
    } catch {
      // A save failure must never break pairing evaluation; the in-memory copy
      // remains authoritative for this process.
    }
  }
}
