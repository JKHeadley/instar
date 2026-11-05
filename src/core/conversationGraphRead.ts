/**
 * conversationGraphRead — the read model behind the Conversations hierarchy routes (v3 §7.1, §7.3,
 * §7.4, §7.5). Pure: every input comes through one source port that the runtime implements.
 *
 * ORDER OF OPERATIONS, every request: readiness → viewer filter → sort / search / count / path /
 * children → page. Nothing is counted, searched or paged before the viewer filter runs.
 *
 * READINESS is not a flag. The source reports it from the increment-A proof runtime; anything but
 * `ready` answers 503 and nothing else is computed.
 *
 * CURSORS bind a short-lived AUTHORIZED SNAPSHOT, not the graph revision (§7.5): page 1 freezes the
 * ordered list of refs this viewer may see for this query. Graph events never invalidate it. A
 * cursor is refused (409) when the viewer's principal or grant version differs from the snapshot's,
 * when the snapshot has expired, or when it is malformed or unknown. Every page re-checks `mayView`
 * when it is served, so a revocation inside the snapshot window drops the row instead of leaking it.
 */
import crypto from 'node:crypto';
import {
  reduceGraph, GraphProjection, nodeKey, validateNodeRef,
  type GraphEvent, type ConversationSource, type EffortRef, type NodeRef, type ProjectionItem, type PartialReason,
} from './conversationGraph.js';

export interface GraphReadSource {
  /** From the increment-A proof runtime. Anything but ready answers 503. */
  readiness(): { ready: true } | { ready: false; reason: string };
  /** ONLY the all-member verified final-certificate union. Never the raw local event file. */
  certifiedEvents(): GraphEvent[];
  /** Receipt verification for reduceGraph. */
  verify(event: GraphEvent): boolean;
  /** The flat conversation inventory: exact list id and machine. */
  conversations(): ConversationSource[];
  /** Effort titles (EffortHeaderStore); null when absent or forgotten. */
  effortTitle(effort: EffortRef): string | null;
  /** Replication state; every true field becomes a partial reason. Nothing is synthesized complete. */
  replication(): { replicaLag: boolean; eventGap: boolean; evidenceMissing: boolean };
  now(): Date;
}

export interface GraphViewer {
  principalKey: string;
  grantVersion: string;
  mayView(ref: NodeRef): boolean;
}

export type ReadResult =
  | { status: 200; body: Record<string, unknown> }
  | { status: 404; body: { code: 'not-found' } }
  | { status: 409; body: { code: 'cursor-stale'; reason: 'grant-changed' | 'snapshot-expired' | 'cursor-invalid' } }
  | { status: 503; body: { code: 'conversation-graph-not-ready'; reason: string } };

interface Snapshot {
  principalKey: string;
  grantVersion: string;
  /** What the snapshot answers: a roots query or one node's children. */
  scope: string;
  refs: NodeRef[];
  expiresAt: number;
}

const MAX_SNAPSHOTS = 1000;

export class ConversationGraphReadModel {
  private readonly snapshots = new Map<string, Snapshot>();
  private readonly pageSize: number;
  private readonly ttlMs: number;

  constructor(private readonly source: GraphReadSource, opts: { pageSize?: number; snapshotTtlMs?: number } = {}) {
    this.pageSize = opts.pageSize ?? 50;
    this.ttlMs = opts.snapshotTtlMs ?? 120_000;
  }

  roots(viewer: GraphViewer, q: { view: 'overview' | 'all'; q?: string | null; cursor?: string | null }): ReadResult {
    const ready = this.source.readiness();
    if (!ready.ready) return { status: 503, body: { code: 'conversation-graph-not-ready', reason: ready.reason } };
    const { projection, revision, partialReasons } = this.project(viewer);
    const scope = `roots|${q.view}|${(q.q ?? '').trim().toLowerCase()}`;
    const page = this.page(viewer, scope, q.cursor ?? null, () => projection.list(q.view, q.q ?? null));
    if ('status' in page) return page;
    const items = page.refs.map((r) => projection.item(r)).filter((x): x is ProjectionItem => x !== null);
    return { status: 200, body: { ...this.envelope(revision, partialReasons), items, nextCursor: page.nextCursor } };
  }

  node(viewer: GraphViewer, ref: NodeRef, q: { cursor?: string | null }): ReadResult {
    const ready = this.source.readiness();
    if (!ready.ready) return { status: 503, body: { code: 'conversation-graph-not-ready', reason: ready.reason } };
    const valid = validateNodeRef(ref);
    if (!valid) return { status: 404, body: { code: 'not-found' } };
    const { projection, graph, revision, partialReasons } = this.project(viewer);
    const node = projection.item(valid);
    if (!node) return { status: 404, body: { code: 'not-found' } }; // hidden and absent look the same
    const scope = `children|${nodeKey(valid)}`;
    const page = this.page(viewer, scope, q.cursor ?? null, () => projection.childrenOf(valid));
    if ('status' in page) return page;
    const children = page.refs.map((r) => projection.item(r)).filter((x): x is ProjectionItem => x !== null);
    // Provenance describes a placement, so it is shown only when that placement's parent is visible
    // to this viewer: a hidden parent leaves no trace here either.
    const placedUnder = graph.parentOf.get(nodeKey(valid)) ?? null;
    const src = placedUnder && projection.has(placedUnder) ? graph.placementSource.get(nodeKey(valid)) : undefined;
    return {
      status: 200,
      body: {
        ...this.envelope(revision, partialReasons),
        node,
        path: node.primaryPath,
        children: { items: children, nextCursor: page.nextCursor },
        links: [],
        provenance: src ? [{ authority: src.authority, eventId: src.eventId, at: src.at }] : [],
        digest: null,
      },
    };
  }

  private project(viewer: GraphViewer) {
    const graph = reduceGraph(this.source.certifiedEvents(), { verify: (e) => this.source.verify(e) });
    const projection = new GraphProjection({
      graph,
      conversations: this.source.conversations(),
      effortTitle: (e) => this.source.effortTitle(e),
      mayView: (r) => viewer.mayView(r),
    });
    const rep = this.source.replication();
    const reasons = new Set<PartialReason['reason']>();
    if (rep.replicaLag) reasons.add('replica-lag');
    if (rep.eventGap || graph.partial.eventGap) reasons.add('event-gap');
    if (rep.evidenceMissing || graph.partial.evidenceMissing) reasons.add('evidence-missing');
    const partialReasons = [...reasons].sort().map((reason) => ({ reason }));
    return { graph, projection, revision: graph.revision, partialReasons };
  }

  private envelope(revision: string, partialReasons: PartialReason[]) {
    return { revision, asOf: this.source.now().toISOString(), partial: partialReasons.length > 0, partialReasons };
  }

  /**
   * Page 1 freezes the authorized ref list into a snapshot; later pages read the snapshot, re-filter
   * each ref through mayView, and never consult the current graph for membership or order.
   */
  private page(viewer: GraphViewer, scope: string, cursor: string | null, fresh: () => NodeRef[]):
    { refs: NodeRef[]; nextCursor: string | null } | Extract<ReadResult, { status: 409 }> {
    const now = this.source.now().getTime();
    this.sweep(now);
    let snapshotId: string;
    let offset: number;
    let snap: Snapshot | undefined;
    if (cursor === null || cursor === '') {
      snapshotId = crypto.randomBytes(16).toString('base64url');
      offset = 0;
      snap = { principalKey: viewer.principalKey, grantVersion: viewer.grantVersion, scope, refs: fresh(), expiresAt: now + this.ttlMs };
      // Only a result with a next page needs to be remembered.
      if (snap.refs.length > this.pageSize) {
        this.snapshots.set(snapshotId, snap);
        if (this.snapshots.size > MAX_SNAPSHOTS) this.snapshots.delete(this.snapshots.keys().next().value!);
      }
    } else {
      const parsed = decodeCursor(cursor);
      if (!parsed) return stale('cursor-invalid');
      ({ snapshotId, offset } = parsed);
      snap = this.snapshots.get(snapshotId);
      if (!snap) return stale('snapshot-expired');
      if (snap.expiresAt <= now) { this.snapshots.delete(snapshotId); return stale('snapshot-expired'); }
      if (snap.principalKey !== viewer.principalKey || snap.grantVersion !== viewer.grantVersion) return stale('grant-changed');
      if (snap.scope !== scope) return stale('cursor-invalid');
      if (offset > snap.refs.length) return stale('cursor-invalid');
    }
    const slice = snap.refs.slice(offset, offset + this.pageSize).filter((r) => viewer.mayView(r));
    const next = offset + this.pageSize;
    return { refs: slice, nextCursor: next < snap.refs.length ? encodeCursor(snapshotId, next) : null };
  }

  private sweep(now: number): void {
    for (const [id, s] of this.snapshots) if (s.expiresAt <= now) this.snapshots.delete(id);
  }
}

function stale(reason: 'grant-changed' | 'snapshot-expired' | 'cursor-invalid'): Extract<ReadResult, { status: 409 }> {
  return { status: 409, body: { code: 'cursor-stale', reason } };
}

function encodeCursor(snapshotId: string, offset: number): string {
  return Buffer.from(JSON.stringify({ s: snapshotId, o: offset }), 'utf8').toString('base64url');
}

function decodeCursor(cursor: string): { snapshotId: string; offset: number } | null {
  if (cursor.length > 200 || !/^[A-Za-z0-9_-]+$/.test(cursor)) return null;
  try {
    const v = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as Record<string, unknown>;
    if (typeof v.s !== 'string' || !/^[A-Za-z0-9_-]{16,40}$/.test(v.s)) return null;
    if (typeof v.o !== 'number' || !Number.isSafeInteger(v.o) || v.o < 0) return null;
    return { snapshotId: v.s, offset: v.o };
  } catch {
    return null;
  }
}
