/**
 * The live sources behind the relationship index (docs/specs/work-front-doors.md §4): each authoritative
 * store, read through its own existing read path and permission check. Built once per read, so the
 * audience resolved at the start of a read is the one its permission checks use. Read-only: nothing here
 * writes to any store.
 */
import type { NeighbourhoodSources, GraphSource, CardSource, ProjectSource, CommitmentSource, Audience, ConversationKey, GraphPlacement } from '../core/RelationshipIndex.js';
import type { ConversationGraphReadModel, GraphViewer } from '../core/conversationGraphRead.js';
import type { NodeRef, ProjectionItem } from '../core/conversationGraph.js';
import { cosConversationRef } from '../core/workFrontDoorsGraph.js';
import type { ResolvedPerson } from '../core/MobilePeople.js';

/** The slices of each live store this reads (the real classes satisfy them; tests pass small fakes). */
export interface NeighbourhoodLiveDeps {
  graphModel: () => ConversationGraphReadModel | null;
  telegramChatId: () => string;
  workBoard: () => {
    svc: { cardIds(): string[]; view(id: string): { status: string; card: { cardId: string; created: boolean; redacted?: unknown; conversationKey: string; title: string; projectKey: string | null; source: { conversationKey: string } | null; waitingOn: unknown; carrier: unknown } } | null; newestHlc(): { physical: number; logical: number; node: string } | null };
    behind(): { machineId: string; since: string } | null;
  } | null;
  chiefOfStaff: () => {
    projectsOverview(): Array<{ conversationKey: string; title: string }> | null;
    tree(): Map<string, { conversationKey: string; parentConversationKey: string | null }>;
  } | null;
  commitments: () => {
    own: () => Array<{ id: string; status: string; topicId?: number; agentResponse?: string; originMachineId?: string }>;
    replicas: () => Array<{ ownerMachineId: string; receivedAt: string; records: Array<{ id: string; status: string; topicId?: number; agentResponse?: string; originMachineId: string }> }>;
    selfId: string;
  } | null;
  pairing: () => {
    teamOn(): boolean;
    teamLog(): { healthState(): string; gaps(): unknown[]; state(): { people: Map<string, unknown> } } | null;
    teamPuller: { refusing(): boolean } | null;
    teamStanding(personKey: string): { name: string; tier: string } | null;
    devices: { list(): Array<{ status: string; role?: string; userId?: string }> };
    personOfDevice(d: never): ResolvedPerson | { ok: false };
    mayUse(person: ResolvedPerson, ref: string, op?: 'read'): boolean;
  } | null;
  ownerPersonKey: () => string | null;
  /**
   * Who else may read this conversation through memory privacy (people in a group topic or Slack channel,
   * another registered person's own conversation): 'owner' when only the owner can (or privacy is off, where
   * every session already has owner reach), 'shared' when someone else may, 'unknown' when it cannot be told.
   * Absent: the team record and phones are the only readers considered.
   */
  privacyReach?: (key: ConversationKey) => 'owner' | 'shared' | 'unknown';
  displayName: (personKey: string) => string;
  now?: () => number;
}

/** The reader that stands for everyone memory privacy says may read the conversation: it reads that one only. */
const OTHERS_PREFIX = 'others-in:';

/** A graph ref as the stores' shared conversation key; null for kinds the index does not name. */
export function keyOfRef(ref: NodeRef): ConversationKey | null {
  if (ref.kind !== 'conversation') return null;
  if (ref.platform === 'telegram') return `telegram:${ref.topicId}`;
  if (ref.platform === 'app') return `app:${ref.conversationKey}`;
  return null;
}

function graphSource(model: ConversationGraphReadModel, chatId: string): GraphSource {
  return {
    read(key, visible) {
      const ref = cosConversationRef(key, chatId);
      // A key with no graph form (Slack, or Telegram with no chat id) is simply not in the graph.
      if (!ref) return { revision: 'no-ref', partialReasons: [], placement: null };
      const viewer: GraphViewer = {
        principalKey: 'agent:least-privileged-audience',
        grantVersion: 'per-read',
        mayView: (r) => {
          if (r.kind === 'effort') return visible({ kind: 'effort' });
          const k = keyOfRef(r);
          return k !== null && visible({ kind: 'conversation', key: k });
        },
      };
      const self = model.node(viewer, ref, { remember: false });
      if (self.status === 503) throw new Error(String((self.body as { code?: unknown }).code ?? 'graph-unavailable'));
      const env = self.body as { revision?: string; partialReasons?: Array<{ reason: string }> };
      const revision = String(env.revision ?? 'unknown');
      const partialReasons = (env.partialReasons ?? []).map((p) => p.reason);
      if (self.status !== 200) return { revision, partialReasons, placement: null };
      const path = (self.body.path as Array<{ ref: NodeRef; title: string }> | undefined) ?? [];
      const effortStep = [...path].reverse().find((p) => p.ref.kind === 'effort') ?? null;
      if (!effortStep) return { revision, partialReasons, placement: { effort: null, siblings: [], siblingsTruncated: false } };
      const effortNode = model.node(viewer, effortStep.ref, { remember: false });
      let siblings: GraphPlacement['siblings'] = [];
      let truncated = false;
      let frontDoor: ConversationKey | null = null;
      if (effortNode.status === 200) {
        const children = effortNode.body.children as { items: ProjectionItem[]; nextCursor: string | null } | undefined;
        siblings = (children?.items ?? []).flatMap((c) => { const k = keyOfRef(c.ref); return k && c.kind === 'conversation' ? [{ key: k, title: c.title }] : []; });
        truncated = !!children?.nextCursor;
        const fd = (effortNode.body.node as ProjectionItem | undefined)?.metadata?.frontDoor;
        frontDoor = fd ? keyOfRef(fd) : null;
      }
      const effortId = (effortStep.ref as { id: string }).id;
      return { revision, partialReasons, placement: { effort: { id: effortId, title: effortStep.title, frontDoor }, siblings, siblingsTruncated: truncated } };
    },
  };
}

function principal(raw: unknown): 'agent' | 'none' | { personKey: string } {
  if (raw === 'agent' || raw === 'none') return raw;
  const k = (raw as { personKey?: unknown } | null)?.personKey;
  return typeof k === 'string' && k ? { personKey: k } : 'none';
}

/** Build one read's sources. */
export function neighbourhoodSources(d: NeighbourhoodLiveDeps): NeighbourhoodSources {
  // Each reader the audience found, with the person record its permission check needs.
  const readerPeople = new Map<string, ResolvedPerson>();

  const audience = (key: ConversationKey): Audience => {
    const ownerKey = d.ownerPersonKey();
    const readers = [ownerKey ?? 'owner'];
    const reach = d.privacyReach ? d.privacyReach(key) : 'owner';
    if (reach === 'unknown') return { kind: 'unresolved', reason: 'who else may read this conversation is not known' };
    // People who may read this conversation and nothing else we can name: the strict stand-in for all of them.
    if (reach === 'shared') readers.push(`${OTHERS_PREFIX}${key}`);
    const svc = d.pairing();
    // No phone pairing at all: no team record and no other phone can read anything here.
    if (!svc) return { kind: 'resolved', ownerKey: ownerKey ?? 'owner', readers };
    if (svc.teamOn()) {
      const log = svc.teamLog();
      if (!log || log.healthState() === 'unreadable') return { kind: 'unresolved', reason: 'team record unreadable' };
      if (log.gaps().length > 0) return { kind: 'unresolved', reason: 'team record behind (a gap)' };
      if (svc.teamPuller?.refusing()) return { kind: 'unresolved', reason: 'team record being checked' };
      for (const personKey of log.state().people.keys()) {
        if (personKey === ownerKey) continue;
        const standing = svc.teamStanding(personKey);
        if (!standing) continue;
        const person = { ok: true, role: 'team', userId: personKey, name: standing.name, telegramUserId: null, tier: standing.tier } as unknown as ResolvedPerson;
        if (svc.mayUse(person, key, 'read')) { readers.push(personKey); readerPeople.set(personKey, person); }
      }
    }
    // Managed-service phones read by their own grants (they are not in the team record).
    for (const dev of svc.devices.list()) {
      if (dev.status !== 'active' || dev.role !== 'msp' || !dev.userId) continue;
      const person = svc.personOfDevice(dev as never);
      if (!('ok' in person) || !person.ok) continue;
      const readerKey = `msp:${dev.userId}`;
      if (readerPeople.has(readerKey)) continue;
      if (svc.mayUse(person as ResolvedPerson, key, 'read')) { readers.push(readerKey); readerPeople.set(readerKey, person as ResolvedPerson); }
    }
    return { kind: 'resolved', ownerKey: ownerKey ?? 'owner', readers };
  };

  const mayRead = (reader: string, key: ConversationKey): boolean => {
    if (reader.startsWith(OTHERS_PREFIX)) return reader.slice(OTHERS_PREFIX.length) === key;
    const svc = d.pairing();
    const person = readerPeople.get(reader);
    return !!svc && !!person && svc.mayUse(person, key, 'read');
  };

  const graph = (): GraphSource | null => { const m = d.graphModel(); return m ? graphSource(m, d.telegramChatId()) : null; };

  const cards = (): CardSource | null => {
    const rt = d.workBoard();
    if (!rt) return null;
    const hlc = rt.svc.newestHlc();
    return {
      version: hlc ? `${hlc.physical}.${hlc.logical}.${hlc.node}` : 'empty',
      behind: rt.behind(),
      cards: () => rt.svc.cardIds().flatMap((id) => {
        const v = rt.svc.view(id);
        // A removed (redacted) card is gone for every reader, its title included.
        if (!v || !v.card.created || v.card.redacted) return [];
        const c = v.card;
        return [{
          cardId: c.cardId, conversationKey: `app:${c.conversationKey}`, title: c.title, status: v.status,
          projectKey: c.projectKey, sourceConversationKey: c.source?.conversationKey ?? null,
          waitingOn: principal(c.waitingOn), carrier: c.carrier === 'agent' ? 'agent' as const : (principal(c.carrier) as { personKey: string }),
        }];
      }),
    };
  };

  const projects = (): ProjectSource | null => {
    const loop = d.chiefOfStaff();
    if (!loop) return null;
    let tree: Map<string, { parentConversationKey: string | null }> | null = null;
    return {
      projects: () => loop.projectsOverview()?.map((p) => ({ conversationKey: p.conversationKey, title: p.title })) ?? null,
      parentOf: (key) => { tree ??= loop.tree(); return tree.get(key)?.parentConversationKey ?? null; },
    };
  };

  const commitments = (): CommitmentSource | null => {
    const c = d.commitments();
    if (!c) return null;
    const now = (d.now ?? Date.now)();
    return {
      rows: () => [
        ...c.own().map((r) => ({ id: r.id, originMachineId: r.originMachineId ?? c.selfId, topicId: typeof r.topicId === 'number' ? r.topicId : null, status: r.status, text: r.agentResponse ?? '' })),
        ...c.replicas().flatMap((rep) => rep.records.filter((r) => r.status === 'pending').map((r) => ({
          id: r.id, originMachineId: r.originMachineId, topicId: typeof r.topicId === 'number' ? r.topicId : null, status: r.status, text: r.agentResponse ?? '',
          stalenessMs: Math.max(0, now - Date.parse(rep.receivedAt)),
        }))),
      ],
    };
  };

  return { graph, cards, projects, commitments, audience, mayRead, displayName: d.displayName };
}
