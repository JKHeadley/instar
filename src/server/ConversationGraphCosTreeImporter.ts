/**
 * The Chief of Staff tree import runner (work-front-doors §3.1 and §7 stage 2). Runs on the graph writer (the
 * lease holder) only, on a slow timer, and only when the gate is open: the switch is on AND every other graph
 * member advertises a build that verifies import receipts (older builds refuse them, so an import could never
 * certify there).
 *
 * Each run: read the CERTIFIED graph snapshot, plan with the pure planner, then for each planned import take the
 * graph mutation lock, re-check (the child still has no placement event, the tree record is still the same live
 * write, the effort's front door is unchanged), sign an import receipt and submit through the ordinary witnessed
 * all-member commit path. It never stops or changes the Chief of Staff tree writes (CMT-2074 tracks that).
 */
import {DegradationReporter} from '../monitoring/DegradationReporter.js';
import {canonicalHash,graphOperationKey} from '../core/GraphWitnessTypes.js';
import {reduceGraph,validateGraphEvent,validateNodeRef,nodeKey,type ConversationRef,type GraphEvent} from '../core/conversationGraph.js';
import {signGraphAuthorizationReceipt,type GraphAuthorizationProof} from '../core/ConversationGraphReplicationProof.js';
import {
  planCosTreeImports,cosTreeImportGate,cosTreeImportCore,cosTreeImportIdempotencyKey,cosTreeRecordStillLive,placementSubjectKeys,
  COS_TREE_IMPORT_PRINCIPAL,type CosTreeImportSource,type CosTreeRecordInput,type CosTreeImportGate,type CosTreeImportSkip,
} from '../core/ConversationGraphCosTreeImport.js';
import type {ConversationGraphReplicationRuntime} from './ConversationGraphReplicationRuntime.js';
import type {ConversationGraphReplicationRecord} from '../core/ConversationGraphReplication.js';
import type {MachineIdentityManager} from '../core/MachineIdentity.js';

export interface CosTreeImporterDeps {
  runtime(): ConversationGraphReplicationRuntime | null;
  identity(): MachineIdentityManager | null;
  /** The live CoS tree records (with each write's HLC and origin); null when unreadable or no Chief of Staff. */
  tree(): CosTreeRecordInput[] | null;
  /** The switch (dev-agent gated). */
  enabled(): boolean;
  /** Does this machine's latest heartbeat advertise the import authority? null = unknown. */
  advertises(machineId: string): boolean | null;
  telegramChatId(): string;
  rootConversation(): ConversationRef | null;
  projectOf?(ref: ConversationRef): string | null | undefined;
  now?(): number;
}

export type CosTreeImportRun =
  | {state: 'off' | 'no-chief-of-staff' | 'not-ready' | 'not-writer' | 'not-current'}
  | {state: 'gated'; gate: Extract<CosTreeImportGate, {open: false}>}
  | {state: 'ran'; imported: Array<{eventId: string; conversationKey: string; outcome: string}>; skipped: Record<string, number>; refused: Array<{conversationKey: string; reason: string}>};

const REFRESH_MS = 10 * 60_000;
const FIRST_RUN_MS = 90_000;

/** The conversation subjects an owner change names (a move's subject; a front-door choice's conversation). */
function ownerChangeSubjectKeys(raw: unknown): string[] {
  const change = raw as {kind?: unknown; subject?: unknown; conversation?: unknown} | null;
  if (!change || typeof change !== 'object') return [];
  const out: string[] = [];
  for (const ref of [change.subject, change.conversation]) { const valid = validateNodeRef(ref); if (valid) out.push(nodeKey(valid)); }
  return out;
}

export class ConversationGraphCosTreeImporter {
  private timer: NodeJS.Timeout | null = null;
  private first: NodeJS.Timeout | null = null;
  private running: Promise<CosTreeImportRun> | null = null;
  private last: CosTreeImportRun | null = null;
  constructor(private readonly deps: CosTreeImporterDeps) {}

  status(): CosTreeImportRun | null { return this.last; }

  start(): void {
    if (this.timer) return;
    this.first = setTimeout(() => { void this.runOnce(); }, FIRST_RUN_MS); this.first.unref?.();
    this.timer = setInterval(() => { void this.runOnce(); }, REFRESH_MS); this.timer.unref?.();
  }
  stop(): void {
    if (this.first) clearTimeout(this.first); if (this.timer) clearInterval(this.timer);
    this.first = null; this.timer = null;
  }

  /** One pass. Concurrent callers share the pass in flight. */
  runOnce(): Promise<CosTreeImportRun> {
    if (!this.running) this.running = this.pass().then((r) => { this.last = r; return r; }).finally(() => { this.running = null; });
    return this.running;
  }

  private snapshot(runtime: ConversationGraphReplicationRuntime) {
    const union = runtime.projection();
    const events = union.records.filter((r) => r.coreType === 'graph-event').map((r) => validateGraphEvent(r.core)).filter((e): e is GraphEvent => e !== null);
    const byId = new Map(union.records.map((r) => [r.packet.eventId, r]));
    const verify = (event: GraphEvent) => { const record = byId.get(graphOperationKey('graph-event', event.eventId)); return !!record && runtime.source.verifyHistoricalRecord(record); };
    return {union, graph: reduceGraph(events, {verify})};
  }

  private async held(runtime: ConversationGraphReplicationRuntime, certified: ReadonlySet<string>) {
    const all: ConversationGraphReplicationRecord[] = [...runtime.source.recordsForRepair(), ...await runtime.source.controlIntents(), ...await runtime.intake.reservations()];
    const graphRecords = all.filter((r) => r.coreType === 'graph-event');
    const events = graphRecords.map((r) => validateGraphEvent(r.core));
    const knownEventIds = new Set(events.filter((e): e is GraphEvent => e !== null).map((e) => e.eventId));
    const pendingSubjects = placementSubjectKeys(graphRecords.filter((r) => !certified.has(r.packet.eventId)).map((r) => validateGraphEvent(r.core)));
    // An owner change saved here while the graph could not commit (the local owner queue) names a subject too: an
    // import must not land first and make that owner change stale.
    let cursor: string | null = null;
    for (let page = 0; page < 1000; page++) {
      const result: {intents: Array<{change: unknown}>; nextCursor: string | null} = await runtime.intake.ownerQueue.pendingPage(cursor);
      for (const intent of result.intents) for (const key of ownerChangeSubjectKeys(intent.change)) pendingSubjects.add(key);
      if (result.nextCursor === null) break;
      cursor = result.nextCursor;
    }
    return {knownEventIds, pendingSubjects};
  }

  private plan(runtime: ConversationGraphReplicationRuntime, tree: CosTreeRecordInput[], held: {knownEventIds: Set<string>; pendingSubjects: Set<string>}) {
    const {union, graph} = this.snapshot(runtime);
    if (union.missingEventIds.length || graph.partial.eventGap || graph.partial.evidenceMissing) return null;
    const known = new Set(runtime.inventory().conversations.map((row) => nodeKey(row.ref)));
    const root = this.deps.rootConversation();
    const actuation = runtime.actuation();
    return {union, graph, plan: planCosTreeImports({
      agentId: runtime.agentId, writerId: runtime.machineId, leaseEpoch: actuation.lease.leaseEpoch, leaseStartMs: Date.parse(actuation.originalLease.acquiredAt),
      telegramChatId: this.deps.telegramChatId(), tree, graph,
      pendingSubjects: held.pendingSubjects, knownEventIds: held.knownEventIds,
      isKnownConversation: (ref) => known.has(nodeKey(ref)),
      isRootConversation: (ref) => !!root && nodeKey(root) === nodeKey(ref),
      ...(this.deps.projectOf ? {projectOf: (ref: ConversationRef) => this.deps.projectOf!(ref)} : {}),
    })};
  }

  private async pass(): Promise<CosTreeImportRun> {
    try {
      if (!this.deps.enabled()) return {state: 'off'};
      const runtime = this.deps.runtime(), identity = this.deps.identity();
      if (!runtime || !identity || !runtime.isReady()) return {state: 'not-ready'};
      const membership = runtime.installedMembership;
      const gate = cosTreeImportGate({enabled: true, selfId: runtime.machineId, members: membership.members.map((m) => m.machineId), advertises: (m) => this.deps.advertises(m)});
      if (!gate.open) return {state: 'gated', gate};
      let writer = false;
      try { writer = runtime.actuation().lease.writerId === runtime.machineId; }
      catch { writer = false; } // @silent-fallback-ok — a standby or fenced machine is simply not the writer; only the lease holder imports
      if (!writer) return {state: 'not-writer'};
      const tree = this.deps.tree();
      if (!tree) return {state: 'no-chief-of-staff'};
      const certified = new Set(runtime.projection().records.map((r) => r.packet.eventId));
      const first = this.plan(runtime, tree, await this.held(runtime, certified));
      if (!first) return {state: 'not-current'};
      const skipped: Record<string, number> = {};
      for (const s of first.plan.skipped) skipped[s.reason] = (skipped[s.reason] ?? 0) + 1;
      const imported: Array<{eventId: string; conversationKey: string; outcome: string}> = [];
      const refused: Array<{conversationKey: string; reason: string}> = [];
      for (const planned of first.plan.imports) {
        const result = await runtime.withSourceMutation((token) => this.submitOne(runtime, identity, planned, token));
        if ('refused' in result) refused.push({conversationKey: planned.childKey, reason: result.refused});
        else imported.push({eventId: result.eventId, conversationKey: planned.childKey, outcome: result.outcome});
      }
      return {state: 'ran', imported, skipped, refused};
    } catch {
      DegradationReporter.getInstance().report({feature: 'Conversations.cosTreeImport', primary: 'Bring the Chief of Staff tree into Conversations',
        fallback: 'Try again on the next pass; the Chief of Staff tree keeps working as before', reason: 'cos-tree-import-unavailable',
        impact: 'Some project sub-conversations are not yet shown under their project in Conversations', internalOnly: true});
      return {state: 'not-current'};
    }
  }

  /** Under the graph mutation lock: re-check everything this import depends on, then sign and submit. */
  private async submitOne(runtime: ConversationGraphReplicationRuntime, identity: MachineIdentityManager, planned: CosTreeImportSource, token: symbol):
    Promise<{eventId: string; outcome: string} | {refused: CosTreeImportSkip | 'tree-record-changed' | 'plan-changed'}> {
    const tree = this.deps.tree();
    if (!tree || !cosTreeRecordStillLive(planned, tree)) return {refused: 'tree-record-changed'};
    const certified = new Set(runtime.projection().records.map((r) => r.packet.eventId));
    const again = this.plan(runtime, tree, await this.held(runtime, certified));
    if (!again) return {refused: 'plan-changed'};
    const same = again.plan.imports.find((s) => s.childKey === planned.childKey);
    if (!same || canonicalHash(same) !== canonicalHash(planned)) {
      return {refused: again.plan.skipped.find((s) => s.conversationKey === planned.childKey)?.reason ?? 'plan-changed'};
    }
    const actuation = runtime.actuation();
    if (actuation.lease.writerId !== runtime.machineId) return {refused: 'plan-changed'};
    if (planned.writerId !== runtime.machineId || planned.leaseEpoch !== actuation.lease.leaseEpoch) return {refused: 'plan-changed'};
    const acceptedAt = new Date((this.deps.now ?? Date.now)()).toISOString();
    const core = cosTreeImportCore(planned);
    const membership = runtime.installedMembership, idempotencyKey = cosTreeImportIdempotencyKey(planned);
    const receipt = signGraphAuthorizationReceipt({v: 1, agentId: membership.agentId, eventId: graphOperationKey('graph-event', core.eventId), coreHash: canonicalHash(core),
      actorPrincipal: COS_TREE_IMPORT_PRINCIPAL, authenticationMethod: 'cos-tree-import', receiptId: core.receipt.id, membershipEpoch: membership.epoch,
      leaseEpoch: actuation.lease.leaseEpoch, idempotencyKey, writerId: runtime.machineId, fencedLeaseHash: canonicalHash(actuation.originalLease), acceptedAt},
    identity.loadSigningKey());
    const proof: GraphAuthorizationProof = {receipt, membership, lease: actuation.lease, originalLease: actuation.originalLease, importSource: structuredClone(planned)};
    const bytes = Buffer.from(JSON.stringify({kind: 'cos-tree-import', source: planned}));
    try {
      const outcome = await runtime.submitPrepared({coreType: 'graph-event', idempotencyKey, requestHash: canonicalHash({kind: 'cos-tree-import', source: planned}),
        core: core as unknown as Record<string, unknown>, authorizationProof: proof, plaintextSource: bytes}, token);
      return {eventId: core.eventId, outcome: outcome.state};
    } finally { bytes.fill(0); }
  }
}
