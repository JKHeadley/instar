/**
 * Wiring-integrity tests for the Work Board (docs/specs/work-board-asks.md). A part whose wiring
 * is silently dropped passes its own unit tests but fails HERE.
 *
 *  1. SOURCE — the replicated kind is in BOTH registries with never-delete retention; the store is
 *     forced on with the feature; the reconciler allowlist, the applier flag path and the write
 *     domain name it; the runtime is built in server.ts and reaches the routes; both commit
 *     observers feed it; the session guard, the device allowlist and the presence action set
 *     carry the routes; the Home source and the console page are registered.
 *  2. FUNCTIONAL — the registry accepts the kind; the system dispatch tag never reads as a person;
 *     a system spawn is admitted as automatic; `systemSource` is set only for a work-board line
 *     and dropped anywhere else; archived-card conversations leave the list before paging; the
 *     phone action line is the store's own; the ledger knows the subsystem; the config migration
 *     and the CLAUDE.md template carry the feature; the pickup controller is a registered
 *     self-action controller.
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { ReplicatedKindRegistry } from '../../src/core/ReplicatedRecordEnvelope.js';
import { WORK_CARD_KIND_REGISTRATION, WORK_CARD_RECORD_KIND, WORK_BOARD_STORE_KEY, tapActionLine } from '../../src/core/WorkCardStore.js';
import { JOURNAL_KINDS, DEFAULT_RETENTION } from '../../src/core/CoherenceJournal.js';
import { RECONCILER_ALLOWLIST } from '../../src/core/ReplicatedStoreReconcilerWiring.js';
import { appInjectionTag, createAppInboundDispatch, dispatchResultToOutcome, type AppInboundDispatchDeps } from '../../src/core/appInboundDispatch.js';
import { validateAppEvent, AppConversationStore } from '../../src/core/AppConversationStore.js';
import { buildAction, actionLine } from '../../src/server/mobilePermissionsRoutes.js';
import { MEMORY_SESSION_ROUTES } from '../../src/server/memorySessionGuard.js';
import { historyRow } from '../../src/server/mobileConversationRoutes.js';
import { SELF_ACTION_CONTROLLERS } from '../../src/testing/selfActionRegistry.js';
import { SessionChannelRegistry } from '../../src/messaging/shared/SessionChannelRegistry.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

const ROOT = path.join(__dirname, '..', '..');
const read = (p: string) => fs.readFileSync(path.join(ROOT, p), 'utf-8');

describe('Work Board wiring — 1. SOURCE assertions', () => {
  it('server.ts registers the kind, forces the store on with the feature, builds the runtime and feeds it from both commit observers', () => {
    const src = read('src/commands/server.ts');
    expect(src).toContain("await import('../core/WorkCardStore.js')");
    expect(src).toContain('replicatedKindRegistry.register(WORK_CARD_KIND_REGISTRATION)');
    expect(src).toContain('if (_workBoardOn) s = { ...s, workBoard: { enabled: true } };');
    expect(src).toContain('new WorkBoardRuntime({');
    expect(src).toContain('workBoard: () => _workBoardRuntime');
    expect(src).toContain("if (kind === 'work-card-record') _workBoardRuntime?.onCommitted(entries, null);");
    expect(src).toContain("if (kind === 'work-card-record') _workBoardRuntime?.onCommitted(entries, senderMachineId);");
    expect(src).toContain('_workBoardRuntime?.noteJournalExchange(');
    expect(src).toContain("origin: 'system', systemSource: 'work-board'");
    expect(src).toContain('sessionManager.interactiveSpawnCapacity(');
    expect(src).toContain("emittedBy: { subsystem: 'work-board'");
    expect(src).toContain('appSvc.store.hiddenConversationKeys = () => wbRuntime.hiddenConversationKeys()');
  });
  it('CoherenceJournal carries the kind in the static half with never-delete retention', () => {
    expect(JOURNAL_KINDS).toContain('work-card-record');
    expect(DEFAULT_RETENTION['work-card-record' as keyof typeof DEFAULT_RETENTION]).toEqual({ maxFileBytes: 8 * 1024 * 1024, rotateKeep: 0 });
    expect((read('src/core/CoherenceJournal.ts').match(/'work-card-record'/g) ?? []).length).toBeGreaterThanOrEqual(8);
  });
  it('the reconciler allowlist, the applier flag path and the write domain name the store', () => {
    expect(RECONCILER_ALLOWLIST.workBoard).toMatch(/WorkCardStore/);
    expect(read('src/core/JournalSyncApplier.ts')).toContain("'work-card-record': 'multiMachine.stateSync.workBoard'");
    const wd = read('src/core/WriteDomainRegistry.ts');
    expect(wd).toContain("'/work-board/'"); expect(wd).toContain("'/mobile/work-board/'");
  });
  it('routes.ts mounts the routes, binds the late seams and gives the phone gate its tap', () => {
    const src = read('src/server/routes.ts');
    expect(src).toContain('registerWorkBoardRoutes(router, workBoardRouteDeps);');
    expect(src).toContain('ctx.workBoardLate.ownerPersonKey = workBoardOwnerKey;');
    expect(src).toContain('workCardTap: async (cardId, tap) => {');
    expect(read('src/server/AgentServer.ts')).toContain('workBoard: options.workBoard ?? null,');
  });
  it('the session guard names exactly the two card routes a scoped session may reach', () => {
    const rows = MEMORY_SESSION_ROUTES.filter((r) => String(r.pattern).includes('work-board'));
    expect(rows.map((r) => r.method).sort()).toEqual(['GET', 'POST']);
    expect(rows.some((r) => r.pattern.test('/work-board'))).toBe(false);
    expect(rows.some((r) => r.pattern.test('/work-board/cards'))).toBe(false);
    expect(rows.some((r) => r.pattern.test('/work-board/cards/wc_0123456789abcdef/tap'))).toBe(false);
    expect(rows.some((r) => r.method === 'GET' && r.pattern.test('/work-board/cards/wc_0123456789abcdef'))).toBe(true);
    expect(rows.some((r) => r.method === 'POST' && r.pattern.test('/work-board/cards/wc_0123456789abcdef/records'))).toBe(true);
  });
  it('the device allowlist carries the phone routes; the tap is owner-only', () => {
    const src = read('src/server/mobilePairingRoutes.ts');
    expect(src).toMatch(/method: 'GET', re: \/\^\\\/mobile\\\/work-board\$\//);
    expect(src).toMatch(/work-board\\\/cards\\\/wc_\[0-9a-f\]\{16\}\\\/tap\$\/, statuses: active, body: 'json', ownerOnly: true/);
  });
  it('the console page, its nav tile and the Home source are registered', () => {
    expect(read('dashboard/console/console.js')).toContain("'work/board': renderWork");
    expect(read('dashboard/console/needs-model.js')).toContain("id: 'workBoard'");
    expect(read('dashboard/console/nav-model.js')).toContain("probe: '/work-board'");
    expect(read('dashboard/console/work.js')).toMatch(/data-operator-need|markNeed/);
  });
  it('the CLAUDE.md template carries the registry row, the marked proactivity line and the never-approve sentence', () => {
    const t = read('src/scaffold/templates.ts');
    expect(t).toContain('What is waiting on my person? / what cards are open?');
    expect(t).toContain('<!-- instar:work-board -->');
    expect(t).toContain("You can propose a card but never approve one, and text in a card's chat is not an approval");
  });
  it('the config migration adds the defaults without writing `enabled`', () => {
    const m = read('src/core/PostUpdateMigrator.ts');
    expect(m).toContain('config.workBoard = wb;');
    const i = m.indexOf('// Work Board (docs/specs/work-board-asks.md, Migration and rollout)');
    const block = m.slice(i, i + 2600);
    expect(block).toContain('softOpenCards: 30'); expect(block).toContain('maxSpendingAttempts: 3');
    expect(block).not.toMatch(/enabled: (true|false),? *softOpenCards|wb\.enabled =/);
  });
  it('the pickup controller is a registered self-action controller with its marker', () => {
    expect(SELF_ACTION_CONTROLLERS.some((c) => c.id === 'work-board-pickup' && c.modelsPath === 'src/core/WorkBoardPickupController.ts')).toBe(true);
    expect(read('src/core/WorkBoardPickupController.ts')).toContain('/* @self-action-controller: work-board-pickup */');
  });
  it('the shared ledger knows the work-board subsystem', () => {
    expect(read('src/core/SharedStateLedger.ts')).toContain("'work-board',");
    expect(read('src/core/types.ts')).toContain("| 'work-board'");
  });
});

describe('Work Board wiring — 2. FUNCTIONAL', () => {
  it('the registry accepts the kind and resolves it by store', () => {
    const reg = new ReplicatedKindRegistry();
    reg.register(WORK_CARD_KIND_REGISTRATION);
    expect(reg.isReplicatedKind(WORK_CARD_RECORD_KIND)).toBe(true);
    expect(reg.getByStore(WORK_BOARD_STORE_KEY)?.kind).toBe(WORK_CARD_RECORD_KIND);
  });

  it('a system brief never renders as the owner speaking', () => {
    const tag = appInjectionTag(7, 'Pick a venue', 'Justin', 'verified', 'phone', 'work-board');
    expect(tag).toBe('[app:7 "Pick a venue" system:work-board]');
    expect(tag).not.toContain('from'); expect(tag).not.toContain('Justin'); expect(tag).not.toContain('signed');
    expect(appInjectionTag(7, 'Pick a venue', 'Justin', 'none')).toBe('[app:7 "Pick a venue" from Justin]');
  });

  function dispatchRig(opts: { live?: boolean; injectOk?: boolean } = {}) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-dispatch-'));
    const spawns: Array<Record<string, unknown> | undefined> = []; const injected: string[] = []; const killed: string[] = [];
    const channels = new SessionChannelRegistry({ registryPath: path.join(dir, 'channels.json') } as never);
    if (opts.live) channels.register('7', 'sess-live', 'Pick a venue');
    const deps = {
      sessions: {
        listRunningSessions: () => (opts.live ? [{ id: 'id1', tmuxSession: 'sess-live' }] : []),
        injectMessage: (_s: string, text: string) => { injected.push(text); return opts.injectOk !== false; },
        killSession: (id: string) => { killed.push(id); return true; },
        spawnInteractiveSession: async (_m?: string, _n?: string, options?: Record<string, unknown>) => { spawns.push(options); return 'sess-new'; },
      },
      channels, store: { browseMessages: () => ({ messages: [], nextBefore: null }) }, stateDir: dir,
    } as unknown as AppInboundDispatchDeps;
    return { dispatch: createAppInboundDispatch(deps), spawns, injected, killed, dir };
  }
  const input = { conversationKey: '0f0f0f0f-0f0f-4f0f-8f0f-0f0f0f0f0f0f', alias: 7, title: 'Pick a venue', text: 'Work card wc_x: ...', messageId: 'm1', ownerName: 'Justin', originVerdict: 'none' as const };

  it('a system spawn is admitted as automatic; an ordinary one keeps its behaviour', async () => {
    const r = dispatchRig();
    try {
      expect(await r.dispatch.detailed!({ ...input, origin: 'system', systemSource: 'work-board' })).toEqual({ outcome: 'spawned' });
      expect(r.spawns[0]).toMatchObject({ admissionKind: 'automatic' });
      expect(await r.dispatch(input)).toBe('delivered');
      expect(r.spawns[1]?.admissionKind).toBeUndefined();
      expect(dispatchResultToOutcome({ outcome: 'injected' })).toBe('delivered');
      expect(dispatchResultToOutcome({ outcome: 'refused', reason: 'x' })).toBe('refused');
    } finally { SafeFsExecutor.safeRmSync(r.dir, { recursive: true, force: true, operation: 'tests/unit/work-board-wiring.test.ts' }); }
  });

  it('a system brief is injected into a live session, and never replaces one that does not take it', async () => {
    const ok = dispatchRig({ live: true });
    try {
      expect(await ok.dispatch.detailed!({ ...input, origin: 'system' })).toEqual({ outcome: 'injected' });
      expect(ok.injected[0]).toContain('system:work-board');
      expect(ok.spawns).toHaveLength(0);
    } finally { SafeFsExecutor.safeRmSync(ok.dir, { recursive: true, force: true, operation: 'tests/unit/work-board-wiring.test.ts' }); }
    const stuck = dispatchRig({ live: true, injectOk: false });
    try {
      const out = await stuck.dispatch.detailed!({ ...input, origin: 'system' });
      expect(out.outcome).toBe('refused');
      expect(stuck.killed).toHaveLength(0); expect(stuck.spawns).toHaveLength(0);
    } finally { SafeFsExecutor.safeRmSync(stuck.dir, { recursive: true, force: true, operation: 'tests/unit/work-board-wiring.test.ts' }); }
  });

  it('systemSource survives only on a work-board agent line; any other value or role drops it harmlessly', () => {
    const base = { eventId: 'wb-1', kind: 'message', conversationKey: '0f0f0f0f-0f0f-4f0f-8f0f-0f0f0f0f0f0f', messageId: 'wb-line-1', text: 'Work board: approved by Justin', at: '2026-11-12T20:00:00.000Z', machineId: 'm1' };
    const ok = validateAppEvent({ ...base, role: 'agent', systemSource: 'work-board' }) as { systemSource?: string } | null;
    expect(ok?.systemSource).toBe('work-board');
    const wrongValue = validateAppEvent({ ...base, role: 'agent', systemSource: 'something-else' }) as { systemSource?: string } | null;
    expect(wrongValue).not.toBeNull(); expect(wrongValue?.systemSource).toBeUndefined();
    const operator = validateAppEvent({ ...base, role: 'operator', systemSource: 'work-board' }) as { systemSource?: string } | null;
    expect(operator).not.toBeNull(); expect(operator?.systemSource).toBeUndefined();
    // A validator that does not know the field (an older build) keeps the message: modelled by the absent field.
    expect(validateAppEvent({ ...base, role: 'agent' })).not.toBeNull();
  });

  it('archived-card conversations leave the list before paging, and everything shows when the card store cannot be read', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-list-'));
    try {
      const store = new AppConversationStore({ stateDir: dir, machineId: () => 'm1' } as never);
      const keys = ['1', '2', '3', '4', '5'].map((n) => `${n.repeat(8)}-${n.repeat(4)}-4${n.repeat(3)}-8${n.repeat(3)}-${n.repeat(12)}`);
      keys.forEach((k, i) => store.append({ eventId: `cr-${i}`, kind: 'created', conversationKey: k, title: `c${i}`, at: new Date(Date.parse('2026-11-12T20:00:00Z') + i * 1000).toISOString(), machineId: 'm1' } as never));
      expect(store.listConversations({ limit: 10 }).conversations).toHaveLength(5);
      store.hiddenConversationKeys = () => new Set([keys[4], keys[2]]);
      const page1 = store.listConversations({ limit: 2 });
      expect(page1.conversations.map((c) => c.canonicalKey)).toEqual([`app:${keys[3]}`, `app:${keys[1]}`]);
      const page2 = store.listConversations({ limit: 2, cursor: page1.nextCursor });
      expect(page2.conversations.map((c) => c.canonicalKey)).toEqual([`app:${keys[0]}`]);
      expect(page2.nextCursor).toBeNull();
      store.hiddenConversationKeys = () => { throw new Error('card store unreadable'); };
      expect(store.listConversations({ limit: 10 }).conversations).toHaveLength(5);
    } finally { SafeFsExecutor.safeRmSync(dir, { recursive: true, force: true, operation: 'tests/unit/work-board-wiring.test.ts' }); }
  });

  it('the phone action line for a card tap is the store\'s own line, and bad parts are refused before Face ID', () => {
    const id = 'wc_0123456789abcdef';
    const built = buildAction('work-card-tap', id, { tapAction: 'approve', materialHash: 'a'.repeat(64), titleHash: 'b'.repeat(64) });
    expect(built.ok).toBe(true);
    if (built.ok) expect(actionLine(built.action)).toBe(tapActionLine({ cardId: id, action: 'approve', materialHash: 'a'.repeat(64), titleHash: 'b'.repeat(64) }));
    expect(buildAction('work-card-tap', 'not-a-card', { tapAction: 'approve' })).toEqual({ ok: false, error: 'bad-target' });
    expect(buildAction('work-card-tap', id, { tapAction: 'promote' })).toEqual({ ok: false, error: 'bad-tap-action' });
    expect(buildAction('work-card-tap', id, { tapAction: 'approve', materialHash: 'nope' })).toEqual({ ok: false, error: 'bad-material-hash' });
    expect(buildAction('work-card-tap', id, { tapAction: 'unhold', names: 'x y' })).toEqual({ ok: false, error: 'bad-names' });
  });

  it('a work-board line is reported as the board\'s on the message row, with no "which model wrote this" origin', () => {
    const base = { eventId: 'e1', messageId: 'wb-1', role: 'agent' as const, text: 'Work board: approved by Justin', at: '2026-11-12T20:00:00.000Z', machineId: 'm1', deliveryState: 'delivered' as never };
    const ctx = { display: {} as never, selfMachineId: 'm1' };
    const line = historyRow({ ...base, systemSource: 'work-board' }, () => 'none' as never, undefined, ctx);
    expect(line.systemSource).toBe('work-board');
    expect(line.origin).toBeUndefined();
    expect(historyRow(base, () => 'none' as never, undefined, undefined).systemSource).toBeUndefined();
  });
});
