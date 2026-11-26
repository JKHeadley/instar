import { afterEach, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { ImportedHistoryStore, importedRef, ImportWriteCleanupPending, type ImportedHistoryWritePlan } from '../../src/import/ImportedHistoryStore.js';
import { localSourceDestination, type LocalSourceIdentity } from '../../src/import/LocalSourceIdentity.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import type { ImportedConversation } from '../../src/import/exportParsers.js';

const homes: string[] = [];
afterEach(() => { vi.restoreAllMocks(); for (const home of homes.splice(0)) SafeFsExecutor.safeRmSync(home,
  { recursive: true, force: true, operation: 'owned writer plan fixture cleanup' }); });
const identity: LocalSourceIdentity = { ownerUserId: 'synthetic-owner', source: 'codex', originalId: 'synthetic-session',
  projectPath: '/synthetic/project', representation: 'canonical', parserContractVersion: 1 };
function fixture() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'history-write-plan-')); homes.push(home);
  const store = new ImportedHistoryStore(home), originalId = localSourceDestination(identity);
  const conv: ImportedConversation = { from: 'codex', originalId, title: 'Synthetic garden 🌱', createdAt: null,
    messages: [{ key: 'one', role: 'operator', senderName: 'Me', at: null, text: 'A café 🌱' }],
    overflow: [{ key: 'one', text: 'Synthetic overflow 🌿' }], stats: { redactions: 0, splitMessages: 0, droppedBranches: 0 } };
  const file = crypto.createHash('sha256').update(importedRef(conv.from, originalId)).digest('hex').slice(0, 32);
  return { home, store, conv, conversation: path.join(store.dir, 'conversations', file + '.jsonl') };
}
const fileBytes = (directory: string) => fs.readdirSync(directory).reduce((n, name) => n + fs.statSync(path.join(directory, name)).size, 0);
const flush = (store: ImportedHistoryStore) => { const plan = store.planManifestWrite(); store.executeWritePlan(plan, plan.contentBytes); return plan; };
it('plans exact UTF8 content and the whole manifest replacement under the actual writer', async () => {
  const { home, store, conv, conversation } = fixture();
  await store.withWriter(async () => {
    store.assertOrClaimLocalSource(identity);
    const plan = store.planConversationWrite(conv);
    expect(plan.kind).toBe('conversation'); expect(Object.isFrozen(plan)).toBe(true);
    expect(JSON.stringify(plan)).not.toContain('café');
    const expected = Buffer.byteLength(JSON.stringify(conv.messages[0]) + '\n') + Buffer.byteLength(conv.overflow[0].text);
    expect(plan.contentBytes).toBe(expected);
    expect(plan.allocationInput).toEqual({ kind: 'conversation',
      appendBytes: expected - Buffer.byteLength(conv.overflow[0].text),
      attachmentBytes: [Buffer.byteLength(conv.overflow[0].text)] });
    expect(store.executeWritePlan(plan, expected)).toEqual({ added: 1, isNew: true });
    expect(fs.statSync(conversation).size + fileBytes(path.join(store.dir, 'attachments'))).toBe(expected);
    const manifest = flush(store);
    expect(manifest.contentBytes).toBe(fs.statSync(path.join(store.dir, 'manifest.json')).size);
    expect(flush(store).contentBytes).toBe(0);
  });
  expect(new ImportedHistoryStore(home).readMessages(importedRef(conv.from, conv.originalId))[0].text).toBe('A café 🌱');
});
it('refuses insufficient and noninteger ceilings before creating any destination content', async () => {
  const { store, conv } = fixture();
  await store.withWriter(async () => {
    store.assertOrClaimLocalSource(identity);
    for (const ceiling of [-1, NaN, Infinity, 0.5, 0]) {
      const plan = store.planConversationWrite(conv);
      expect(() => store.executeWritePlan(plan, ceiling)).toThrow('import-write-plan-budget');
      expect(() => store.executeWritePlan(plan, plan.contentBytes)).toThrow('import-write-plan-stale');
    }
    expect(fs.readdirSync(path.join(store.dir, 'conversations'))).toEqual([]);
    expect(fs.readdirSync(path.join(store.dir, 'attachments'))).toEqual([]);
    expect(fs.existsSync(path.join(store.dir, 'manifest.json'))).toBe(false);
  });
});
it('rejects forged, wrong-store, replayed and expired-writer plans', async () => {
  const { store, conv } = fixture(), other = fixture().store;
  let expired!: ImportedHistoryWritePlan;
  expect(() => store.planConversationWrite(conv)).toThrow('import-write-plan-writer-required');
  await store.withWriter(async () => {
    store.assertOrClaimLocalSource(identity); const plan = store.planConversationWrite(conv);
    expect(() => other.executeWritePlan(plan, plan.contentBytes)).toThrow('import-write-plan-stale');
    expect(() => store.executeWritePlan({ ...plan }, plan.contentBytes)).toThrow('import-write-plan-stale');
    store.executeWritePlan(plan, plan.contentBytes);
    expect(() => store.executeWritePlan(plan, plan.contentBytes)).toThrow('import-write-plan-stale'); flush(store);
    expired = store.planConversationWrite(conv);
  });
  await store.withWriter(async () => {
    store.assertOrClaimLocalSource(identity);
    expect(() => store.executeWritePlan(expired, expired.contentBytes)).toThrow('import-write-plan-stale');
  });
});
it('invalidates a plan on another real store mutation and retains frozen input strings', async () => {
  const { store, conv, conversation } = fixture();
  await store.withWriter(async () => {
    store.assertOrClaimLocalSource(identity); const old = store.planConversationWrite(conv);
    store.addProject({ from: 'claude', originalId: 'synthetic-project', name: 'Project', instructions: '', fileNames: [] });
    expect(() => store.executeWritePlan(old, old.contentBytes)).toThrow('import-write-plan-stale');
    const plan = store.planConversationWrite(conv), expected = conv.messages[0].text;
    conv.messages[0].text = 'Changed after planning'; conv.overflow[0].text = 'Changed after planning';
    store.executeWritePlan(plan, plan.contentBytes); flush(store);
    expect(fs.readFileSync(conversation, 'utf8')).toContain(expected);
    expect(fs.readFileSync(conversation, 'utf8')).not.toContain('Changed after planning');
  });
});
it('includes the torn-tail separator and charges no bytes for already present messages or attachments', async () => {
  const { store, conv, conversation } = fixture();
  await store.withWriter(async () => { store.assertOrClaimLocalSource(identity); store.addConversation(conv); store.flush(); });
  fs.appendFileSync(conversation, '{"torn":');
  await store.withWriter(async () => {
    store.assertOrClaimLocalSource(identity);
    const next = { ...conv, messages: [...conv.messages, { ...conv.messages[0], key: 'two', text: 'Next' }] };
    const before = fs.statSync(conversation).size, plan = store.planConversationWrite(next);
    expect(plan.contentBytes).toBe(Buffer.byteLength('\n' + JSON.stringify(next.messages[1]) + '\n'));
    store.executeWritePlan(plan, plan.contentBytes); expect(fs.statSync(conversation).size - before).toBe(plan.contentBytes); flush(store);
    const replay = store.planConversationWrite(next); expect(replay.contentBytes).toBe(0);
    expect(store.executeWritePlan(replay, 0)).toEqual({ added: 0, isNew: false });
  });
});
it('refuses a destination changed after planning without another write', async () => {
  const { store, conv, conversation } = fixture();
  await store.withWriter(async () => {
    store.assertOrClaimLocalSource(identity); const plan = store.planConversationWrite(conv);
    fs.writeFileSync(conversation, 'synthetic external change', { mode: 0o600 });
    expect(() => store.executeWritePlan(plan, plan.contentBytes)).toThrow('import-write-plan-stale');
    expect(fs.readFileSync(conversation, 'utf8')).toBe('synthetic external change');
    expect(fs.readdirSync(path.join(store.dir, 'attachments'))).toEqual([]);
  });
});
it('refuses a changed missing attachment and a changed manifest replacement', async () => {
  const { store, conv } = fixture();
  await store.withWriter(async () => {
    store.assertOrClaimLocalSource(identity); const plan = store.planConversationWrite(conv);
    const ref = importedRef(conv.from, conv.originalId), attachment = crypto.createHash('sha256').update(ref + '#one').digest('hex').slice(0, 32);
    fs.writeFileSync(path.join(store.dir, 'attachments', attachment + '.txt'), 'external', { mode: 0o600 });
    expect(() => store.executeWritePlan(plan, plan.contentBytes)).toThrow('import-write-plan-stale');
    const fresh = store.planConversationWrite(conv); store.executeWritePlan(fresh, fresh.contentBytes);
    const manifest = store.planManifestWrite(); fs.writeFileSync(path.join(store.dir, 'manifest.json'), '{}', { mode: 0o600 });
    expect(() => store.executeWritePlan(manifest, manifest.contentBytes)).toThrow('import-write-plan-stale');
    // Reconciliation in this still-held writer explicitly plans the actual current file again.
    flush(store);
  });
});
it('consumes a lost-completion plan after a full append and reconciles without duplicates', async () => {
  const { home, store, conv, conversation } = fixture();
  await expect(store.withWriter(async () => {
    store.assertOrClaimLocalSource(identity); const plan = store.planConversationWrite(conv);
    const actual = fs.appendFileSync;
    const write = vi.spyOn(fs, 'appendFileSync').mockImplementationOnce((...args: Parameters<typeof fs.appendFileSync>) => {
      actual(...args); throw new Error('synthetic lost completion after actual append');
    });
    try {
      expect(() => store.executeWritePlan(plan, plan.contentBytes)).toThrow('synthetic lost completion');
      expect(() => store.executeWritePlan(plan, plan.contentBytes)).toThrow('import-write-plan-stale');
      throw new Error('synthetic worker stopped after uncertain write');
    } finally { write.mockRestore(); }
  })).rejects.toThrow('synthetic worker stopped');
  const existing = fs.readFileSync(conversation, 'utf8'), reopened = new ImportedHistoryStore(home);
  await reopened.withWriter(async () => {
    reopened.assertOrClaimLocalSource(identity); const plan = reopened.planConversationWrite(conv);
    expect(plan.contentBytes).toBe(Buffer.byteLength(conv.overflow[0].text));
    expect(reopened.executeWritePlan(plan, plan.contentBytes)).toEqual({ added: 0, isNew: false }); flush(reopened);
  });
  expect(fs.readFileSync(conversation, 'utf8')).toBe(existing);
});
it('rejects reentrant serialization instead of publishing a plan across another mutation', async () => {
  const { store, conv } = fixture();
  await store.withWriter(async () => {
    store.assertOrClaimLocalSource(identity);
    const message = { ...conv.messages[0], toJSON() {
      store.addProject({ from: 'claude', originalId: 'reentrant-project', name: 'Synthetic', instructions: '', fileNames: [] });
      return conv.messages[0];
    } };
    expect(() => store.planConversationWrite({ ...conv, messages: [message] })).toThrow('import-write-plan-stale');
    expect(fs.readdirSync(path.join(store.dir, 'conversations'))).toEqual([]); flush(store);
  });
});
it('verifies the actual opened append descriptor against the planned inode', async () => {
  const { store, conv, conversation } = fixture();
  await store.withWriter(async () => { store.assertOrClaimLocalSource(identity); store.addConversation(conv); store.flush(); });
  await store.withWriter(async () => {
    store.assertOrClaimLocalSource(identity);
    const next = { ...conv, messages: [...conv.messages, { ...conv.messages[0], key: 'two', text: 'Second' }] };
    const plan = store.planConversationWrite(next), before = fs.readFileSync(conversation), actualOpen = fs.openSync;
    let replaced = false;
    const open = vi.spyOn(fs, 'openSync').mockImplementation((...args: Parameters<typeof fs.openSync>) => {
      if (!replaced && args[0] === conversation && typeof args[1] === 'number' && (args[1] & fs.constants.O_RDWR) !== 0) {
        replaced = true; fs.renameSync(conversation, conversation + '.previous'); fs.writeFileSync(conversation, before, { mode: 0o600 });
      }
      return actualOpen(...args);
    });
    try { expect(() => store.executeWritePlan(plan, plan.contentBytes)).toThrow('import-write-plan-stale'); }
    finally { open.mockRestore(); }
    expect(replaced).toBe(true); expect(fs.readFileSync(conversation)).toEqual(before);
  });
});
it('requires the complete replacement ceiling even when the manifest grows only slightly', async () => {
  const { store, conv } = fixture(), manifest = path.join(store.dir, 'manifest.json');
  await store.withWriter(async () => { store.assertOrClaimLocalSource(identity); store.addConversation(conv); store.flush(); });
  const before = fs.readFileSync(manifest);
  await store.withWriter(async () => {
    store.assertOrClaimLocalSource(identity); store.addConversation({ ...conv, title: conv.title + ' changed' });
    const plan = store.planManifestWrite(); expect(plan.contentBytes).toBeGreaterThan(before.length);
    expect(() => store.executeWritePlan(plan, plan.contentBytes - before.length)).toThrow('import-write-plan-budget');
    expect(fs.readFileSync(manifest)).toEqual(before);
    expect(fs.readdirSync(store.dir).some(name => name.includes('.tmp-'))).toBe(false);
    const fresh = flush(store); expect(fs.statSync(manifest).size).toBe(fresh.contentBytes);
  });
});
it('charges duplicate overflow destinations once and retains the first text', async () => {
  const { store, conv } = fixture();
  await store.withWriter(async () => {
    store.assertOrClaimLocalSource(identity);
    const duplicate = { ...conv, overflow: [...conv.overflow, { key: 'one', text: 'must not replace first' }] };
    const plan = store.planConversationWrite(duplicate);
    expect(plan.contentBytes).toBe(Buffer.byteLength(JSON.stringify(conv.messages[0]) + '\n') + Buffer.byteLength(conv.overflow[0].text));
    store.executeWritePlan(plan, plan.contentBytes); flush(store);
    const attachments = path.join(store.dir, 'attachments'); expect(fs.readdirSync(attachments)).toHaveLength(1);
    expect(fs.readFileSync(path.join(attachments, fs.readdirSync(attachments)[0]), 'utf8')).toBe(conv.overflow[0].text);
  });
});
it('reconciles an actual byte-prefix append with a torn second message exactly once', async () => {
  const { home, store, conv, conversation } = fixture();
  conv.messages.push({ ...conv.messages[0], key: 'two', text: 'Second complete message' });
  await expect(store.withWriter(async () => {
    store.assertOrClaimLocalSource(identity); const plan = store.planConversationWrite(conv), actual = fs.appendFileSync;
    const write = vi.spyOn(fs, 'appendFileSync').mockImplementationOnce((...args: Parameters<typeof fs.appendFileSync>) => {
      const content = String(args[1]); actual(args[0], content.slice(0, content.indexOf('\n') + 7));
      throw new Error('synthetic real prefix failure');
    });
    try { store.executeWritePlan(plan, plan.contentBytes); } finally { write.mockRestore(); }
  })).rejects.toThrow('synthetic real prefix failure');
  const prefix = fs.readFileSync(conversation, 'utf8'); expect(prefix.endsWith('\n')).toBe(false);
  const reopened = new ImportedHistoryStore(home);
  await reopened.withWriter(async () => {
    reopened.assertOrClaimLocalSource(identity); const plan = reopened.planConversationWrite(conv);
    expect(reopened.executeWritePlan(plan, plan.contentBytes)).toEqual({ added: 1, isNew: false }); flush(reopened);
  });
  expect(reopened.readMessages(importedRef(conv.from, conv.originalId)).map(message => message.key)).toEqual(['one', 'two']);
  expect(fs.readFileSync(conversation, 'utf8').startsWith(prefix + '\n')).toBe(true);
});
it('cleans its unpublished temporary after a real attachment collision and preserves the destination', async () => {
  const { store, conv } = fixture();
  await store.withWriter(async () => {
    store.assertOrClaimLocalSource(identity); const plan = store.planConversationWrite(conv), actual = fs.linkSync;
    const link = vi.spyOn(fs, 'linkSync').mockImplementationOnce((source, destination) => {
      fs.writeFileSync(destination, 'synthetic destination appeared', { mode: 0o600 }); actual(source, destination);
    });
    try { expect(() => store.executeWritePlan(plan, plan.contentBytes)).toThrow(); } finally { link.mockRestore(); }
    const attachments = path.join(store.dir, 'attachments'), files = fs.readdirSync(attachments);
    expect(files).toHaveLength(1); expect(files[0]).not.toContain('.tmp-');
    expect(fs.readFileSync(path.join(attachments, files[0]), 'utf8')).toBe('synthetic destination appeared');
  });
});
it('retains an exact cleanup handle after link disposal fails and permits retry only after disposal', async () => {
  const { home, store, conv } = fixture(); let pending!: ImportWriteCleanupPending;
  await store.withWriter(async () => {
    store.assertOrClaimLocalSource(identity); const plan = store.planConversationWrite(conv);
    const unlink = vi.spyOn(SafeFsExecutor, 'safeUnlinkSync').mockImplementationOnce(() => { throw new Error('synthetic disposal blocked'); });
    try {
      try { store.executeWritePlan(plan, plan.contentBytes); } catch (error) { pending = error as ImportWriteCleanupPending; }
      expect(pending).toBeInstanceOf(ImportWriteCleanupPending);
      expect(pending.retainedContentBytes).toBe(Buffer.byteLength(conv.overflow[0].text));
      expect(pending.temporaryArtifact).toMatch(/\.tmp-/);
      expect(() => store.executeWritePlan(plan, plan.contentBytes)).toThrow('import-write-plan-stale');
    } finally { unlink.mockRestore(); }
    expect(() => store.planConversationWrite(conv)).toThrow('import-write-file-untrusted');
  });
  pending.disposeOwnedTemporary(); pending.disposeOwnedTemporary();
  const reopened = new ImportedHistoryStore(home);
  await reopened.withWriter(async () => {
    reopened.assertOrClaimLocalSource(identity); const plan = reopened.planConversationWrite(conv);
    expect(plan.contentBytes).toBe(0); reopened.executeWritePlan(plan, 0); flush(reopened);
  });
  const files = fs.readdirSync(path.join(store.dir, 'attachments')); expect(files).toHaveLength(1);
  expect(fs.statSync(path.join(store.dir, 'attachments', files[0])).nlink).toBe(1);
  expect(reopened.readMessages(importedRef(conv.from, conv.originalId))).toHaveLength(1);
  expect(() => new ImportWriteCleanupPending('forged', 0).disposeOwnedTemporary()).toThrow('import-write-cleanup-unowned');
});
it('closes a newly created descriptor when initial identity capture fails and retains unresolved creation evidence', async () => {
  const { store, conv } = fixture(); let descriptor: number | undefined, pending!: ImportWriteCleanupPending;
  const actualOpen = fs.openSync, actualStat = fs.fstatSync;
  await store.withWriter(async () => {
    store.assertOrClaimLocalSource(identity); const plan = store.planConversationWrite(conv);
    const open = vi.spyOn(fs, 'openSync').mockImplementation((...args: Parameters<typeof fs.openSync>) => {
      const fd = actualOpen(...args); if (String(args[0]).includes('.tmp-') && args[1] === 'wx') descriptor = fd; return fd;
    });
    const stat = vi.spyOn(fs, 'fstatSync').mockImplementation(((...args: Parameters<typeof fs.fstatSync>) => {
      if (descriptor !== undefined && args[0] === descriptor) throw new Error('synthetic initial identity unavailable');
      return actualStat(...args);
    }) as typeof fs.fstatSync);
    try { try { store.executeWritePlan(plan, plan.contentBytes); } catch (error) { pending = error as ImportWriteCleanupPending; } }
    finally { stat.mockRestore(); open.mockRestore(); }
    expect(pending).toBeInstanceOf(ImportWriteCleanupPending); expect(pending.ownership).toBe('unresolved-creation');
    expect(descriptor).toBeTypeOf('number'); expect(() => actualStat(descriptor!)).toThrow();
    expect(() => pending.disposeOwnedTemporary()).toThrow('import-write-cleanup-identity-unavailable');
    const retained = path.join(store.dir, 'attachments', pending.temporaryArtifact);
    expect(fs.existsSync(retained)).toBe(true); expect(fs.statSync(retained).size).toBe(0);
    expect(() => store.executeWritePlan(plan, plan.contentBytes)).toThrow('import-write-plan-stale');
  });
});
