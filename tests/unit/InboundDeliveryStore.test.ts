import { describe, expect, it } from 'vitest';
import crypto from 'node:crypto';
import {
  InboundDeliveryBackpressureError, InboundDeliveryStore, inboundDeliveryStoreOptionsFromQueue,
} from '../../src/core/InboundDeliveryStore.js';

describe('InboundDeliveryStore', () => {
  it('derives live row/payload bounds from the inbound queue config and retains later rows prepared', () => {
    expect(inboundDeliveryStoreOptionsFromQueue(undefined)).toEqual({
      maxLiveRows: 100, maxLiveRowsPerConversation: 10,
      maxPayloadBytes: 256 * 1024, maxLiveBytes: 100 * (256 * 1024 + 512),
    });
    const options = inboundDeliveryStoreOptionsFromQueue({
      enabled: true, maxPerSession: 2, maxTotal: 3, hardMaxTotal: 2, maxPayloadBytes: 16,
    });
    expect(options).toEqual({ maxLiveRows: 2, maxLiveRowsPerConversation: 2, maxPayloadBytes: 16, maxLiveBytes: 1_056 });
    const store = InboundDeliveryStore.openMemory(options);
    const first = store.prepare({ conversationId: 'c', deliveryId: 'one', incarnation: 'i', framework: 'codex-cli', envelope: 'first', hmacKey: 'k' });
    store.transition('c', first.deliveryId, 'prepared', 'dispatch-armed');
    store.transition('c', first.deliveryId, 'dispatch-armed', 'dispatch-started');
    store.transition('c', first.deliveryId, 'dispatch-started', 'dispatched');
    const queued = store.prepare({ conversationId: 'c', deliveryId: 'two', incarnation: 'i', framework: 'codex-cli', envelope: 'second', hmacKey: 'k' });
    expect(queued.transportState).toBe('prepared');
    expect(store.hasOtherActiveDispatch('c', queued.deliveryId)).toBe(true);
    expect(store.dispatchablePrepared()).toEqual([]);
    expect(() => store.prepare({ conversationId: 'c', deliveryId: 'three', incarnation: 'i', framework: 'codex-cli', envelope: 'third', hmacKey: 'k' }))
      .toThrow(InboundDeliveryBackpressureError);
  });

  it('does not let preserved non-Codex prepared rows starve the bounded Codex dispatcher', () => {
    const store = InboundDeliveryStore.openMemory();
    for (let index = 0; index < 4; index++) {
      store.prepare({
        conversationId: `legacy-${index}`, deliveryId: `legacy-${index}`, incarnation: `claude-${index}`,
        framework: 'claude-code', envelope: `legacy ${index}`, hmacKey: 'k',
      });
    }
    const codex = store.prepare({
      conversationId: 'codex', deliveryId: 'codex-next', incarnation: 'codex-session',
      framework: 'codex-cli', envelope: 'queued codex delivery', hmacKey: 'k',
    });
    expect(store.dispatchablePrepared(4).map((row) => row.deliveryId)).toEqual([codex.deliveryId]);
  });

  it('can scan the full configured live-row ceiling beyond one hundred candidates', () => {
    const store = InboundDeliveryStore.openMemory({ maxLiveRows: 110, maxLiveRowsPerConversation: 1 });
    for (let index = 0; index < 105; index++) {
      store.prepare({
        conversationId: `dead-codex-${index}`, deliveryId: `dead-codex-${index}`,
        incarnation: `dead-codex-${index}`, framework: 'codex-cli', envelope: `dead ${index}`, hmacKey: 'k',
      });
    }
    const live = store.prepare({
      conversationId: 'live-codex', deliveryId: 'live-codex', incarnation: 'live-codex',
      framework: 'codex-cli', envelope: 'live', hmacKey: 'k',
    });
    const candidates = store.dispatchablePrepared(Number.MAX_SAFE_INTEGER);
    expect(candidates).toHaveLength(106);
    expect(candidates.at(-1)?.deliveryId).toBe(live.deliveryId);
  });

  it('keeps bodies private and enforces monotonic dispatch phases', () => {
    const store = InboundDeliveryStore.openMemory();
    const row = store.prepare({
      conversationId: 'topic:59199', incarnation: 'inc-1', framework: 'codex-cli',
      envelope: 'private multiline\r\nbody', hmacKey: 'secret-key',
    });
    expect(row.envelopeHmac).not.toContain('private');
    expect(row.envelopeBytes).toBe(Buffer.byteLength('private multiline\nbody'));
    expect(store.transition('topic:59199', row.deliveryId, 'prepared', 'dispatch-armed')).toBe(true);
    expect(store.transition('topic:59199', row.deliveryId, 'dispatch-armed', 'dispatched')).toBe(false);
    expect(store.transition('topic:59199', row.deliveryId, 'dispatch-armed', 'dispatch-started')).toBe(true);
    expect(store.transition('topic:59199', row.deliveryId, 'dispatch-started', 'dispatched')).toBe(true);
  });

  it('allocates unique ordinals and exactly four distinct key rungs', () => {
    const store = InboundDeliveryStore.openMemory();
    const make = () => store.prepare({ conversationId: 'c', incarnation: 'i', framework: 'codex-cli', envelope: 'same', hmacKey: 'k' });
    const first = make();
    const second = make();
    expect([first.ordinal, second.ordinal]).toEqual([1, 2]);
    store.transition('c', first.deliveryId, 'prepared', 'dispatch-armed');
    store.transition('c', first.deliveryId, 'dispatch-armed', 'dispatch-started');
    store.transition('c', first.deliveryId, 'dispatch-started', 'dispatched');
    for (let i = 0; i < 4; i++) expect(store.armAttempt('c', first.deliveryId, i)).toBe(true);
    expect(store.armAttempt('c', first.deliveryId, 4)).toBe(false);
    expect(store.armAttempt('c', first.deliveryId, 0)).toBe(false);
  });

  it('turns crash-open physical effects into permanent uncertainty', () => {
    const store = InboundDeliveryStore.openMemory();
    const row = store.prepare({ conversationId: 'c', incarnation: 'i', framework: 'codex-cli', envelope: 'x', hmacKey: 'k' });
    store.transition('c', row.deliveryId, 'prepared', 'dispatch-armed');
    store.transition('c', row.deliveryId, 'dispatch-armed', 'dispatch-started');
    expect(store.reconcileInterruptedEffects()).toEqual({ deliveries: 1, attempts: 0 });
    expect(store.get('c', row.deliveryId)?.transportState).toBe('effect-unknown');
    expect(store.transition('c', row.deliveryId, 'effect-unknown', 'dispatched')).toBe(false);
  });

  it('fences live rows to a monotonically newer owner epoch', () => {
    const store = InboundDeliveryStore.openMemory();
    const row = store.prepare({
      conversationId: 'topic:59199', incarnation: 'inc-1', framework: 'codex-cli',
      envelope: 'private body', hmacKey: 'k', ownerMachineId: 'studio', ownerEpoch: 7,
    });
    expect(row).toMatchObject({ schemaVersion: 2, ownerMachineId: 'studio', ownerEpoch: 7, transferState: 'local' });
    expect(store.ownsLiveDelivery('topic:59199', row.deliveryId, 'studio', 7)).toBe(true);
    expect(store.transferLiveRows('topic:59199', 'studio', 7, 'mini', 7)).toBe(0);
    expect(store.transferLiveRows('topic:59199', 'studio', 7, 'mini', 8)).toBe(1);
    expect(store.ownsLiveDelivery('topic:59199', row.deliveryId, 'studio', 7)).toBe(false);
    expect(store.ownsLiveDelivery('topic:59199', row.deliveryId, 'mini', 8)).toBe(false);
    expect(store.claimTransferredRows('topic:59199', 'mini', 8, 9)).toBe(1);
    expect(store.ownsLiveDelivery('topic:59199', row.deliveryId, 'mini', 9)).toBe(true);
    expect(store.get('topic:59199', row.deliveryId)).toMatchObject({
      ownerMachineId: 'mini', ownerEpoch: 9, transferState: 'imported',
    });
  });

  it('moves encrypted replay custody across machines and rejects stale or foreign imports', () => {
    const source = InboundDeliveryStore.openMemory();
    const target = InboundDeliveryStore.openMemory();
    const foreign = crypto.generateKeyPairSync('x25519');
    const targetKeys = crypto.generateKeyPairSync('x25519');
    const targetPublic = (targetKeys.publicKey.export({ type: 'spki', format: 'der' }) as Buffer).toString('base64');
    const row = source.prepare({
      conversationId: '59199', deliveryId: 'd-1', incarnation: 'inc-a', framework: 'codex-cli',
      envelope: 'message body that must stay encrypted on the wire', hmacKey: 'source-key',
      ownerMachineId: 'studio', ownerEpoch: 7,
    });
    source.transition('59199', row.deliveryId, 'prepared', 'dispatch-armed');
    source.transition('59199', row.deliveryId, 'dispatch-armed', 'dispatch-started');
    source.transition('59199', row.deliveryId, 'dispatch-started', 'dispatched');
    expect(source.bindImportedRolloutPath('59199', row.deliveryId, '/tmp/should-not-bind-without-baseline')).toBe(false);
    source.armAttempt('59199', row.deliveryId, 0);
    const transfer = source.exportLiveRows({
      conversationId: '59199', sourceMachineId: 'studio', sourceEpoch: 7,
      targetMachineId: 'mini', transferEpoch: 8, activeEpoch: 9,
      localHmacKey: 'source-key', targetEncryptionPublicKey: targetPublic,
    });
    expect(JSON.stringify(transfer)).not.toContain('message body');
    expect(source.ownsLiveDelivery('59199', 'd-1', 'studio', 7)).toBe(false);
    expect(() => target.importLiveRows({
      transfer, ownEncryptionPrivateKey: foreign.privateKey, localHmacKey: 'target-key',
      authenticatedSourceMachineId: 'studio', expectedTargetMachineId: 'mini',
      expectedConversationId: '59199', expectedTransferEpoch: 8,
    })).toThrow();
    expect(() => target.importLiveRows({
      transfer, ownEncryptionPrivateKey: targetKeys.privateKey, localHmacKey: 'target-key',
      authenticatedSourceMachineId: 'studio', expectedTargetMachineId: 'mini',
      expectedConversationId: '59199', expectedTransferEpoch: 7,
    })).toThrow('identity/epoch mismatch');
    expect(target.importLiveRows({
      transfer, ownEncryptionPrivateKey: targetKeys.privateKey, localHmacKey: 'target-key',
      authenticatedSourceMachineId: 'studio', expectedTargetMachineId: 'mini',
      expectedConversationId: '59199', expectedTransferEpoch: 8,
    })).toEqual({ imported: 1, duplicate: 0, activeEpoch: 9 });
    expect(target.ownsLiveDelivery('59199', 'd-1', 'mini', 9)).toBe(true);
    expect(target.importLiveRows({
      transfer, ownEncryptionPrivateKey: targetKeys.privateKey, localHmacKey: 'target-key',
      authenticatedSourceMachineId: 'studio', expectedTargetMachineId: 'mini',
      expectedConversationId: '59199', expectedTransferEpoch: 8,
    })).toEqual({ imported: 0, duplicate: 1, activeEpoch: 9 });
  });

  it('keeps a consumed-but-unanswered delivery live and transferable until response evidence arrives', () => {
    const source = InboundDeliveryStore.openMemory({ now: () => 2_000 });
    const target = InboundDeliveryStore.openMemory({ now: () => 2_000 });
    const targetKeys = crypto.generateKeyPairSync('x25519');
    const targetPublic = (targetKeys.publicKey.export({ type: 'spki', format: 'der' }) as Buffer).toString('base64');
    const row = source.prepare({
      conversationId: 'c', deliveryId: 'd', incarnation: 'inc', framework: 'codex-cli', envelope: 'body',
      hmacKey: 'source', ownerMachineId: 'studio', ownerEpoch: 1,
    });
    expect(source.bindRolloutBaseline('c', 'd', '/tmp/source-rollout.jsonl', 'rollout-1', 42)).toBe(true);
    source.transition('c', 'd', 'prepared', 'dispatch-armed');
    source.transition('c', 'd', 'dispatch-armed', 'dispatch-started');
    source.transition('c', 'd', 'dispatch-started', 'dispatched');
    expect(source.recordTranscriptConsumed('c', 'd', 'turn-1', 100)).toBe(true);
    expect(source.get('c', 'd')).toMatchObject({ transportState: 'dispatched', transcriptState: 'consumed' });
    expect(source.status().liveRows).toBe(1);

    const transfer = source.exportLiveRows({
      conversationId: 'c', sourceMachineId: 'studio', sourceEpoch: 1, targetMachineId: 'mini',
      transferEpoch: 2, activeEpoch: 3, localHmacKey: 'source', targetEncryptionPublicKey: targetPublic,
    });
    expect(target.importLiveRows({
      transfer, ownEncryptionPrivateKey: targetKeys.privateKey, localHmacKey: 'target',
      authenticatedSourceMachineId: 'studio', expectedTargetMachineId: 'mini', expectedConversationId: 'c', expectedTransferEpoch: 2,
    })).toMatchObject({ imported: 1 });
    expect(target.get('c', 'd')).toMatchObject({
      transportState: 'dispatched', transcriptState: 'consumed', rolloutId: 'rollout-1', baselineOffset: 42,
      observedOffset: 100, turnId: 'turn-1', consumedAt: 2_000,
    });
    expect(target.bindImportedRolloutSuccessor({
      conversationId: 'c', deliveryId: 'd', targetMachineId: 'mini', ownerEpoch: 3,
      incarnation: 'target-incarnation', rolloutPath: '/tmp/target-successor.jsonl',
      rolloutId: 'rollout-1', baselineOffset: 17,
    })).toBe(true);
    expect(target.get('c', 'd')).toMatchObject({
      incarnation: 'target-incarnation', rolloutId: 'rollout-1',
      rolloutPath: '/tmp/target-successor.jsonl', baselineOffset: 17, observedOffset: 17,
    });
    expect(target.bindImportedRolloutSuccessor({
      conversationId: 'c', deliveryId: 'd', targetMachineId: 'mini', ownerEpoch: 3,
      incarnation: 'attacker', rolloutPath: '/tmp/other.jsonl', rolloutId: 'other', baselineOffset: 0,
    })).toBe(false);
  });

  it('permanently supersedes an older exhausted draft when a newer ordinal dispatches', () => {
    const store = InboundDeliveryStore.openMemory();
    const first = store.prepare({
      conversationId: 'c', deliveryId: 'old', incarnation: 'i', framework: 'codex-cli', envelope: 'old', hmacKey: 'k',
    });
    store.transition('c', first.deliveryId, 'prepared', 'dispatch-armed');
    store.transition('c', first.deliveryId, 'dispatch-armed', 'dispatch-started');
    store.transition('c', first.deliveryId, 'dispatch-started', 'dispatched');
    expect(store.recordComposerState('c', first.deliveryId, 'present')).toBe(true);
    for (let index = 0; index < 4; index++) {
      expect(store.armAttempt('c', first.deliveryId, index)).toBe(true);
      expect(store.transitionAttempt('c', first.deliveryId, index, 'attempt-armed', 'attempt-started')).toBe(true);
      expect(store.transitionAttempt('c', first.deliveryId, index, 'attempt-started', 'attempted')).toBe(true);
    }
    expect(store.markKeypressExhausted('c', first.deliveryId)).toBe(true);

    const newer = store.prepare({
      conversationId: 'c', deliveryId: 'new', incarnation: 'i', framework: 'codex-cli', envelope: 'new', hmacKey: 'k',
    });
    store.transition('c', newer.deliveryId, 'prepared', 'dispatch-armed');
    store.transition('c', newer.deliveryId, 'dispatch-armed', 'dispatch-started');
    expect(store.get('c', first.deliveryId)?.eligibilityState).toBe('keypress-exhausted');
    expect(store.transition('c', newer.deliveryId, 'dispatch-started', 'dispatched')).toBe(true);
    expect(store.get('c', first.deliveryId)?.eligibilityState).toBe('superseded');
    expect(store.armAttempt('c', first.deliveryId, 0)).toBe(false);
    expect(store.pendingNotices()).toEqual([expect.objectContaining({
      conversationId: 'c', deliveryId: first.deliveryId, kind: 'superseded',
    })]);
    expect(store.markNoticeDelivered(store.pendingNotices()[0])).toBe(true);
    expect(store.pendingNotices()).toEqual([]);
  });

  it('refuses atomically at the live row and byte ceilings without evicting evidence', () => {
    const rows = InboundDeliveryStore.openMemory({ maxLiveRows: 2, maxLiveBytes: 100 });
    const make = (id: string, envelope = '1234') => rows.prepare({
      conversationId: 'c', deliveryId: id, incarnation: 'i', framework: 'codex-cli', envelope, hmacKey: 'k',
    });
    make('one');
    make('two');
    expect(() => make('three')).toThrowError(expect.objectContaining({
      code: 'INBOUND_DELIVERY_BACKPRESSURE', reason: 'live-row-limit',
    }));
    expect(rows.status()).toMatchObject({ liveRows: 2, liveBytes: 8, logicalRows: 2 });

    const bytes = InboundDeliveryStore.openMemory({ maxLiveRows: 10, maxLiveBytes: 5 });
    bytes.prepare({ conversationId: 'c', deliveryId: 'a', incarnation: 'i', framework: 'codex-cli', envelope: '1234', hmacKey: 'k' });
    expect(() => bytes.prepare({ conversationId: 'c', deliveryId: 'b', incarnation: 'i', framework: 'codex-cli', envelope: 'xx', hmacKey: 'k' }))
      .toThrowError(expect.objectContaining({ reason: 'live-byte-limit' }));
    expect(bytes.status().liveRows).toBe(1);
  });

  it('releases admission capacity when an expired observation becomes terminally unknown', () => {
    const store = InboundDeliveryStore.openMemory({ maxLiveRows: 1 });
    const row = store.prepare({
      conversationId: 'c', deliveryId: 'uncertain', incarnation: 'i',
      framework: 'codex-cli', envelope: 'first', hmacKey: 'k',
    });
    store.transition('c', row.deliveryId, 'prepared', 'dispatch-armed');
    store.transition('c', row.deliveryId, 'dispatch-armed', 'dispatch-started');
    store.transition('c', row.deliveryId, 'dispatch-started', 'dispatched');
    expect(store.status().liveRows).toBe(1);

    expect(store.markObservationUnknown('c', row.deliveryId)).toBe(true);

    expect(store.get('c', row.deliveryId)).toMatchObject({
      transportState: 'effect-unknown', transcriptState: 'unknown', eligibilityState: 'unknown',
    });
    expect(store.status()).toMatchObject({ liveRows: 0, uncertainEffects: 1 });
    expect(() => store.prepare({
      conversationId: 'next', deliveryId: 'next', incarnation: 'i',
      framework: 'codex-cli', envelope: 'second', hmacKey: 'k',
    })).not.toThrow();
  });

  it('atomically releases all live capacity when a shared rollout becomes unknown', () => {
    const store = InboundDeliveryStore.openMemory({ maxLiveRows: 2, maxLiveRowsPerConversation: 2 });
    for (const [conversationId, deliveryId] of [['one', 'd1'], ['two', 'd2']] as const) {
      const row = store.prepare({
        conversationId, deliveryId, incarnation: 'i', framework: 'codex-cli',
        envelope: deliveryId, hmacKey: 'k',
      });
      store.transition(conversationId, deliveryId, 'prepared', 'dispatch-armed');
      store.bindRolloutBaseline(conversationId, deliveryId, '/tmp/shared-rollout.jsonl', 'rollout', 0);
      store.transition(conversationId, deliveryId, 'dispatch-armed', 'dispatch-started');
      store.transition(conversationId, deliveryId, 'dispatch-started', 'dispatched');
    }
    expect(store.status().liveRows).toBe(2);

    expect(store.markRolloutUnknown('rollout', '/tmp/shared-rollout.jsonl')).toBe(2);

    expect(store.status()).toMatchObject({ liveRows: 0, uncertainEffects: 2 });
    expect(store.get('one', 'd1')?.transportState).toBe('effect-unknown');
    expect(store.get('two', 'd2')?.transportState).toBe('effect-unknown');
  });

  it('retains at most the newest terminal rows and expires them by TTL in bounded batches', () => {
    let now = 1_000;
    const store = InboundDeliveryStore.openMemory({
      terminalRowsPerConversation: 2, terminalTtlMs: 100, gcBatchRows: 2, gcBudgetMs: 25, now: () => now,
    });
    const finish = (id: string) => {
      const row = store.prepare({ conversationId: 'c', deliveryId: id, incarnation: 'i', framework: 'codex-cli', envelope: id, hmacKey: 'k' });
      store.transition('c', row.deliveryId, 'prepared', 'dispatch-armed');
      store.transition('c', row.deliveryId, 'dispatch-armed', 'dispatch-started');
      store.transition('c', row.deliveryId, 'dispatch-started', 'dispatched');
      store.terminalize('c', row.deliveryId);
    };
    finish('one'); now += 1; finish('two'); now += 1; finish('three');
    expect(store.gc().deletedRows).toBe(1);
    expect(store.status().deliveriesByState.consumed).toBe(2);
    now += 101;
    expect(store.gc().deletedRows).toBe(2);
    expect(store.status().logicalRows).toBe(0);
  });

  it('opens and persists the storage breaker at the first global bound', () => {
    const store = InboundDeliveryStore.openMemory({ maxLogicalRows: 1 });
    store.prepare({ conversationId: 'c', deliveryId: 'one', incarnation: 'i', framework: 'codex-cli', envelope: 'x', hmacKey: 'k' });
    expect(() => store.prepare({ conversationId: 'c', deliveryId: 'two', incarnation: 'i', framework: 'codex-cli', envelope: 'x', hmacKey: 'k' }))
      .toThrow(InboundDeliveryBackpressureError);
    expect(store.status().breaker).toEqual({ open: true, epoch: 1, reason: 'logical-row-limit' });
    expect(() => store.prepare({ conversationId: 'other', deliveryId: 'three', incarnation: 'i', framework: 'codex-cli', envelope: 'x', hmacKey: 'k' }))
      .toThrowError(expect.objectContaining({ reason: 'storage-breaker' }));
    expect(store.status().breaker.epoch).toBe(1);
  });

  it('applies the global breaker to auxiliary attempt admission', () => {
    const store = InboundDeliveryStore.openMemory({ maxLogicalRows: 2 });
    const row = store.prepare({ conversationId: 'c', incarnation: 'i', framework: 'codex-cli', envelope: 'x', hmacKey: 'k' });
    store.transition('c', row.deliveryId, 'prepared', 'dispatch-armed');
    store.transition('c', row.deliveryId, 'dispatch-armed', 'dispatch-started');
    store.transition('c', row.deliveryId, 'dispatch-started', 'dispatched');
    expect(store.armAttempt('c', row.deliveryId, 0)).toBe(true);
    expect(store.armAttempt('c', row.deliveryId, 1)).toBe(false);
    expect(store.status()).toMatchObject({
      logicalRows: 2,
      breaker: { open: true, epoch: 1, reason: 'logical-row-limit' },
    });
  });

  it('fails storage admission closed when the physical size probe is unavailable', () => {
    const store = InboundDeliveryStore.openMemory({ sizeProbe: () => { throw new Error('disk unavailable'); } });
    expect(() => store.prepare({ conversationId: 'c', incarnation: 'i', framework: 'codex-cli', envelope: 'x', hmacKey: 'k' }))
      .toThrowError(expect.objectContaining({ reason: 'storage-breaker' }));
    expect(store.status().breaker).toMatchObject({ open: true, reason: 'database-byte-limit' });
  });
});
