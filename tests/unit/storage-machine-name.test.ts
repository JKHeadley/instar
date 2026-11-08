import { afterEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { storageMachineName, nameStorageError, isStorageError, storageErrorResponse, operatorError } from '../../src/core/storageMachineName.js';
import { AppMediaStore } from '../../src/core/AppMediaStore.js';
import { AppConversationStore } from '../../src/core/AppConversationStore.js';
import { HealthChecker } from '../../src/monitoring/HealthChecker.js';
import { PasteManager } from '../../src/paste/PasteManager.js';
import { DegradationReporter } from '../../src/monitoring/DegradationReporter.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

const dirs: string[] = [];
function machine(name = 'Mac Studio') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'storage-machine-')); dirs.push(dir);
  fs.mkdirSync(path.join(dir, 'machine')); fs.mkdirSync(path.join(dir, 'machines'));
  fs.writeFileSync(path.join(dir, 'machine/identity.json'), JSON.stringify({ machineId: 'm_self' }));
  fs.writeFileSync(path.join(dir, 'machines/registry.json'), JSON.stringify({ version: 1, machines: {
    m_self: { nickname: name }, m_other: { nickname: 'Mac Mini' },
  } }));
  return dir;
}
afterEach(() => {
  vi.restoreAllMocks(); DegradationReporter.resetForTesting();
  for (const dir of dirs.splice(0)) SafeFsExecutor.safeRmSync(dir, { recursive: true, force: true, operation: 'tests/unit/storage-machine-name.test.ts' });
});

describe('storage errors identify their origin machine', () => {
  it('reads the nickname live and never takes a sibling nickname', () => {
    const dir = machine(); expect(storageMachineName(dir)).toBe('Mac Studio');
    fs.writeFileSync(path.join(dir, 'machines/registry.json'), JSON.stringify({ version: 1, machines: { m_self: { nickname: 'Office Studio' } } }));
    expect(storageMachineName(dir)).toBe('Office Studio');
    expect(nameStorageError('ENOSPC', dir)).toBe('Office Studio: ENOSPC');
    expect(nameStorageError('Office Studio: ENOSPC', dir)).toBe('Office Studio: ENOSPC');
  });

  it('falls back safely if the registry is missing, corrupt or contains only an id', () => {
    vi.spyOn(os, 'hostname').mockReturnValue('Office-Mac-Studio.local');
    const dir = machine('m_self'); expect(storageMachineName(dir)).toBe('Office Mac Studio');
    fs.writeFileSync(path.join(dir, 'machines/registry.json'), '{');
    expect(storageMachineName(dir)).toBe('Office Mac Studio');
    expect(storageMachineName(path.join(dir, 'missing'))).toBe('Office Mac Studio');
    expect(fs.existsSync(path.join(dir, 'missing'))).toBe(false);
  });

  it.each(['ENOSPC', 'EDQUOT', 'SQLITE_FULL', 'SQLITE_IOERR', 'EIO', 'disk full', 'storage-error', 'filesystem error'])('recognizes %s without controlling admission', (text) => {
    expect(isStorageError(text)).toBe(true);
    expect(isStorageError('provider quota exhausted')).toBe(false);
  });

  it('names raw OS and SQLite failures while leaving unrelated exceptions unchanged', () => {
    const dir = machine();
    expect(operatorError(new Error('ENOSPC: write failed'), dir)).toBe('Mac Studio: ENOSPC: write failed');
    expect(operatorError(Object.assign(new Error('write failed'), { code: 'EDQUOT' }), dir)).toBe('Mac Studio: write failed');
    expect(operatorError(new Error('SQLITE_IOERR_WRITE'), dir)).toBe('Mac Studio: SQLITE_IOERR_WRITE');
    expect(operatorError(new Error('provider unavailable'), dir)).toBe('provider unavailable');
  });

  it('preserves protocol codes while naming direct storage-response details', () => {
    const dir = machine();
    expect(storageErrorResponse({ error: 'chat-unavailable', detail: 'The message could not be saved.' }, dir)).toEqual({ error: 'chat-unavailable', detail: 'Mac Studio: The message could not be saved.' });
    expect(storageErrorResponse({ error: 'Could not save the file' }, dir)).toEqual({ error: 'Mac Studio: Could not save the file', detail: 'Mac Studio: Could not save the file' });
  });

  it('preserves redaction and provenance in structured storage degradations', () => {
    const dir = machine(); const reporter = DegradationReporter.getInstance();
    reporter.configure({ stateDir: dir, agentName: 'Echo', instarVersion: 'test' });
    const dispatch = vi.fn(async () => {}); reporter.setRemediator({ dispatch });
    reporter.reportStructured({ subsystem: 'storage', errorCode: 'SQLITE_FULL', provenance: 'free-text', reason: { full: 'SQLITE_FULL secret', redacted: 'SQLITE_FULL [redacted]' }, timestamp: new Date().toISOString(), monotonicTs: 1 });
    expect(dispatch).toHaveBeenCalledWith(expect.objectContaining({ provenance: 'free-text', reason: { full: 'Mac Studio: SQLITE_FULL secret', redacted: 'Mac Studio: SQLITE_FULL [redacted]' } }));
  });

  it('names disk-floor and file-store refusals without injected names', () => {
    const dir = machine();
    const store = new AppConversationStore({ stateDir: dir, machineId: () => 'm_self' });
    const space = { free: 1, total: 1e12 };
    const media = new AppMediaStore({ stateDir: dir, store, diskSpace: () => space, maxStoreBytes: () => 1 });
    try {
      expect(media.admission('a'.repeat(64), 2)).toMatchObject({ status: 507, error: 'media-disk-floor', detail: expect.stringContaining('Mac Studio') });
      space.free = 1e12;
      expect(media.admission('a'.repeat(64), 2)).toMatchObject({ status: 507, error: 'media-store-full', detail: expect.stringContaining('Mac Studio') });
    } finally { media.close(); store.close(); }
  });

  it('names paste capacity errors', () => {
    const dir = machine();
    const manager = new PasteManager({ stateDir: dir, projectDir: dir, pasteDir: path.join(dir, 'pastes'), maxDirSizeBytes: 1 });
    try { expect(() => manager.create('first')).toThrow(/Mac Studio/); }
    finally { manager.shutdown(); }
  });

  it('names state-directory write failures', () => {
    const dir = machine();
    const checker = new HealthChecker({ stateDir: dir } as any, {} as any);
    const write = fs.writeFileSync;
    vi.spyOn(fs, 'writeFileSync').mockImplementation(((file: any, ...args: any[]) => {
      if (String(file).endsWith('.health-check-probe')) throw new Error('ENOSPC');
      return (write as any)(file, ...args);
    }) as any);
    expect((checker as any).checkStateDir()).toMatchObject({ status: 'unhealthy', message: expect.stringMatching(/Mac Studio.*ENOSPC/) });
  });

  it('qualifies degradation records before persistence and forwarding', () => {
    const dir = machine(); const reporter = DegradationReporter.getInstance();
    reporter.configure({ stateDir: dir, agentName: 'Echo', instarVersion: 'test' });
    reporter.report({ feature: 'semantic-memory', reason: 'SQLITE_IOERR', primary: 'save', fallback: 'retry', impact: 'disk unavailable' });
    expect(reporter.getEvents().at(-1)?.reason).toBe('Mac Studio: SQLITE_IOERR');
  });
});
