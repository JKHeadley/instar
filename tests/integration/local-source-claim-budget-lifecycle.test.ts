/** Actual process death on both sides of the budgeted durable claim boundary.
 * This is store/SQLite lifecycle proof, not a signed apply endpoint or user consent. */
import { afterEach, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { pathToFileURL } from 'node:url';
import { ImportedHistoryStore } from '../../dist/import/ImportedHistoryStore.js';
import { createLocalSourceClaim } from '../../dist/import/LocalSourceIdentity.js';
import { SafeFsExecutor } from '../../dist/core/SafeFsExecutor.js';

const privateIt = it.skipIf(process.platform === 'win32' || !process.getuid);
const homes: string[] = [];
afterEach(() => { for (const home of homes.splice(0)) SafeFsExecutor.safeRmSync(home,
  { recursive: true, force: true, operation: 'owned claim crash fixture cleanup after actual process exit' }); });
const original = { ownerUserId: 'synthetic-owner', source: 'codex' as const, originalId: 'synthetic-original',
  projectPath: '/synthetic/original', representation: 'canonical' as const, parserContractVersion: 1 as const };
const selected = { ...original, originalId: 'synthetic-new', projectPath: '/synthetic/' + 'p'.repeat(200_000) };
const moduleURL = pathToFileURL(path.resolve('dist/import/ImportedHistoryStore.js')).href;
const program = `
import Database from 'better-sqlite3';
const { ImportedHistoryStore } = await import(${JSON.stringify(moduleURL)});
const store = new ImportedHistoryStore(process.argv[1]);
const phase = process.argv[2], identity = JSON.parse(process.argv[3]);
identity.projectPath = '/synthetic/' + 'p'.repeat(200000);
if (phase === 'before') {
  const prepare = Database.prototype.prepare;
  Database.prototype.prepare = function(sql) {
    const statement = prepare.call(this, sql);
    if (sql === 'INSERT INTO local_source_claims (ref, payload) VALUES (?, ?)') {
      const run = statement.run.bind(statement);
      statement.run = (...args) => { const out = run(...args); process.kill(process.pid, 'SIGKILL'); return out; };
    }
    return statement;
  };
}
await store.withWriter(async () => {
  const plan = store.planSourceClaimWrite(identity);
  store.executeWritePlan(plan, plan.contentBytes);
  process.kill(process.pid, 'SIGKILL');
});
`;
async function killed(home: string, phase: 'before' | 'after') {
  const child = spawn(process.execPath, ['--input-type=module', '-e', program, home, phase, JSON.stringify({ ...selected, projectPath: '/synthetic' })],
    { cwd: process.cwd(), stdio: ['ignore', 'ignore', 'pipe'], env: { PATH: process.env.PATH ?? '/usr/bin:/bin' } });
  let errors = '';
  child.stderr.on('data', (bytes: Buffer) => { if (errors.length + bytes.length <= 8192) errors += bytes.toString(); else child.kill('SIGKILL'); });
  const exited = once(child, 'close') as Promise<[number | null, NodeJS.Signals | null]>;
  const deadline = setTimeout(() => child.kill('SIGKILL'), 15_000);
  try { expect(await exited).toEqual([null, 'SIGKILL']); expect(errors).toBe(''); }
  finally { clearTimeout(deadline); if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); await exited.catch(() => undefined); }
}
async function setup() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'claim-budget-crash-')); homes.push(home);
  const store = new ImportedHistoryStore(home);
  await store.withWriter(async () => { store.assertOrClaimLocalSource(original); });
  return { home, store, file: path.join(store.dir, 'source-claims.sqlite') };
}
privateIt('refuses unresolved native journal state before any new budgeted open after death before commit', async () => {
  const { home, file } = await setup(), before = fs.readFileSync(file); await killed(home, 'before');
  const reopened = new ImportedHistoryStore(home), sidecar = file + '-journal';
  expect(fs.existsSync(sidecar)).toBe(true); const journal = fs.readFileSync(sidecar);
  await reopened.withWriter(async () => {
    expect(() => reopened.planSourceClaimWrite(selected)).toThrow('local-source-budget-recovery-required');
    expect(fs.readFileSync(sidecar)).toEqual(journal); // No hidden recovery or deletion in budgeted preflight.
  });
  // Existing SQLite-owned recovery/read behavior remains distinct from the new budgeted path.
  expect(reopened.readLocalSourceClaim(original)).toEqual(createLocalSourceClaim(original));
  expect(reopened.readLocalSourceClaim(selected)).toBeNull(); expect(fs.readFileSync(file)).toEqual(before);
  expect(fs.readdirSync(path.join(reopened.dir, 'conversations'))).toEqual([]);
});
privateIt('retains the actual durable claim after death before append and reconciles through a fresh writer', async () => {
  const { home } = await setup(); await killed(home, 'after'); const reopened = new ImportedHistoryStore(home);
  expect(reopened.readLocalSourceClaim(selected)).toEqual(createLocalSourceClaim(selected));
  expect(fs.readdirSync(path.join(reopened.dir, 'conversations'))).toEqual([]);
  await reopened.withWriter(async () => {
    const claim = reopened.planSourceClaimWrite(selected); expect(claim.contentBytes).toBe(0);
    const durable = reopened.executeWritePlan(claim, 0) as ReturnType<typeof createLocalSourceClaim>;
    const conversation = reopened.planConversationWrite({ from: selected.source, originalId: durable.destinationId,
      title: 'Synthetic resumed copy', createdAt: null,
      messages: [{ key: 'synthetic-one', role: 'operator', senderName: 'Me', at: null, text: 'Synthetic resumed message.' }],
      overflow: [], stats: { redactions: 0, splitMessages: 0, droppedBranches: 0 } });
    reopened.executeWritePlan(conversation, conversation.contentBytes);
    const flush = reopened.planManifestWrite(); reopened.executeWritePlan(flush, flush.contentBytes);
  });
  expect(new ImportedHistoryStore(home).listConversations()).toHaveLength(1);
});
