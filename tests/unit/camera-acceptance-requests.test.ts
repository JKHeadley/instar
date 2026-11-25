import { describe, expect, it, vi } from 'vitest';
import {
  issueCameraVerifierRequest,
  recordCameraVerifierReceipt,
  type CameraReceiptJournal,
  type CameraRequestJournal,
  type CameraRequestTransaction,
} from '../../src/core/CameraAcceptanceRequests.js';

const requirement = { candidate: 'tested-candidate', revision: 2, verifier: 'verifier', builders: ['builder'] };
const pass = { candidate: requirement.candidate, revision: 2, verifier: 'verifier', sequence: 1, decision: 'pass' } as const;

function journalWith(transaction: CameraRequestTransaction | null): CameraRequestJournal {
  return { withWriteLock: operation => operation(transaction) };
}

describe('Camera verifier request issuance', () => {
  it('requires a durable Pending before issuing a request against an active Pass', async () => {
    const appendRequest = vi.fn(async () => {});
    const blocked = await issueCameraVerifierRequest(journalWith({ requirement, receipts: [pass], appendRequest }), 'verifier');
    expect(blocked).toEqual({ status: 'pending-required' });
    expect(appendRequest).not.toHaveBeenCalled();

    const receipts = [pass, { ...pass, sequence: 2, decision: 'pending' as const }];
    const issued = await issueCameraVerifierRequest(journalWith({ requirement, receipts, appendRequest }), 'verifier');
    expect(issued).toEqual({ status: 'issued', request: expect.objectContaining({
      candidate: requirement.candidate, revision: 2, verifier: 'verifier',
    }) });
    if (issued.status !== 'issued') throw new Error('Expected a request');
    expect(appendRequest).toHaveBeenCalledTimes(1);
    expect(appendRequest).toHaveBeenCalledWith(issued.request);
  });

  it('holds when authoritative history is unavailable', async () => {
    await expect(issueCameraVerifierRequest(journalWith(null), 'verifier')).resolves.toEqual({ status: 'unavailable' });
  });

  it('holds inconsistent receipt history instead of treating it as a durable Pending', async () => {
    const appendRequest = vi.fn(async () => {});
    await expect(issueCameraVerifierRequest(journalWith({
      requirement, receipts: [pass, { ...pass, sequence: 3, decision: 'pending' }], appendRequest,
    }), 'verifier')).resolves.toEqual({ status: 'unavailable' });
    expect(appendRequest).not.toHaveBeenCalled();
  });

  it('denies an unrelated principal and a builder assigned as verifier', async () => {
    const appendRequest = vi.fn(async () => {});
    await expect(issueCameraVerifierRequest(journalWith({ requirement, receipts: [], appendRequest }), 'other'))
      .resolves.toEqual({ status: 'forbidden' });
    await expect(issueCameraVerifierRequest(journalWith({
      requirement: { ...requirement, verifier: 'builder' }, receipts: [], appendRequest,
    }), 'builder')).resolves.toEqual({ status: 'forbidden' });
    expect(appendRequest).not.toHaveBeenCalled();
  });

  it('does not return an issued request if its durable append fails', async () => {
    const appendRequest = vi.fn(async () => { throw new Error('append failed'); });
    await expect(issueCameraVerifierRequest(journalWith({ requirement, receipts: [], appendRequest }), 'verifier'))
      .rejects.toThrow('append failed');
  });
});

describe('Camera verifier receipt submission', () => {
  const computer = 'target';
  const phone = 'phone';
  const grant = { id: 'g1', phone, computer, access: 'manage', expiresAt: null, revokedAt: null };
  const other = { ...grant, id: 'g2', computer: 'other' };
  const unlinked = { before: [other], after: [other], visibleComputer: null };
  const linked = { before: [other, grant], after: [grant, other], visibleComputer: computer };
  const evidence = {
    candidate: requirement.candidate, computer, phone, expectedGrant: grant,
    observedAt: '2026-11-24T22:00:00Z', redirected: false, cancellation: unlinked, expiry: unlinked,
    replay: linked, success: { ...linked, before: [other] },
  };
  const request = { id: 'request', candidate: requirement.candidate, revision: 2, verifier: 'verifier', receiptSequence: 0 };

  it('records the result and consumes the current server-issued request in one append', async () => {
    const appendReceipt = vi.fn(async () => {});
    const journal: CameraReceiptJournal = {
      withWriteLock: operation => operation({
        requirement, receipts: [], findRequest: () => request, appendReceipt,
      }),
    };
    const result = await recordCameraVerifierReceipt(journal, 'verifier', 'request', evidence);
    expect(result).toEqual({ status: 'recorded', receipt: pass });
    expect(appendReceipt).toHaveBeenCalledWith(request, pass);
  });

  it('rejects outstanding requests from before a Pass and Pending cycle', async () => {
    const appendReceipt = vi.fn(async () => {});
    const journal: CameraReceiptJournal = {
      withWriteLock: operation => operation({
        requirement, receipts: [pass, { ...pass, sequence: 2, decision: 'pending' }],
        findRequest: () => request, appendReceipt,
      }),
    };
    await expect(recordCameraVerifierReceipt(journal, 'verifier', 'request', evidence))
      .resolves.toEqual({ status: 'stale-request' });
    expect(appendReceipt).not.toHaveBeenCalled();
  });

  it('rejects a missing server-issued request and evidence for another candidate', async () => {
    const appendReceipt = vi.fn(async () => {});
    const journal: CameraReceiptJournal = {
      withWriteLock: operation => operation({
        requirement, receipts: [], findRequest: id => id === request.id ? request : null, appendReceipt,
      }),
    };
    await expect(recordCameraVerifierReceipt(journal, 'verifier', 'unknown', evidence))
      .resolves.toEqual({ status: 'stale-request' });
    await expect(recordCameraVerifierReceipt(journal, 'verifier', 'request', { ...evidence, candidate: 'other' }))
      .resolves.toEqual({ status: 'stale-request' });
    expect(appendReceipt).not.toHaveBeenCalled();
  });
});
