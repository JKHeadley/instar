/**
 * The `owned-repo` replicated record kind (docs/specs/no-data-loss-on-machine-death.md §1.2, §1.8,
 * "New record kinds"). One record per (machine, object store), latest per key.
 *
 * Disclosure-minimized: only what a survivor needs to name a dead machine's repositories and
 * say whether their work existed anywhere else. Class, a home-relative display path, the
 * remotes' hosts and accounts (never a URL), single-copy yes/no, power-of-two buckets of the
 * single-copy and uncommitted counts, and whether the grace window has passed. Exact counts,
 * bytes, branch names and every timestamp stay local and are served on read (§0).
 *
 * Replicas are READ evidence only: a peer's record is shown, never acted on.
 */
import crypto from 'node:crypto';
import type { StoreFieldSchema, StoreValidateContext, ReplicatedOp } from './ReplicatedRecordEnvelope.js';
import type { HlcTimestamp } from './HybridLogicalClock.js';

export const OWNED_REPO_RECORD_KIND = 'owned-repo';
export const OWNED_REPO_STORE_KEY = 'ownedRepo';

export interface OwnedRepoReplica {
  repoId: string;
  machineId: string;
  /** `~/...` relative to the user's home, or an absolute path outside it (a declared root). */
  displayPath: string;
  class: 'owned' | 'candidate';
  remotes: Array<{ name: string; host: string; ownerAccount: string | null; offMachine: boolean }>;
  singleCopy: boolean;
  /** Power-of-two buckets (0, 1, 2, 4, 8, ...), never exact counts. */
  singleCopyCommitsBucket: number;
  singleCopyBranchesBucket: number;
  uncommitted: boolean;
  /** True once single-copy work has outlived the grace window (§1.4): a state change, so it replicates. */
  pastGrace: boolean;
  state: 'ok' | 'unknown';
  /** The repository is gone from the machine (kept as a tombstone). */
  gone: boolean;
}

export function bucket(n: number): number {
  if (!Number.isFinite(n) || n <= 0) return 0;
  return 2 ** Math.floor(Math.log2(n));
}

export function deriveOwnedRepoRecordKey(machineId: string, repoId: string): string {
  return crypto.createHash('sha256').update(`owned-repo\u0000${machineId}\u0000${repoId}`).digest('hex');
}

const HEX = /^[0-9a-f]{64}$/;
const SAFE_ID = /^[A-Za-z0-9_.:-]{1,128}$/u;
const str = (v: unknown, max: number): string | null => (typeof v === 'string' && v.length <= max && !/[\u0000-\u001f\u007f]/.test(v) ? v : null);
const nonNegBucket = (v: unknown): number | null => (typeof v === 'number' && Number.isInteger(v) && v >= 0 && v <= 2 ** 30 && (v === 0 || (v & (v - 1)) === 0) ? v : null);

/** Validate a replica (pure). Returns null to reject the whole record. */
export function validateOwnedRepoReplica(raw: unknown): OwnedRepoReplica | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const repoId = typeof r.repoId === 'string' && HEX.test(r.repoId) ? r.repoId : null;
  const machineId = typeof r.machineId === 'string' && SAFE_ID.test(r.machineId) ? r.machineId : null;
  const displayPath = str(r.displayPath, 400);
  if (!repoId || !machineId || !displayPath || displayPath.split('/').includes('..')) return null;
  if (!displayPath.startsWith('~/') && !displayPath.startsWith('/')) return null;
  if (r.class !== 'owned' && r.class !== 'candidate') return null;
  if (!Array.isArray(r.remotes) || r.remotes.length > 20) return null;
  const remotes: OwnedRepoReplica['remotes'] = [];
  for (const x of r.remotes) {
    if (!x || typeof x !== 'object') return null;
    const o = x as Record<string, unknown>;
    const name = str(o.name, 100); const host = str(o.host, 200);
    const ownerAccount = o.ownerAccount === null ? null : str(o.ownerAccount, 100);
    if (!name || !host || (o.ownerAccount !== null && !ownerAccount) || typeof o.offMachine !== 'boolean') return null;
    if (/[/@\s]/.test(host) || /[/@\s:]/.test(name) || (ownerAccount && /[/@\s:]/.test(ownerAccount))) return null; // never a URL or credential
    remotes.push({ name, host, ownerAccount, offMachine: o.offMachine });
  }
  const c = nonNegBucket(r.singleCopyCommitsBucket); const b = nonNegBucket(r.singleCopyBranchesBucket);
  if (c === null || b === null) return null;
  for (const k of ['singleCopy', 'uncommitted', 'pastGrace', 'gone']) if (typeof r[k] !== 'boolean') return null;
  if (r.state !== 'ok' && r.state !== 'unknown') return null;
  return {
    repoId, machineId, displayPath, class: r.class, remotes,
    singleCopy: r.singleCopy as boolean, singleCopyCommitsBucket: c, singleCopyBranchesBucket: b,
    uncommitted: r.uncommitted as boolean, pastGrace: r.pastGrace as boolean, state: r.state, gone: r.gone as boolean,
  };
}

const KNOWN = ['repo'] as const;

export const ownedRepoStoreSchema: StoreFieldSchema = {
  knownFields: KNOWN as unknown as ReadonlyArray<string>,
  validate(raw: Readonly<Record<string, unknown>>, ctx: StoreValidateContext): Record<string, unknown> | null {
    if (raw.op === 'delete') return null; // a removed repository is a `gone` tombstone, never a delete
    const repo = validateOwnedRepoReplica(raw.repo);
    if (!repo) return null;
    // A machine may only describe its own repositories (single-origin, §6.1 anti-forgery).
    if (typeof raw.origin === 'string' && raw.origin !== repo.machineId) return null;
    if (raw.recordKey !== deriveOwnedRepoRecordKey(repo.machineId, repo.repoId)) return null;
    void ctx;
    return { repo };
  },
};

export function buildOwnedRepoRecordData(repo: OwnedRepoReplica) {
  return (hlc: HlcTimestamp, origin: string, observed?: HlcTimestamp): Record<string, unknown> | null => ({
    repo,
    recordKey: deriveOwnedRepoRecordKey(repo.machineId, repo.repoId),
    hlc, op: 'put' as ReplicatedOp, origin,
    ...(observed !== undefined ? { observed } : {}),
  });
}

export const OWNED_REPO_KIND_REGISTRATION = {
  kind: OWNED_REPO_RECORD_KIND,
  store: OWNED_REPO_STORE_KEY,
  schema: ownedRepoStoreSchema,
} as const;
