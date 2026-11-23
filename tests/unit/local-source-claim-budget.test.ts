import { afterEach, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { ImportedHistoryStore, type ImportedHistoryWritePlan } from '../../src/import/ImportedHistoryStore.js';
import { createLocalSourceClaim, type LocalSourceIdentity } from '../../src/import/LocalSourceIdentity.js';
import { inspectLocalClaimBudgetSource, planLocalClaimBudget, enforceLocalClaimBudget } from '../../src/import/LocalHistoryClaimBudget.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

const privateIt = it.skipIf(process.platform === 'win32' || !process.getuid);
const homes: string[] = [];
afterEach(() => { vi.restoreAllMocks(); for (const home of homes.splice(0)) SafeFsExecutor.safeRmSync(home,
  { recursive: true, force: true, operation: 'owned claim budget fixtures' }); });
const identity: LocalSourceIdentity = { ownerUserId: 'synthetic-owner', source: 'codex', originalId: 'synthetic-session',
  projectPath: '/synthetic/project', representation: 'canonical', parserContractVersion: 1 };
function fixture() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'claim-budget-')); homes.push(home);
  const store = new ImportedHistoryStore(home), file = path.join(store.dir, 'source-claims.sqlite');
  return { home, store, file };
}
const conversation = (originalId: string) => ({ from: 'codex' as const, originalId, title: 'Synthetic claim', createdAt: null,
  messages: [{ key: 'synthetic-one', role: 'operator' as const, senderName: 'Me', at: null, text: 'Synthetic private message' }], overflow: [],
  stats: { redactions: 0, splitMessages: 0, droppedBranches: 0 } });
privateIt('plans before database creation and commits a real active claim before append', async () => {
  const { home, store, file } = fixture();
  await store.withWriter(async () => {
    const plan = store.planSourceClaimWrite(identity); expect(plan.kind).toBe('source-claim');
    expect(plan.contentBytes).toBeGreaterThan(0); expect(fs.existsSync(file)).toBe(false);
    const claim = store.executeWritePlan(plan, plan.contentBytes) as ReturnType<typeof createLocalSourceClaim>;
    expect(claim).toEqual(createLocalSourceClaim(identity)); expect(store.readLocalSourceClaim(identity)).toEqual(claim);
    expect(fs.statSync(file).size).toBeLessThanOrEqual(plan.contentBytes);
    const write = store.planConversationWrite(conversation(claim.destinationId)); store.executeWritePlan(write, write.contentBytes);
    const flush = store.planManifestWrite(); store.executeWritePlan(flush, flush.contentBytes);
  });
  expect(new ImportedHistoryStore(home).readLocalSourceClaim(identity)).toEqual(createLocalSourceClaim(identity));
});
privateIt('rejects an insufficient ceiling before even creating the claims file and consumes the token', async () => {
  const { store, file } = fixture();
  await store.withWriter(async () => {
    const plan = store.planSourceClaimWrite(identity);
    expect(() => store.executeWritePlan(plan, plan.contentBytes - 1)).toThrow('import-write-plan-budget');
    expect(fs.existsSync(file)).toBe(false);
    expect(() => store.executeWritePlan(plan, plan.contentBytes)).toThrow('import-write-plan-stale');
  });
});
privateIt('activates the identical durable claim at zero content cost in a later writer', async () => {
  const { store } = fixture();
  await store.withWriter(async () => { store.assertOrClaimLocalSource(identity); });
  await store.withWriter(async () => {
    const plan = store.planSourceClaimWrite(identity); expect(plan.contentBytes).toBe(0);
    const claim = store.executeWritePlan(plan, 0) as ReturnType<typeof createLocalSourceClaim>;
    expect(store.addConversation(conversation(claim.destinationId)).added).toBe(1); store.flush();
  });
});
privateIt('refuses changed provenance instead of using an old claim to authorize another representation', async () => {
  const { store } = fixture();
  await store.withWriter(async () => { store.assertOrClaimLocalSource(identity); });
  await store.withWriter(async () => {
    expect(() => store.planSourceClaimWrite({ ...identity, representation: 'event-fallback' })).toThrow('local-source-reconciliation-required');
  });
});
privateIt('enforces the actual native SQLite page ceiling and can use only a fresh plan/transaction afterward', async () => {
  const { store, file } = fixture();
  await store.withWriter(async () => {
    const tooSmall = store.planSourceClaimWrite(identity, 1);
    expect(() => store.executeWritePlan(tooSmall, tooSmall.contentBytes)).toThrow('local-source-budget-capacity');
    expect(fs.statSync(file).size).toBeLessThanOrEqual(4096);
    expect(() => store.executeWritePlan(tooSmall, tooSmall.contentBytes)).toThrow('import-write-plan-stale');
    const enough = store.planSourceClaimWrite(identity, 32);
    expect(store.executeWritePlan(enough, enough.contentBytes)).toEqual(createLocalSourceClaim(identity));
  });
});
privateIt('rolls back the first failed insert without changing an existing database or its real claims', async () => {
  const { store, file } = fixture();
  await store.withWriter(async () => { store.assertOrClaimLocalSource(identity); });
  const before = fs.readFileSync(file), pages = before.length / 4096;
  await store.withWriter(async () => {
    const large = { ...identity, originalId: 'synthetic-second', projectPath: '/synthetic/' + 'x'.repeat(200_000) };
    const plan = store.planSourceClaimWrite(large, pages);
    expect(() => store.executeWritePlan(plan, plan.contentBytes)).toThrow('local-source-budget-capacity');
    expect(fs.readFileSync(file)).toEqual(before);
    expect(store.readLocalSourceClaim(identity)).toEqual(createLocalSourceClaim(identity)); expect(store.readLocalSourceClaim(large)).toBeNull();
  });
});
for (const suffix of ['-journal', '-wal', '-shm']) privateIt('preserves existing ' + suffix + ' before opening SQLite', async () => {
  const { store, file } = fixture();
  await store.withWriter(async () => {
    fs.writeFileSync(file + suffix, 'synthetic unresolved sidecar', { mode: 0o600 });
    expect(() => store.planSourceClaimWrite(identity)).toThrow('local-source-budget-recovery-required');
    expect(fs.readFileSync(file + suffix, 'utf8')).toBe('synthetic unresolved sidecar'); expect(fs.existsSync(file)).toBe(false);
  });
});
privateIt('refuses a WAL header even when closing SQLite removed all WAL sidecars', async () => {
  const { store, file } = fixture();
  await store.withWriter(async () => { store.assertOrClaimLocalSource(identity); });
  const db = new Database(file); db.pragma('journal_mode = WAL'); db.close();
  expect(fs.existsSync(file + '-wal')).toBe(false); expect(fs.readFileSync(file)[18]).toBe(2);
  await store.withWriter(async () => {
    expect(() => store.planSourceClaimWrite(identity)).toThrow('local-source-budget-recovery-required');
    expect(fs.existsSync(file + '-wal')).toBe(false); expect(fs.existsSync(file + '-shm')).toBe(false);
  });
});
privateIt('refuses a destination changed after planning and does not revive the old writer', async () => {
  const { store, file } = fixture(); let old!: ImportedHistoryWritePlan;
  await store.withWriter(async () => {
    old = store.planSourceClaimWrite(identity); fs.writeFileSync(file, 'synthetic changed file', { mode: 0o600 });
    expect(() => store.executeWritePlan(old, old.contentBytes)).toThrow('import-write-plan-stale');
    expect(fs.readFileSync(file, 'utf8')).toBe('synthetic changed file');
  });
  await store.withWriter(async () => { expect(() => store.executeWritePlan(old, old.contentBytes)).toThrow('import-write-plan-stale'); });
});
privateIt('verifies native pager settings and uses only checked bounded content arithmetic', () => {
  const db = new Database(':memory:');
  try {
    const budget = planLocalClaimBudget(db, 0, 512, 32);
    expect(budget.databaseGrowthBytes).toBe(32 * 4096);
    expect(budget.journalBytes).toBe(32 * (4096 + 8) + 2 * 65536);
    expect(() => planLocalClaimBudget(db, 0, 512, Number.MAX_SAFE_INTEGER)).toThrow('local-source-budget-policy');
    expect(() => enforceLocalClaimBudget(db, budget)).toThrow('local-source-budget-policy'); // Memory mode is not a disk claim transaction.
  } finally { db.close(); }
});
privateIt('subtracts existing logical file length when computing the main-file growth allowance', async () => {
  const { store, file } = fixture();
  await store.withWriter(async () => { store.assertOrClaimLocalSource(identity); });
  const size = fs.statSync(file).size, db = new Database(file);
  try {
    const budget = planLocalClaimBudget(db, size, 512, size / 4096 + 4);
    expect(budget.databaseGrowthBytes).toBe(4 * 4096);
    enforceLocalClaimBudget(db, budget);
    expect(db.pragma('cache_spill', { simple: true })).toBe(0); expect(db.pragma('temp_store', { simple: true })).toBe(2);
    expect(db.pragma('synchronous', { simple: true })).toBe(2); expect(db.pragma('max_page_count', { simple: true })).toBeLessThanOrEqual(budget.maxPageCount);
  } finally { db.close(); }
});
privateIt('requires a non-auto-vacuum default pager rather than assuming a relocation journal bound', () => {
  const db = new Database(':memory:');
  try { db.pragma('auto_vacuum = FULL'); expect(() => planLocalClaimBudget(db, 0, 512)).toThrow('local-source-budget-policy'); }
  finally { db.close(); }
});
privateIt('does not open or follow a symlink as the canonical claim database', () => {
  const { store, file } = fixture(), target = path.join(store.dir, 'synthetic-target'); fs.writeFileSync(target, 'preserved', { mode: 0o600 });
  fs.symlinkSync(target, file); expect(() => inspectLocalClaimBudgetSource(file)).toThrow(); expect(fs.readFileSync(target, 'utf8')).toBe('preserved');
});
privateIt('observes real main/journal content within the reserved ceiling before the native commit', async () => {
  const { store, file } = fixture();
  await store.withWriter(async () => { store.assertOrClaimLocalSource(identity); });
  const originalBytes = fs.statSync(file).size, realPrepare = Database.prototype.prepare;
  let observed = false, allowance = 0;
  const inspect = vi.spyOn(Database.prototype, 'prepare').mockImplementation(function(this: Database.Database, sql: string) {
    const statement = realPrepare.call(this, sql);
    if (sql === 'INSERT INTO local_source_claims (ref, payload) VALUES (?, ?)') {
      const realRun = statement.run.bind(statement);
      statement.run = (...args: unknown[]) => {
        const result = realRun(...args); observed = true;
        const growth = Math.max(0, fs.statSync(file).size - originalBytes);
        const journal = fs.existsSync(file + '-journal') ? fs.statSync(file + '-journal').size : 0;
        expect(growth + journal).toBeLessThanOrEqual(allowance); expect(journal).toBeGreaterThan(0);
        return result;
      };
    }
    return statement;
  });
  try {
    await store.withWriter(async () => {
      const plan = store.planSourceClaimWrite({ ...identity, originalId: 'synthetic-observed', projectPath: '/synthetic/' + 'p'.repeat(200_000) });
      allowance = plan.contentBytes; store.executeWritePlan(plan, allowance);
      expect(observed).toBe(true); expect(Math.max(0, fs.statSync(file).size - originalBytes)).toBeLessThanOrEqual(allowance);
      expect(fs.existsSync(file + '-journal')).toBe(false);
    });
  } finally { inspect.mockRestore(); }
});
