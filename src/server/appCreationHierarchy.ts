/** Reader-scoped, read-only projection of supported local creation evidence.
 * Historical context never overrides explicit current Chief placement.
 */
import { setImmediate as nextTurn } from 'node:timers/promises';
import type { AppCreationContext } from '../core/AppCreationContext.js';
import type { AppConversationStore, CreatedEvent } from '../core/AppConversationStore.js';

export interface CreationCardEvidence {
  conversationKey: string;
  cardId: string;
  creationContext: AppCreationContext;
  conflict: boolean;
}
export interface CreationHierarchySource {
  version: string;
  complete: boolean;
  parents: ReadonlyMap<string, string | null>;
  confirmedProjects: ReadonlySet<string>;
  cardEvidence: ReadonlyArray<CreationCardEvidence>;
  resolveRef: (raw: string, originMachineId?: string) => string | null;
}
export interface PublicCreationSource {
  v: 1;
  kind: 'person' | 'work-board-card' | 'session';
  evidence: 'created-event' | 'card-binding';
  cardId?: string;
  sourceConversationKey?: string;
  projectKey?: string;
  originMachineId?: string;
}
export interface AppHierarchyFields {
  parentConversationKey?: string | null;
  creationSource?: PublicCreationSource;
  hierarchyState: 'root' | 'child' | 'unplaced' | 'unknown';
}
export interface ParentPreviewRow {
  conversationRef: string;
  currentParentConversationKey?: string | null;
  proposedParentConversationKey?: string | null;
  creationSource?: PublicCreationSource;
  action: 'would-place' | 'keep-current' | 'unresolved';
  reason: string;
}
export interface CreationHierarchyScope {
  key: string;
  authorizationVersion: string;
  /** One source snapshot captured for this response; null preserves unavailable evidence. */
  source?: CreationHierarchySource | null;
  /** Current existence and authorization, not historical permission. */
  mayRead: (ref: string) => boolean;
}
interface Entry {
  context: AppCreationContext | null;
  generated: boolean;
  fields: AppHierarchyFields;
  preview: ParentPreviewRow;
}
interface Cached {
  signature: string;
  entries: Map<string, Entry>;
}
const own = (o: object, key: string): boolean => Object.prototype.hasOwnProperty.call(o, key);
const childRef = (key: string): string => key.startsWith('app:') ? key : `app:${key}`;
const keyOf = (ref: string): string => ref.startsWith('app:') ? ref.slice(4) : ref;

function readable(source: CreationHierarchySource, scope: CreationHierarchyScope, raw: unknown, origin?: string): string | null {
  if (typeof raw !== 'string') return null;
  const ref = source.resolveRef(raw, origin);
  return ref && scope.mayRead(ref) ? ref : null;
}
function sourceFor(context: AppCreationContext, evidence: PublicCreationSource['evidence'], card: CreationCardEvidence | undefined,
  source: CreationHierarchySource, scope: CreationHierarchyScope): PublicCreationSource {
  const raw = context.source;
  const result: PublicCreationSource = { v: 1, kind: raw.kind, evidence };
  // These are provenance references, not inferred placement or new read grants.
  if (raw.kind === 'work-board-card' && card && !card.conflict && raw.cardId === card.cardId && scope.mayRead(childRef(card.conversationKey))) result.cardId = card.cardId;
  const from = readable(source, scope, raw.sourceConversationKey, raw.originMachineId);
  if (from) result.sourceConversationKey = from;
  const project = readable(source, scope, raw.projectKey, raw.originMachineId);
  if (project && source.confirmedProjects.has(project)) result.projectKey = project;
  if (raw.originMachineId) result.originMachineId = raw.originMachineId;
  return result;
}
interface Candidate { parent?: string | null; reason: string }
function candidate(context: AppCreationContext, source: CreationHierarchySource, scope: CreationHierarchyScope): Candidate {
  if (own(context, 'parentConversationKey')) {
    if (context.parentConversationKey === null) return { parent: null, reason: 'explicit-root' };
    const parent = readable(source, scope, context.parentConversationKey, context.source.originMachineId);
    if (!parent) return { reason: 'parent-unavailable' };
    if (context.parentBasis === 'project' && !source.confirmedProjects.has(parent)) return { reason: 'project-unconfirmed' };
    return { parent, reason: 'recorded-parent' };
  }
  const from = readable(source, scope, context.source.sourceConversationKey, context.source.originMachineId);
  const project = readable(source, scope, context.source.projectKey, context.source.originMachineId);
  const candidates = new Set<string>();
  if (from) candidates.add(from);
  if (project && source.confirmedProjects.has(project)) candidates.add(project);
  if (candidates.size > 1) return { reason: 'ambiguous-recorded-parent' };
  if (candidates.size === 1) return { parent: [...candidates][0], reason: 'recorded-source' };
  return { reason: 'recorded-parent-unresolved' };
}

/** Remove only historical fallback edges that take part in a cycle, across the full relation. */
function cyclicFallbacks(edges: ReadonlyMap<string, string | null>, fallbacks: ReadonlySet<string>): Set<string> {
  const done = new Set<string>();
  const suppressed = new Set<string>();
  for (const start of edges.keys()) {
    if (done.has(start)) continue;
    const path: string[] = [];
    const at = new Map<string, number>();
    let current: string | null | undefined = start;
    while (current && edges.has(current) && !done.has(current)) {
      const repeated = at.get(current);
      if (repeated !== undefined) {
        for (const ref of path.slice(repeated)) if (fallbacks.has(ref)) suppressed.add(ref);
        break;
      }
      at.set(current, path.length); path.push(current); current = edges.get(current);
    }
    for (const ref of path) done.add(ref);
  }
  return suppressed;
}

/** Cache invalidation is source/generation/scope based, never a TTL. Refresh yields between pages. */
export class AppCreationHierarchyProjection {
  private readonly cache = new Map<string, Cached>();
  private readonly pending = new Map<string, Promise<void>>();
  private cardKinds: { version: string; generated: ReadonlySet<string> } | null = null;
  constructor(private readonly store: AppConversationStore, private readonly source: () => CreationHierarchySource | null | undefined) {}

  private readSource(): CreationHierarchySource | null | undefined {
    try { return this.source(); } catch { return null; /* @silent-fallback-ok: the response exposes unknown hierarchy, never an asserted empty tree. */ }
  }
  private signature(source: CreationHierarchySource | null | undefined, scope: CreationHierarchyScope): string {
    return JSON.stringify([source?.complete === true, source?.version ?? null, this.store.getCreationGeneration(), scope.authorizationVersion]);
  }
  private known(scope: CreationHierarchyScope): Cached | null {
    const source = own(scope, 'source') ? scope.source : this.readSource();
    const cached = this.cache.get(scope.key);
    if (!source?.complete || !cached || cached.signature !== this.signature(source, scope)) {
      this.schedule(scope); return null;
    }
    return cached;
  }
  schedule(scope: CreationHierarchyScope): void {
    if (this.pending.has(scope.key)) return;
    const task = nextTurn().then(() => this.refresh(scope)).finally(() => this.pending.delete(scope.key));
    // A failed source stays uncertain; no request receives an asserted empty tree.
    this.pending.set(scope.key, task.catch(() => { this.cache.delete(scope.key); /* @silent-fallback-ok: invalidation exposes unknown placement; no fabricated fallback or self-retry. */ }));
  }
  async settled(scope: CreationHierarchyScope): Promise<void> {
    this.schedule(scope); await this.pending.get(scope.key);
  }
  async refresh(scope: CreationHierarchyScope): Promise<void> {
    const source = this.readSource();
    if (own(scope, 'source') && (scope.source?.version !== source?.version || scope.source?.complete !== source?.complete)) {
      this.cache.delete(scope.key); return;
    }
    if (source) this.cardKinds = { version: source.version, generated: new Set(source.cardEvidence.map((item) => childRef(item.conversationKey))) };
    if (!source?.complete) { this.cache.delete(scope.key); return; }
    const signature = this.signature(source, scope);
    const records = new Map<string, CreatedEvent | null>();
    let cursor: string | null = null;
    do {
      const page = this.store.creationInventoryPage({ limit: 500, cursor });
      for (const row of page.conversations) records.set(childRef(row.conversationKey), this.store.getCreationRecord(row.conversationKey));
      cursor = page.nextCursor;
      await nextTurn();
    } while (cursor !== null);
    const cards = new Map(source.cardEvidence.map((item) => [childRef(item.conversationKey), item]));
    const entries = new Map<string, Entry>();
    const edges = new Map(source.parents);
    const fallbacks = new Set<string>();
    const proposals = new Map<string, Candidate>();
    for (const [ref, record] of records) {
      const card = cards.get(ref);
      const conflict = this.store.hasCreationConflict(keyOf(ref)) || card?.conflict === true;
      const context = conflict ? null : record?.creationContext ?? null;
      const generated = conflict || !!card || context?.source.kind === 'work-board-card' || context?.source.kind === 'session';
      const legacyContext = !record?.creationContext && !conflict ? card?.creationContext : null;
      const evidenceContext = context ?? legacyContext ?? null;
      const creationSource = evidenceContext ? sourceFor(evidenceContext, context ? 'created-event' : 'card-binding', card, source, scope) : undefined;
      const base: AppHierarchyFields = { hierarchyState: generated ? 'unplaced' : 'unknown', ...(creationSource ? { creationSource } : {}) };
      const preview: ParentPreviewRow = { conversationRef: ref, action: 'unresolved', reason: conflict ? 'creation-evidence-conflict' : 'creation-evidence-unavailable', ...(creationSource ? { creationSource } : {}) };
      if (source.parents.has(ref)) {
        const parent = source.parents.get(ref)!;
        if (parent === null) { base.parentConversationKey = null; base.hierarchyState = 'root'; preview.currentParentConversationKey = null; }
        else if (scope.mayRead(parent)) { base.parentConversationKey = parent; base.hierarchyState = 'child'; preview.currentParentConversationKey = parent; }
        else base.hierarchyState = 'unplaced';
        preview.action = 'keep-current'; preview.reason = 'explicit-current-placement';
      } else if (evidenceContext) {
        const proposed = candidate(evidenceContext, source, scope);
        if (context && own(proposed, 'parent')) {
          base.parentConversationKey = proposed.parent!;
          base.hierarchyState = proposed.parent === null ? 'root' : 'child';
          edges.set(ref, proposed.parent!); fallbacks.add(ref);
          preview.currentParentConversationKey = proposed.parent!;
          preview.action = 'keep-current'; preview.reason = 'recorded-current-placement';
        } else {
          preview.reason = proposed.reason;
          if (context && own(context, 'parentConversationKey') && context.parentConversationKey !== null) base.hierarchyState = 'unplaced';
          if (own(proposed, 'parent')) proposals.set(ref, proposed);
        }
        if (context && context.source.kind === 'person' && !own(context, 'parentConversationKey')) base.hierarchyState = 'unknown';
      }
      entries.set(ref, { context, generated, fields: base, preview });
    }
    const cycles = cyclicFallbacks(edges, fallbacks);
    for (const ref of cycles) {
      edges.delete(ref);
      const entry = entries.get(ref)!;
      delete entry.fields.parentConversationKey; entry.fields.hierarchyState = 'unplaced';
      delete entry.preview.currentParentConversationKey; entry.preview.action = 'unresolved'; entry.preview.reason = 'cyclic-recorded-placement';
    }
    // Legacy proposals are assessed against the fixed effective relation. Rejected proposals
    // never remove the existing edge that revealed the cycle.
    const proposedEdges = new Map(edges);
    for (const [ref, proposed] of proposals) proposedEdges.set(ref, proposed.parent!);
    const proposalCycles = cyclicFallbacks(proposedEdges, new Set(proposals.keys()));
    for (const [ref, proposed] of proposals) {
      const entry = entries.get(ref)!;
      if (proposalCycles.has(ref)) { entry.preview.reason = 'cyclic-proposed-placement'; continue; }
      entry.preview.proposedParentConversationKey = proposed.parent!;
      entry.preview.action = 'would-place'; entry.preview.reason = proposed.reason;
    }
    if (this.signature(this.readSource(), scope) !== signature) { this.cache.delete(scope.key); return; }
    this.cache.set(scope.key, { signature, entries });
  }
  fields(key: string, scope: CreationHierarchyScope): AppHierarchyFields {
    const cached = this.known(scope);
    const entry = cached?.entries.get(childRef(key));
    if (!entry) {
      const record = this.store.getCreationRecord(keyOf(key));
      const kind = record?.creationContext?.source.kind;
      const source = own(scope, 'source') ? scope.source : this.readSource();
      const cardGenerated = source?.version === this.cardKinds?.version && this.cardKinds?.generated.has(childRef(key));
      return { hierarchyState: this.store.hasCreationConflict(keyOf(key)) || kind === 'session' || kind === 'work-board-card' || cardGenerated ? 'unplaced' : 'unknown' };
    }
    const fields = { ...entry.fields };
    if (typeof fields.parentConversationKey === 'string' && !scope.mayRead(fields.parentConversationKey)) {
      delete fields.parentConversationKey; fields.hierarchyState = 'unplaced';
    }
    if (fields.creationSource) {
      fields.creationSource = { ...fields.creationSource };
      for (const name of ['sourceConversationKey', 'projectKey'] as const) {
        const ref = fields.creationSource[name]; if (ref && !scope.mayRead(ref)) delete fields.creationSource[name];
      }
    }
    return fields;
  }
  preview(key: string, scope: CreationHierarchyScope): ParentPreviewRow {
    const entry = this.known(scope)?.entries.get(childRef(key));
    if (!entry) return { conversationRef: childRef(key), action: 'unresolved', reason: 'hierarchy-evidence-not-ready' };
    const row = { ...entry.preview, ...(this.fields(key, scope).creationSource ? { creationSource: this.fields(key, scope).creationSource } : {}) };
    for (const name of ['currentParentConversationKey', 'proposedParentConversationKey'] as const) {
      const ref = row[name]; if (typeof ref === 'string' && !scope.mayRead(ref)) { delete row[name]; row.action = name === 'currentParentConversationKey' ? 'keep-current' : 'unresolved'; row.reason = 'parent-unavailable'; }
    }
    return row;
  }
}
