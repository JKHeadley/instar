/**
 * EffortHeaderStore: erasable, versioned effort titles kept outside immutable graph events.
 * - compare-and-set: a stale version is a conflict that names the current version;
 * - forget removes the text from the file on disk, and nothing can restore it;
 * - a reload sees exactly what was committed; an unreadable file refuses to start.
 */
import { describe, it, expect, afterAll, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import { EffortHeaderStore } from '../../src/core/EffortHeaderStore.js';
import type { EffortRef } from '../../src/core/conversationGraph.js';

const roots: string[] = [];
function tmp(): string { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-headers-')); roots.push(d); return d; }
afterAll(() => { for (const d of roots) SafeFsExecutor.safeRmSync(d, { recursive: true, force: true, operation: 'tests/unit/EffortHeaderStore.test.ts' }); });
const E: EffortRef = { kind: 'effort', id: '00000000-0000-4000-8000-000000000001' };

describe('EffortHeaderStore', () => {
  it('writes with compare-and-set and survives a reload', () => {
    const dir = tmp();
    const s = new EffortHeaderStore(dir);
    expect(s.write(E, 0, 'Launch')).toEqual({ ok: true, version: 1 });
    expect(s.write(E, 0, 'Stale')).toEqual({ ok: false, code: 'version-conflict', currentVersion: 1 });
    expect(s.write(E, 1, 'Launch v2')).toEqual({ ok: true, version: 2 });
    expect(new EffortHeaderStore(dir).titleOf(E)).toBe('Launch v2');
  });

  it('forget removes the text from the file and refuses any later write', () => {
    const dir = tmp();
    const s = new EffortHeaderStore(dir);
    s.write(E, 0, 'Very private plan');
    expect(s.forget(E)).toEqual({ ok: true, version: 2, local: true });
    expect(fs.readFileSync(s.file, 'utf8')).not.toContain('Very private plan');
    expect(s.titleOf(E)).toBeNull();
    expect(s.write(E, 2, 'Very private plan')).toEqual({ ok: false, code: 'forgotten' });
    const again = new EffortHeaderStore(dir);
    expect(again.get(E)).toEqual({ version: 2, title: null, forgotten: true });
    expect(again.forget(E)).toEqual({ ok: true, version: 2, local: true }); // idempotent
  });

  it('refuses invalid titles and ids', () => {
    const s = new EffortHeaderStore(tmp());
    expect(s.write(E, 0, '   ')).toEqual({ ok: false, code: 'invalid' });
    expect(s.write(E, 0, 'x'.repeat(201))).toEqual({ ok: false, code: 'invalid' });
    expect(s.write({ kind: 'effort', id: 'nope' }, 0, 'T')).toEqual({ ok: false, code: 'invalid' });
  });

  it('refuses to start on a file it cannot read, rather than replacing it', () => {
    const dir = tmp();
    fs.mkdirSync(path.join(dir, 'conversation-graph'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'conversation-graph', 'effort-headers.json'), '{"schemaVersion":9}');
    expect(() => new EffortHeaderStore(dir)).toThrow(/unreadable/);
  });

  it('a failed write leaves no temp file behind (finding 8)', () => {
    const dir = tmp();
    const s = new EffortHeaderStore(dir);
    s.write(E, 0, 'Plan');
    const spy = vi.spyOn(fs, 'fsyncSync').mockImplementationOnce(() => { throw new Error('disk gone'); });
    try { expect(() => s.forget(E)).toThrow(/disk gone/); } finally { spy.mockRestore(); }
    expect(fs.readdirSync(path.join(dir, 'conversation-graph')).filter((n) => n.endsWith('.tmp'))).toEqual([]);
  });

  it('a temp file left by a crash is removed on load, so it cannot keep forgotten text', () => {
    const dir = tmp();
    const s = new EffortHeaderStore(dir);
    s.write(E, 0, 'Secret');
    s.forget(E);
    const stale = path.join(dir, 'conversation-graph', 'effort-headers.json.999999.tmp');
    fs.writeFileSync(stale, '{"schemaVersion":1,"headers":{"x":{"version":1,"title":"Secret"}}}');
    new EffortHeaderStore(dir);
    expect(fs.existsSync(stale)).toBe(false);
  });

  it('keeps a temp file whose writer is still alive', () => {
    const dir = tmp();
    new EffortHeaderStore(dir).write(E, 0, 'T');
    const live = path.join(dir, 'conversation-graph', `effort-headers.json.${process.ppid}.tmp`);
    fs.writeFileSync(live, '{}');
    new EffortHeaderStore(dir);
    expect(fs.existsSync(live)).toBe(true);
  });
});
