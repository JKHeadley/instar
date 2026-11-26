import { randomUUID } from 'node:crypto';
import type { Database } from 'better-sqlite3';
import type { WorkBoardApprovalVersion, WorkBoardWriterProof } from './WorkBoardApprovalWriter.js';
import { approvalEventId, sameProof } from './WorkBoardApprovalWriter.js';
import { canonicalJson, isCardId, sha256Hex } from './WorkCardStore.js';

const lifetimeMs = 24 * 60 * 60 * 1000;

export interface WorkBoardSlipProposal {
  sourceId: string;
  sourceDigest: string;
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

export interface WorkBoardSlipDecision {
  slipId: string;
  digest: string;
  writer: WorkBoardWriterProof;
  decisionId: string;
}

export type WorkBoardSlipItemOutcome =
  | { status: 'applied' | 'already-approved'; eventId: string }
  | { status: 'changed' | 'unresolved' };

interface SlipItemRow {
  card_id: string;
  claim_id: string | null;
  status: string;
  event_id: string | null;
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
  if (!proposal || typeof proposal.sourceId !== 'string' || !proposal.sourceId
    || typeof proposal.sourceDigest !== 'string' || proposal.sourceDigest.length !== 64 || !/^[a-f0-9]{64}$/.test(proposal.sourceDigest)
    || !proposal.writer
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
      );
      CREATE TABLE IF NOT EXISTS work_board_permission_slip_items (
        slip_id TEXT NOT NULL,
        card_id TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('pending', 'claimed', 'applied', 'already-approved', 'changed', 'unresolved')),
        claim_id TEXT,
        event_id TEXT,
        PRIMARY KEY (slip_id, card_id)
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

  getBySource(sourceId: string): WorkBoardSlip | null {
    const row = this.db.prepare('SELECT * FROM work_board_permission_slips WHERE source_id = ?')
      .get(sourceId) as SlipRow | undefined;
    return row ? unpack(row) : null;
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
      const addItem = this.db.prepare("INSERT INTO work_board_permission_slip_items (slip_id, card_id, status) VALUES (?, ?, 'pending')");
      for (const { version } of slip.proposal.items) addItem.run(id, version.cardId);
      return this.get(id);
    });
    return consume.immediate();
  }

  private readDecision(key: WorkBoardSlipDecision): WorkBoardSlip | null {
    const slip = this.get(key.slipId);
    if (!slip || slip.decisionId !== key.decisionId || !key.decisionId
      || slip.digest !== key.digest || !sameProof(key.writer, slip.proposal.writer)) return null;
    return slip;
  }

  /** The active writer may claim a pending item once. A claim survives process loss. */
  claimItem(key: WorkBoardSlipDecision, cardId: string): { id: string; version: WorkBoardApprovalVersion } | null {
    const claim = this.db.transaction(() => {
      const slip = this.readDecision(key);
      if (!slip || this.now() >= slip.expiresAt) return null;
      const item = slip.proposal.items.find(({ version }) => version.cardId === cardId);
      if (!item) return null;
      const claimId = randomUUID();
      const result = this.db.prepare(`
        UPDATE work_board_permission_slip_items SET status = 'claimed', claim_id = ?
        WHERE slip_id = ? AND card_id = ? AND status = 'pending'
      `).run(claimId, key.slipId, cardId);
      return result.changes === 1 ? { id: claimId, version: item.version } : null;
    });
    return claim.immediate();
  }

  /** Record the exact result of a claimed item after authoritative writer readback. */
  finishItem(key: WorkBoardSlipDecision, cardId: string, claimId: string, outcome: WorkBoardSlipItemOutcome): boolean {
    const finish = this.db.transaction(() => {
      const item = this.readDecision(key)?.proposal.items.find(({ version }) => version.cardId === cardId);
      if (!item) return false;
      const eventId = 'eventId' in outcome ? outcome.eventId : null;
      if (eventId !== null && eventId !== approvalEventId({
        proof: key.writer, version: item.version, source: 'slip', decisionId: key.decisionId,
      })) return false;
      const result = this.db.prepare(`
        UPDATE work_board_permission_slip_items SET status = ?, event_id = ?
        WHERE slip_id = ? AND card_id = ? AND status = 'claimed' AND claim_id = ?
      `).run(outcome.status, eventId, key.slipId, cardId, claimId);
      return result.changes === 1;
    });
    return finish.immediate();
  }

  /** Candidate evidence for one enrolled writer. The journal still owns exact event proof. */
  *completedApprovals(writer: WorkBoardWriterProof) {
    const rows = this.db.prepare(`
      SELECT DISTINCT slip_id FROM work_board_permission_slip_items
      WHERE status IN ('applied', 'already-approved')
      ORDER BY slip_id
    `).all() as Array<{ slip_id: string }>;
    for (const { slip_id: slipId } of rows) {
      const slip = this.get(slipId);
      if (!slip?.decisionId || !sameProof(writer, slip.proposal.writer)) continue;
      const decisionId = slip.decisionId;
      const results = this.readItemResults({ slipId, writer, digest: slip.digest, decisionId });
      if (!results) continue;
      for (const [index, result] of results.entries()) {
        if ('eventId' in result) yield { ...result, decisionId, version: slip.proposal.items[index].version };
      }
    }
  }

  /** Report in signed order. A claim without a durable result remains unresolved. */
  readItemResults(key: WorkBoardSlipDecision): Array<{ cardId: string } & (WorkBoardSlipItemOutcome | { status: 'pending' })> | null {
    const slip = this.readDecision(key);
    if (!slip) return null;
    const records = this.db.prepare('SELECT * FROM work_board_permission_slip_items WHERE slip_id = ?')
      .all(key.slipId) as SlipItemRow[];
    const byCard = new Map(records.map((row) => [row.card_id, row]));
    return slip.proposal.items.map(({ version }) => {
      const { cardId } = version;
      const row = byCard.get(cardId);
      if (row?.status === 'pending' || row?.status === 'changed') return { cardId, status: row.status };
      if ((row?.status === 'applied' || row?.status === 'already-approved') && row.event_id === approvalEventId({
        proof: key.writer, version, source: 'slip', decisionId: key.decisionId,
      })) return { cardId, status: row.status, eventId: row.event_id };
      return { cardId, status: 'unresolved' };
    });
  }
}
