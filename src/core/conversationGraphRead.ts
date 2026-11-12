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
  reduceGraph, GraphProjection, nodeKey, validateNodeRef, moveEligibility,
  type GraphEvent, type ConversationSource, type ConversationRef, type EffortRef, type NodeRef, type ProjectionItem, type PartialReason,
} from './conversationGraph.js';

export interface GraphReadSource {
  /** From the increment-A proof runtime. Anything but ready answers 503. */
  readiness(): { ready: true } | { ready: false; reason: string };
  /** Actual owned local intake may remain usable while canonical authority is
   * held. This supplies neither a snapshot nor a positive graph-write grant. */
  localRecordingReady?(): boolean;
  /** ONLY the all-member verified final-certificate union. Never the raw local event file. */
  certifiedEvents(): GraphEvent[];
  /** Receipt verification for reduceGraph. */
  verify(event: GraphEvent): boolean;
  /** The flat conversation inventory: exact list id and machine. */
  conversations(): ConversationSource[];
  unavailableConversations?(): ConversationRef[];
  /** Effort titles (EffortHeaderStore); null when absent or forgotten. */
  effortTitle(effort: EffortRef): string | null;
  headerMetadata?(effort: EffortRef): {version:number;forgotten:boolean}|null;
  /** True only when the certified increment-C routes are mounted by composition. */
  correctionsReady?():boolean;
  /** Negative-only owner privacy actions do not require placement-write readiness. */
  erasureReady?():boolean;
  /** Replication state; every true field becomes a partial reason. Nothing is synthesized complete. */
  replication(): { replicaLag: boolean; eventGap: boolean; evidenceMissing: boolean };
  now(): Date;
}

export interface GraphViewer {
  principalKey: string;
  grantVersion: string;
  mayView(ref: NodeRef): boolean;
  /** Fresh global owner authority, not subject visibility. Restricted viewers
   * consistently receive no correction heads, including for unplaced nodes. */
  hasFullCorrectionScope?(): boolean;
}

export type ReadResult =
  | { status: 200; body: Record<string, unknown> }
  | { status: 404; body: { code: 'not-found' } }
  | { status: 409; body: { code: 'cursor-stale'; reason: 'grant-changed' | 'snapshot-expired' | 'cursor-invalid' } }
  | { status: 503; body: { code: 'conversation-graph-off'; reason: string } }
  | { status: 503; body: { code: 'conversation-graph-pending'; reason: 'owned-custody-pending'; capabilities: { recordLocal: true; canonical: false } } };

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
  private readonly cursorKey = crypto.randomBytes(32);
  private readonly pageSize: number;
  private readonly ttlMs: number;

  private readonly rootConversation: () => ConversationRef | null;

  constructor(private readonly source: GraphReadSource, opts: {
    pageSize?: number; snapshotTtlMs?: number;
    /**
     * The agent's Chief of Staff conversation, the root of the owner's Overview
     * (docs/specs/conversation-graph-suggestions.md §2). Presentation only: it is returned as
     * `root` beside the root efforts, offered no move destinations, and left out of suggestions.
     */
    rootConversation?: () => ConversationRef | null;
  } = {}) {
    this.pageSize = opts.pageSize ?? 50;
    this.ttlMs = opts.snapshotTtlMs ?? 120_000;
    this.rootConversation = opts.rootConversation ?? (() => null);
  }

  /** The root conversation, validated, or null. A throwing lookup reads as "none". */
  rootRef(): ConversationRef | null {
    let raw: ConversationRef | null = null;
    try { raw = this.rootConversation(); } catch { return null; }
    const ref = raw ? validateNodeRef(raw) : null;
    return ref && ref.kind === 'conversation' ? ref : null;
  }

  isRootConversation(ref: NodeRef): boolean {
    const root = this.rootRef();
    return root !== null && validateNodeRef(ref) !== null && nodeKey(ref) === nodeKey(root);
  }

  /**
   * The viewer's unassigned conversations (no visible parent), for the suggestion builder.
   * The root conversation is never offered. Null while the graph is not ready.
   */
  unassignedConversations(viewer: GraphViewer): ProjectionItem[] | null {
    if (!this.source.readiness().ready) return null;
    const { projection } = this.project(viewer);
    return projection.list('all', null)
      .filter((ref) => ref.kind === 'conversation' && !this.isRootConversation(ref))
      .map((ref) => projection.item(ref))
      .filter((item): item is ProjectionItem => item !== null && item.role === 'unassigned' && item.state !== 'unavailable');
  }

  roots(viewer: GraphViewer, q: { view: 'overview' | 'all'; q?: string | null; cursor?: string | null }): ReadResult {
    const ready = this.source.readiness();
    if (!ready.ready) return this.unavailable(ready.reason);
    const { projection, revision, partialReasons } = this.project(viewer);
    const scope = `roots|${q.view}|${(q.q ?? '').trim().toLowerCase()}`;
    const page = this.page(viewer, scope, q.cursor ?? null, () => {
      const refs = projection.list(q.view, q.q ?? null);
      return q.view === 'overview' && !(q.q ?? '').trim() ? refs.slice(0, 5) : refs;
    });
    if ('status' in page) return page;
    const items = page.refs.map((r) => projection.item(r)).filter((x): x is ProjectionItem => x !== null);
    // The Overview opens with the root conversation; every root effort sits under it.
    const rootRef = q.view === 'overview' && !(q.q ?? '').trim() ? this.rootRef() : null;
    const root = rootRef ? projection.item(rootRef) : null;
    return { status: 200, body: { ...this.envelope(revision, partialReasons), ...(root ? { root } : {}), items, nextCursor: page.nextCursor } };
  }

  node(viewer: GraphViewer, ref: NodeRef, q: { cursor?: string | null }): ReadResult {
    const ready = this.source.readiness();
    if (!ready.ready) return this.unavailable(ready.reason);
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
    const eligibility: { eligible: boolean; reason?: string } = this.isRootConversation(valid)
      ? { eligible: false, reason: 'chief-of-staff-is-root' }
      : moveEligibility(this.source.certifiedEvents(), {verify:event=>this.source.verify(event)}, valid, null, this.source.now().toISOString());
    const header = valid.kind === 'effort' ? this.source.headerMetadata?.(valid) : null;
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
        ...(valid.kind==='effort'&&this.source.erasureReady?.() ? {erasure:{headerForgotten:header?.forgotten===true}} : {}),
        ...(this.source.correctionsReady?.() && viewer.hasFullCorrectionScope?.() === true ? {correction: {
          replacesPlacementEventIds: graph.placementHeads.get(nodeKey(valid)) ?? [],
          moveEligible: node.state !== 'unavailable' && eligibility.eligible,
          ...(!eligibility.eligible ? {reason:eligibility.reason} : {}),
          ...(valid.kind === 'effort' ? {replacesFrontDoorEventIds:graph.frontDoorHeads.get(nodeKey(valid)) ?? [],
            ...(header ? {headerVersion:header.version,headerForgotten:header.forgotten} : {})} : {}),
        }} : {}),
      },
    };
  }

  /** Authorized candidate destinations, not a promise that a future move will
   * apply. Preview and write ingress run the real reducer with current heads. */
  destinations(viewer: GraphViewer, subject: NodeRef, q: { q?: string | null; cursor?: string | null }): ReadResult {
    const ready = this.source.readiness();
    if (!ready.ready) return this.unavailable(ready.reason);
    const valid = validateNodeRef(subject);
    if (!valid) return { status: 404, body: { code: 'not-found' } };
    const { projection, graph, revision, partialReasons } = this.project(viewer);
    if (!projection.has(valid)) return { status: 404, body: { code: 'not-found' } };
    // The root conversation stays the root: it has nowhere to move to.
    if (this.isRootConversation(valid)) return { status: 200, body: { ...this.envelope(revision, partialReasons), items: [], nextCursor: null } };
    const subjectKey = nodeKey(valid);
    const descendant = (candidate: NodeRef): boolean => {
      let cursor: NodeRef | null = candidate;
      const seen = new Set<string>();
      while (cursor && !seen.has(nodeKey(cursor))) {
        const key = nodeKey(cursor); if (key === subjectKey) return true;
        seen.add(key); cursor = graph.parentOf.get(key) ?? null;
      }
      return false;
    };
    const scope = `destinations|${subjectKey}|${(q.q ?? '').trim().toLowerCase()}`;
    const page = this.page(viewer, scope, q.cursor ?? null, () => projection.list('all', q.q ?? null)
      .filter(parent => (valid.kind !== 'effort' || parent.kind === 'effort') && !descendant(parent)
        && projection.item(parent)?.state !== 'unavailable'));
    if ('status' in page) return page;
    return { status: 200, body: { ...this.envelope(revision, partialReasons),
      items: page.refs.map(ref => projection.item(ref)).filter((item): item is ProjectionItem => item !== null),
      nextCursor: page.nextCursor } };
  }

  private unavailable(reason: string): ReadResult {
    if (this.source.localRecordingReady?.() === true) return { status: 503, body: {
      code: 'conversation-graph-pending', reason: 'owned-custody-pending', capabilities: { recordLocal: true, canonical: false },
    } };
    return { status: 503, body: { code: 'conversation-graph-off', reason } };
  }

  private project(viewer: GraphViewer) {
    const graph = reduceGraph(this.source.certifiedEvents(), { verify: (e) => this.source.verify(e) });
    const projection = new GraphProjection({
      graph,
      conversations: this.source.conversations(),
      unavailableConversations: this.source.unavailableConversations?.() ?? [],
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
    return { revision, asOf: this.source.now().toISOString(), partial: partialReasons.length > 0, partialReasons,
      capabilities:{ownerCorrections:this.source.correctionsReady?.()===true,ownerErasure:this.source.erasureReady?.()===true},
      replicationState: partialReasons.some(p => p.reason === 'replica-lag') ? 'pending' : 'current' };
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
      const parsed = decodeCursor(cursor, this.cursorKey);
      if (!parsed) return stale('cursor-invalid');
      snapshotId = parsed.snapshotId;
      snap = this.snapshots.get(snapshotId);
      if (!snap) return stale('snapshot-expired');
      if (snap.expiresAt <= now) { this.snapshots.delete(snapshotId); return stale('snapshot-expired'); }
      if (snap.principalKey !== viewer.principalKey || snap.grantVersion !== viewer.grantVersion) return stale('grant-changed');
      if (snap.scope !== scope) return stale('cursor-invalid');
      const previous = snap.refs.findIndex(ref => nodeKey(ref) === parsed.lastKey);
      if (previous < 0) return stale('cursor-invalid');
      offset = previous + 1;
    }
    const slice = snap.refs.slice(offset, offset + this.pageSize).filter((r) => viewer.mayView(r));
    const next = offset + this.pageSize;
    return { refs: slice, nextCursor: next < snap.refs.length
      ? encodeCursor(snapshotId, nodeKey(snap.refs[next - 1]), this.cursorKey) : null };
  }

  private sweep(now: number): void {
    for (const [id, s] of this.snapshots) if (s.expiresAt <= now) this.snapshots.delete(id);
  }
}

function stale(reason: 'grant-changed' | 'snapshot-expired' | 'cursor-invalid'): Extract<ReadResult, { status: 409 }> {
  return { status: 409, body: { code: 'cursor-stale', reason } };
}

function encodeCursor(snapshotId: string, lastKey: string, secret: Buffer): string {
  const body = Buffer.from(JSON.stringify({ s: snapshotId, k: lastKey }), 'utf8').toString('base64url');
  return body + '.' + crypto.createHmac('sha256', secret).update(body).digest('base64url');
}

function decodeCursor(cursor: string, secret: Buffer): { snapshotId: string; lastKey: string } | null {
  if (cursor.length > 2048 || !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]{43}$/.test(cursor)) return null;
  try {
    const [body, signature] = cursor.split('.');
    const expected = crypto.createHmac('sha256', secret).update(body).digest();
    const supplied = Buffer.from(signature, 'base64url');
    if (supplied.length !== expected.length || !crypto.timingSafeEqual(supplied, expected)) return null;
    const v = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as Record<string, unknown>;
    if (Object.keys(v).sort().join(',') !== 'k,s') return null;
    if (typeof v.s !== 'string' || !/^[A-Za-z0-9_-]{16,40}$/.test(v.s)) return null;
    if (typeof v.k !== 'string' || v.k.length > 1024) return null;
    return { snapshotId: v.s, lastKey: v.k };
  } catch {
    // @silent-fallback-ok — malformed signed cursor is refused as cursor-stale; no page is synthesized.
    return null;
  }
}
