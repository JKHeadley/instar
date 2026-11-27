import { z } from 'zod';
import { canonicalHash } from './GraphWitnessTypes.js';

const ref = z.string().regex(/^[A-Za-z0-9_.:-]{1,200}$/);
const askIdentity = z.strictObject({ project: ref, bindingVersion: ref, episode: ref, requestVersion: ref });
export type OwnerNeedsAskIdentity = z.infer<typeof askIdentity>;

export function decodeOwnerNeedsAskIdentity(input: unknown): OwnerNeedsAskIdentity | null {
  const parsed = askIdentity.safeParse(input);
  return parsed.success ? parsed.data : null;
}

const withdrawalRecord = z.strictObject({
  kind: z.literal('owner-ask-withdrawal'),
  key: z.string().regex(/^[a-f0-9]{64}$/),
  ask: askIdentity,
  coordinator: z.string().min(1).max(200),
  leaseEpoch: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
});

export type OwnerNeedsWithdrawal = Readonly<z.infer<typeof withdrawalRecord>>;

/** Decode a record from the authenticated source journal and verify its exact key. */
export function decodeOwnerNeedsWithdrawal(input: unknown): OwnerNeedsWithdrawal | null {
  const parsed = withdrawalRecord.safeParse(input);
  if (!parsed.success || parsed.data.key !== ownerNeedsAskKey(parsed.data.ask)) return null;
  return parsed.data;
}

export interface OwnerNeedsWithdrawalTransaction {
  /** Resolve from trusted session authority while holding the source write lock. */
  authority(): { principal: string; leaseEpoch: number } | null;
  activeAsk(): { identity: OwnerNeedsAskIdentity; state: 'pending' | 'consumed' } | null;
  /** Return only a verified durable withdrawal. */
  findWithdrawal(key: string): OwnerNeedsWithdrawal | null;
  /** Atomically compare authority and pending ask and append only the withdrawal. */
  appendIfCurrent(record: OwnerNeedsWithdrawal): Promise<boolean>;
}

export interface OwnerNeedsWithdrawalJournal {
  /** Lock shared with ask revisions, owner decisions and coordinator mutations. */
  withAskLock<T>(project: string, run: (transaction: OwnerNeedsWithdrawalTransaction | null) => Promise<T>): Promise<T>;
}

export function ownerNeedsAskKey(ask: OwnerNeedsAskIdentity): string {
  return canonicalHash(['owner-needs-ask-withdrawal-v1', ask.project, ask.bindingVersion, ask.episode, ask.requestVersion]);
}

/** Derive identity from the records that opened and defined the current request. */
export function deriveOwnerNeedsAskIdentity(input: {
  project: string;
  bindingVersion: string;
  episodeRecord: string;
  requestRecord: string;
  disclosure: unknown;
}): OwnerNeedsAskIdentity {
  return askIdentity.parse({
    project: input.project,
    bindingVersion: input.bindingVersion,
    episode: canonicalHash(['owner-needs-episode-v1', input.episodeRecord]),
    requestVersion: canonicalHash(['owner-needs-request-v1', input.requestRecord, input.disclosure]),
  });
}

/** Check exact ask identity at presentation and again at decision execution. */
export function isOwnerNeedsAskWithdrawn(ask: OwnerNeedsAskIdentity, record: OwnerNeedsWithdrawal | null): boolean {
  return decodeOwnerNeedsWithdrawal(record)?.key === ownerNeedsAskKey(ask);
}

type AskState = Pick<OwnerNeedsWithdrawalTransaction, 'activeAsk' | 'findWithdrawal'>;

function isPendingAsk(transaction: AskState, ask: OwnerNeedsAskIdentity, withdrawal: OwnerNeedsWithdrawal | null): boolean {
  const key = ownerNeedsAskKey(ask);
  if (isOwnerNeedsAskWithdrawn(ask, withdrawal)) return false;
  const active = transaction.activeAsk();
  return active?.state === 'pending' && ownerNeedsAskKey(active.identity) === key;
}

export interface OwnerNeedsCompletionTransaction<Receipt> extends AskState {
  /** Verify the signed owner decision, disclosure and current authority under the write lock. */
  authorized(): boolean;
  /** Look up the exact already committed decision for this authorized attempt. */
  findCompletion(key: string): Receipt | null;
  /** Recheck the lease and exact pending ask and durably commit verification and close in one record. */
  appendCompletionIfCurrent(ask: OwnerNeedsAskIdentity): Promise<Receipt | null>;
}

export interface OwnerNeedsCompletionJournal<Receipt> {
  /** Uses the same backing writer and lock as withdrawal, including across lease handover. */
  withAskLock<T>(project: string, run: (transaction: OwnerNeedsCompletionTransaction<Receipt> | null) => Promise<T>): Promise<T>;
}

/** Run after evidence gathering, so a withdrawal during gathering is seen before any completion write. */
export async function completeOwnerNeedsAsk<Receipt>(journal: OwnerNeedsCompletionJournal<Receipt>, input: unknown) {
  const ask = decodeOwnerNeedsAskIdentity(input);
  if (!ask) return { status: 'invalid' } as const;

  return journal.withAskLock(ask.project, async transaction => {
    if (!transaction) return { status: 'unavailable' } as const;
    if (!transaction.authorized()) return { status: 'forbidden' } as const;
    const prior = transaction.findCompletion(ownerNeedsAskKey(ask));
    if (prior !== null) return { status: 'completed', receipt: prior } as const;
    if (!isPendingAsk(transaction, ask, transaction.findWithdrawal(ownerNeedsAskKey(ask)))) return { status: 'stale' } as const;

    const receipt = await transaction.appendCompletionIfCurrent(ask);
    return receipt !== null ? { status: 'completed', receipt } as const : { status: 'stale' } as const;
  });
}

export async function withdrawOwnerNeedsAsk(journal: OwnerNeedsWithdrawalJournal, input: unknown) {
  const parsed = askIdentity.safeParse(input);
  if (!parsed.success) return { status: 'invalid' } as const;

  const ask = parsed.data;
  return journal.withAskLock(ask.project, async transaction => {
    if (!transaction) return { status: 'unavailable' } as const;
    const authority = transaction.authority();
    if (!authority?.principal || authority.principal.length > 200 || !Number.isSafeInteger(authority.leaseEpoch) || authority.leaseEpoch < 1) {
      return { status: 'forbidden' } as const;
    }

    const key = ownerNeedsAskKey(ask);
    const prior = transaction.findWithdrawal(key);
    if (isOwnerNeedsAskWithdrawn(ask, prior)) return { status: 'withdrawn', record: prior! } as const;
    if (!isPendingAsk(transaction, ask, prior)) return { status: 'stale' } as const;

    const record: OwnerNeedsWithdrawal = {
      kind: 'owner-ask-withdrawal', key, ask, coordinator: authority.principal, leaseEpoch: authority.leaseEpoch,
    };
    return await transaction.appendIfCurrent(record)
      ? { status: 'withdrawn', record } as const
      : { status: 'stale' } as const;
  });
}
