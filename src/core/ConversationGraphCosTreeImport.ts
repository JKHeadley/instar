/**
 * Chief of Staff tree -> conversation graph, the import authority (work-front-doors §3.1 and §7 stage 2;
 * conversation-effort-hierarchy-v3 §3 authority tiers owner > delegation > import > inference).
 *
 * Pure: no I/O. The runner (src/server/ConversationGraphCosTreeImporter.ts) reads the stores and submits.
 *
 *  - A tree record "child -> project conversation" becomes ONE import-tier `set-primary-placement` of the
 *    child under the effort whose CERTIFIED front door is that project conversation (only an owner
 *    `set-front-door` makes one: the owner accepted that project as an effort, stage 2b).
 *  - It is emitted only when the child has NO placement event at all (certified or pending), and it
 *    replaces nothing (the validator refuses any other import placement), so it never displaces a
 *    placement and an owner placement or removal always wins.
 *  - The event id and receipt id are derived from the import source, so a re-run names the same event.
 *  - Verification is pure: the proof carries the source, and the core must be exactly what that source
 *    derives. The writer ties the source to the live replicated CoS record before it signs.
 */
import {
  canonicalJson, sha256Hex, nodeKey, validateNodeRef,
  type ConversationRef, type EffortRef, type GraphEvent, type NodeRef, type PlacementEvent, type ReducedGraph,
} from './conversationGraph.js';

export const COS_TREE_IMPORT_PRINCIPAL = 'chief-of-staff-tree-import';
export const COS_TREE_IMPORT_METHOD = 'cos-tree-import';
/** At most this many imports per run, so one run never floods the witness. */
export const COS_TREE_IMPORT_MAX_PER_RUN = 25;

const KEY_RE = /^(telegram|app|slack|imessage|whatsapp):[A-Za-z0-9_.:-]{1,128}$/;
const MACHINE_RE = /^[A-Za-z0-9_.:@-]{1,120}$/;
const EVENT_ID_RE = /^[A-Za-z0-9_-]{8,80}$/;
const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

/** A live tree record as the CoS store folds it, with the identity of the write that set it. */
export interface CosTreeRecordInput {
  conversationKey: string;
  parentConversationKey: string | null;
  role?: 'chief-of-staff' | 'project' | 'sub-topic';
  hlc: { physical: number; logical: number; node: string };
  origin: string;
}

/** What an import event was made from: carried in the authorization proof and hashed into its ids. */
export interface CosTreeImportSource {
  v: 1;
  kind: 'cos-tree-import-source';
  agentId: string;
  /** The tree record: its key (the child), its parent key (the project conversation) and the write's identity. */
  childKey: string;
  parentKey: string;
  treeHlc: { physical: number; logical: number; node: string };
  treeOrigin: string;
  /** The child and project conversations as graph refs. */
  child: ConversationRef;
  frontDoor: ConversationRef;
  /** The effort whose certified front door is the project conversation, and the owner event that chose it. */
  effort: EffortRef;
  frontDoorEventId: string;
  /** The writer, its graph lease epoch and the event time. In the ids, so two writers (a failover) never make two
   *  different events with ONE id (that would fork the source tail); the same writer re-running makes identical bytes. */
  writerId: string;
  leaseEpoch: number;
  createdAt: string;
}

function exactKeys(o: Record<string, unknown>, keys: string[]): boolean {
  return Object.keys(o).sort().join(',') === [...keys].sort().join(',');
}
const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);

/** Does a CoS conversation key name this graph conversation? (No chat id needed: the ref carries it.) */
export function cosKeyMatchesRef(key: string, ref: ConversationRef): boolean {
  const t = /^telegram:(\d+)$/.exec(key);
  if (t) return ref.platform === 'telegram' && ref.topicId === Number(t[1]);
  const a = /^app:([A-Za-z0-9_.:-]{1,200})$/.exec(key);
  if (a) return ref.platform === 'app' && ref.conversationKey === a[1];
  return false;
}

/** The ref for a CoS key, as stage 2b maps it (Telegram needs the agent's chat id; other kinds have none yet). */
export function cosKeyToRef(key: string, telegramChatId: string): ConversationRef | null {
  const t = /^telegram:(\d+)$/.exec(key);
  if (t && telegramChatId) return validateConversation({ kind: 'conversation', platform: 'telegram', chatId: telegramChatId, topicId: Number(t[1]) });
  const a = /^app:([A-Za-z0-9_.:-]{1,200})$/.exec(key);
  if (a) return validateConversation({ kind: 'conversation', platform: 'app', conversationKey: a[1] });
  return null;
}
function validateConversation(raw: unknown): ConversationRef | null {
  const ref = validateNodeRef(raw);
  return ref && ref.kind === 'conversation' ? ref : null;
}

/** Strict shape check of an untrusted import source. */
export function validateCosTreeImportSource(raw: unknown): CosTreeImportSource | null {
  if (!isObj(raw) || !exactKeys(raw, ['v', 'kind', 'agentId', 'childKey', 'parentKey', 'treeHlc', 'treeOrigin', 'child', 'frontDoor', 'effort', 'frontDoorEventId', 'writerId', 'leaseEpoch', 'createdAt'])) return null;
  if (raw.v !== 1 || raw.kind !== 'cos-tree-import-source') return null;
  if (typeof raw.agentId !== 'string' || !MACHINE_RE.test(raw.agentId)) return null;
  if (typeof raw.childKey !== 'string' || !KEY_RE.test(raw.childKey) || typeof raw.parentKey !== 'string' || !KEY_RE.test(raw.parentKey)) return null;
  if (raw.childKey === raw.parentKey) return null;
  const h = raw.treeHlc;
  if (!isObj(h) || !exactKeys(h, ['physical', 'logical', 'node']) || !Number.isSafeInteger(h.physical) || (h.physical as number) < 0
    || !Number.isSafeInteger(h.logical) || (h.logical as number) < 0 || typeof h.node !== 'string' || !MACHINE_RE.test(h.node)) return null;
  if (typeof raw.treeOrigin !== 'string' || !MACHINE_RE.test(raw.treeOrigin)) return null;
  const child = validateConversation(raw.child), frontDoor = validateConversation(raw.frontDoor);
  if (!child || !frontDoor || canonicalJson(child) !== canonicalJson(raw.child) || canonicalJson(frontDoor) !== canonicalJson(raw.frontDoor)) return null;
  if (!cosKeyMatchesRef(raw.childKey, child) || !cosKeyMatchesRef(raw.parentKey, frontDoor) || nodeKey(child) === nodeKey(frontDoor)) return null;
  const effort = validateNodeRef(raw.effort);
  if (!effort || effort.kind !== 'effort' || canonicalJson(effort) !== canonicalJson(raw.effort)) return null;
  if (typeof raw.frontDoorEventId !== 'string' || !EVENT_ID_RE.test(raw.frontDoorEventId)) return null;
  if (typeof raw.writerId !== 'string' || !MACHINE_RE.test(raw.writerId) || !Number.isSafeInteger(raw.leaseEpoch) || (raw.leaseEpoch as number) < 0) return null;
  if (typeof raw.createdAt !== 'string' || !ISO_RE.test(raw.createdAt) || Number.isNaN(Date.parse(raw.createdAt))) return null;
  return raw as unknown as CosTreeImportSource;
}

export function cosTreeImportSourceHash(source: CosTreeImportSource): string {
  return sha256Hex(`instar:conversation-graph:cos-tree-import:v1\n${canonicalJson(source)}`);
}
/** Deterministic: the same tree record, mapping and agent always name the same event. */
export function cosTreeImportEventId(source: CosTreeImportSource): string { return `cos-import-${cosTreeImportSourceHash(source)}`; }
export function cosTreeImportReceiptId(source: CosTreeImportSource): string { return `cos-tree:${cosTreeImportSourceHash(source)}`; }
export function cosTreeImportIdempotencyKey(source: CosTreeImportSource): string { return `cos-tree-import:${cosTreeImportSourceHash(source)}`; }

/** The one import event a source yields (written by its writer at its time). */
export function cosTreeImportCore(source: CosTreeImportSource): PlacementEvent {
  return {
    schemaVersion: 1, eventId: cosTreeImportEventId(source), subject: structuredClone(source.child), authority: 'import',
    principal: COS_TREE_IMPORT_PRINCIPAL, receipt: { kind: 'import-record', id: cosTreeImportReceiptId(source) },
    machineId: source.writerId, createdAt: source.createdAt, op: 'set-primary-placement', parent: structuredClone(source.effort), relation: 'coordinates',
    replacesPlacementEventIds: [],
  };
}

/**
 * Receive-side, pure: the core is exactly the import event this source yields, for this agent, written by the
 * writer the receipt names. Anything else is not an import (refused, never reduced).
 */
export function verifyCosTreeImportCoreSource(core: unknown, raw: unknown, agentId: string, writerId: string, leaseEpoch: number): boolean {
  try {
    const source = validateCosTreeImportSource(raw);
    if (!source || source.agentId !== agentId || source.writerId !== writerId || source.leaseEpoch !== leaseEpoch || !isObj(core)) return false;
    return canonicalJson(core) === canonicalJson(cosTreeImportCore(source));
  } catch { /* @silent-fallback-ok — a malformed import source is a negative verification result, never an import. */ return false; }
}

export type CosTreeImportSkip =
  | 'no-parent' | 'chief-of-staff-root' | 'unmapped-key' | 'project-not-accepted' | 'front-door-unsettled'
  | 'already-placed' | 'change-pending' | 'already-imported' | 'is-front-door' | 'unknown-conversation' | 'project-scope';

export interface CosTreeImportPlanInput {
  agentId: string;
  /** The writer that would sign (this machine), its graph lease epoch, and its lease start (ms). */
  writerId: string;
  leaseEpoch: number;
  leaseStartMs: number;
  telegramChatId: string;
  /** Live tree records only (a tombstoned record is not here, so it emits nothing). */
  tree: CosTreeRecordInput[];
  /** The reduced CERTIFIED graph. */
  graph: ReducedGraph;
  /** Node keys of subjects with a placement event not yet certified (any origin): wait for it. */
  pendingSubjects: ReadonlySet<string>;
  /** Every graph event id this machine holds (certified, pending, reserved), any origin. */
  knownEventIds: ReadonlySet<string>;
  /** Is this conversation in the certified source inventory? */
  isKnownConversation(ref: ConversationRef): boolean;
  /** The Chief of Staff conversation, never placed under anything. */
  isRootConversation(ref: ConversationRef): boolean;
  /** The project binding of a conversation (undefined = not knowable here); for the effort's project scope. */
  projectOf?(ref: ConversationRef): string | null | undefined;
  max?: number;
}

export interface CosTreeImportPlan { imports: CosTreeImportSource[]; skipped: Array<{ conversationKey: string; reason: CosTreeImportSkip }> }

/** Which tree records to import now. Never an owner decision: every judgement here only ever ADDS a first placement. */
export function planCosTreeImports(input: CosTreeImportPlanInput): CosTreeImportPlan {
  const out: CosTreeImportPlan = { imports: [], skipped: [] };
  const skip = (conversationKey: string, reason: CosTreeImportSkip) => { out.skipped.push({ conversationKey, reason }); };
  // Project conversation key -> effort, from CERTIFIED front doors only.
  const effortByFrontDoor = new Map<string, { effort: EffortRef; heads: string[] }>();
  for (const [effortKey, conv] of input.graph.frontDoorOf) {
    const e = input.graph.efforts.get(effortKey);
    if (e) effortByFrontDoor.set(nodeKey(conv), { effort: e.ref, heads: input.graph.frontDoorHeads.get(effortKey) ?? [] });
  }
  const frontDoorKeys = new Set([...input.graph.frontDoorOf.values()].map((c) => nodeKey(c)));
  const max = input.max ?? COS_TREE_IMPORT_MAX_PER_RUN;
  const records = [...input.tree].sort((a, b) => (a.conversationKey < b.conversationKey ? -1 : a.conversationKey > b.conversationKey ? 1 : 0));
  for (const r of records) {
    if (out.imports.length >= max) break;
    if (r.role === 'chief-of-staff') { skip(r.conversationKey, 'chief-of-staff-root'); continue; }
    if (!r.parentConversationKey) { skip(r.conversationKey, 'no-parent'); continue; }
    const child = cosKeyToRef(r.conversationKey, input.telegramChatId);
    const parent = cosKeyToRef(r.parentConversationKey, input.telegramChatId);
    if (!child || !parent || nodeKey(child) === nodeKey(parent)) { skip(r.conversationKey, 'unmapped-key'); continue; }
    if (input.isRootConversation(child)) { skip(r.conversationKey, 'chief-of-staff-root'); continue; }
    const mapped = effortByFrontDoor.get(nodeKey(parent));
    if (!mapped) { skip(r.conversationKey, 'project-not-accepted'); continue; }
    if (mapped.heads.length !== 1) { skip(r.conversationKey, 'front-door-unsettled'); continue; }
    const childKey = nodeKey(child);
    // Any placement event at all (owner, delegation, an owner REMOVAL, an earlier import) means it is placed.
    if ((input.graph.placementHeads.get(childKey) ?? []).length > 0) { skip(r.conversationKey, 'already-placed'); continue; }
    if (input.pendingSubjects.has(childKey)) { skip(r.conversationKey, 'change-pending'); continue; }
    if (frontDoorKeys.has(childKey)) { skip(r.conversationKey, 'is-front-door'); continue; }
    if (!input.isKnownConversation(child)) { skip(r.conversationKey, 'unknown-conversation'); continue; }
    const scope = input.graph.efforts.get(nodeKey(mapped.effort))?.projectScope ?? [];
    if (scope.length) {
      const project = input.projectOf?.(child);
      if (project === undefined || (project !== null && !scope.includes(project))) { skip(r.conversationKey, 'project-scope'); continue; }
    }
    const source: CosTreeImportSource = {
      v: 1, kind: 'cos-tree-import-source', agentId: input.agentId, childKey: r.conversationKey, parentKey: r.parentConversationKey,
      treeHlc: { physical: r.hlc.physical, logical: r.hlc.logical, node: r.hlc.node }, treeOrigin: r.origin,
      child, frontDoor: parent, effort: structuredClone(mapped.effort), frontDoorEventId: mapped.heads[0],
      // Deterministic per (record, writer, lease): the later of the tree write and the lease start.
      writerId: input.writerId, leaseEpoch: input.leaseEpoch, createdAt: new Date(Math.max(r.hlc.physical, input.leaseStartMs)).toISOString(),
    };
    if (!validateCosTreeImportSource(source)) { skip(r.conversationKey, 'unmapped-key'); continue; }
    if (input.knownEventIds.has(cosTreeImportEventId(source))) { skip(r.conversationKey, 'already-imported'); continue; }
    out.imports.push(source);
  }
  return out;
}

/** Is this source's tree record still the live winner (same write) in the replicated CoS store right now? */
export function cosTreeRecordStillLive(source: CosTreeImportSource, tree: CosTreeRecordInput[]): boolean {
  const r = tree.find((x) => x.conversationKey === source.childKey);
  return !!r && r.parentConversationKey === source.parentKey && r.origin === source.treeOrigin
    && r.hlc.physical === source.treeHlc.physical && r.hlc.logical === source.treeHlc.logical && r.hlc.node === source.treeHlc.node;
}

export type CosTreeImportGate = { open: true } | { open: false; reason: 'off' | 'waiting-for-machines'; waitingOn: string[] };

/**
 * Old builds refuse import receipts, so an import can only certify when every member of the graph runs this
 * build. Open only when the switch is on AND every OTHER member advertises it (unknown keeps it shut).
 */
export function cosTreeImportGate(input: { enabled: boolean; selfId: string; members: string[]; advertises(machineId: string): boolean | null }): CosTreeImportGate {
  if (!input.enabled) return { open: false, reason: 'off', waitingOn: [] };
  const waitingOn = input.members.filter((m) => m !== input.selfId && input.advertises(m) !== true).sort();
  return waitingOn.length ? { open: false, reason: 'waiting-for-machines', waitingOn } : { open: true };
}

/** The placement subjects among a set of graph events (for the pending set). */
export function placementSubjectKeys(events: Array<GraphEvent | null>): Set<string> {
  const out = new Set<string>();
  for (const e of events) if (e && e.op === 'set-primary-placement') out.add(nodeKey(e.subject as NodeRef));
  return out;
}
