import { describe, expect, it } from 'vitest';
import { WorkBoardApprovalWriter, type WorkBoardApprovalEvent, type WorkBoardApprovalRequest, type WorkBoardApprovalVersion, type WorkBoardWriterProof } from '../../src/core/WorkBoardApprovalWriter.js';

const proof: WorkBoardWriterProof = { epoch: 'board:2', ownerGeneration: 'owner:3', writerIncarnation: 'machine:1' };
const version: WorkBoardApprovalVersion = {
  cardId: 'wc_6248a51921c41ca0', cardRevision: 'edit:2', policyRevision: 'policy:1', visibleTextHash: 'visible:2', materialHash: 'material:2', titleHash: 'title:2',
};
const slip: WorkBoardApprovalRequest = { proof, version, source: 'slip', decisionId: 'slip-approve-1' };
const consoleTap: WorkBoardApprovalRequest = { proof, version, source: 'console', decisionId: 'console-approve-1' };

function fixture() {
  let current: WorkBoardWriterProof | null = proof;
  let eligible: WorkBoardApprovalVersion | null = version;
  let event: WorkBoardApprovalEvent | undefined;
  let durable = false;
  let finish: () => void = () => {};
  const stored = new Promise<void>((resolve) => { finish = resolve; });
  let appends = 0;
  const writer = new WorkBoardApprovalWriter({
    currentWriter: () => current,
    currentEligibleVersion: () => eligible,
    readEvent: (id) => event?.eventId === id
      ? durable ? { status: 'durable', event } : { status: 'unknown' }
      : { status: 'missing' },
    append: (entry) => { appends++; event = entry; eligible = null; return appends; },
    awaitDurable: () => stored,
  });
  return {
    writer, appends: () => appends,
    commit: () => { durable = true; finish(); },
    ambiguous: () => finish(),
    edit: (next: WorkBoardApprovalVersion) => { eligible = next; },
    loseWriter: () => { current = null; },
  };
}

describe('Work Board approval generation writer', () => {
  it.each([[slip, consoleTap], [consoleTap, slip]])('preserves the first winner across approval paths', async (first, other) => {
    const f = fixture();
    const firstResult = f.writer.approve(first);
    const otherResult = f.writer.approve(other);
    expect(f.appends()).toBe(1);
    f.commit();
    const applied = await firstResult;
    expect(applied).toMatchObject({ status: 'applied', winner: { request: first } });
    expect(await otherResult).toEqual({ ...applied, status: 'already-approved' });
    expect(await f.writer.approve(first)).toEqual(applied);
    expect(f.appends()).toBe(1);
  });

  it('rejects a new revision even when the screen text is unchanged', async () => {
    const f = fixture();
    f.edit({ ...version, cardRevision: 'edit:3' });
    expect(await f.writer.approve(slip)).toEqual({ status: 'changed' });
    expect(f.appends()).toBe(0);
  });

  it('requires current writer proof even if durability completes', async () => {
    const f = fixture();
    const result = f.writer.approve(slip);
    f.loseWriter();
    f.commit();
    expect(await result).toEqual({ status: 'unavailable' });
    expect(await f.writer.approve(consoleTap)).toEqual({ status: 'unavailable' });
  });

  it('binds the event to the request snapshot before waiting for durability', async () => {
    const f = fixture();
    const input = { ...slip, proof: { ...slip.proof }, version: { ...slip.version } };
    const result = f.writer.approve(input);
    input.version.cardRevision = 'edit:3';
    input.decisionId = 'other-request';
    f.commit();
    expect(await result).toMatchObject({ status: 'applied', winner: { request: slip } });
  });

  it('blocks redrive while the exact append is unresolved', async () => {
    const f = fixture();
    const result = f.writer.approve(slip);
    f.ambiguous();
    expect(await result).toEqual({ status: 'unresolved' });
    expect(await f.writer.approve(consoleTap)).toEqual({ status: 'unresolved' });
    expect(f.appends()).toBe(1);
  });
});
