import { randomUUID } from 'node:crypto';
import type { Database } from 'better-sqlite3';
import type { WorkBoardApprovalVersion, WorkBoardWriterProof } from './WorkBoardApprovalWriter.js';
import { sameProof } from './WorkBoardApprovalWriter.js';
import { canonicalJson, isCardId, sha256Hex } from './WorkCardStore.js';

const lifetimeMs = 24 * 60 * 60 * 1000;

export interface WorkBoardSlipProposal {
  sourceId: string;
  writer: WorkBoardWriterProof;
  items: ReadonlyArray<{ version: WorkBoardApprovalVersion; disclosure: unknown }>;
}

export interface WorkBoardSlip {
  id: string;
  proposal: WorkBoardSlipProposal;
  digest: string;
  expiresAt: number;
  decisionId: string | null;
}

interface SlipRow {
  id: string;
  source_id: string;
  proposal: string;
  digest: string;
  expires_at: number;
  decision_id: string | null;
}

function validProposal(proposal: WorkBoardSlipProposal): boolean {
  if (!proposal || typeof proposal.sourceId !== 'string' || !proposal.sourceId || !proposal.writer
    || !Array.isArray(proposal.items) || !proposal.items.length) return false;
  const writer = proposal.writer;
  if (![writer.epoch, writer.ownerGeneration, writer.ownerPersonKey, writer.writerIncarnation]
    .every((part) => typeof part === 'string' && part.length > 0)) return false;
  const ids = new Set<string>();
  for (const item of proposal.items) {
    const version = item?.version;
    if (!version || !isCardId(version.cardId) || ids.has(version.cardId)
      || ![version.cardRevision, version.policyRevision].every((part) => typeof part === 'string' && part.length > 0)
      || ![version.materialHash, version.titleHash].every((hash) => typeof hash === 'string' && /^[a-f0-9]{64}$/.test(hash))
      || sha256Hex(canonicalJson(item.disclosure)) !== version.visibleTextHash) return false;
    ids.add(version.cardId);
  }
  return true;
}

function slipDigest(id: string, expiresAt: number, canonicalProposal: string): string {
  return sha256Hex(canonicalJson([id, expiresAt, canonicalProposal]));
}

function unpack(row: SlipRow): WorkBoardSlip | null {
  if (!Number.isSafeInteger(row.expires_at) || row.expires_at <= 0
    || slipDigest(row.id, row.expires_at, row.proposal) !== row.digest) return null;
  let proposal: WorkBoardSlipProposal;
  try { proposal = JSON.parse(row.proposal); }
  catch { return null; /* @silent-fallback-ok: malformed stored evidence refuses approval */ }
  if (!validProposal(proposal) || proposal.sourceId !== row.source_id || canonicalJson(proposal) !== row.proposal) return null;
  return { id: row.id, proposal, digest: row.digest, expiresAt: row.expires_at, decisionId: row.decision_id };
}

/** Stores exactly one immutable proposal per source and one verified decision per slip. */
export class WorkBoardSlipStore {
  constructor(private readonly db: Database, private readonly now: () => number = Date.now) {
    const mode = db.pragma('journal_mode', { simple: true });
    if (!db.memory && mode !== 'wal' && mode !== 'delete' && mode !== 'truncate' && mode !== 'persist') {
      throw new Error('Work Board slips require a persistent SQLite journal mode');
    }
    db.pragma('synchronous = FULL');
    db.exec(`
      CREATE TABLE IF NOT EXISTS work_board_permission_slips (
        id TEXT PRIMARY KEY,
        source_id TEXT NOT NULL UNIQUE,
        proposal TEXT NOT NULL,
        digest TEXT NOT NULL,
        expires_at INTEGER NOT NULL,
        decision_id TEXT UNIQUE
      )
    `);
  }

  /** The caller resolves source provenance and supplies server-derived versions. */
  issue(proposal: WorkBoardSlipProposal): WorkBoardSlip | null {
    if (!validProposal(proposal)) return null;
    const canonical = canonicalJson(proposal);
    const issue = this.db.transaction(() => {
      const existing = this.db.prepare('SELECT * FROM work_board_permission_slips WHERE source_id = ?')
        .get(proposal.sourceId) as SlipRow | undefined;
      if (existing) return existing.proposal === canonical ? unpack(existing) : null;
      const id = randomUUID();
      const expiresAt = this.now() + lifetimeMs;
      if (!Number.isSafeInteger(expiresAt) || expiresAt <= 0) return null;
      const digest = slipDigest(id, expiresAt, canonical);
      this.db.prepare('INSERT INTO work_board_permission_slips (id, source_id, proposal, digest, expires_at) VALUES (?, ?, ?, ?, ?)')
        .run(id, proposal.sourceId, canonical, digest, expiresAt);
      return this.get(id);
    });
    return issue.immediate();
  }

  get(id: string): WorkBoardSlip | null {
    const row = this.db.prepare('SELECT * FROM work_board_permission_slips WHERE id = ?').get(id) as SlipRow | undefined;
    return row ? unpack(row) : null;
  }

  /** Record a decision after the owner-device proof has been verified by its authority. */
  consumeVerified(id: string, digest: string, currentWriter: WorkBoardWriterProof, decisionId: string): WorkBoardSlip | null {
    if (!decisionId) return null;
    const consume = this.db.transaction(() => {
      const slip = this.get(id);
      if (!slip || digest !== slip.digest || !sameProof(currentWriter, slip.proposal.writer)) return null;
      if (slip.decisionId !== null) return slip.decisionId === decisionId ? slip : null;
      if (this.now() >= slip.expiresAt) return null;
      const prior = this.db.prepare('SELECT id FROM work_board_permission_slips WHERE decision_id = ?').get(decisionId);
      if (prior) return null;
      this.db.prepare('UPDATE work_board_permission_slips SET decision_id = ? WHERE id = ? AND decision_id IS NULL')
        .run(decisionId, id);
      return this.get(id);
    });
    return consume.immediate();
  }
}
