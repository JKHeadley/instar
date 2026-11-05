/**
 * conversationGraph — the pure core of the Conversations hierarchy (read slice).
 *
 * No I/O lives here. The event store (ConversationGraphStore) owns the durable file; the routes
 * own authentication. This module owns three things, all deterministic:
 *
 *  1. REFS. A graph subject is a conversation ref in the form the device routes already parse
 *     (`telegram:<topicId>`, `slack:…`, `app:<uuid>`) or an effort (`effort:<id>`). The API never
 *     exposes that string directly: it returns `encodeRef()` — base64url of canonical JSON — which
 *     clients treat as opaque. A ref is identity only; it never grants access.
 *
 *  2. THE REDUCER. Placement events are immutable and unioned by eventId. For each subject, a HEAD
 *     is an accepted placement event that no other accepted event replaces. One head is a
 *     placement. Several heads that agree on the parent coalesce. A user head defeats concurrent
 *     agent/import/inference heads without erasing them. Incompatible USER heads are a conflict:
 *     the subject keeps its last agreed parent until a resolution event names both heads. A
 *     placement that would close a cycle is quarantined and the previous valid forest is kept.
 *     Event order on disk never decides an outcome — the same event set yields the same graph on
 *     every machine.
 *
 *  3. THE PROJECTION. Everything a viewer sees is computed AFTER the viewer filter: children,
 *     counts, search matches, links. A node the viewer cannot see does not exist for them — not as
 *     a count, not as a link, not as an empty-state hint.
 */
import crypto from 'node:crypto';

export const GRAPH_EVENT_SCHEMA_VERSION = 1;
export const MAX_GRAPH_EVENT_BYTES = 16 * 1024;
export const MAX_TITLE_CHARS = 200;

const CONVERSATION_REF_RE = /^(telegram:[1-9][0-9]{0,15}|slack:[A-Za-z0-9_.:-]{1,120}|app:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/;
const EFFORT_REF_RE = /^effort:[A-Za-z0-9_-]{1,64}$/;
const EVENT_ID_RE = /^[A-Za-z0-9_-]{8,80}$/;
const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?Z$/;

export type GraphSource = 'user' | 'delegation' | 'import' | 'inference';
export type GraphOp = 'place' | 'set-front-door' | 'define-effort';

/**
 * One immutable graph event. `replacesPlacementEventIds` lists the subject's heads the author
 * observed when writing it (empty for a first placement).
 */
export interface GraphEvent {
  schemaVersion: 1;
  eventId: string;
  op: GraphOp;
  subject: string;
  /** For `place`: the new parent ref, or null to make the subject a root / unassigned. */
  parent?: string | null;
  /** For `set-front-door`: whether the subject is a front door in the default view. */
  frontDoor?: boolean;
  /** For `define-effort`: the effort's title. */
  title?: string;
  replacesPlacementEventIds: string[];
  source: GraphSource;
  actor: string;
  machineId: string;
  createdAt: string;
}

export function isConversationRef(ref: string): boolean { return CONVERSATION_REF_RE.test(ref); }
export function isEffortRef(ref: string): boolean { return EFFORT_REF_RE.test(ref); }
export function isGraphRef(ref: unknown): ref is string {
  return typeof ref === 'string' && (CONVERSATION_REF_RE.test(ref) || EFFORT_REF_RE.test(ref));
}

/** Canonical JSON: keys sorted at every level, so equal values always serialise to equal bytes. */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    return `{${Object.keys(obj).sort().filter((k) => obj[k] !== undefined)
      .map((k) => `${JSON.stringify(k)}:${canonicalJson(obj[k])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

export function sha256Hex(text: string): string {
  return crypto.createHash('sha256').update(text).digest('hex');
}

/** The opaque API ref: base64url(canonical JSON {v:1, ref}). */
export function encodeRef(ref: string): string {
  return Buffer.from(canonicalJson({ v: 1, ref }), 'utf8').toString('base64url');
}

/** Decode an opaque API ref; anything malformed or unknown is null (the route answers 404). */
export function decodeRef(opaque: unknown): string | null {
  if (typeof opaque !== 'string' || opaque.length === 0 || opaque.length > 400) return null;
  if (!/^[A-Za-z0-9_-]+$/.test(opaque)) return null;
  try {
    const parsed = JSON.parse(Buffer.from(opaque, 'base64url').toString('utf8')) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    const obj = parsed as Record<string, unknown>;
    if (Object.keys(obj).sort().join(',') !== 'ref,v' || obj.v !== 1 || !isGraphRef(obj.ref)) return null;
    // Only the canonical spelling is accepted, so one subject has exactly one opaque ref.
    return encodeRef(obj.ref) === opaque ? obj.ref : null;
  } catch {
    return null;
  }
}

/** Validate an untrusted event (from disk or a peer). Anything off-schema is null. */
export function validateGraphEvent(raw: unknown): GraphEvent | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const e = raw as Record<string, unknown>;
  if (e.schemaVersion !== GRAPH_EVENT_SCHEMA_VERSION) return null;
  if (typeof e.eventId !== 'string' || !EVENT_ID_RE.test(e.eventId)) return null;
  if (!isGraphRef(e.subject)) return null;
  if (!Array.isArray(e.replacesPlacementEventIds) || e.replacesPlacementEventIds.length > 32 ||
    e.replacesPlacementEventIds.some((id) => typeof id !== 'string' || !EVENT_ID_RE.test(id))) return null;
  if (!['user', 'delegation', 'import', 'inference'].includes(e.source as string)) return null;
  if (typeof e.actor !== 'string' || e.actor.length === 0 || e.actor.length > 120) return null;
  if (typeof e.machineId !== 'string' || e.machineId.length === 0 || e.machineId.length > 120) return null;
  if (typeof e.createdAt !== 'string' || !ISO_RE.test(e.createdAt) || Number.isNaN(Date.parse(e.createdAt))) return null;
  const base = {
    schemaVersion: 1 as const,
    eventId: e.eventId,
    subject: e.subject,
    replacesPlacementEventIds: [...e.replacesPlacementEventIds] as string[],
    source: e.source as GraphSource,
    actor: e.actor,
    machineId: e.machineId,
    createdAt: e.createdAt,
  };
  if (e.op === 'place') {
    if (e.parent !== null && !isGraphRef(e.parent)) return null;
    if (e.parent === e.subject) return null;
    return { ...base, op: 'place', parent: e.parent as string | null };
  }
  if (e.op === 'set-front-door') {
    if (typeof e.frontDoor !== 'boolean') return null;
    return { ...base, op: 'set-front-door', frontDoor: e.frontDoor };
  }
  if (e.op === 'define-effort') {
    if (!isEffortRef(e.subject)) return null;
    if (typeof e.title !== 'string' || e.title.trim().length === 0 || e.title.length > MAX_TITLE_CHARS) return null;
    return { ...base, op: 'define-effort', title: e.title };
  }
  return null;
}

/** The canonical payload hash of an event: what a duplicate eventId must match to be the same event. */
export function graphEventHash(event: GraphEvent): string {
  return sha256Hex(canonicalJson(event));
}

export interface PlacementConflict {
  subject: string;
  /** The incompatible user heads, by eventId (sorted). */
  heads: string[];
  /** Their proposed parents (null = root), aligned with `heads`. */
  proposedParents: Array<string | null>;
  lastAgreedParent: string | null;
}

export interface ReducedGraph {
  /** sha256 over the sorted (eventId, payload hash) pairs of every accepted event. */
  revision: string;
  /** subject -> current parent (null = root / unassigned). Subjects with no placement are absent. */
  parentOf: Map<string, string | null>;
  /** Where each current placement came from. */
  placementSource: Map<string, { source: GraphSource; eventId: string; at: string }>;
  frontDoors: Set<string>;
  effortTitles: Map<string, string>;
  conflicts: PlacementConflict[];
  /** Event ids set aside (a cycle, or a duplicate id with different bytes), with the reason. */
  quarantined: Array<{ eventId: string; reason: string }>;
}

function placementOrder(a: GraphEvent, b: GraphEvent): number {
  // Deterministic and independent of arrival order: time, then id.
  return a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : a.eventId < b.eventId ? -1 : a.eventId > b.eventId ? 1 : 0;
}

function wouldCycle(parentOf: Map<string, string | null>, subject: string, parent: string | null): boolean {
  let cur = parent;
  const seen = new Set<string>();
  while (cur) {
    if (cur === subject) return true;
    if (seen.has(cur)) return true;
    seen.add(cur);
    cur = parentOf.get(cur) ?? null;
  }
  return false;
}

/**
 * Reduce an event set to a graph. `events` may contain duplicates and arrive in any order; the
 * result depends only on the set. Duplicate ids with different bytes are quarantined (both copies).
 */
export function reduceGraph(events: GraphEvent[]): ReducedGraph {
  const byId = new Map<string, GraphEvent>();
  const hashOf = new Map<string, string>();
  const quarantined: Array<{ eventId: string; reason: string }> = [];
  const poisoned = new Set<string>();
  for (const ev of events) {
    const h = graphEventHash(ev);
    const prior = hashOf.get(ev.eventId);
    if (prior === undefined) { byId.set(ev.eventId, ev); hashOf.set(ev.eventId, h); continue; }
    if (prior !== h) poisoned.add(ev.eventId);
  }
  for (const id of [...poisoned].sort()) {
    byId.delete(id);
    quarantined.push({ eventId: id, reason: 'duplicate-event-id-different-payload' });
  }
  const accepted = [...byId.values()].sort(placementOrder);
  const revision = sha256Hex(accepted.map((e) => `${e.eventId}:${hashOf.get(e.eventId)}`).sort().join('\n'));

  const effortTitles = new Map<string, string>();
  for (const e of accepted) if (e.op === 'define-effort' && e.title) effortTitles.set(e.subject, e.title);

  // Front doors: per subject, the latest set-front-door event (deterministic order) wins.
  const frontDoors = new Set<string>();
  const frontDoorLatest = new Map<string, GraphEvent>();
  for (const e of accepted) if (e.op === 'set-front-door') frontDoorLatest.set(e.subject, e);
  for (const [subject, e] of frontDoorLatest) if (e.frontDoor) frontDoors.add(subject);

  // Placements, per subject.
  const placements = new Map<string, GraphEvent[]>();
  for (const e of accepted) {
    if (e.op !== 'place') continue;
    const list = placements.get(e.subject) ?? [];
    list.push(e);
    placements.set(e.subject, list);
  }

  const parentOf = new Map<string, string | null>();
  const placementSource = new Map<string, { source: GraphSource; eventId: string; at: string }>();
  const conflicts: PlacementConflict[] = [];

  // Resolve each subject's heads; apply in a deterministic subject order, checking cycles.
  for (const subject of [...placements.keys()].sort()) {
    const list = placements.get(subject)!;
    const ids = new Set(list.map((e) => e.eventId));
    const replaced = new Set<string>();
    for (const e of list) for (const r of e.replacesPlacementEventIds) if (ids.has(r)) replaced.add(r);
    const heads = list.filter((e) => !replaced.has(e.eventId));
    const userHeads = heads.filter((e) => e.source === 'user');
    const candidates = userHeads.length > 0 ? userHeads : heads;
    const parents = new Set(candidates.map((e) => e.parent ?? null));

    // The last agreed parent: the newest non-head placement, else none (unassigned).
    const lastAgreed = (() => {
      const nonHeads = list.filter((e) => replaced.has(e.eventId));
      const last = nonHeads[nonHeads.length - 1];
      return last ? last.parent ?? null : null;
    })();

    let chosen: GraphEvent | null;
    if (parents.size === 1) {
      chosen = candidates[candidates.length - 1]; // newest of the agreeing heads, for provenance
    } else if (userHeads.length > 1) {
      conflicts.push({
        subject,
        heads: userHeads.map((e) => e.eventId).sort(),
        proposedParents: userHeads.slice().sort((a, b) => (a.eventId < b.eventId ? -1 : 1)).map((e) => e.parent ?? null),
        lastAgreedParent: lastAgreed,
      });
      chosen = null;
    } else {
      // Several non-user heads disagree (no user head): the newest wins deterministically.
      chosen = candidates[candidates.length - 1];
    }

    const target = chosen ? chosen.parent ?? null : lastAgreed;
    if (target !== null && wouldCycle(parentOf, subject, target)) {
      if (chosen) quarantined.push({ eventId: chosen.eventId, reason: 'placement-would-create-cycle' });
      continue; // keep the previous valid forest: the subject stays where it was (absent = unassigned)
    }
    parentOf.set(subject, target);
    if (chosen) placementSource.set(subject, { source: chosen.source, eventId: chosen.eventId, at: chosen.createdAt });
  }

  return { revision, parentOf, placementSource, frontDoors, effortTitles, conflicts, quarantined };
}

// ── Projection ────────────────────────────────────────────────────────────────────────────

/** A conversation the agent knows about, from the existing inventories (Telegram/Slack/app). */
export interface ConversationSource {
  ref: string;
  platform: 'telegram' | 'slack' | 'app';
  /** EXACTLY the flat list row's `id` (same type and value): ChatView opens the source with it. */
  conversationId: string | number;
  /** EXACTLY the flat list row's `machine`, when it has one (Slack and peer rows need it). */
  machine?: string | null;
  title: string;
  lastActivity: string | null;
}

export type PartialReason = { reason: 'evidence-missing' | 'replica-lag' | 'event-gap'; ref?: string };

export interface ProjectionItem {
  ref: string;
  title: string;
  kind: 'effort' | 'conversation';
  role: 'front-door' | 'worker' | 'unassigned';
  platform?: 'telegram' | 'slack' | 'app';
  primaryPath: Array<{ ref: string; title: string }>;
  visibleChildCount: number;
  digestVersion: string | null;
  sourceFreshness: string | null;
  /** The flat-row descriptor that opens the original transcript through the existing routes. */
  source?: { platform: 'telegram' | 'slack' | 'app'; conversationId: string | number; title: string; machine?: string | null };
}

export interface ProjectionInput {
  graph: ReducedGraph;
  conversations: ConversationSource[];
  /** The viewer predicate: may this viewer see this graph subject? Applied before anything else. */
  mayView: (ref: string) => boolean;
}

/**
 * The viewer's view of the graph. Built once per request (or snapshot) and then sorted, counted,
 * searched and paginated — never the other way round.
 */
export class GraphProjection {
  private readonly visible = new Set<string>();
  private readonly titles = new Map<string, string>();
  private readonly conv = new Map<string, ConversationSource>();
  private readonly children = new Map<string, string[]>();
  private readonly parent = new Map<string, string | null>();

  constructor(private readonly input: ProjectionInput) {
    const { graph, conversations, mayView } = input;
    for (const c of conversations) {
      if (!isConversationRef(c.ref) || !mayView(c.ref)) continue;
      this.visible.add(c.ref);
      this.conv.set(c.ref, c);
      this.titles.set(c.ref, c.title);
    }
    for (const [effort, title] of graph.effortTitles) {
      if (!mayView(effort)) continue;
      this.visible.add(effort);
      this.titles.set(effort, title);
    }
    // A visible subject's parent counts only if the parent is visible too; otherwise the subject
    // surfaces as a root for this viewer and the hidden parent leaves no trace.
    for (const ref of this.visible) {
      const p = graph.parentOf.get(ref) ?? null;
      const visibleParent = p !== null && this.visible.has(p) ? p : null;
      this.parent.set(ref, visibleParent);
      if (visibleParent) {
        const list = this.children.get(visibleParent) ?? [];
        list.push(ref);
        this.children.set(visibleParent, list);
      }
    }
    for (const list of this.children.values()) list.sort((a, b) => this.compare(a, b));
  }

  has(ref: string): boolean { return this.visible.has(ref); }

  private activityOf(ref: string): string {
    const own = this.conv.get(ref)?.lastActivity ?? '';
    const kids = this.children.get(ref) ?? [];
    return kids.reduce((best, k) => { const a = this.activityOf(k); return a > best ? a : best; }, own);
  }

  /** Newest activity first, then ref, so the order is total and stable. */
  private compare(a: string, b: string): number {
    const aa = this.activityOf(a);
    const bb = this.activityOf(b);
    if (aa !== bb) return aa > bb ? -1 : 1;
    return a < b ? -1 : a > b ? 1 : 0;
  }

  private pathOf(ref: string): Array<{ ref: string; title: string }> {
    const out: Array<{ ref: string; title: string }> = [];
    const seen = new Set<string>([ref]);
    let cur = this.parent.get(ref) ?? null;
    while (cur && !seen.has(cur)) {
      seen.add(cur);
      out.unshift({ ref: encodeRef(cur), title: this.titles.get(cur) ?? '' });
      cur = this.parent.get(cur) ?? null;
    }
    return out;
  }

  item(ref: string): ProjectionItem | null {
    if (!this.visible.has(ref)) return null;
    const c = this.conv.get(ref);
    const parent = this.parent.get(ref) ?? null;
    const role: ProjectionItem['role'] = this.input.graph.frontDoors.has(ref)
      ? 'front-door'
      : parent !== null ? 'worker' : 'unassigned';
    const base: ProjectionItem = {
      ref: encodeRef(ref),
      title: this.titles.get(ref) ?? '',
      kind: c ? 'conversation' : 'effort',
      role,
      primaryPath: this.pathOf(ref),
      visibleChildCount: (this.children.get(ref) ?? []).length,
      digestVersion: null,
      sourceFreshness: c?.lastActivity ?? null,
    };
    if (c) {
      base.platform = c.platform;
      base.source = { platform: c.platform, conversationId: c.conversationId, title: c.title };
      if (c.machine !== undefined) base.source.machine = c.machine;
    }
    return base;
  }

  /**
   * Roots for a view. `overview`: front doors, and efforts that are roots for this viewer.
   * `all`: every visible subject that is a root for this viewer, including unassigned
   * conversations, so nothing the viewer may open becomes unreachable.
   * `q` matches titles of the authorized set only.
   */
  roots(view: 'overview' | 'all', q: string | null): string[] {
    const needle = q ? q.trim().toLowerCase() : '';
    const out: string[] = [];
    for (const ref of this.visible) {
      if (needle) {
        if ((this.titles.get(ref) ?? '').toLowerCase().includes(needle)) out.push(ref);
        continue;
      }
      if (this.parent.get(ref) !== null) continue;
      if (view === 'all') { out.push(ref); continue; }
      if (this.input.graph.frontDoors.has(ref) || isEffortRef(ref)) out.push(ref);
    }
    return out.sort((a, b) => this.compare(a, b));
  }

  childrenOf(ref: string): string[] {
    return this.visible.has(ref) ? [...(this.children.get(ref) ?? [])] : [];
  }
}
