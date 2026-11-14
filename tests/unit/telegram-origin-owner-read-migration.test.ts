/**
 * native-conversation-base §3b — agent awareness and migration parity for the
 * owner-read outcome route, plus the server wiring that makes it live.
 */
import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { generateClaudeMd } from '../../src/scaffold/templates.js';
import { PostUpdateMigrator } from '../../src/core/PostUpdateMigrator.js';
import { telegramOriginOwnerReadAwareness, OWNER_READ_AWARENESS_MARKER } from '../../src/messaging/telegram-origin/OriginAwareness.js';
import { originOwnerReadConfig } from '../../src/messaging/telegram-origin/OriginConfig.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

describe('owner-read outcome awareness installation parity', () => {
  it('new agents learn that only safeToResend: true permits a resend and that unknown names the missing fact', () => {
    const md = generateClaudeMd('echo', 'Echo', 4042, true);
    expect(md).toContain(telegramOriginOwnerReadAwareness());
    for (const phrase of ['answeredBy', '`pending` means wait', 'Only `safeToResend: true` permits a resend', 'owner-unresolved', 'author-unanswered', 'messageOrigin.ownerRead.enabled']) {
      expect(md).toContain(phrase);
    }
  });
  it('existing agents receive it once, in CLAUDE.md and the framework shadow', () => {
    const tmpBase = process.env.TMPDIR && !process.env.TMPDIR.includes('/.') ? process.env.TMPDIR : os.tmpdir();
    const projectDir = fs.mkdtempSync(path.join(tmpBase, 'owner-read-migration-'));
    const stateDir = path.join(projectDir, '.instar'), md = path.join(projectDir, 'CLAUDE.md');
    fs.mkdirSync(stateDir); fs.writeFileSync(path.join(stateDir, 'config.json'), JSON.stringify({ projectName: 'echo', port: 4042, claudeMd: { layout: 'full' } }));
    fs.writeFileSync(md, '# Existing custom instructions\n');
    fs.writeFileSync(path.join(projectDir, 'AGENTS.md'), '# Custom framework instructions\n');
    try {
      const migrate = () => new PostUpdateMigrator({ stateDir, projectDir, version: '1.3.1740' }).migrate();
      migrate(); migrate();
      const text = fs.readFileSync(md, 'utf8');
      expect(text).toContain('# Existing custom instructions');
      expect(text.split(OWNER_READ_AWARENESS_MARKER)).toHaveLength(2);
      expect(fs.readFileSync(path.join(projectDir, 'AGENTS.md'), 'utf8').split(OWNER_READ_AWARENESS_MARKER)).toHaveLength(2);
    } finally {
      SafeFsExecutor.safeRmSync(projectDir, { recursive: true, force: true, operation: 'test:owner-read-migration:cleanup' });
    }
  });
});

describe('messageOrigin.ownerRead config (read inline, never written)', () => {
  it('defaults on with the inherited budget and cache size', () => {
    expect(originOwnerReadConfig(undefined)).toEqual({ enabled: true, budgetMs: 2000, cacheEntries: 1024 });
    expect(originOwnerReadConfig({ forwardToHolder: { enabled: true } })).toEqual({ enabled: true, budgetMs: 2000, cacheEntries: 1024 });
  });
  it('honours an explicit false and valid tuning; invalid values fall back to the defaults instead of throwing', () => {
    expect(originOwnerReadConfig({ ownerRead: { enabled: false, budgetMs: 1500, cacheEntries: 0 } })).toEqual({ enabled: false, budgetMs: 1500, cacheEntries: 0 });
    expect(originOwnerReadConfig({ ownerRead: { enabled: 'no', budgetMs: 99_999, cacheEntries: -1 } })).toEqual({ enabled: true, budgetMs: 2000, cacheEntries: 1024 });
    expect(originOwnerReadConfig({ ownerRead: [] })).toEqual({ enabled: true, budgetMs: 2000, cacheEntries: 1024 });
  });
});

describe('server wiring (the reader is live, not a no-op)', () => {
  const source = fs.readFileSync(path.join(process.cwd(), 'src/commands/server.ts'), 'utf8');
  it('builds the reader on the receipt peer\'s signed sender, with the lease holder and both switches read live', () => {
    const block = source.slice(source.indexOf('originRuntime.ownerReader = new OriginOwnerReader('), source.indexOf('originRuntime.ownerReader = new OriginOwnerReader(') + 1200);
    expect(block).toContain('transport: { send: receiptPeer.send }');
    expect(block).toContain('leaseHolder: () => coordinator.getSyncStatus().leaseHolder');
    expect(block).toContain('originForwardToHolderEnabled(origin)');
    expect(block).toContain('originOwnerReadConfig(origin).enabled');
    expect(source.indexOf('originReceiptPeer = { selfMachineId: meshSelfId')).toBeLessThan(source.indexOf('originRuntime.ownerReader = new OriginOwnerReader('));
  });
});
