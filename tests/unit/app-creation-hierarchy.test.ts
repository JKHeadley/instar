import { afterEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { AppConversationStore } from '../../src/core/AppConversationStore.js';
import type { AppCreationContext } from '../../src/core/AppCreationContext.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import { AppCreationHierarchyProjection, type CreationHierarchySource, type CreationHierarchyScope } from '../../src/server/appCreationHierarchy.js';

const stores: AppConversationStore[] = [];
const dirs: string[] = [];
afterEach(() => {
  for (const store of stores.splice(0)) store.close();
  for (const dir of dirs.splice(0)) SafeFsExecutor.safeRmSync(dir, { recursive: true, force: true, operation: 'tests/unit/app-creation-hierarchy.test.ts' });
});
function setup() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'app-hierarchy-')); dirs.push(dir);
  const store = new AppConversationStore({ stateDir: dir, machineId: () => 'm1' }); stores.push(store);
  const known = new Set(['telegram:1', 'telegram:2']);
  const unreadable = new Set<string>();
  let source: CreationHierarchySource = { version: 'one', complete: true, parents: new Map(), confirmedProjects: new Set(), cardEvidence: [], resolveRef: (raw) => known.has(raw) ? raw : null };
  const scope: CreationHierarchyScope = { key: 'owner', authorizationVersion: 'v1', mayRead: (ref) => known.has(ref) && !unreadable.has(ref) };
  const projection = new AppCreationHierarchyProjection(store, () => source);
  const add = (context?: AppCreationContext) => {
    const key = crypto.randomUUID(); known.add(`app:${key}`);
    store.append({ kind: 'created', eventId: `create-${key}`, conversationKey: key, title: 'Chat', at: new Date().toISOString(), machineId: 'm1', ...(context ? { creationContext: context } : {}) });
    return key;
  };
  return { store, known, unreadable, scope, projection, add, source: () => source, setSource: (next: CreationHierarchySource) => { source = next; } };
}
const generated = (parent?: string | null): AppCreationContext => ({ v: 1, source: { kind: 'session', requestId: 'session-request', originMachineId: 'm1' }, ...(parent !== undefined ? { parentConversationKey: parent, parentBasis: 'explicit' } : {}) });

describe('reader scoped App hierarchy projection', () => {
  it('distinguishes explicit person roots, verified children, generated unplaced and legacy unknown', async () => {
    const e = setup();
    const root = e.add({ v: 1, source: { kind: 'person' }, parentConversationKey: null, parentBasis: 'explicit' });
    const child = e.add(generated('telegram:1'));
    const unplaced = e.add(generated());
    const legacy = e.add();
    await e.projection.settled(e.scope);
    expect(e.projection.fields(root, e.scope)).toMatchObject({ hierarchyState: 'root', parentConversationKey: null });
    expect(e.projection.fields(child, e.scope)).toMatchObject({ hierarchyState: 'child', parentConversationKey: 'telegram:1' });
    expect(e.projection.fields(unplaced, e.scope).hierarchyState).toBe('unplaced');
    expect(e.projection.fields(legacy, e.scope).hierarchyState).toBe('unknown');
  });
  it('explicit current roots and parents override historical candidates', async () => {
    const e = setup(); const root = e.add(generated('telegram:1')); const child = e.add(generated('telegram:1'));
    e.setSource({ ...e.source(), parents: new Map([[`app:${root}`, null], [`app:${child}`, 'telegram:2']]) });
    await e.projection.settled(e.scope);
    expect(e.projection.fields(root, e.scope)).toMatchObject({ hierarchyState: 'root', parentConversationKey: null });
    expect(e.projection.fields(child, e.scope)).toMatchObject({ hierarchyState: 'child', parentConversationKey: 'telegram:2' });
    expect(e.projection.preview(root, e.scope).action).toBe('keep-current');
    expect(e.projection.preview(child, e.scope).action).toBe('keep-current');
  });
  it('unreadable current authority suppresses readable historical fallback; person intent stays unplaced', async () => {
    const e = setup(); const child = e.add(generated('telegram:1'));
    const person = e.add({ v: 1, source: { kind: 'person' }, parentConversationKey: 'telegram:2', parentBasis: 'explicit' });
    e.unreadable.add('telegram:2');
    e.setSource({ ...e.source(), parents: new Map([[`app:${child}`, 'telegram:2']]) });
    await e.projection.settled(e.scope);
    expect(e.projection.fields(child, e.scope)).toMatchObject({ hierarchyState: 'unplaced' });
    expect(e.projection.fields(child, e.scope).parentConversationKey).toBeUndefined();
    expect(e.projection.fields(person, e.scope).hierarchyState).toBe('unplaced');
    expect(e.projection.preview(child, e.scope).action).toBe('keep-current');
  });
  it('unavailable/incomplete is not an empty tree, including exact legacy card binding', async () => {
    const e = setup(); const person = e.add({ v: 1, source: { kind: 'person' }, parentConversationKey: null }); const legacy = e.add();
    e.setSource({ ...e.source(), complete: false, cardEvidence: [{ conversationKey: legacy, cardId: 'wc_0123456789abcdef', creationContext: { v: 1, source: { kind: 'work-board-card', cardId: 'wc_0123456789abcdef' } }, conflict: false }] });
    await e.projection.settled(e.scope);
    expect(e.projection.fields(person, e.scope).hierarchyState).toBe('unknown');
    expect(e.projection.fields(legacy, e.scope).hierarchyState).toBe('unplaced');
    expect(e.projection.preview(legacy, e.scope)).toMatchObject({ action: 'unresolved' });
  });
  it('suppresses all fallback cycle edges independently of page/output order', async () => {
    const e = setup(); const a = crypto.randomUUID(); const b = crypto.randomUUID();
    for (const [key, parent] of [[a, b], [b, a]]) {
      e.known.add(`app:${key}`);
      e.store.append({ kind: 'created', eventId: `create-${key}`, conversationKey: key!, title: 'Chat', at: new Date().toISOString(), machineId: 'm1', creationContext: generated(`app:${parent}`) });
    }
    const list = e.store.creationInventoryPage.bind(e.store);
    vi.spyOn(e.store, 'creationInventoryPage').mockImplementation((opts = {}) => list({ ...opts, limit: 1 }));
    await e.projection.settled(e.scope);
    expect(e.projection.fields(a, e.scope).hierarchyState).toBe('unplaced');
    expect(e.projection.fields(b, e.scope).hierarchyState).toBe('unplaced');
    expect(e.projection.fields(a, e.scope).parentConversationKey).toBeUndefined();
  });
  it('hidden live Work Board conversations remain in cycle detection without reappearing in user lists', async () => {
    const e = setup(); const a = crypto.randomUUID(); const b = crypto.randomUUID();
    for (const [key, parent] of [[a, b], [b, a]]) {
      e.known.add(`app:${key}`);
      e.store.append({ kind: 'created', eventId: `create-${key}`, conversationKey: key!, title: 'Chat', at: new Date().toISOString(), machineId: 'm1', creationContext: generated(`app:${parent}`) });
    }
    e.store.hiddenConversationKeys = () => new Set([b]);
    expect(e.store.listConversations().conversations.map((row) => row.conversationKey)).toEqual([a]);
    await e.projection.settled(e.scope);
    expect(e.projection.fields(a, e.scope).hierarchyState).toBe('unplaced');
    expect(e.projection.fields(b, e.scope).hierarchyState).toBe('unplaced');
    expect(e.store.listConversations().conversations.map((row) => row.conversationKey)).toEqual([a]);
  });
  it('preview rejects only the cyclic legacy proposal and preserves the current relation', async () => {
    const e = setup(); const a = e.add(); const b = e.add(generated(`app:${a}`));
    e.setSource({ ...e.source(), parents: new Map([[`app:${b}`, `app:${a}`]]), cardEvidence: [{ conversationKey: a, cardId: 'wc_0123456789abcdef', creationContext: { v: 1, source: { kind: 'work-board-card', cardId: 'wc_0123456789abcdef', sourceConversationKey: `app:${b}` } }, conflict: false }] });
    await e.projection.settled(e.scope);
    expect(e.projection.preview(a, e.scope)).toMatchObject({ action: 'unresolved', reason: 'cyclic-proposed-placement' });
    expect(e.projection.fields(b, e.scope)).toMatchObject({ hierarchyState: 'child', parentConversationKey: `app:${a}` });
  });
  it('a source-version change invalidates the cached result and fresh reference checks redact revocation', async () => {
    const e = setup(); const key = e.add(generated('telegram:1'));
    await e.projection.settled(e.scope);
    expect(e.projection.fields(key, e.scope).hierarchyState).toBe('child');
    e.unreadable.add('telegram:1');
    expect(e.projection.fields(key, e.scope)).toMatchObject({ hierarchyState: 'unplaced' });
    expect(e.projection.fields(key, e.scope).parentConversationKey).toBeUndefined();
    e.setSource({ ...e.source(), version: 'two', parents: new Map([[`app:${key}`, null]]) });
    expect(e.projection.fields(key, e.scope).hierarchyState).toBe('unplaced');
    await e.projection.settled(e.scope);
    expect(e.projection.fields(key, e.scope)).toMatchObject({ hierarchyState: 'root', parentConversationKey: null });
  });
  it('project fallback requires a current confirmed binding and ambiguous sources stay unresolved', async () => {
    const e = setup();
    const project = e.add({ v: 1, source: { kind: 'session', requestId: 'project-request' }, parentConversationKey: 'telegram:1', parentBasis: 'project' });
    const ambiguous = e.add({ v: 1, source: { kind: 'work-board-card', cardId: 'wc_0123456789abcdef', sourceConversationKey: 'telegram:1', projectKey: 'telegram:2' } });
    await e.projection.settled(e.scope);
    expect(e.projection.fields(project, e.scope).hierarchyState).toBe('unplaced');
    e.setSource({ ...e.source(), version: 'confirmed', confirmedProjects: new Set(['telegram:1', 'telegram:2']) });
    await e.projection.settled(e.scope);
    expect(e.projection.fields(project, e.scope)).toMatchObject({ hierarchyState: 'child', parentConversationKey: 'telegram:1' });
    expect(e.projection.fields(ambiguous, e.scope).hierarchyState).toBe('unplaced');
    expect(e.projection.preview(ambiguous, e.scope).reason).toBe('ambiguous-recorded-parent');
  });
  it('a background refresh cannot publish a fresh-source result under an older captured reader scope', async () => {
    const e = setup(); const key = e.add(generated('telegram:1'));
    const old = e.source(); const captured = { ...e.scope, source: old };
    e.setSource({ ...old, version: 'new-source', parents: new Map([[`app:${key}`, null]]) });
    await e.projection.settled(captured);
    const fresh = { ...e.scope, source: e.source() };
    // No result is attributed to the new source until a matching scope computed it.
    expect(e.projection.fields(key, fresh).hierarchyState).toBe('unplaced');
    await e.projection.settled(fresh);
    expect(e.projection.fields(key, fresh)).toMatchObject({ hierarchyState: 'root', parentConversationKey: null });
  });
  it('observable conflicting creation evidence is recoverably unplaced before and after refresh', async () => {
    const e = setup(); const key = e.add(generated('telegram:1'));
    const first = e.store.getCreationRecord(key)!;
    e.store.append({ ...first, creationContext: generated('telegram:2') });
    expect(e.store.hasCreationConflict(key)).toBe(true);
    expect(e.projection.fields(key, e.scope).hierarchyState).toBe('unplaced');
    await e.projection.settled(e.scope);
    expect(e.projection.fields(key, e.scope)).toEqual({ hierarchyState: 'unplaced' });
    expect(e.projection.preview(key, e.scope)).toMatchObject({ action: 'unresolved', reason: 'creation-evidence-conflict' });
  });
  it('read-only preview returns exact legacy card evidence without writing creation events', async () => {
    const e = setup(); const key = e.add();
    e.setSource({ ...e.source(), cardEvidence: [{ conversationKey: key, cardId: 'wc_0123456789abcdef', creationContext: { v: 1, source: { kind: 'work-board-card', cardId: 'wc_0123456789abcdef', sourceConversationKey: 'telegram:1' } }, conflict: false }] });
    const before = e.store.getCreationGeneration();
    await e.projection.settled(e.scope);
    expect(e.projection.fields(key, e.scope)).toMatchObject({ hierarchyState: 'unplaced', creationSource: { kind: 'work-board-card', evidence: 'card-binding' } });
    expect(e.projection.preview(key, e.scope)).toMatchObject({ action: 'would-place', proposedParentConversationKey: 'telegram:1' });
    expect(e.store.getCreationGeneration()).toBe(before);
    expect(e.store.getCreationRecord(key)?.creationContext).toBeUndefined();
  });
});
