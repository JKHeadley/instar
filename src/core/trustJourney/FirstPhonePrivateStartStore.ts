import { createHash, randomBytes } from 'node:crypto';
import type { Database, Statement } from 'better-sqlite3';
import type { Receipt } from './accountPath.js';
import { FIRST_PHONE_PRIVATE_START, matchesFirstPhonePrivateStart, type FirstPhoneStart } from './firstPhonePrivateStart.js';

const MAX_START_LIFETIME_MS = 10 * 60_000;

type Locator = Omit<FirstPhoneStart, 'token'> & { proposalHash: string };

function tokenHash(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

/** A local Start locator can open one disclosure for one exact proposal. */
export class FirstPhonePrivateStartStore {
  private readonly insert: Statement;
  private readonly find: Statement<[string], Locator>;
  private readonly consume: Statement;

  constructor(private readonly db: Database) {
    if (db.inTransaction) throw new Error('First-phone Start store requires a top-level schema transaction');
    db.exec(`
      CREATE TABLE IF NOT EXISTS first_phone_private_starts (
        token_hash TEXT PRIMARY KEY,
        owner_account_id TEXT NOT NULL,
        holder_epoch TEXT NOT NULL,
        holder_machine_id TEXT NOT NULL,
        issued_at INTEGER NOT NULL,
        expires_at INTEGER NOT NULL,
        proposal_hash TEXT NOT NULL,
        claimed INTEGER NOT NULL DEFAULT 0
      )
    `);
    this.insert = db.prepare(`
      INSERT INTO first_phone_private_starts (
        token_hash, owner_account_id, holder_epoch, holder_machine_id, issued_at, expires_at, proposal_hash
      ) VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT DO NOTHING
    `);
    this.find = db.prepare(`
      SELECT owner_account_id AS ownerAccountId, holder_epoch AS holderEpoch, holder_machine_id AS holderMachineId,
        issued_at AS issuedAt, expires_at AS expiresAt, proposal_hash AS proposalHash
      FROM first_phone_private_starts WHERE token_hash = ? AND claimed = 0
    `);
    this.consume = db.prepare('UPDATE first_phone_private_starts SET claimed = 1 WHERE token_hash = ? AND claimed = 0');
  }

  prepare(locator: Readonly<Locator>): string | null {
    if (this.db.inTransaction || !/^[1-9][0-9]*$/.test(locator.ownerAccountId)
      || !locator.holderEpoch || !locator.holderMachineId || !/^[a-f0-9]{64}$/.test(locator.proposalHash)
      || !Number.isSafeInteger(locator.issuedAt) || !Number.isSafeInteger(locator.expiresAt)
      || locator.issuedAt <= 0 || locator.expiresAt <= locator.issuedAt
      || locator.expiresAt - locator.issuedAt > MAX_START_LIFETIME_MS) return null;
    const token = `fp1_${randomBytes(32).toString('base64url')}`;
    return this.insert.run(tokenHash(token), locator.ownerAccountId, locator.holderEpoch, locator.holderMachineId,
      locator.issuedAt, locator.expiresAt, locator.proposalHash).changes === 1 ? token : null;
  }

  /** The caller supplies current authority and a firsthand receipt bound to the local machine. */
  claim(receipt: Receipt, ownerAccountId: string, holderEpoch: string, now: number): string | null {
    if (this.db.inTransaction || !FIRST_PHONE_PRIVATE_START.test(receipt.text)) return null;
    const token = receipt.text.slice('/start '.length);
    const hash = tokenHash(token);
    const locator = this.find.get(hash);
    if (!locator || !matchesFirstPhonePrivateStart({ ...locator, token }, receipt, ownerAccountId, holderEpoch, now)) return null;
    return this.consume.run(hash).changes === 1 ? locator.proposalHash : null;
  }
}
