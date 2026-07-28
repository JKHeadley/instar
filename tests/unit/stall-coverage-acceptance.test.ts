// safe-fs-allow: test file — SafeFsExecutor used for tmpdir cleanup.

/**
 * Unit tests — MatrixAcceptanceStore (framework-stall-coverage-matrix §2.2,
 * Frontloaded Decisions 14 + 20 — spec §5 "Acceptance authority" rows).
 *
 *  - requester == acceptor refused (a bearer principal can never bind);
 *  - a dashboard-PIN challenge acceptance passes;
 *  - contentHash mismatch refused (accept-then-edit voids, at bind AND at gate);
 *  - a reused challenge ref refused (single-use — replay);
 *  - a row-scoped acceptance survives UNRELATED codemod row additions;
 *  - a per-instance override is inert on any change to its row;
 *  - integrity-tampered artifacts are never honored (tamper-evident);
 *  - the conversational reply-anchor arm binds only for the verified operator.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { MatrixAcceptanceStore } from '../../src/core/ApprenticeshipMatrixAcceptance.js';
import { canonicalRowHash, canonicalRowSetHash } from '../../src/core/ApprenticeshipStallGate.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

let tmpDir: string;
let stateDir: string;
let store: MatrixAcceptanceStore;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'matrix-acceptance-'));
  stateDir = path.join(tmpDir, '.instar');
  fs.mkdirSync(path.join(stateDir, 'logs'), { recursive: true });
  store = new MatrixAcceptanceStore({ stateDir });
});

afterEach(() => {
  SafeFsExecutor.safeRmSync(tmpDir, { recursive: true, force: true, operation: 'tests/unit/stall-coverage-acceptance.test.ts' });
});

const HASH_A = 'a'.repeat(64);
const HASH_B = 'b'.repeat(64);

function mintWholeSet(hash = HASH_A) {
  return store.mintChallenge({
    instanceId: 'inst-1',
    framework: 'codex-cli',
    scope: 'whole-set',
    contentHash: hash,
    rowIds: ['codex-cli:quota-wall', 'codex-cli:wedged-context'],
  });
}

describe('acceptance authority (requester ≠ acceptor, structurally)', () => {
  it('REFUSES an acceptance recorded by the transition-calling (bearer) principal', () => {
    const ch = mintWholeSet();
    const bound = store.bind({
      challengeId: ch.challengeId,
      principal: { kind: 'bearer', id: 'agent-token' },
      currentContentHash: HASH_A,
    });
    expect(bound.ok).toBe(false);
    expect(bound.reason).toContain('requester ≠ acceptor');
    // Not consumed AND not honored.
    expect(store.getChallenge(ch.challengeId)?.used).toBe(false);
    expect(store.hasWholeSetAcceptance('inst-1', HASH_A)).toBe(false);
  });

  it('a dashboard-PIN challenge acceptance passes and satisfies the gate check', () => {
    const ch = mintWholeSet();
    const bound = store.bind({
      challengeId: ch.challengeId,
      principal: { kind: 'operator-pin', id: 'dashboard-pin' },
      currentContentHash: HASH_A,
    });
    expect(bound.ok).toBe(true);
    expect(store.hasWholeSetAcceptance('inst-1', HASH_A)).toBe(true);
    // Scoped to instance + hash — a different instance or hash never matches.
    expect(store.hasWholeSetAcceptance('inst-2', HASH_A)).toBe(false);
    expect(store.hasWholeSetAcceptance('inst-1', HASH_B)).toBe(false);
  });

  it('a verified-operator principal also binds (the conversational arm identity)', () => {
    const ch = mintWholeSet();
    expect(store.bind({
      challengeId: ch.challengeId,
      principal: { kind: 'verified-operator', id: 'sha-of-uid' },
      currentContentHash: HASH_A,
    }).ok).toBe(true);
  });
});

describe('content-hash binding (accept-then-edit voids — Decision 20)', () => {
  it('REFUSES when the current content hash mismatches the minted challenge (edit between mint and bind)', () => {
    const ch = mintWholeSet(HASH_A);
    const bound = store.bind({
      challengeId: ch.challengeId,
      principal: { kind: 'operator-pin', id: 'dashboard-pin' },
      currentContentHash: HASH_B,
    });
    expect(bound.ok).toBe(false);
    expect(bound.reason).toContain('content hash mismatch');
  });

  it('a recorded acceptance can never satisfy a later check over CHANGED content (gate side)', () => {
    const ch = mintWholeSet(HASH_A);
    expect(store.bind({ challengeId: ch.challengeId, principal: { kind: 'operator-pin', id: 'dashboard-pin' }, currentContentHash: HASH_A }).ok).toBe(true);
    // The matrix then changes: its hash is now HASH_B — the standing artifact is void for it.
    expect(store.hasWholeSetAcceptance('inst-1', HASH_B)).toBe(false);
  });

  it('a null current hash (content no longer resolvable) refuses the bind', () => {
    const ch = mintWholeSet(HASH_A);
    expect(store.bind({ challengeId: ch.challengeId, principal: { kind: 'operator-pin', id: 'dashboard-pin' }, currentContentHash: null }).ok).toBe(false);
  });
});

describe('single-use challenges (replay refused)', () => {
  it('a reused challenge ref is refused', () => {
    const ch = mintWholeSet();
    expect(store.bind({ challengeId: ch.challengeId, principal: { kind: 'operator-pin', id: 'dashboard-pin' }, currentContentHash: HASH_A }).ok).toBe(true);
    const replay = store.bind({ challengeId: ch.challengeId, principal: { kind: 'operator-pin', id: 'dashboard-pin' }, currentContentHash: HASH_A });
    expect(replay.ok).toBe(false);
    expect(replay.reason).toContain('replay refused');
  });

  it('an unknown challenge is refused', () => {
    expect(store.bind({ challengeId: 'MAC-nope', principal: { kind: 'operator-pin', id: 'dashboard-pin' }, currentContentHash: HASH_A }).ok).toBe(false);
  });
});

describe('row-scoped binding granularity (Decision 20)', () => {
  const row = { class: 'quota-wall', status: 'declared-gap', issueRef: 'stallclass::quota-wall::codex-cli::gap', closePath: 'CMT-9' };
  const ROW_ID = 'codex-cli:quota-wall';

  /** Simulates the gate's live-matrix resolver over a rowId→row map. */
  const resolverFor = (rows: Record<string, Record<string, unknown>>) => (rowIds: string[]): string | null => {
    const entries: Array<{ rowId: string; row: Record<string, unknown> }> = [];
    for (const id of rowIds) {
      if (!rows[id]) return null;
      entries.push({ rowId: id, row: rows[id] });
    }
    return canonicalRowSetHash(entries);
  };

  function bindRowAcceptance(): string {
    const setHash = canonicalRowSetHash([{ rowId: ROW_ID, row }]);
    const ch = store.mintChallenge({
      instanceId: 'inst-1',
      framework: 'codex-cli',
      scope: 'rows',
      contentHash: setHash,
      rowIds: [ROW_ID],
    });
    expect(store.bind({ challengeId: ch.challengeId, principal: { kind: 'operator-pin', id: 'dashboard-pin' }, currentContentHash: setHash }).ok).toBe(true);
    return ch.challengeId;
  }

  it('a row-scoped acceptance SURVIVES unrelated codemod row additions (only the accepted rows are hashed)', () => {
    const ref = bindRowAcceptance();
    // The codemod adds OTHER rows: the joint hash covers only the ACCEPTED
    // rowIds, so the standing acceptance remains valid.
    const withUnrelated = resolverFor({
      [ROW_ID]: row,
      'codex-cli:brand-new-class': { class: 'brand-new-class', status: 'declared-gap', closePath: 'pending-mint' },
    });
    expect(store.rowAcceptanceValid(ref, ROW_ID, withUnrelated)).toBe(true);
  });

  it('a row-scoped acceptance is VOID once the accepted row itself changes (and on row removal)', () => {
    const ref = bindRowAcceptance();
    const edited = resolverFor({ [ROW_ID]: { ...row, closePath: 'CMT-10' } });
    expect(store.rowAcceptanceValid(ref, ROW_ID, edited)).toBe(false);
    const removed = resolverFor({});
    expect(store.rowAcceptanceValid(ref, ROW_ID, removed)).toBe(false);
  });

  it('a row-scoped acceptance never covers a row id outside its enumerated set', () => {
    const ref = bindRowAcceptance();
    expect(store.rowAcceptanceValid(ref, 'codex-cli:wedged-context', resolverFor({ [ROW_ID]: row }))).toBe(false);
  });

  it('writing the acceptanceRef INTO the accepted row does not void it (the ref field is excluded from canonical content)', () => {
    const ref = bindRowAcceptance();
    const withRef = resolverFor({ [ROW_ID]: { ...row, acceptanceRef: ref } });
    expect(store.rowAcceptanceValid(ref, ROW_ID, withRef)).toBe(true);
  });
});

describe('per-instance override relief (§3.4 rollback)', () => {
  const row = { class: 'wedged-context', status: 'covered', detector: 'src/a.ts#Flaky', recovery: 'src/b.ts#R', guardKey: 'x', posture: 'live', evidence: 'e.md' };

  function bindOverride(): void {
    const rowHash = canonicalRowHash(row);
    const ch = store.mintChallenge({
      instanceId: 'inst-1',
      framework: 'codex-cli',
      scope: 'override',
      contentHash: rowHash,
      rowIds: ['codex-cli:wedged-context'],
      rule: 'symbol-unresolvable',
    });
    expect(store.bind({ challengeId: ch.challengeId, principal: { kind: 'operator-pin', id: 'dashboard-pin' }, currentContentHash: rowHash }).ok).toBe(true);
  }

  it('excuses exactly the named (rule, row) while the row content is unchanged', () => {
    bindOverride();
    expect(store.overrideExcuses('inst-1', 'symbol-unresolvable', 'codex-cli:wedged-context', canonicalRowHash(row))).toBe(true);
    // A different rule / instance / row is NOT excused.
    expect(store.overrideExcuses('inst-1', 'evidence-missing', 'codex-cli:wedged-context', canonicalRowHash(row))).toBe(false);
    expect(store.overrideExcuses('inst-2', 'symbol-unresolvable', 'codex-cli:wedged-context', canonicalRowHash(row))).toBe(false);
  });

  it('is INERT on any change to the excused row (expires on change)', () => {
    bindOverride();
    const changed = { ...row, detector: 'src/a.ts#Renamed' };
    expect(store.overrideExcuses('inst-1', 'symbol-unresolvable', 'codex-cli:wedged-context', canonicalRowHash(changed))).toBe(false);
  });
});

describe('tamper evidence', () => {
  it('an artifact whose integrity hash no longer matches is never honored', () => {
    const ch = mintWholeSet();
    expect(store.bind({ challengeId: ch.challengeId, principal: { kind: 'operator-pin', id: 'dashboard-pin' }, currentContentHash: HASH_A }).ok).toBe(true);
    expect(store.hasWholeSetAcceptance('inst-1', HASH_A)).toBe(true);
    // Tamper: rewrite the instanceId inside the persisted artifact row.
    const logPath = path.join(stateDir, 'logs', 'apprenticeship-decisions.jsonl');
    fs.writeFileSync(logPath, fs.readFileSync(logPath, 'utf8').replace('"inst-1"', '"inst-9"'));
    expect(store.hasWholeSetAcceptance('inst-9', HASH_A)).toBe(false); // tampered row skipped
    expect(store.hasWholeSetAcceptance('inst-1', HASH_A)).toBe(false); // original content gone
  });
});

describe('conversational reply-anchor arm', () => {
  function mintPosted(): ReturnType<MatrixAcceptanceStore['mintChallenge']> {
    const ch = mintWholeSet();
    store.attachMessage(ch.challengeId, { topicId: 42, messageId: 777 });
    return ch;
  }

  const deps = (operatorUid: string | null, currentHash: string | null = HASH_A) => ({
    getOperatorUid: () => operatorUid,
    resolveCurrentContentHash: () => currentHash,
  });

  it('binds when the VERIFIED operator reply-anchors an affirmative onto the enumeration message', async () => {
    const ch = mintPosted();
    await store.observeInbound(
      { topicId: 42, text: 'yes', senderUid: '1001', messageId: 900, replyToMessageId: 777 },
      deps('1001'),
    );
    expect(store.getChallenge(ch.challengeId)?.used).toBe(true);
    expect(store.hasWholeSetAcceptance('inst-1', HASH_A)).toBe(true);
  });

  it('ignores a NON-operator sender (Know Your Principal)', async () => {
    const ch = mintPosted();
    await store.observeInbound(
      { topicId: 42, text: 'yes', senderUid: '9999', messageId: 900, replyToMessageId: 777 },
      deps('1001'),
    );
    expect(store.getChallenge(ch.challengeId)?.used).toBe(false);
    expect(store.hasWholeSetAcceptance('inst-1', HASH_A)).toBe(false);
  });

  it('ignores a bare affirmative that is NOT reply-anchored', async () => {
    const ch = mintPosted();
    await store.observeInbound(
      { topicId: 42, text: 'yes', senderUid: '1001', messageId: 900 },
      deps('1001'),
    );
    expect(store.getChallenge(ch.challengeId)?.used).toBe(false);
  });

  it('a reply-anchored confirmation over CHANGED content does not record an acceptance (hash re-checked at bind)', async () => {
    const ch = mintPosted();
    await store.observeInbound(
      { topicId: 42, text: 'approve', senderUid: '1001', messageId: 900, replyToMessageId: 777 },
      deps('1001', HASH_B),
    );
    expect(store.hasWholeSetAcceptance('inst-1', HASH_A)).toBe(false);
    expect(store.hasWholeSetAcceptance('inst-1', HASH_B)).toBe(false);
    void ch;
  });
});
