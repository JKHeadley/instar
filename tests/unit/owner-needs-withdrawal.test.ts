import { describe, expect, it, vi } from 'vitest';
import { admitOwnerNeedsCard } from '../../src/core/OwnerNeedsCardAdmission.js';
import { completeOwnerNeedsAsk, ownerNeedsAskKey, type OwnerNeedsCompletionJournal, type OwnerNeedsCompletionTransaction, type OwnerNeedsWithdrawalTransaction, decodeOwnerNeedsWithdrawal, deriveOwnerNeedsAskIdentity, isOwnerNeedsAskWithdrawn, withdrawOwnerNeedsAsk, type OwnerNeedsWithdrawal, type OwnerNeedsWithdrawalJournal } from '../../src/core/OwnerNeedsWithdrawal.js';

const ask = { project: 'telegram:131439', bindingVersion: 'v1', episode: 'wait-1', requestVersion: 'r1' };

function fixture() {
  let saved: OwnerNeedsWithdrawal | null = null;
  const activeAsk = vi.fn((): { identity: typeof ask; state: 'pending' | 'consumed' } => ({ identity: ask, state: 'pending' }));
  const authority = vi.fn((): { principal: string; leaseEpoch: number } | null => ({ principal: 'coordinator', leaseEpoch: 3 }));
  const appendIfCurrent = vi.fn(async (record: OwnerNeedsWithdrawal) => { saved = record; return true; });
  const journal: OwnerNeedsWithdrawalJournal = {
    withAskLock: (_project, run) => run({ activeAsk, authority, appendIfCurrent, findWithdrawal: key => saved?.key === key ? saved : null }),
  };
  return { journal, activeAsk, authority, appendIfCurrent };
}

describe('owner ask withdrawal', () => {
  it('records one exact withdrawal, recovers the same result on retry and leaves later asks actionable', async () => {
    const { journal, appendIfCurrent } = fixture();
    const first = await withdrawOwnerNeedsAsk(journal, ask);
    expect(first.status).toBe('withdrawn');
    if (first.status !== 'withdrawn') throw new Error('Expected withdrawal');
    await expect(withdrawOwnerNeedsAsk(journal, ask)).resolves.toEqual(first);
    expect(appendIfCurrent).toHaveBeenCalledTimes(1);
    expect(isOwnerNeedsAskWithdrawn(ask, first.record)).toBe(true);
    expect(isOwnerNeedsAskWithdrawn({ ...ask, episode: 'wait-2' }, first.record)).toBe(false);
    expect(isOwnerNeedsAskWithdrawn({ ...ask, bindingVersion: 'v2' }, first.record)).toBe(false);
    const candidate = {
      responsibility: 'owner-required' as const, ownerAction: 'approve' as const, verifiesCurrentOwnerRequest: () => true, actions: [{ kind: 'approval', requestId: 'current' }], handoffs: [],
      withdrawal: { ask, record: first.record },
    };
    expect(admitOwnerNeedsCard(candidate)).toEqual({ disposition: 'withdrawn' });
    expect(admitOwnerNeedsCard({ ...candidate, withdrawal: { ...candidate.withdrawal, ask: { ...ask, episode: 'wait-2' } } }))
      .toMatchObject({ disposition: 'show' });
  });

  it('changes identity when the source episode, request revision or disclosed action changes', () => {
    const input = {
      project: ask.project, bindingVersion: ask.bindingVersion,
      episodeRecord: 'check:opening', requestRecord: 'check:wording',
      disclosure: { title: 'Approve the repair', action: 'repair' },
    };
    const original = deriveOwnerNeedsAskIdentity(input);
    expect(deriveOwnerNeedsAskIdentity({ ...input })).toEqual(original);
    expect(deriveOwnerNeedsAskIdentity({ ...input, episodeRecord: 'check:reopened' }).episode).not.toBe(original.episode);
    expect(deriveOwnerNeedsAskIdentity({ ...input, requestRecord: 'check:revised' }).requestVersion).not.toBe(original.requestVersion);
    expect(deriveOwnerNeedsAskIdentity({ ...input, disclosure: { ...input.disclosure, action: 'replace' } }).requestVersion)
      .not.toBe(original.requestVersion);
  });

  it('decodes a persisted record and rejects malformed or mismatched records', async () => {
    const { journal } = fixture();
    const result = await withdrawOwnerNeedsAsk(journal, ask);
    if (result.status !== 'withdrawn') throw new Error('Expected withdrawal');
    const persisted = JSON.parse(JSON.stringify(result.record));
    expect(decodeOwnerNeedsWithdrawal(persisted)).toEqual(result.record);
    expect(decodeOwnerNeedsWithdrawal({ ...persisted, ask: { ...ask, episode: 'replacement' } })).toBeNull();
    expect(decodeOwnerNeedsWithdrawal({ ...persisted, leaseEpoch: 0 })).toBeNull();
    expect(isOwnerNeedsAskWithdrawn(ask, { ...persisted, ask: null })).toBe(false);
  });

  it('rejects lost coordinator authority, changed request version and consumed asks', async () => {
    const { journal, activeAsk, authority, appendIfCurrent } = fixture();
    authority.mockReturnValueOnce(null);
    await expect(withdrawOwnerNeedsAsk(journal, ask)).resolves.toEqual({ status: 'forbidden' });
    await expect(withdrawOwnerNeedsAsk(journal, { ...ask, requestVersion: 'old' })).resolves.toEqual({ status: 'stale' });
    activeAsk.mockReturnValueOnce({ identity: ask, state: 'consumed' });
    await expect(withdrawOwnerNeedsAsk(journal, ask)).resolves.toEqual({ status: 'stale' });
    expect(appendIfCurrent).not.toHaveBeenCalled();
  });

  it('never reports withdrawal when the source rejects the atomic compare and append', async () => {
    const { journal, appendIfCurrent } = fixture();
    appendIfCurrent.mockResolvedValueOnce(false);
    await expect(withdrawOwnerNeedsAsk(journal, ask)).resolves.toEqual({ status: 'stale' });
  });
});

describe('exact request decision arbitration', () => {
  function decisionJournal() {
    let withdrawal: OwnerNeedsWithdrawal | null = null;
    let completion: { key: string } | null = null;
    let queue = Promise.resolve();
    const authorized = vi.fn(() => true);
    const appendCompletionIfCurrent = vi.fn(async () => (completion = { key: ownerNeedsAskKey(ask) }));
    const appendIfCurrent = vi.fn(async (record: OwnerNeedsWithdrawal) => { withdrawal = record; return true; });
    type Transaction = OwnerNeedsWithdrawalTransaction & OwnerNeedsCompletionTransaction<{ key: string }>;
    const journal: OwnerNeedsWithdrawalJournal & OwnerNeedsCompletionJournal<{ key: string }> = {
      withAskLock<T>(_project: string, run: (transaction: Transaction) => Promise<T>): Promise<T> {
        const result = queue.then(() => run({
          authority: () => ({ principal: 'coordinator', leaseEpoch: 3 }),
          activeAsk: () => ({ identity: ask, state: completion ? 'consumed' : 'pending' }),
          findWithdrawal: key => withdrawal?.key === key ? withdrawal : null,
          appendIfCurrent,
          authorized,
          findCompletion: key => completion?.key === key ? completion : null,
          appendCompletionIfCurrent,
        }));
        queue = result.then(() => undefined, () => undefined);
        return result;
      },
    };
    return { journal, authorized, appendCompletionIfCurrent, appendIfCurrent };
  }

  it('keeps a withdrawal that wins the write lock, even when approval evidence was gathered earlier', async () => {
    const { journal, appendCompletionIfCurrent, appendIfCurrent } = decisionJournal();
    const [withdrawal, approval] = await Promise.all([
      withdrawOwnerNeedsAsk(journal, ask),
      completeOwnerNeedsAsk(journal, ask),
    ]);
    expect(withdrawal.status).toBe('withdrawn');
    expect(approval.status).toBe('stale');
    expect(appendIfCurrent).toHaveBeenCalledTimes(1);
    expect(appendCompletionIfCurrent).not.toHaveBeenCalled();
  });

  it('keeps completion that wins first and recovers its receipt only for an authorized retry', async () => {
    const { journal, authorized, appendCompletionIfCurrent, appendIfCurrent } = decisionJournal();
    const [approval, withdrawal] = await Promise.all([
      completeOwnerNeedsAsk(journal, ask),
      withdrawOwnerNeedsAsk(journal, ask),
    ]);
    expect(approval.status).toBe('completed');
    expect(withdrawal.status).toBe('stale');
    await expect(completeOwnerNeedsAsk(journal, ask)).resolves.toEqual(approval);
    authorized.mockReturnValueOnce(false);
    await expect(completeOwnerNeedsAsk(journal, ask)).resolves.toEqual({ status: 'forbidden' });
    expect(appendCompletionIfCurrent).toHaveBeenCalledTimes(1);
    expect(appendIfCurrent).not.toHaveBeenCalled();
  });
});
