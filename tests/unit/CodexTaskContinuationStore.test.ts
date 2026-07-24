import { afterEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  CodexTaskContinuationStore,
  parseContinuationTasks,
} from '../../src/core/CodexTaskContinuationStore.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

const dirs: string[] = [];
const temp = () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'instar-continuation-'));
  dirs.push(dir);
  return dir;
};

afterEach(() => {
  vi.restoreAllMocks();
  for (const dir of dirs.splice(0)) SafeFsExecutor.safeRmSync(dir, { recursive: true, force: true, operation: 'CodexTaskContinuationStore.test.cleanup' });
});

describe('parseContinuationTasks', () => {
  it('accepts only the exact top-level authority grammar', () => {
    const tasks = parseContinuationTasks([
      '- [ ] open',
      '- [x] done',
      '    - [ ] nested',
      '> - [ ] quoted',
      '1. [ ] ordered',
      '```md',
      '- [ ] fenced',
      '```',
      '~~~md',
      '- [ ] tilde fenced',
      '~~~',
      '<!-- - [ ] hidden -->',
      '- \\[ ] escaped',
    ].join('\n'));
    expect(tasks).toEqual([{ open: true, line: 0 }, { open: false, line: 1 }]);
  });

  it('normalizes CRLF and excludes multiline comments', () => {
    expect(parseContinuationTasks('- [ ] yes\r\n<!--\r\n- [ ] no\r\n-->\r\n- [X] done')).toEqual([
      { open: true, line: 0 },
      { open: false, line: 4 },
    ]);
  });
});

describe('CodexTaskContinuationStore', () => {
  const live = (dir: string, extra = {}) => new CodexTaskContinuationStore(dir, {
    enabled: true,
    maxDurationSeconds: 3600,
    maxContinuations: 3,
    auditMaxRows: 20,
    ...extra,
  });

  it('continues open work, binds the first Stop, and stops on an empty list', () => {
    const dir = temp();
    const store = live(dir);
    store.start({ topicId: '458', tasks: ['first', 'second'] });
    expect(store.decide('458', 'session-a')).toMatchObject({ decision: 'continue', openTaskCount: 2 });
    store.complete('458', 1);
    expect(store.decide('458', 'session-a')).toMatchObject({ decision: 'continue', openTaskCount: 1 });
    store.complete('458', 2);
    expect(store.decide('458', 'session-a')).toMatchObject({ decision: 'deactivate', reason: 'all-tasks-complete' });
  });

  it('fails open for a session mismatch after initial binding', () => {
    const store = live(temp());
    store.start({ topicId: '458', tasks: ['one'] });
    expect(store.decide('458', 'session-a').decision).toBe('continue');
    expect(store.decide('458', 'session-b')).toMatchObject({ decision: 'allow', reason: 'ownership-mismatch' });
  });

  it('uses generation ordering so operator stop always beats stale work', () => {
    const dir = temp();
    const store = live(dir);
    store.start({ topicId: '458', sessionId: 's', tasks: ['one'] });
    store.stop('458');
    expect(store.decide('458', 's')).toMatchObject({ decision: 'deactivate', reason: 'operator-stop' });
    const next = store.start({ topicId: '458', sessionId: 's', tasks: ['new generation'] });
    expect(next.generation).toBeGreaterThan(1);
    expect(store.decide('458', 's').decision).toBe('continue');
  });

  it('treats a present but corrupt operator-stop marker as authoritative', () => {
    const dir = temp();
    const store = live(dir);
    store.start({ topicId: '458', sessionId: 's', tasks: ['one'] });
    fs.writeFileSync(path.join(dir, 'continuation', '458.operator-stop.local'), 'not-a-generation\n');
    expect(store.decide('458', 's')).toMatchObject({ decision: 'deactivate', reason: 'operator-stop' });
  });

  it('serializes decision commits with global stop publication', () => {
    const dir = temp();
    const store = live(dir);
    store.start({ topicId: '458', sessionId: 's', tasks: ['one'] });

    // Model stopAll holding the global ordering boundary before publishing.
    // A concurrent decision must fail open instead of committing stale work.
    const maintenance = path.join(dir, 'continuation', 'maintenance.lock');
    fs.mkdirSync(maintenance);
    expect(store.decide('458', 's')).toMatchObject({ decision: 'allow', reason: 'lock-unavailable' });
    SafeFsExecutor.safeRmSync(maintenance, { recursive: true, force: true, operation: 'CodexTaskContinuationStore.test.releaseMaintenance' });

    store.stopAll();
    expect(store.decide('458', 's')).toMatchObject({ decision: 'deactivate', reason: 'operator-stop' });
  });

  it('never treats an unreadable ledger directory as empty during stop-all', () => {
    const dir = temp();
    const store = live(dir);
    store.start({ topicId: '458', sessionId: 's', tasks: ['one'] });
    vi.spyOn(fs, 'readdirSync').mockImplementation(() => {
      throw Object.assign(new Error('enumeration-failed'), { code: 'EACCES' });
    });
    expect(() => store.stopAll()).toThrow('enumeration-failed');
  });

  it('never omits a discovered but unreadable ledger during stop-all', () => {
    const dir = temp();
    const store = live(dir);
    store.start({ topicId: '458', sessionId: 's', tasks: ['one'] });
    const ledgerPath = path.join(dir, 'continuation', '458.local.json');
    const readFileSync = fs.readFileSync.bind(fs);
    vi.spyOn(fs, 'readFileSync').mockImplementation(((file: fs.PathOrFileDescriptor, options?: unknown) => {
      if (String(file) === ledgerPath) throw Object.assign(new Error('ledger-read-failed'), { code: 'EACCES' });
      return readFileSync(file, options as never);
    }) as typeof fs.readFileSync);
    expect(() => store.stopAll()).toThrow('ledger-read-failed');
  });

  it('enforces the independent continuation ceiling', () => {
    const store = live(temp(), { maxContinuations: 1 });
    store.start({ topicId: '458', sessionId: 's', tasks: ['one'], maxContinuations: 1 });
    expect(store.decide('458', 's').decision).toBe('continue');
    expect(store.decide('458', 's')).toMatchObject({ decision: 'deactivate', reason: 'continuation-ceiling' });
  });

  it('enforces duration and malformed-state fail-toward-stop', () => {
    const dir = temp();
    const store = live(dir);
    const ledger = store.start({ topicId: '458', sessionId: 's', tasks: ['one'], durationSeconds: 1 });
    ledger.startedAt = new Date(Date.now() - 2_000).toISOString();
    fs.writeFileSync(path.join(dir, 'continuation', '458.local.json'), JSON.stringify(ledger));
    expect(store.decide('458', 's')).toMatchObject({ decision: 'deactivate', reason: 'duration-expired' });

    const next = store.start({ topicId: '459', sessionId: 's', tasks: ['one'] });
    next.body += 'tamper';
    fs.writeFileSync(path.join(dir, 'continuation', '459.local.json'), JSON.stringify(next));
    expect(store.decide('459', 's')).toMatchObject({ decision: 'deactivate', reason: 'invalid-state' });
  });

  it('renews an expired ledger as a fresh audited generation without reopening completed tasks', () => {
    const dir = temp();
    const store = live(dir);
    const first = store.start({ topicId: '458', sessionId: 'old-session', tasks: ['done', 'still open'], durationSeconds: 1 });
    store.complete('458', 1);
    first.startedAt = new Date(Date.now() - 2_000).toISOString();
    first.body = store.read('458')!.body;
    first.bodyDigest = store.read('458')!.bodyDigest;
    fs.writeFileSync(path.join(dir, 'continuation', '458.local.json'), JSON.stringify(first));
    expect(store.decide('458', 'old-session')).toMatchObject({ decision: 'deactivate', reason: 'duration-expired' });

    const renewed = store.renew('458', { durationSeconds: 60 });
    expect(renewed.generation).toBeGreaterThan(first.generation);
    expect(renewed.sessionId).toBe('__bind_on_first_stop__');
    expect(renewed.continuationCount).toBe(0);
    expect(parseContinuationTasks(renewed.body)).toEqual([
      { open: false, line: 0 },
      { open: true, line: 1 },
    ]);
    expect(fs.readFileSync(path.join(dir, 'continuation', 'audit.local.jsonl'), 'utf8')).toContain('"reason":"renewed"');
    expect(store.decide('458', 'new-session')).toMatchObject({ decision: 'continue', openTaskCount: 1 });
  });

  it('hard-disables without mutating into a continuation', () => {
    const dir = temp();
    live(dir).start({ topicId: '458', sessionId: 's', tasks: ['one'] });
    expect(new CodexTaskContinuationStore(dir, { enabled: false }).decide('458', 's'))
      .toMatchObject({ decision: 'allow', reason: 'disabled' });
  });

  it('audit rows contain no task prose or raw session id', () => {
    const dir = temp();
    const store = live(dir);
    store.start({ topicId: '458', sessionId: 'super-secret-session', tasks: ['private task prose'] });
    store.decide('458', 'super-secret-session');
    const audit = fs.readFileSync(path.join(dir, 'continuation', 'audit.local.jsonl'), 'utf8');
    expect(audit).not.toContain('private task prose');
    expect(audit).not.toContain('super-secret-session');
    expect(audit).toContain('open-tasks');
  });

  it('serializes start under the topic lock', () => {
    const dir = temp();
    const lock = path.join(dir, 'continuation', '458.lock');
    fs.mkdirSync(lock, { recursive: true });
    expect(() => live(dir).start({ topicId: '458', tasks: ['one'] })).toThrow('lock-unavailable');
    expect(live(dir).read('458')).toBeNull();
  });

  it('never continues either topic while the global audit transition is locked', () => {
    const dir = temp();
    const store = live(dir);
    store.start({ topicId: '458', sessionId: 'a', tasks: ['one'] });
    store.start({ topicId: '459', sessionId: 'b', tasks: ['two'] });
    fs.mkdirSync(path.join(dir, 'continuation', 'audit.lock'));
    expect(store.decide('458', 'a')).toMatchObject({ decision: 'deactivate', reason: 'audit-failed' });
    expect(store.decide('459', 'b')).toMatchObject({ decision: 'deactivate', reason: 'audit-failed' });
  });

  it('rejects a multibyte task body by UTF-8 bytes before writing', () => {
    const dir = temp();
    const store = live(dir);
    expect(() => store.start({ topicId: '458', tasks: ['🧠'.repeat(20_000)] })).toThrow('task-list-too-large');
    expect(store.read('458')).toBeNull();
  });
});
