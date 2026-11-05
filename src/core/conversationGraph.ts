/**
 * conversationGraph — the pure core of the Conversations hierarchy (increment A, local part).
 * Spec: docs/specs/conversation-effort-hierarchy-v3.md §3.1–3.3, §7.2, §7.5.
 *
 * No I/O lives here. ConversationGraphStore owns the durable event file, EffortHeaderStore owns the
 * erasable titles, and the routes own authentication. This module is deterministic:
 *
 *  1. IDENTITY. A node is a `NodeRef` object (§7.5): an effort `{kind:'effort', id}` or a typed
 *     conversation — Telegram `{chatId, topicId}`, Slack `{channelId, threadTs?}` under the enforced
 *     single-workspace rule, app `{conversationKey}`. Never a local numeric alias. The route
 *     parameter is base64url(canonical JSON NodeRef); responses carry the object itself.
 *
 *  2. EVENTS. Immutable, no user-authored text (titles live in EffortHeaderStore). v1 ops:
 *     `create-effort`, `set-primary-placement` (relation derived from the node kinds, so a
 *     conversation can never contain an effort), `set-front-door` (per effort).
 *
 *  3. AUTHORITY. Each event declares an authority tier — owner > delegation > import > inference —
 *     and carries an authorization receipt reference whose kind must match the tier. The caller
 *     supplies `verify`, which decides whether that receipt is real. An UNVERIFIED event is never
 *     authoritative: it is reported, not reduced. Until receipt verification is wired by the
 *     increment-A owners, every event is unverified and this graph is scaffolding, not state.
 *
 *  4. THE REDUCER depends only on the event set. Rules, in order:
 *     - authority is verified FIRST, per copy: an unverified copy is set aside and can neither
 *       poison nor displace a verified event that shares its id;
 *     - two VERIFIED copies of one id with different bytes: the id is set aside;
 *     - an event naming a predecessor that was never received: HELD (event-gap). A predecessor
 *       that arrived but is unverified counts as known, so an owner can always correct it;
 *     - a replacement counts only when the replacer's tier >= the replaced event's tier, so an
 *       agent event can never dislodge an owner head even if it is causally later;
 *     - the highest-tier heads decide; incompatible OWNER heads are a visible conflict that keeps
 *       the last agreed value = the newest event every conflicting head descends from; disagreeing
 *       concurrent heads below owner tier resolve to the newest, and the losers are reported;
 *     - cycles are resolved by tier (higher tiers apply first), then by age (older first), so the
 *       newer placement that would close a cycle is set aside and its subject falls back to its
 *       previous placement;
 *     - a cycle is reported as a `cycle` conflict with the event that would have closed it;
 *     - a move or unlink of an effort's certified front door is refused and the subject stays
 *       under that effort (§3.2 guard),
 *       and a front door is valid only for a conversation that effort directly coordinates.
 *
 *  5. THE PROJECTION filters by viewer FIRST, then counts, searches, paths and pages.
 */
import crypto from 'node:crypto';

export const GRAPH_EVENT_SCHEMA_VERSION = 1;
export const MAX_GRAPH_EVENT_BYTES = 16 * 1024;

// ── Identity ──────────────────────────────────────────────────────────────────────────────

export type EffortRef = { kind: 'effort'; id: string };
export type TelegramRef = { kind: 'conversation'; platform: 'telegram'; chatId: string; topicId: number };
export type SlackRef = { kind: 'conversation'; platform: 'slack'; channelId: string; threadTs?: string };
export type AppRef = { kind: 'conversation'; platform: 'app'; conversationKey: string };
export type ConversationRef = TelegramRef | SlackRef | AppRef;
export type NodeRef = EffortRef | ConversationRef;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const TG_CHAT_RE = /^-?[1-9][0-9]{0,19}$/;
const SLACK_CHANNEL_RE = /^[CDG][A-Z0-9]{2,30}$/;
const SLACK_TS_RE = /^\d{10}\.\d{6}$/;
const EVENT_ID_RE = /^[A-Za-z0-9_-]{8,80}$/;
const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?Z$/;

function exactKeys(o: Record<string, unknown>, required: string[], optional: string[] = []): boolean {
  const keys = Object.keys(o);
  return required.every((k) => keys.includes(k)) && keys.every((k) => required.includes(k) || optional.includes(k));
}

/** Validate an untrusted NodeRef; returns a fresh object with exactly the allowed fields, or null. */
export function validateNodeRef(raw: unknown): NodeRef | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  if (r.kind === 'effort') {
    if (!exactKeys(r, ['kind', 'id']) || typeof r.id !== 'string' || !UUID_RE.test(r.id)) return null;
    return { kind: 'effort', id: r.id };
  }
  if (r.kind !== 'conversation') return null;
  if (r.platform === 'telegram') {
    if (!exactKeys(r, ['kind', 'platform', 'chatId', 'topicId'])) return null;
    if (typeof r.chatId !== 'string' || !TG_CHAT_RE.test(r.chatId)) return null;
    if (typeof r.topicId !== 'number' || !Number.isSafeInteger(r.topicId) || r.topicId < 1) return null;
    return { kind: 'conversation', platform: 'telegram', chatId: r.chatId, topicId: r.topicId };
  }
  if (r.platform === 'slack') {
    if (!exactKeys(r, ['kind', 'platform', 'channelId'], ['threadTs'])) return null;
    if (typeof r.channelId !== 'string' || !SLACK_CHANNEL_RE.test(r.channelId)) return null;
    if (r.threadTs !== undefined && (typeof r.threadTs !== 'string' || !SLACK_TS_RE.test(r.threadTs))) return null;
    return r.threadTs === undefined
      ? { kind: 'conversation', platform: 'slack', channelId: r.channelId }
      : { kind: 'conversation', platform: 'slack', channelId: r.channelId, threadTs: r.threadTs };
  }
  if (r.platform === 'app') {
    if (!exactKeys(r, ['kind', 'platform', 'conversationKey'])) return null;
    if (typeof r.conversationKey !== 'string' || !UUID_RE.test(r.conversationKey)) return null;
    return { kind: 'conversation', platform: 'app', conversationKey: r.conversationKey };
  }
  return null;
}

/** Canonical JSON: keys sorted at every level, undefined dropped. */
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

/** The internal map key for a node: its canonical JSON. */
export function nodeKey(ref: NodeRef): string { return canonicalJson(ref); }

/** Route parameter form: base64url(canonical JSON NodeRef). */
export function encodeRouteRef(ref: NodeRef): string {
  return Buffer.from(canonicalJson(ref), 'utf8').toString('base64url');
}

/** Decode a route parameter; only the canonical spelling of a valid NodeRef is accepted. */
export function decodeRouteRef(param: unknown): NodeRef | null {
  if (typeof param !== 'string' || param.length === 0 || param.length > 400 || !/^[A-Za-z0-9_-]+$/.test(param)) return null;
  try {
    const ref = validateNodeRef(JSON.parse(Buffer.from(param, 'base64url').toString('utf8')));
    return ref && encodeRouteRef(ref) === param ? ref : null;
  } catch {
    return null;
  }
}

/** The relation a primary placement has, derived from the node kinds (§3.3 invariant 2). */
export function relationFor(subject: NodeRef, parent: NodeRef): 'contains' | 'coordinates' | 'delegates-to' | null {
  if (parent.kind === 'effort') return subject.kind === 'effort' ? 'contains' : 'coordinates';
  return subject.kind === 'conversation' ? 'delegates-to' : null; // a conversation never contains an effort
}

// ── Events ────────────────────────────────────────────────────────────────────────────────

export type Authority = 'owner' | 'delegation' | 'import' | 'inference';
export const AUTHORITY_TIER: Record<Authority, number> = { owner: 3, delegation: 2, import: 1, inference: 0 };

export interface AuthorizationReceiptRef { kind: 'owner-proof' | 'dispatch-record' | 'import-record' | 'inference-candidate'; id: string }

interface EventBase {
  schemaVersion: 1;
  eventId: string;
  subject: NodeRef;
  authority: Authority;
  principal: string;
  receipt: AuthorizationReceiptRef;
  machineId: string;
  createdAt: string;
}
export interface CreateEffortEvent extends EventBase { op: 'create-effort'; projectScope: string[] }
export interface PlacementEvent extends EventBase {
  op: 'set-primary-placement';
  parent: NodeRef | null;
  relation: 'contains' | 'coordinates' | 'delegates-to' | null;
  replacesPlacementEventIds: string[];
}
export interface FrontDoorEvent extends EventBase {
  op: 'set-front-door';
  frontDoor: ConversationRef | null;
  replacesFrontDoorEventIds: string[];
  /**
   * The front-door conversation's placement heads the owner observed when choosing it (empty when
   * clearing). The choice is eligible only if those heads put the conversation directly under this
   * effort, and the guard is causal: a placement outside their history cannot move it away,
   * whatever time it claims.
   */
  observedPlacementEventIds: string[];
}
export type GraphEvent = CreateEffortEvent | PlacementEvent | FrontDoorEvent;

const RECEIPT_FOR: Record<Authority, AuthorizationReceiptRef['kind']> = {
  owner: 'owner-proof', delegation: 'dispatch-record', import: 'import-record', inference: 'inference-candidate',
};

function idList(raw: unknown): string[] | null {
  if (!Array.isArray(raw) || raw.length > 32) return null;
  if (raw.some((id) => typeof id !== 'string' || !EVENT_ID_RE.test(id))) return null;
  return [...new Set(raw as string[])].sort();
}

/** Validate an untrusted event (from disk, a peer, or a route). Off-schema → null. */
export function validateGraphEvent(raw: unknown): GraphEvent | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const e = raw as Record<string, unknown>;
  if (e.schemaVersion !== GRAPH_EVENT_SCHEMA_VERSION) return null;
  if (typeof e.eventId !== 'string' || !EVENT_ID_RE.test(e.eventId)) return null;
  const subject = validateNodeRef(e.subject);
  if (!subject) return null;
  if (typeof e.authority !== 'string' || !Object.prototype.hasOwnProperty.call(AUTHORITY_TIER, e.authority)) return null;
  const authority = e.authority as Authority;
  if (typeof e.principal !== 'string' || e.principal.length === 0 || e.principal.length > 120) return null;
  const rc = e.receipt as Record<string, unknown> | null;
  if (!rc || typeof rc !== 'object' || Array.isArray(rc) || !exactKeys(rc, ['kind', 'id'])) return null;
  if (rc.kind !== RECEIPT_FOR[authority]) return null; // the receipt kind must match the claimed tier
  if (typeof rc.id !== 'string' || rc.id.length === 0 || rc.id.length > 200) return null;
  if (typeof e.machineId !== 'string' || e.machineId.length === 0 || e.machineId.length > 120) return null;
  if (typeof e.createdAt !== 'string' || !ISO_RE.test(e.createdAt) || Number.isNaN(Date.parse(e.createdAt))) return null;
  const base: EventBase = {
    schemaVersion: 1, eventId: e.eventId, subject, authority, principal: e.principal,
    receipt: { kind: RECEIPT_FOR[authority], id: rc.id },
    machineId: e.machineId, createdAt: e.createdAt,
  };
  if (e.op === 'create-effort') {
    if (subject.kind !== 'effort' || authority !== 'owner') return null;
    if (!Array.isArray(e.projectScope) || e.projectScope.length > 32 ||
      e.projectScope.some((p) => typeof p !== 'string' || p.length === 0 || p.length > 120)) return null;
    return { ...base, op: 'create-effort', projectScope: [...new Set(e.projectScope as string[])].sort() };
  }
  if (e.op === 'set-primary-placement') {
    const replaces = idList(e.replacesPlacementEventIds);
    if (!replaces) return null;
    let parent: NodeRef | null = null;
    if (e.parent !== null) {
      parent = validateNodeRef(e.parent);
      if (!parent || nodeKey(parent) === nodeKey(subject)) return null;
    }
    const relation = parent ? relationFor(subject, parent) : null;
    if (parent && !relation) return null; // an effort under a conversation
    if ((e.relation ?? null) !== relation) return null;
    // Delegation may only place a worker conversation under its coordinating conversation (§3.2).
    if (authority === 'delegation' && relation !== 'delegates-to') return null;
    return { ...base, op: 'set-primary-placement', parent, relation, replacesPlacementEventIds: replaces };
  }
  if (e.op === 'set-front-door') {
    if (subject.kind !== 'effort' || authority !== 'owner') return null;
    const replaces = idList(e.replacesFrontDoorEventIds);
    const observed = idList(e.observedPlacementEventIds);
    if (!replaces || !observed) return null;
    let frontDoor: ConversationRef | null = null;
    if (e.frontDoor !== null) {
      const fd = validateNodeRef(e.frontDoor);
      if (!fd || fd.kind !== 'conversation') return null;
      frontDoor = fd;
    }
    // Choosing a front door must name what was observed; clearing one names nothing.
    if ((frontDoor !== null) !== (observed.length > 0)) return null;
    return { ...base, op: 'set-front-door', frontDoor, replacesFrontDoorEventIds: replaces, observedPlacementEventIds: observed };
  }
  return null;
}

export function graphEventHash(event: GraphEvent): string { return sha256Hex(canonicalJson(event)); }

// ── Reducer ───────────────────────────────────────────────────────────────────────────────

export type SetAsideReason =
  | 'duplicate-event-id-different-payload'
  | 'unverified-authority'
  | 'missing-replaced-event'
  | 'placement-would-create-cycle'
  | 'front-door-guard'
  | 'front-door-not-coordinated'
  | 'front-door-observation-invalid'
  | 'concurrent-lower-tier-head';

export interface Conflict {
  /** 'cycle' and 'agent-heads' are informational: the reducer already chose, and says why. */
  kind: 'placement' | 'front-door' | 'cycle' | 'agent-heads';
  subject: NodeRef;
  heads: string[];
  lastAgreed: NodeRef | null;
}

export interface ReducedGraph {
  /** sha256 over the sorted (eventId, hash) pairs of every event that was eligible to apply. */
  revision: string;
  efforts: Map<string, { ref: EffortRef; projectScope: string[] }>;
  /** node key -> current primary parent (null = root). Subjects never placed are absent. */
  parentOf: Map<string, NodeRef | null>;
  placementSource: Map<string, { authority: Authority; eventId: string; at: string }>;
  /** effort key -> its certified front-door conversation. */
  frontDoorOf: Map<string, ConversationRef>;
  conflicts: Conflict[];
  setAside: Array<{ eventId: string; reason: SetAsideReason }>;
  /** Held or unverified events make any projection built on this graph partial. */
  partial: { eventGap: boolean; evidenceMissing: boolean };
}

export interface ReduceOptions {
  /** Is this event's authorization receipt real? Until wired, nothing is verified. */
  verify: (event: GraphEvent) => boolean;
}

function order(a: GraphEvent, b: GraphEvent): number {
  return a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : a.eventId < b.eventId ? -1 : a.eventId > b.eventId ? 1 : 0;
}

/** Resolve one subject's chain of replacing events into a winner, or an owner conflict. */
function resolveChain<E extends GraphEvent>(
  list: E[], replacesOf: (e: E) => string[], valueOf: (e: E) => NodeRef | null,
): { winner: E | null; conflictHeads: E[] | null; lastAgreed: E | null; losingHeads: E[] } {
  const byId = new Map(list.map((e) => [e.eventId, e]));
  // A replacement edge counts only from an equal-or-higher tier.
  const validReplaces = (e: E) => replacesOf(e).filter((r) => {
    const target = byId.get(r);
    return target !== undefined && AUTHORITY_TIER[e.authority] >= AUTHORITY_TIER[target.authority];
  });
  const replaced = new Set<string>();
  for (const e of list) for (const r of validReplaces(e)) replaced.add(r);
  const heads = list.filter((e) => !replaced.has(e.eventId)).sort(order);
  if (heads.length === 0) return { winner: null, conflictHeads: null, lastAgreed: null, losingHeads: [] };
  const top = Math.max(...heads.map((h) => AUTHORITY_TIER[h.authority]));
  const topHeads = heads.filter((h) => AUTHORITY_TIER[h.authority] === top);
  const values = new Set(topHeads.map((h) => { const v = valueOf(h); return v ? nodeKey(v) : 'null'; }));
  if (values.size === 1 || top < AUTHORITY_TIER.owner) {
    const winner = topHeads[topHeads.length - 1];
    // Disagreeing concurrent heads below owner tier: the newest wins, and the losers are reported.
    const losingHeads = values.size === 1 ? [] : topHeads.slice(0, -1);
    return { winner, conflictHeads: null, lastAgreed: null, losingHeads };
  }
  // Incompatible owner heads: last agreed = the newest event every conflicting head descends from.
  const ancestors = (e: E): Set<string> => {
    const out = new Set<string>();
    const stack = [...validReplaces(e)];
    while (stack.length) {
      const id = stack.pop()!;
      if (out.has(id)) continue;
      out.add(id);
      const ev = byId.get(id);
      if (ev) stack.push(...validReplaces(ev));
    }
    return out;
  };
  const sets = topHeads.map(ancestors);
  const common = [...sets[0]].filter((id) => sets.every((s) => s.has(id))).map((id) => byId.get(id)!).sort(order);
  return { winner: null, conflictHeads: topHeads, lastAgreed: common.length ? common[common.length - 1] : null, losingHeads: [] };
}

function closesCycle(parentOf: Map<string, NodeRef | null>, subjectKey: string, parent: NodeRef | null): boolean {
  let cur = parent;
  const seen = new Set<string>();
  while (cur) {
    const k = nodeKey(cur);
    if (k === subjectKey || seen.has(k)) return true;
    seen.add(k);
    cur = parentOf.get(k) ?? null;
  }
  return false;
}

function groupBy<E extends GraphEvent>(events: E[]): Map<string, E[]> {
  const out = new Map<string, E[]>();
  for (const e of events) {
    const k = nodeKey(e.subject);
    const list = out.get(k);
    if (list) list.push(e); else out.set(k, [e]);
  }
  return out;
}

export function reduceGraph(events: GraphEvent[], opts: ReduceOptions): ReducedGraph {
  const setAside: ReducedGraph['setAside'] = [];
  const partial = { eventGap: false, evidenceMissing: false };

  // 1. Verify FIRST, per copy: an unverified copy can never poison or displace a verified one.
  const received = new Set<string>(); // every event id this machine has seen, verified or not
  const verified: GraphEvent[] = [];
  const unverifiedCopies = new Map<string, string>(); // `${id}:${hash}` -> id, for reporting
  for (const ev of [...events].sort(order)) {
    received.add(ev.eventId);
    if (opts.verify(ev)) verified.push(ev);
    else unverifiedCopies.set(`${ev.eventId}:${graphEventHash(ev)}`, ev.eventId);
  }

  // 2. Union verified copies by id; two VERIFIED copies with different bytes poison the id.
  const byId = new Map<string, GraphEvent>();
  const hashOf = new Map<string, string>();
  const poisoned = new Set<string>();
  for (const ev of verified) {
    const h = graphEventHash(ev);
    const prior = hashOf.get(ev.eventId);
    if (prior === undefined) { byId.set(ev.eventId, ev); hashOf.set(ev.eventId, h); } else if (prior !== h) poisoned.add(ev.eventId);
  }
  for (const id of [...poisoned].sort()) { byId.delete(id); setAside.push({ eventId: id, reason: 'duplicate-event-id-different-payload' }); }
  // Every unverified copy is reported — including a forged copy that reuses a verified event's id.
  for (const key of [...unverifiedCopies.keys()].sort()) setAside.push({ eventId: unverifiedCopies.get(key)!, reason: 'unverified-authority' });
  if (unverifiedCopies.size > 0) partial.evidenceMissing = true;

  // 3. Hold an event only when a predecessor it names was never RECEIVED. A predecessor that
  //    arrived but is unverified or poisoned is known: naming it is enough for an owner to
  //    correct it, so a lower-tier or forged event can never hold an owner correction.
  for (const ev of [...byId.values()].sort(order)) {
    const reps = ev.op === 'set-primary-placement' ? ev.replacesPlacementEventIds
      : ev.op === 'set-front-door' ? [...ev.replacesFrontDoorEventIds, ...ev.observedPlacementEventIds] : [];
    if (reps.some((r) => !received.has(r))) {
      byId.delete(ev.eventId);
      setAside.push({ eventId: ev.eventId, reason: 'missing-replaced-event' });
      partial.eventGap = true;
    }
  }

  const accepted = [...byId.values()].sort(order);
  const revision = sha256Hex(accepted.map((e) => `${e.eventId}:${hashOf.get(e.eventId)}`).sort().join('\n'));

  const efforts = new Map<string, { ref: EffortRef; projectScope: string[] }>();
  for (const e of accepted) {
    if (e.op === 'create-effort' && !efforts.has(nodeKey(e.subject))) efforts.set(nodeKey(e.subject), { ref: e.subject as EffortRef, projectScope: e.projectScope });
  }
  const conflicts: Conflict[] = [];

  // 4. Front doors first (owner-only), so the placement guard can see them.
  const chosenFrontDoor = new Map<string, ConversationRef>();
  const chosenFrontDoorEvent = new Map<string, FrontDoorEvent>(); // effort key -> the deciding event
  const fdByEffort = groupBy(accepted.filter((e): e is FrontDoorEvent => e.op === 'set-front-door'));
  for (const [key, list] of fdByEffort) {
    const r = resolveChain(list, (e) => e.replacesFrontDoorEventIds, (e) => e.frontDoor);
    if (r.conflictHeads) {
      conflicts.push({ kind: 'front-door', subject: list[0].subject, heads: r.conflictHeads.map((h) => h.eventId).sort(), lastAgreed: r.lastAgreed?.frontDoor ?? null });
      if (r.lastAgreed?.frontDoor) { chosenFrontDoor.set(key, r.lastAgreed.frontDoor); chosenFrontDoorEvent.set(key, r.lastAgreed); }
    } else if (r.winner?.frontDoor) { chosenFrontDoor.set(key, r.winner.frontDoor); chosenFrontDoorEvent.set(key, r.winner); }
  }
  // The guard is CAUSAL. A front-door choice names the conversation's placement heads it observed.
  // It is eligible only if every observed head put the conversation directly under this effort; a
  // conversation the owner had already moved away is simply an invalid front door (step 6). Once
  // eligible, a placement of that conversation that is not in the observed history (the heads and
  // everything they replace) and does not keep it under the effort is refused — whatever time it
  // claims, so a backdated or late-replicated dispatch cannot move a certified front door.
  const placementsOf = groupBy(accepted.filter((e): e is PlacementEvent => e.op === 'set-primary-placement'));
  const placementById = new Map<string, PlacementEvent>();
  for (const list of placementsOf.values()) for (const e of list) placementById.set(e.eventId, e);
  const frontDoorEffortOf = new Map<string, { key: string; ref: EffortRef; seen: Set<string> }>();
  const invalidObservation = new Set<string>(); // effort keys whose choice named foreign/unverified heads
  for (const [effortKey, conv] of chosenFrontDoor) {
    const ev = chosenFrontDoorEvent.get(effortKey)!;
    const convKey = nodeKey(conv);
    const heads = ev.observedPlacementEventIds.map((id) => placementById.get(id));
    // A head that is not an accepted placement of THIS conversation (foreign, unverified, or
    // poisoned) means the choice cannot be guarded here, so it is not certified either.
    if (heads.length === 0 || heads.some((h) => !h || nodeKey(h.subject) !== convKey)) { invalidObservation.add(effortKey); continue; }
    const seen = new Set<string>();
    const stack = [...ev.observedPlacementEventIds];
    while (stack.length) {
      const id = stack.pop()!;
      if (seen.has(id)) continue;
      seen.add(id);
      const e = placementById.get(id);
      if (e) stack.push(...e.replacesPlacementEventIds);
    }
    // Where the observed history put the conversation: resolved exactly as the reducer resolves it.
    const observedChain = (placementsOf.get(convKey) ?? []).filter((e) => seen.has(e.eventId));
    const asOf = resolveChain(observedChain, (e) => e.replacesPlacementEventIds, (e) => e.parent);
    const parentThen = asOf.conflictHeads ? asOf.lastAgreed?.parent ?? null : asOf.winner?.parent ?? null;
    if (!parentThen || nodeKey(parentThen) !== effortKey) continue;
    frontDoorEffortOf.set(convKey, { key: effortKey, ref: ev.subject as EffortRef, seen });
  }

  // 5. Placements: resolve per subject, then apply highest tier first.
  type Plan = { key: string; subject: NodeRef; target: NodeRef | null; tier: number; at: string; event: PlacementEvent | null; fallback: NodeRef | null };
  const plans: Plan[] = [];
  for (const [key, list] of placementsOf) {
    const r = resolveChain(list, (e) => e.replacesPlacementEventIds, (e) => e.parent);
    if (r.losingHeads.length > 0) {
      for (const h of r.losingHeads) setAside.push({ eventId: h.eventId, reason: 'concurrent-lower-tier-head' });
      conflicts.push({ kind: 'agent-heads', subject: list[0].subject, heads: [...r.losingHeads, r.winner!].map((h) => h.eventId).sort(), lastAgreed: r.winner!.parent });
    }
    if (r.conflictHeads) {
      conflicts.push({ kind: 'placement', subject: list[0].subject, heads: r.conflictHeads.map((h) => h.eventId).sort(), lastAgreed: r.lastAgreed?.parent ?? null });
      plans.push({ key, subject: list[0].subject, target: r.lastAgreed?.parent ?? null, tier: AUTHORITY_TIER.owner, at: r.lastAgreed?.createdAt ?? '', event: null, fallback: null });
    } else if (r.winner) {
      const winner = r.winner;
      const prev = list.filter((e) => winner.replacesPlacementEventIds.includes(e.eventId)).sort(order).pop();
      plans.push({ key, subject: winner.subject, target: winner.parent, tier: AUTHORITY_TIER[winner.authority], at: winner.createdAt, event: winner, fallback: prev?.parent ?? null });
    }
  }
  // Higher tiers first; within a tier the OLDER placement first, so an established edge is the
  // "previous valid tree" and the newer edge that would close a cycle is the one set aside.
  plans.sort((a, b) => b.tier - a.tier || (a.at < b.at ? -1 : a.at > b.at ? 1 : 0) || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));

  const parentOf = new Map<string, NodeRef | null>();
  const placementSource = new Map<string, { authority: Authority; eventId: string; at: string }>();
  for (const p of plans) {
    let target = p.target;
    // §3.2 guard: a move or unlink of an effort's certified front door is REFUSED — the subject
    // stays directly under that effort, exactly as before the refused event.
    const fd = frontDoorEffortOf.get(p.key);
    if (fd && (target === null || nodeKey(target) !== fd.key) && (p.event === null || !fd.seen.has(p.event.eventId))) {
      if (p.event) setAside.push({ eventId: p.event.eventId, reason: 'front-door-guard' });
      target = fd.ref;
    }
    if (target && closesCycle(parentOf, p.key, target)) {
      if (p.event) setAside.push({ eventId: p.event.eventId, reason: 'placement-would-create-cycle' });
      const fallback = p.fallback && !closesCycle(parentOf, p.key, p.fallback) ? p.fallback : null;
      conflicts.push({ kind: 'cycle', subject: p.subject, heads: p.event ? [p.event.eventId] : [], lastAgreed: fallback });
      target = fallback;
      if (target === null) continue;
    }
    parentOf.set(p.key, target);
    if (p.event && target === p.event.parent) placementSource.set(p.key, { authority: p.event.authority, eventId: p.event.eventId, at: p.event.createdAt });
  }

  // 6. A front door is certified only if its choice passed the guard's eligibility check AND the
  //    effort directly coordinates the conversation now. Certified always means guarded.
  const frontDoorOf = new Map<string, ConversationRef>();
  for (const [effortKey, conv] of chosenFrontDoor) {
    const guarded = frontDoorEffortOf.get(nodeKey(conv));
    const parent = parentOf.get(nodeKey(conv));
    if (guarded && guarded.key === effortKey && parent && nodeKey(parent) === effortKey) { frontDoorOf.set(effortKey, conv); continue; }
    const ev = chosenFrontDoorEvent.get(effortKey);
    if (ev) setAside.push({ eventId: ev.eventId, reason: invalidObservation.has(effortKey) ? 'front-door-observation-invalid' : 'front-door-not-coordinated' });
  }

  return { revision, efforts, parentOf, placementSource, frontDoorOf, conflicts, setAside, partial };
}

// ── Projection ────────────────────────────────────────────────────────────────────────────

/** A conversation the agent knows about, from the existing inventories. */
export interface ConversationSource {
  ref: ConversationRef;
  /** EXACTLY the flat list row's `id` (same type and value): ChatView opens the source with it. */
  conversationId: string | number;
  /** EXACTLY the flat list row's `machine`, when it has one. */
  machine?: string | null;
  title: string;
  lastActivity: string | null;
}

export type PartialReason = { reason: 'evidence-missing' | 'replica-lag' | 'event-gap' };

export interface ProjectionItem {
  ref: NodeRef;
  title: string;
  kind: 'effort' | 'conversation';
  role: 'effort' | 'front-door' | 'worker' | 'unassigned';
  primaryPath: Array<{ ref: NodeRef; title: string }>;
  visibleChildCount: number;
  digestVersion: string | null;
  sourceFreshness: string | null;
  source?: { platform: ConversationRef['platform']; conversationId: string | number; title: string; machine?: string | null };
  /**
   * Effort items only. `frontDoor` is present ONLY when this machine's reducer certified it (verified
   * owner choice, guarded, currently coordinated) AND the viewer may see that conversation. It is
   * local certification, not an all-member commit: while partialReasons includes replica-lag it
   * must not be presented as committed on every device.
   */
  metadata?: { frontDoor?: ConversationRef };
}

export interface ProjectionInput {
  graph: ReducedGraph;
  conversations: ConversationSource[];
  /** Effort titles from EffortHeaderStore (a forgotten header returns null). */
  effortTitle: (effort: EffortRef) => string | null;
  /** The viewer predicate, applied before anything else. */
  mayView: (ref: NodeRef) => boolean;
}

export class GraphProjection {
  private readonly visible = new Map<string, NodeRef>();
  private readonly titles = new Map<string, string>();
  private readonly conv = new Map<string, ConversationSource>();
  private readonly children = new Map<string, string[]>();
  private readonly parent = new Map<string, string | null>();
  private readonly activity = new Map<string, string>();

  constructor(private readonly input: ProjectionInput) {
    const { graph, conversations, effortTitle, mayView } = input;
    for (const c of conversations) {
      const ref = validateNodeRef(c.ref);
      if (!ref || ref.kind !== 'conversation' || !mayView(ref)) continue;
      const k = nodeKey(ref);
      this.visible.set(k, ref);
      this.conv.set(k, c);
      this.titles.set(k, c.title);
    }
    for (const [k, e] of graph.efforts) {
      if (!mayView(e.ref)) continue;
      this.visible.set(k, e.ref);
      this.titles.set(k, effortTitle(e.ref) ?? '');
    }
    for (const k of this.visible.keys()) {
      const p = graph.parentOf.get(k) ?? null;
      const pk = p ? nodeKey(p) : null;
      const visibleParent = pk !== null && this.visible.has(pk) ? pk : null;
      this.parent.set(k, visibleParent);
      if (visibleParent) {
        const list = this.children.get(visibleParent);
        if (list) list.push(k); else this.children.set(visibleParent, [k]);
      }
    }
    for (const k of this.visible.keys()) this.activityOf(k, new Set());
    for (const list of this.children.values()) list.sort((a, b) => this.compare(a, b));
  }

  has(ref: NodeRef): boolean { return this.visible.has(nodeKey(ref)); }

  private activityOf(k: string, seen: Set<string>): string {
    const cached = this.activity.get(k);
    if (cached !== undefined) return cached;
    if (seen.has(k)) return '';
    seen.add(k);
    let best = this.conv.get(k)?.lastActivity ?? '';
    for (const c of this.children.get(k) ?? []) { const a = this.activityOf(c, seen); if (a > best) best = a; }
    this.activity.set(k, best);
    return best;
  }

  private compare(a: string, b: string): number {
    const aa = this.activity.get(a) ?? '';
    const bb = this.activity.get(b) ?? '';
    if (aa !== bb) return aa > bb ? -1 : 1;
    return a < b ? -1 : a > b ? 1 : 0;
  }

  private pathOf(k: string): Array<{ ref: NodeRef; title: string }> {
    const out: Array<{ ref: NodeRef; title: string }> = [];
    const seen = new Set<string>([k]);
    let cur = this.parent.get(k) ?? null;
    while (cur && !seen.has(cur)) {
      seen.add(cur);
      out.unshift({ ref: this.visible.get(cur)!, title: this.titles.get(cur) ?? '' });
      cur = this.parent.get(cur) ?? null;
    }
    return out;
  }

  item(ref: NodeRef): ProjectionItem | null {
    const k = nodeKey(ref);
    const node = this.visible.get(k);
    if (!node) return null;
    const c = this.conv.get(k);
    const parentKey = this.parent.get(k) ?? null;
    const fd = parentKey !== null ? this.input.graph.frontDoorOf.get(parentKey) : undefined;
    const role: ProjectionItem['role'] = node.kind === 'effort'
      ? 'effort'
      : fd !== undefined && nodeKey(fd) === k ? 'front-door' : parentKey !== null ? 'worker' : 'unassigned';
    const item: ProjectionItem = {
      ref: node,
      title: this.titles.get(k) ?? '',
      kind: node.kind,
      role,
      primaryPath: this.pathOf(k),
      visibleChildCount: (this.children.get(k) ?? []).length,
      digestVersion: null,
      sourceFreshness: c?.lastActivity ?? null,
    };
    if (c) {
      item.source = { platform: c.ref.platform, conversationId: c.conversationId, title: c.title };
      if (c.machine !== undefined) item.source.machine = c.machine;
    }
    if (node.kind === 'effort') {
      const fd = this.input.graph.frontDoorOf.get(k);
      item.metadata = fd && this.visible.has(nodeKey(fd)) ? { frontDoor: fd } : {};
    }
    return item;
  }

  /**
   * `overview`: efforts that are roots for this viewer.
   * `all`: EVERY visible node — efforts, front doors, workers and unassigned conversations — so
   * nothing the viewer may open is unreachable from All.
   * `q` matches titles of the authorized set only.
   */
  list(view: 'overview' | 'all', q: string | null): NodeRef[] {
    const needle = q ? q.trim().toLowerCase() : '';
    const out: string[] = [];
    for (const [k, ref] of this.visible) {
      if (needle) { if ((this.titles.get(k) ?? '').toLowerCase().includes(needle)) out.push(k); continue; }
      if (view === 'all' || (ref.kind === 'effort' && this.parent.get(k) === null)) out.push(k);
    }
    return out.sort((a, b) => this.compare(a, b)).map((k) => this.visible.get(k)!);
  }

  childrenOf(ref: NodeRef): NodeRef[] {
    const k = nodeKey(ref);
    return this.visible.has(k) ? (this.children.get(k) ?? []).map((c) => this.visible.get(c)!) : [];
  }

  partialReasons(): PartialReason[] {
    const out: PartialReason[] = [{ reason: 'replica-lag' }]; // replication is not wired in this slice
    if (this.input.graph.partial.eventGap) out.push({ reason: 'event-gap' });
    if (this.input.graph.partial.evidenceMissing) out.push({ reason: 'evidence-missing' });
    return out;
  }
}
