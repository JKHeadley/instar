/**
 * CommitmentsSync — P1.5a of multi-machine coherence: the serve / receive /
 * merge engine behind the `commitments-sync` mesh verb.
 *
 * Spec: docs/specs/COMMITMENTS-COHERENCE-SPEC.md §3.2 (read replication) +
 * §3.3 (the merged read). Transport-agnostic, seam-injected (the server
 * registers the serve side as the verb handler; the receive side rides the
 * PeerPresencePuller cadence like journal-sync).
 *
 * Load-bearing rules (§3.2):
 *  - Pages are seq-windowed DELTAS: records with lastMutatedSeq > sinceSeq,
 *    ordered (lastMutatedSeq asc, id tiebreak), EXCLUSIVE cursor, capped at
 *    `syncPageBytes` per page with at least one record per page — a large
 *    store replicates fully over multiple requests, never a flat blob whose
 *    tail stays permanently unreplicated.
 *  - Incarnation fencing: a request carrying a stale incarnation is answered
 *    `incarnationChanged` — the receiver discards the replica wholesale and
 *    re-pulls from 0 (a restored backup must never strand replication).
 *  - First-hop with teeth: the replica's owner identity derives from the
 *    AUTHENTICATED envelope sender; any served row whose originMachineId
 *    names a DIFFERENT machine is rejected + counted (forgedRows) — a peer
 *    cannot inject rows attributed to (or routable to) third machines.
 *  - Disclosure honesty: free-text fields are credential-shape-scanned at
 *    serve time; a flagged FIELD ships REDACTED (the record still
 *    replicates — closeability never depends on the scan).
 *  - Merge: composite key (originMachineId, id) — ids are per-machine
 *    sequential counters and collide across machines by construction.
 */

import fs from 'node:fs';
import path from 'node:path';

import { redactForLiveTail } from './liveTailRedaction.js';
import type { Commitment } from '../monitoring/CommitmentTracker.js';

export const DEFAULT_SYNC_PAGE_BYTES = 256 * 1024;
export const DEFAULT_REPLICA_STALE_WARN_MS = 10 * 60 * 1000;

/** The free-text fields scanned + redacted per §3.2. */
const TEXT_FIELDS = ['userRequest', 'agentResponse', 'resolution', 'escalationDetail'] as const;

// ── Wire shapes ─────────────────────────────────────────────────────

export interface CommitmentsSyncRequest {
  sinceSeq: number;
  incarnation?: string;
}

export interface CommitmentsSyncPage {
  incarnation: string;
  replicationSeq: number;
  /** Served records (redacted + origin-stamped). Empty when caught up. */
  records: ReplicatedCommitment[];
  /** EXCLUSIVE cursor for the next request. */
  nextSinceSeq: number;
  /** True when no records remain past nextSinceSeq. */
  done: boolean;
  /** Set when the requester's incarnation is stale — re-pull from 0. */
  incarnationChanged?: boolean;
}

/** A commitment as it travels: always origin-stamped, possibly redacted. */
export interface ReplicatedCommitment extends Commitment {
  originMachineId: string;
  textRedacted?: boolean;
}

// ── Serve side (§3.2) ───────────────────────────────────────────────

export interface ServePageDeps {
  ownMachineId: string;
  /** The OWN store's records (CommitmentTracker.getAll()) — never replicas. */
  records: Commitment[];
  advert: { incarnation: string; replicationSeq: number };
  syncPageBytes?: number;
}

export function buildCommitmentsSyncPage(
  req: CommitmentsSyncRequest,
  deps: ServePageDeps,
): CommitmentsSyncPage {
  const { incarnation, replicationSeq } = deps.advert;
  // Incarnation fence: a stale requester re-pulls from 0 (§3.2).
  if (req.incarnation !== undefined && req.incarnation !== incarnation) {
    return { incarnation, replicationSeq, records: [], nextSinceSeq: 0, done: false, incarnationChanged: true };
  }
  const sinceSeq = Number.isFinite(req.sinceSeq) && req.sinceSeq >= 0 ? req.sinceSeq : 0;

  // Delta window, EXCLUSIVE cursor; (lastMutatedSeq asc, id) order.
  const eligible = deps.records
    .filter((c) => (c.lastMutatedSeq ?? 1) > sinceSeq)
    .sort((a, b) => {
      const sa = a.lastMutatedSeq ?? 1;
      const sb = b.lastMutatedSeq ?? 1;
      if (sa !== sb) return sa - sb;
      return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
    });

  const cap = deps.syncPageBytes ?? DEFAULT_SYNC_PAGE_BYTES;
  const out: ReplicatedCommitment[] = [];
  let bytes = 0;
  let cursor = sinceSeq;
  for (const c of eligible) {
    const served = serveRecord(c, deps.ownMachineId);
    const size = Buffer.byteLength(JSON.stringify(served), 'utf-8');
    // A page always carries at least one record (an oversize record ships
    // alone in its own page — §3.2).
    if (out.length > 0 && bytes + size > cap) break;
    out.push(served);
    bytes += size;
    cursor = Math.max(cursor, served.lastMutatedSeq ?? 1);
    if (bytes > cap) break;
  }
  const done = out.length === eligible.length;
  return { incarnation, replicationSeq, records: out, nextSinceSeq: cursor, done };
}

/** Serve-time stamping (legacy rows get OUR id — §3.1) + per-field redaction. */
function serveRecord(c: Commitment, ownMachineId: string): ReplicatedCommitment {
  const served: ReplicatedCommitment = {
    ...c,
    originMachineId: c.originMachineId ?? ownMachineId,
  };
  let redacted = false;
  for (const f of TEXT_FIELDS) {
    const v = served[f];
    if (typeof v === 'string' && v) {
      const r = redactForLiveTail(v);
      if (r.redactedCount > 0) {
        (served as unknown as Record<string, unknown>)[f] = r.text;
        redacted = true;
      }
    }
  }
  if (redacted) served.textRedacted = true;
  return served;
}

// ── Receive side (§3.2) ─────────────────────────────────────────────

interface ReplicaFileShape {
  version: 1;
  ownerMachineId: string;
  incarnation: string;
  /** The EXCLUSIVE cursor — the highest lastMutatedSeq applied. */
  sinceSeq: number;
  receivedAt: string;
  /** Keyed by commitment id (ids are unique WITHIN one owner's store). */
  records: Record<string, ReplicatedCommitment>;
}

export interface ApplyResult {
  applied: number;
  /** Rows claiming an originMachineId ≠ the authenticated sender — rejected. */
  forgedRows: number;
  /** The replica was discarded wholesale (incarnation change). */
  replaced: boolean;
}

/**
 * The per-peer replica store: one JSON file per owner under
 * `state/commitment-replicas/`, written ONLY by this receive path
 * (single-writer), temp-file + atomic rename, corrupt → quarantine +
 * fresh (never silently empty).
 */
export class CommitmentReplicaStore {
  private readonly dir: string;
  private readonly now: () => Date;
  private readonly logger: (msg: string) => void;
  private cache = new Map<string, ReplicaFileShape>();

  constructor(config: { stateDir: string; now?: () => Date; logger?: (msg: string) => void }) {
    this.dir = path.join(config.stateDir, 'state', 'commitment-replicas');
    this.now = config.now ?? (() => new Date());
    this.logger = config.logger ?? (() => {});
  }

  /** The cursor to request next from a peer (0 + no incarnation when fresh). */
  cursorFor(ownerMachineId: string): { sinceSeq: number; incarnation?: string } {
    const r = this.load(ownerMachineId);
    return r ? { sinceSeq: r.sinceSeq, incarnation: r.incarnation } : { sinceSeq: 0 };
  }

  /**
   * Apply a served page. `senderMachineId` is the AUTHENTICATED envelope
   * sender — the replica identity derives from it, never a payload field.
   */
  applyPage(senderMachineId: string, page: CommitmentsSyncPage): ApplyResult {
    let replica = this.load(senderMachineId);
    let replaced = false;
    if (page.incarnationChanged || !replica || replica.incarnation !== page.incarnation) {
      // Incarnation change (or first contact) → wholesale replacement (§3.2):
      // never a sinceSeq short-circuit against a restored store.
      replica = {
        version: 1,
        ownerMachineId: senderMachineId,
        incarnation: page.incarnation,
        sinceSeq: 0,
        receivedAt: this.now().toISOString(),
        records: {},
      };
      replaced = true;
      if (page.incarnationChanged) {
        // The page carries no records on the fence response; persist the
        // reset so the next request starts from 0 under the new incarnation.
        this.persist(senderMachineId, replica);
        return { applied: 0, forgedRows: 0, replaced };
      }
    }
    let applied = 0;
    let forgedRows = 0;
    for (const row of page.records) {
      if (row.originMachineId !== senderMachineId) {
        forgedRows++; // first-hop with teeth (§3.2) — counted, never applied
        continue;
      }
      replica.records[row.id] = row;
      applied++;
    }
    replica.sinceSeq = Math.max(replica.sinceSeq, page.nextSinceSeq);
    replica.receivedAt = this.now().toISOString();
    this.persist(senderMachineId, replica);
    return { applied, forgedRows, replaced };
  }

  /** Every replica's rows, tagged with owner + receivedAt. */
  allReplicas(): { ownerMachineId: string; receivedAt: string; records: ReplicatedCommitment[] }[] {
    const out: { ownerMachineId: string; receivedAt: string; records: ReplicatedCommitment[] }[] = [];
    let names: string[] = [];
    try {
      names = fs.readdirSync(this.dir).filter((n) => n.endsWith('.json') && !n.includes('.corrupt-'));
    } catch { /* @silent-fallback-ok: replica dir absent = no replicas yet (single-machine or fresh boot) — an empty merge, never an error (COMMITMENTS-COHERENCE-SPEC §3.3) */
    }
    for (const name of names) {
      const owner = name.replace(/\.json$/, '');
      if (name === 'pending-mutations.json') continue; // sibling store, not a replica
      const r = this.load(owner);
      if (r) out.push({ ownerMachineId: r.ownerMachineId, receivedAt: r.receivedAt, records: Object.values(r.records) });
    }
    return out;
  }

  private fileFor(owner: string): string {
    // Owner ids are mesh machine ids ([A-Za-z0-9_-]); sanitize defensively.
    return path.join(this.dir, `${owner.replace(/[^A-Za-z0-9_.-]/g, '_')}.json`);
  }

  private load(owner: string): ReplicaFileShape | null {
    const cached = this.cache.get(owner);
    if (cached) return cached;
    const file = this.fileFor(owner);
    let raw: string;
    try {
      raw = fs.readFileSync(file, 'utf-8');
    } catch { /* @silent-fallback-ok: absent replica = first contact with this peer — a fresh pull from 0, never an error (COMMITMENTS-COHERENCE-SPEC §3.2) */
      return null;
    }
    try {
      const parsed = JSON.parse(raw) as ReplicaFileShape;
      if (parsed?.version !== 1 || typeof parsed.records !== 'object') throw new Error('shape');
      this.cache.set(owner, parsed);
      return parsed;
    } catch {
      // Corrupt → quarantine + fresh re-pull (never silently empty, §3.2).
      try {
        fs.renameSync(file, `${file}.corrupt-${this.now().getTime()}`);
      } catch { /* @silent-fallback-ok: quarantine rename can lose a race; the fresh re-pull below proceeds either way (COMMITMENTS-COHERENCE-SPEC §3.2) */
      }
      this.logger(`replica for ${owner} unreadable — quarantined; full re-pull will rebuild it`);
      return null;
    }
  }

  private persist(owner: string, replica: ReplicaFileShape): void {
    fs.mkdirSync(this.dir, { recursive: true });
    const file = this.fileFor(owner);
    const tmp = `${file}.tmp-${process.pid}`;
    fs.writeFileSync(tmp, JSON.stringify(replica, null, 2));
    fs.renameSync(tmp, file);
    this.cache.set(owner, replica);
  }
}

// ── The merged read (§3.3) ──────────────────────────────────────────

export interface MergedCommitmentRow extends Commitment {
  /** Named viewSource — Commitment.source ('sentinel'|'agent'|'manual') is taken. */
  viewSource: 'own' | 'replica';
  originMachineId: string;
  /** Replica rows only: now − replica.receivedAt. */
  stalenessMs?: number;
  /** Computed at merge time from the pending-mutation ledger — never stored. */
  pendingMutation?: boolean;
  /** Heuristic duplicate signal (§3.3a) — composite keys of suspects. */
  possibleDuplicateOf?: string[];
}

export interface MergeDeps {
  ownMachineId: string;
  own: Commitment[];
  replicas: { ownerMachineId: string; receivedAt: string; records: ReplicatedCommitment[] }[];
  /** Pending-mutation join (P1.5b) — composite keys with in-flight mutations. */
  pendingKeys?: Set<string>;
  now?: () => Date;
}

export function compositeKey(originMachineId: string, id: string): string {
  return `${originMachineId}::${id}`;
}

/**
 * Own + replicas on the composite key. Own records are authoritative for
 * own truth (replica copies of OUR records never appear — only rows whose
 * origin is the replica's owner survive the first-hop filter, so the only
 * possible overlap is none by construction).
 */
export function mergeCommitmentViews(deps: MergeDeps): MergedCommitmentRow[] {
  const nowMs = (deps.now?.() ?? new Date()).getTime();
  const rows: MergedCommitmentRow[] = [];
  for (const c of deps.own) {
    const origin = c.originMachineId ?? deps.ownMachineId;
    rows.push({
      ...c,
      viewSource: 'own',
      originMachineId: origin,
      ...(deps.pendingKeys?.has(compositeKey(origin, c.id)) ? { pendingMutation: true } : {}),
    });
  }
  for (const rep of deps.replicas) {
    if (rep.ownerMachineId === deps.ownMachineId) continue; // never our own echo
    const staleness = Math.max(0, nowMs - new Date(rep.receivedAt).getTime());
    for (const c of rep.records) {
      rows.push({
        ...c,
        viewSource: 'replica',
        stalenessMs: staleness,
        ...(deps.pendingKeys?.has(compositeKey(c.originMachineId, c.id)) ? { pendingMutation: true } : {}),
      });
    }
  }
  annotateDuplicates(rows);
  return rows;
}

/**
 * §3.3a — explicitly HEURISTIC duplicate surfacing: open rows sharing
 * topicId + type whose creation windows overlap (24h). Signal only;
 * never merged, never actuated.
 */
function annotateDuplicates(rows: MergedCommitmentRow[]): void {
  const open = rows.filter((r) => r.status === 'pending');
  for (let i = 0; i < open.length; i++) {
    for (let j = i + 1; j < open.length; j++) {
      const a = open[i];
      const b = open[j];
      if (a.originMachineId === b.originMachineId) continue; // same store would be visible to its own creator
      if (a.topicId === undefined || a.topicId !== b.topicId) continue;
      if (a.type !== b.type) continue;
      const dt = Math.abs(new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime());
      if (dt > 24 * 60 * 60 * 1000) continue;
      (a.possibleDuplicateOf ??= []).push(compositeKey(b.originMachineId, b.id));
      (b.possibleDuplicateOf ??= []).push(compositeKey(a.originMachineId, a.id));
    }
  }
}

/**
 * §3.1 — bare-id resolution over the merged view: exactly one match → the
 * row; several → 'ambiguous' (the route answers 409 listing candidates);
 * none → null.
 */
export function resolveBareId(
  rows: MergedCommitmentRow[],
  id: string,
  origin?: string,
): MergedCommitmentRow | 'ambiguous' | null {
  const matches = rows.filter((r) => r.id === id && (!origin || r.originMachineId === origin));
  if (matches.length === 1) return matches[0];
  if (matches.length > 1) return 'ambiguous';
  return null;
}
