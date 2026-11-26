import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';
import { approvalEventId } from '../../src/core/WorkBoardApprovalWriter.js';
import { WorkBoardSlipStore, type WorkBoardSlipProposal } from '../../src/core/WorkBoardSlipStore.js';
import { applyWorkBoardSlip } from '../../src/core/workBoardSlipApplication.js';
import { canonicalJson, sha256Hex } from '../../src/core/WorkCardStore.js';

const dbs: Database.Database[] = [];
afterEach(() => { for (const db of dbs.splice(0)) db.close(); });

function fixture() {
  const db = new Database(':memory:');
  dbs.push(db);
  let now = 100;
  const store = new WorkBoardSlipStore(db, () => now);
  const disclosure = { title: 'Review the Work Board' };
  const proposal: WorkBoardSlipProposal = {
    sourceId: 'verified-message-1', sourceDigest: 'c'.repeat(64),
    writer: { epoch: 'epoch1', ownerGeneration: 'owner1', ownerPersonKey: 'justin', writerIncarnation: 'i1' },
    items: [{
      version: {
        cardId: 'wc_6248a51921c41ca0', cardRevision: 'card1', policyRevision: 'policy1',
        titleHash: 'a'.repeat(64), materialHash: 'b'.repeat(64), visibleTextHash: sha256Hex(canonicalJson(disclosure)),
      },
      disclosure,
    }],
  };
  return { db, store, proposal, nextTime: (value: number) => { now = value; } };
}

describe('Work Board slip store', () => {
  it('issues one immutable exact proposal per authenticated source', () => {
    const { store, proposal } = fixture();
    const slip = store.issue(proposal)!;
    expect(slip).toMatchObject({ expiresAt: 86_400_100, decisionId: null });
    expect(store.issue(proposal)).toEqual(slip);
    const [item] = proposal.items;
    expect(store.issue({ ...proposal, items: [{ ...item, version: { ...item.version, cardRevision: 'card2' } }] })).toBeNull();
    expect(store.issue({ ...proposal, items: [{ ...item, disclosure: { title: 'Replaced' } }] })).toBeNull();
    expect(store.issue({ ...proposal, items: [item, item] })).toBeNull();
  });

  it('consumes only the exact digest and writer once and returns the same decision on replay', () => {
    const { store, proposal, nextTime } = fixture();
    const slip = store.issue(proposal)!;
    expect(store.consumeVerified(slip.id, 'wrong', proposal.writer, 'decision1')).toBeNull();
    expect(store.consumeVerified(slip.id, slip.digest, { ...proposal.writer, epoch: 'epoch2' }, 'decision1')).toBeNull();
    const decided = store.consumeVerified(slip.id, slip.digest, proposal.writer, 'decision1');
    expect(decided?.decisionId).toBe('decision1');
    nextTime(slip.expiresAt);
    expect(store.consumeVerified(slip.id, slip.digest, proposal.writer, 'decision1')).toEqual(decided);
    expect(store.consumeVerified(slip.id, slip.digest, proposal.writer, 'decision2')).toBeNull();
  });

  it('fails closed on a changed stored proposal even when its digest column is intact', () => {
    const { db, store, proposal } = fixture();
    const slip = store.issue(proposal)!;
    db.prepare('UPDATE work_board_permission_slips SET proposal = ? WHERE id = ?')
      .run(canonicalJson({ ...proposal, sourceId: 'another-source' }), slip.id);
    expect(store.get(slip.id)).toBeNull();
    expect(store.consumeVerified(slip.id, slip.digest, proposal.writer, 'decision1')).toBeNull();
    db.prepare('UPDATE work_board_permission_slips SET proposal = ?, source_id = ? WHERE id = ?')
      .run(canonicalJson(proposal), 'wrong-source', slip.id);
    expect(store.get(slip.id)).toBeNull();
  });

  it.each(['malformed', 86_400_101])('rejects a changed stored deadline', (deadline) => {
    const { db, store, proposal } = fixture();
    const slip = store.issue(proposal)!;
    db.prepare('UPDATE work_board_permission_slips SET expires_at = ? WHERE id = ?').run(deadline, slip.id);
    expect(store.consumeVerified(slip.id, slip.digest, proposal.writer, 'decision1')).toBeNull();
  });

  it('recovers the same committed decision after reopening a persistent database', () => {
    const { proposal } = fixture();
    const dir = mkdtempSync(join(tmpdir(), 'work-board-slip-store-'));
    const path = join(dir, 'slips.sqlite');
    try {
      const first = new Database(path);
      try {
        const store = new WorkBoardSlipStore(first);
        const slip = store.issue(proposal)!;
        expect(store.consumeVerified(slip.id, slip.digest, proposal.writer, 'decision1')?.decisionId).toBe('decision1');
        const key = { slipId: slip.id, digest: slip.digest, writer: proposal.writer, decisionId: 'decision1' };
        const cardId = proposal.items[0].version.cardId;
        expect(store.claimItem(key, cardId)).toBeTruthy();
        const second = new Database(path);
        try {
          first.close();
          const reopened = new WorkBoardSlipStore(second);
          expect(reopened.consumeVerified(slip.id, slip.digest, proposal.writer, 'decision1')?.decisionId).toBe('decision1');
          expect(reopened.consumeVerified(slip.id, slip.digest, proposal.writer, 'decision2')).toBeNull();
          expect(reopened.claimItem(key, cardId)).toBeNull();
          expect(reopened.readItemResults(key)).toEqual([{ cardId, status: 'unresolved' }]);
        } finally { second.close(); }
      } finally { if (first.open) first.close(); }
    } finally { SafeFsExecutor.safeRmSync(dir, { recursive: true, force: true, operation: 'tests/unit/work-board-slip-store.test.ts' }); }
  });

  it('claims once, rejects another generation as the winner and reports in signed order', () => {
    const { store, proposal, nextTime } = fixture();
    const item = proposal.items[0];
    const secondItem = { ...item, version: { ...item.version, cardId: 'wc_8ef2f314f32acff4' } };
    const slip = store.issue({ ...proposal, items: [secondItem, item] })!;
    const key = { slipId: slip.id, digest: slip.digest, writer: proposal.writer, decisionId: 'decision1' };
    const cardId = item.version.cardId;
    expect(store.claimItem(key, cardId)).toBeNull();
    expect(store.consumeVerified(slip.id, slip.digest, key.writer, key.decisionId)).not.toBeNull();
    const { id: claim } = store.claimItem(key, cardId)!;
    expect(claim).toBeTruthy();
    expect(store.claimItem(key, cardId)).toBeNull();
    expect(store.claimItem({ ...key, writer: { ...key.writer, epoch: 'wrong' } }, secondItem.version.cardId)).toBeNull();
    expect(store.readItemResults(key)).toEqual([
      { cardId: secondItem.version.cardId, status: 'pending' },
      { cardId, status: 'unresolved' },
    ]);
    expect(store.finishItem(key, cardId, claim, { status: 'applied', eventId: 'wrong-event' })).toBe(false);
    const eventId = approvalEventId({ proof: key.writer, version: item.version, source: 'slip', decisionId: key.decisionId });
    expect(store.finishItem(key, cardId, 'wrong-claim', { status: 'applied', eventId })).toBe(false);
    expect(store.finishItem(key, cardId, claim, { status: 'applied', eventId })).toBe(true);
    expect(store.finishItem(key, cardId, claim, { status: 'changed' })).toBe(false);
    expect(store.readItemResults(key)?.[1]).toEqual({ cardId, status: 'applied', eventId });
    nextTime(slip.expiresAt);
    expect(store.claimItem(key, secondItem.version.cardId)).toBeNull();
  });

  it('applies only the exact signed items once and leaves an unprojected approval unresolved', async () => {
    const { store, proposal } = fixture();
    const first = proposal.items[0];
    const second = { ...first, version: { ...first.version, cardId: 'wc_8ef2f314f32acff4' } };
    const slip = store.issue({ ...proposal, items: [first, second] })!;
    const key = { slipId: slip.id, digest: slip.digest, writer: proposal.writer, decisionId: 'decision1' };
    store.consumeVerified(slip.id, slip.digest, key.writer, key.decisionId);
    const attempts: string[] = [];
    const ports: Parameters<typeof applyWorkBoardSlip>[1] = {
      store, currentWriter: () => key.writer,
      approve: async (request) => {
        attempts.push(request.version.cardId);
        return { status: 'applied', winner: { request, eventId: approvalEventId(request) } };
      },
      confirmProjection: async (winner) => winner.request.version.cardId === first.version.cardId,
    };
    const submitted = { ...key };
    const originalApprove = ports.approve;
    ports.approve = (request) => { submitted.decisionId = 'changed-during-apply'; return originalApprove(request); };
    const expected = [
      { cardId: first.version.cardId, status: 'applied', eventId: approvalEventId({ proof: key.writer, version: first.version, source: 'slip', decisionId: key.decisionId }) },
      { cardId: second.version.cardId, status: 'unresolved' },
    ];
    await expect(applyWorkBoardSlip(submitted, ports)).resolves.toEqual(expected);
    await expect(applyWorkBoardSlip(key, ports)).resolves.toEqual(expected);
    expect(attempts).toEqual([first.version.cardId, second.version.cardId]);
  });

  it('rejects a valid event ID for the wrong version before observing projection', async () => {
    const { store, proposal } = fixture();
    const slip = store.issue(proposal)!;
    const key = { slipId: slip.id, digest: slip.digest, writer: proposal.writer, decisionId: 'decision1' };
    store.consumeVerified(slip.id, slip.digest, key.writer, key.decisionId);
    await expect(applyWorkBoardSlip(key, {
      store, currentWriter: () => key.writer,
      approve: async (request) => {
        const altered = { ...request, version: { ...request.version, cardRevision: 'wrong' } };
        return { status: 'applied', winner: { request: altered, eventId: approvalEventId(altered) } };
      },
      confirmProjection: async () => { throw new Error('mismatched winner'); },
    })).resolves.toEqual([{ cardId: proposal.items[0].version.cardId, status: 'unresolved' }]);
  });

  it('stops after writer loss before asking the projection port to act', async () => {
    const { store, proposal } = fixture();
    const slip = store.issue(proposal)!;
    const key = { slipId: slip.id, digest: slip.digest, writer: proposal.writer, decisionId: 'decision1' };
    store.consumeVerified(slip.id, slip.digest, key.writer, key.decisionId);
    let active = true;
    await expect(applyWorkBoardSlip(key, {
      store, currentWriter: () => active ? key.writer : null,
      approve: async (request) => {
        active = false;
        return { status: 'applied', winner: { request, eventId: approvalEventId(request) } };
      },
      confirmProjection: async () => { throw new Error('stale projection'); },
    })).resolves.toBeNull();
    expect(store.readItemResults(key)).toEqual([{ cardId: proposal.items[0].version.cardId, status: 'unresolved' }]);
  });

  it('rejects an expired unsigned proposal and reuse of a decision ID on a second slip', () => {
    const { store, proposal, nextTime } = fixture();
    const first = store.issue(proposal)!;
    const second = store.issue({ ...proposal, sourceId: 'verified-message-2' })!;
    expect(store.consumeVerified(first.id, first.digest, proposal.writer, 'decision1')).not.toBeNull();
    expect(store.consumeVerified(second.id, second.digest, proposal.writer, 'decision1')).toBeNull();
    nextTime(second.expiresAt);
    expect(store.consumeVerified(second.id, second.digest, proposal.writer, 'decision2')).toBeNull();
  });
});
