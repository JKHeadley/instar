import fs from 'node:fs';
import path from 'node:path';

export type FollowMeFailureLane = 'identity' | 'other';

export interface FollowMeBackoffRecord {
  key: string;
  attempts: number;
  lane: FollowMeFailureLane;
  failureCode: string | null;
  identityEvidenceKey: string;
  identityResolved: boolean;
  authoritySetKey: string;
  nextAttemptAt: string | null;
  parkedAt: string | null;
  updatedAt: string;
}

interface BackoffFile {
  version: 1;
  records: FollowMeBackoffRecord[];
}

const DELAYS_MS = [60_000, 5 * 60_000, 15 * 60_000] as const;

/** Durable, pair-scoped finite retry authority for the delivered-mandate consumer. */
export class FollowMeConsumerBackoffStore {
  private readonly filePath: string;
  private records = new Map<string, FollowMeBackoffRecord>();

  constructor(stateDir: string) {
    this.filePath = path.join(stateDir, 'follow-me-consumer-backoff.json');
    this.load();
  }

  get(key: string): FollowMeBackoffRecord | null {
    const value = this.records.get(key);
    return value ? { ...value } : null;
  }

  shouldAttempt(
    key: string,
    now = Date.now(),
    evidence?: { identityEvidenceKey: string; identityResolved: boolean; authoritySetKey: string },
  ): boolean {
    const value = this.records.get(key);
    if (!value) return true;
    const causalWake = evidence && (
      value.lane === 'identity'
        ? evidence.identityResolved && (
            !value.identityResolved || value.identityEvidenceKey !== evidence.identityEvidenceKey
          )
        : value.authoritySetKey !== evidence.authoritySetKey
    );
    if (causalWake) {
      this.records.delete(key);
      this.save();
      return true;
    }
    if (value.parkedAt) return false;
    return value.nextAttemptAt === null || Date.parse(value.nextAttemptAt) <= now;
  }

  recordFailure(
    key: string,
    lane: FollowMeFailureLane,
    now = Date.now(),
    evidence: { identityEvidenceKey: string; identityResolved: boolean; authoritySetKey: string } = {
      identityEvidenceKey: 'legacy', identityResolved: false, authoritySetKey: 'legacy',
    },
    failureCode?: string,
  ): FollowMeBackoffRecord {
    const previous = this.records.get(key);
    const effectiveLane: FollowMeFailureLane =
      previous?.lane === 'identity' || lane === 'identity' ? 'identity' : 'other';
    const attempts = (previous?.attempts ?? 0) + 1;
    const parked = attempts >= 4;
    const value: FollowMeBackoffRecord = {
      key,
      attempts,
      lane: effectiveLane,
      failureCode: failureCode ?? null,
      ...evidence,
      nextAttemptAt: parked ? null : new Date(now + DELAYS_MS[attempts - 1]!).toISOString(),
      parkedAt: parked ? new Date(now).toISOString() : null,
      updatedAt: new Date(now).toISOString(),
    };
    this.records.set(key, value);
    this.save();
    return { ...value };
  }

  clear(key: string): void {
    if (!this.records.delete(key)) return;
    this.save();
  }

  private load(): void {
    try {
      const parsed = JSON.parse(fs.readFileSync(this.filePath, 'utf8')) as BackoffFile;
      if (parsed.version !== 1 || !Array.isArray(parsed.records)) return;
      for (const value of parsed.records) {
        if (!value?.key || !Number.isInteger(value.attempts) || value.attempts < 1) continue;
        this.records.set(value.key, {
          ...value,
          failureCode: typeof value.failureCode === 'string' ? value.failureCode : null,
          identityEvidenceKey: typeof value.identityEvidenceKey === 'string' ? value.identityEvidenceKey : 'legacy',
          identityResolved: value.identityResolved === true,
          authoritySetKey: typeof value.authoritySetKey === 'string' ? value.authoritySetKey : 'legacy',
        });
      }
    } catch {
      // Missing or malformed state fails toward a fresh bounded episode.
    }
  }

  private save(): void {
    const body: BackoffFile = { version: 1, records: [...this.records.values()] };
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    const tmp = `${this.filePath}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, `${JSON.stringify(body, null, 2)}\n`);
    fs.renameSync(tmp, this.filePath);
  }
}

export function followMeBackoffKey(accountId: string, targetMachineId: string): string {
  return `${encodeURIComponent(accountId)}::${encodeURIComponent(targetMachineId)}`;
}

export function classifyFollowMeFailure(status: number, code?: string): FollowMeFailureLane {
  if (
    status === 409 &&
    (code === 'account-record-missing-email' || code === 'account-record-email-conflict')
  ) return 'identity';
  return 'other';
}
