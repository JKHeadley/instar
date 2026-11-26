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
  reduceGraph, GraphProjection, nodeKey, validateNodeRef, moveEligibility, encodeRouteRef,
  type GraphEvent, type ConversationSource, type ConversationRef, type EffortRef, type NodeRef, type ProjectionItem, type PartialReason,
} from './conversationGraph.js';

export interface GraphReadSource {
  /** From the increment-A proof runtime. Anything but ready answers 503. */
  readiness(): { ready: true } | { ready: false; reason: string };
  /** Runs one synchronous read against a single verified view: every lookup inside
   * `fn` (readiness, projection, effort titles) sees the view built once at its start.
   * Optional: a source without it builds per lookup. */
  scoped?<T>(fn: () => T): T;
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
  /** Exact project assignment for each visible conversation, including affirmative nulls. */
  treeProjectMembership?(): ReadonlyMap<string, string | null> | null;
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
  /**
   * Work-front-doors stage 2b (spec §3.2): each open work card's own conversation and the conversation of the
   * project it names (its `projectKey`). A card's conversation is PROPOSED under the effort that holds its
   * project's conversation, shown from the card record until the `card-record` graph authority exists.
   */
  cardPlacements?(): Array<{ card: ConversationRef; project: ConversationRef }>;
}

/** At most this many proposed card conversations on one effort's page. */
export const MAX_PROPOSED_CARDS = 50;

/** The phone's tree read (work-front-doors stage 2; hierarchy v3 §7.1, §7.4). */
export const TREE_MAX_DEPTH = 4;
export const TREE_CHILD_LIMIT = 20;
export const TREE_NODE_BUDGET = 400;

/**
 * A tracked project the tree may label an effort with: its conversation, the project's title and the
 * conversation key the Work page and `GET /mobile/work/projects` use for it.
 */
export interface TreeProject { ref: ConversationRef; title: string; conversationKey: string }

/** One node of the phone tree: the projection item, flattened for a phone, with its children nested. */
export interface TreeNode {
  ref: NodeRef;
  /** The route form of `ref` (base64url canonical JSON), ready for `/mobile/conversation-graph/nodes/:ref`. */
  routeRef: string;
  title: string;
  kind: ProjectionItem['kind'];
  role: ProjectionItem['role'];
  placedBy?: ProjectionItem['placedBy'];
  state?: 'unavailable';
  source?: ProjectionItem['source'];
  sourceFreshness: string | null;
  visibleChildCount: number;
  /** Efforts only, and only when the viewer may see that conversation. */
  frontDoor?: ConversationRef;
  /** Efforts only, when the projects could be read and this effort holds a tracked project's conversation. */
  project?: { title: string; conversationKey: string };
  projectConversationKey?: string;
  children?: TreeNode[];
  /** False when the children shown are not all of them (depth, per-node or response limit): open the node for the rest. */
  childrenComplete?: boolean;
  /** Card conversations proposed here from the card record (work-front-doors §3.2), as on the node read. */
  proposed?: TreeNode[];
  /** Present (false) only when the response limit cut this effort's proposals: open the node for all of them. */
  proposedComplete?: false;
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

  /** One verified view per read: a page during busy writes rebuilt the whole view once per effort title. */
  private scoped<T>(fn: () => T): T { return this.source.scoped ? this.source.scoped(fn) : fn(); }

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
    try { raw = this.rootConversation(); } catch {
      // @silent-fallback-ok: no readable Chief of Staff topic means no root row; the Overview is exactly as before.
      return null;
    }
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
    return this.scoped(() => this.unassignedConversationsUnscoped(viewer));
  }

  private unassignedConversationsUnscoped(viewer: GraphViewer): ProjectionItem[] | null {
    if (!this.source.readiness().ready) return null;
    const { projection } = this.project(viewer);
    return projection.list('all', null)
      .filter((ref) => ref.kind === 'conversation' && !this.isRootConversation(ref))
      .map((ref) => projection.item(ref))
      .filter((item): item is ProjectionItem => item !== null && item.role === 'unassigned' && item.state !== 'unavailable');
  }

  roots(viewer: GraphViewer, q: { view: 'overview' | 'all'; q?: string | null; cursor?: string | null }): ReadResult {
    return this.scoped(() => this.rootsUnscoped(viewer, q));
  }

  private rootsUnscoped(viewer: GraphViewer, q: { view: 'overview' | 'all'; q?: string | null; cursor?: string | null }): ReadResult {
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
    return this.scoped(() => this.nodeUnscoped(viewer, ref, q));
  }

  private nodeUnscoped(viewer: GraphViewer, ref: NodeRef, q: { cursor?: string | null }): ReadResult {
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
    const proposed = valid.kind === 'effort' ? this.proposedFor(valid, graph, projection) : [];
    return {
      status: 200,
      body: {
        ...this.envelope(revision, partialReasons),
        node,
        path: node.primaryPath,
        children: { items: children, nextCursor: page.nextCursor },
        ...(proposed.length ? { proposed: { items: proposed, by: 'card-record' } } : {}),
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

  /**
   * The phone's tree (work-front-doors stage 2, "Mobile hierarchy routes"; hierarchy v3 §7.4): the viewer's root
   * efforts, paged like the Overview but without its five-row cut, each with its visible children nested down to
   * TREE_MAX_DEPTH, at most TREE_CHILD_LIMIT children a node and TREE_NODE_BUDGET nodes a response. Everything comes
   * from the same viewer-filtered projection as roots() and node(), built once: a hidden node is never counted,
   * nested, proposed or used to label a project. A node whose children are cut says so (`childrenComplete: false`);
   * the phone opens it with node(), which pages the rest.
   *
   * `projects` labels an effort as a project: its front door first, then any conversation directly in it, being a
   * tracked project's conversation (the console's rule). null means the projects could not be read; the response
   * then says `projects: 'unknown'` and labels nothing, rather than calling a project a plain group.
   */
  tree(viewer: GraphViewer, q: { cursor?: string | null; projects?: TreeProject[] | null }): ReadResult {
    return this.scoped(() => this.treeUnscoped(viewer, q));
  }

  private treeUnscoped(viewer: GraphViewer, q: { cursor?: string | null; projects?: TreeProject[] | null }): ReadResult {
    const ready = this.source.readiness();
    if (!ready.ready) return this.unavailable(ready.reason);
    const { projection, graph, revision, partialReasons } = this.project(viewer);
    const page = this.page(viewer, 'tree', q.cursor ?? null, () => projection.list('overview', null));
    if ('status' in page) return page;
    const tracked = new Map<string, { title: string; conversationKey: string }>();
    for (const p of q.projects ?? []) {
      const ref = p && validateNodeRef(p.ref);
      if (ref && ref.kind === 'conversation' && typeof p.title === 'string' && typeof p.conversationKey === 'string') {
        tracked.set(nodeKey(ref), { title: p.title, conversationKey: p.conversationKey });
      }
    }
    let budget = TREE_NODE_BUDGET;
    // The card record is read once per tree, not once per effort.
    const placements = this.source.cardPlacements ? this.source.cardPlacements() : null;
    const flat = (item: ProjectionItem): TreeNode => {
      budget -= 1;
      const out: TreeNode = { ref: item.ref, routeRef: encodeRouteRef(item.ref), title: item.title, kind: item.kind, role: item.role,
        sourceFreshness: item.sourceFreshness, visibleChildCount: item.visibleChildCount };
      if (item.placedBy) out.placedBy = item.placedBy;
      if (item.state) out.state = item.state;
      if (item.source) out.source = item.source;
      if (item.metadata?.frontDoor) out.frontDoor = item.metadata.frontDoor;
      return out;
    };
    const build = (item: ProjectionItem, depth: number): TreeNode => {
      const out = flat(item);
      if (item.kind !== 'effort' || item.ref.kind !== 'effort') return out;
      const effortRef = item.ref;
      const childRefs = projection.childrenOf(effortRef);
      if (q.projects) {
        const candidates = [item.metadata?.frontDoor, ...childRefs.filter((r) => r.kind === 'conversation')];
        for (const r of candidates) {
          const hit = r && projection.has(r) ? tracked.get(nodeKey(r)) : undefined;
          if (hit) { out.project = { title: hit.title, conversationKey: hit.conversationKey }; break; }
        }
      }
      const children: TreeNode[] = [];
      let complete = true;
      if (depth >= TREE_MAX_DEPTH) complete = childRefs.length === 0;
      else {
        for (const r of childRefs) {
          if (children.length >= TREE_CHILD_LIMIT || budget <= 0) { complete = false; break; }
          const child = projection.item(r);
          if (child) children.push(build(child, depth + 1));
        }
      }
      out.children = children;
      out.childrenComplete = complete;
      const proposed: TreeNode[] = [];
      for (const p of this.proposedFor(effortRef, graph, projection, placements)) {
        if (budget <= 0) { out.proposedComplete = false; break; }
        proposed.push(flat(p));
      }
      if (proposed.length) out.proposed = proposed;
      return out;
    };
    const items: TreeNode[] = [];
    for (const r of page.refs) {
      const item = projection.item(r);
      if (item) items.push(build(item, 1));
    }
    // The Chief of Staff conversation heads the tree, as it heads the Overview (first page only).
    const rootRef = (q.cursor ?? '') === '' ? this.rootRef() : null;
    const rootItem = rootRef ? projection.item(rootRef) : null;
    const groups = items.filter((item) => item.kind === 'effort');
    const projects: TreeNode[] = [];
    const ungrouped: TreeNode[] = [];
    const membership = this.source.treeProjectMembership?.();
    let placementComplete = false;
    if (membership && q.projects && !q.cursor && !page.nextCursor && partialReasons.length === 0) {
      const refs = projection.list('all', null).filter((ref) => ref.kind === 'conversation');
      const projectRows = new Map<string, TreeNode>();
      const wholeBranch = (row: TreeNode): boolean => row.childrenComplete !== false && row.proposedComplete !== false
        && (row.children?.every(wholeBranch) ?? true);
      placementComplete = groups.every(wholeBranch) && refs.length <= TREE_NODE_BUDGET
        && graph.conflicts.length === 0 && refs.every((ref) => membership.has(nodeKey(ref)));
      for (const project of q.projects) {
        const item = projection.item(project.ref);
        if (!item || budget <= 0 || projectRows.has(project.conversationKey)) { placementComplete = false; continue; }
        const row = flat(item);
        row.project = { title: project.title, conversationKey: project.conversationKey };
        row.projectConversationKey = project.conversationKey;
        row.children = [];
        row.childrenComplete = true;
        projects.push(row);
        projectRows.set(project.conversationKey, row);
      }
      for (const ref of refs) {
        if (rootRef && nodeKey(ref) === nodeKey(rootRef)) continue;
        const item = projection.item(ref);
        const key = membership.get(nodeKey(ref));
        const grouped = graph.parentOf.get(nodeKey(ref));
        if (!item || item.state === 'unavailable' || key === undefined || (key && grouped)) {
          placementComplete = false;
          continue;
        }
        if (key) {
          const project = projectRows.get(key);
          if (!project || !project.children) { placementComplete = false; continue; }
          if (nodeKey(project.ref) !== nodeKey(ref)) {
            if (project.children.length >= TREE_CHILD_LIMIT || budget <= 0) {
              project.childrenComplete = false;
              placementComplete = false;
              continue;
            }
            project.children.push({ ...flat(item), projectConversationKey: key });
            project.visibleChildCount = project.children.length;
          }
        } else if (!grouped) {
          if (budget <= 0) { placementComplete = false; continue; }
          ungrouped.push(flat(item));
        }
      }
    }
    return { status: 200, body: { ...this.envelope(revision, partialReasons), ...(rootItem ? { root: flat(rootItem) } : {}),
      items, nextCursor: page.nextCursor, projects: q.projects ? 'known' : 'unknown',
      sections: { projects, groups, ungrouped: placementComplete ? ungrouped : [] }, placementComplete,
      limits: { depth: TREE_MAX_DEPTH, childrenPerNode: TREE_CHILD_LIMIT, nodes: TREE_NODE_BUDGET } } };
  }

  /**
   * A card's conversation, unplaced, whose project's conversation sits directly in this effort: proposed here.
   * Visibility is the projection's (the viewer filter already ran); an owner placement anywhere wins.
   */
  private proposedFor(effortRef: EffortRef, graph: ReturnType<typeof reduceGraph>, projection: GraphProjection,
    placements: Array<{ card: ConversationRef; project: ConversationRef }> | null = this.source.cardPlacements ? this.source.cardPlacements() : null): ProjectionItem[] {
    const proposed: ProjectionItem[] = [];
    if (!placements) return proposed;
    const here = nodeKey(effortRef);
    const seen = new Set<string>();
    for (const cp of placements) {
      if (proposed.length >= MAX_PROPOSED_CARDS) break;
      const cardKey = nodeKey(cp.card);
      if (seen.has(cardKey) || graph.parentOf.get(cardKey)) continue;
      // Both ends of the link are checked (spec §4.4): a project conversation the viewer may not see is never
      // revealed through a card that points at it.
      if (!projection.has(cp.project)) continue;
      const projectParent = graph.parentOf.get(nodeKey(cp.project));
      if (!projectParent || nodeKey(projectParent) !== here) continue;
      const item = projection.item(cp.card);
      if (!item) continue;
      seen.add(cardKey);
      proposed.push(item);
    }
    return proposed;
  }

  /** Authorized candidate destinations, not a promise that a future move will
   * apply. Preview and write ingress run the real reducer with current heads. */
  destinations(viewer: GraphViewer, subject: NodeRef, q: { q?: string | null; cursor?: string | null }): ReadResult {
    return this.scoped(() => this.destinationsUnscoped(viewer, subject, q));
  }

  private destinationsUnscoped(viewer: GraphViewer, subject: NodeRef, q: { q?: string | null; cursor?: string | null }): ReadResult {
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
