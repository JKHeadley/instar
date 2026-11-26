import { afterEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { SecurityReviewPreflight, securityPreflightFlags, packetSource, verifyPacketSource } from '../../src/scheduler/SecurityReviewPreflight.js';
import { securityRig } from '../helpers/security-preflight.js';
const rigs: ReturnType<typeof securityRig>[] = [];
function make() { const r = securityRig(); rigs.push(r); return r; }
afterEach(() => { vi.restoreAllMocks(); for (const r of rigs.splice(0)) r.close(); });
const run = { slug: 'security-review', sessionId: 'actual-session', sessionName: 'actual-name', runId: 'actual-run', machineId: 'actual-machine', prompt: 'Original prompt, unchanged.' };
function collector(r: ReturnType<typeof securityRig>, overrides: Partial<ConstructorParameters<typeof SecurityReviewPreflight>[0]> = {}) {
  return new SecurityReviewPreflight({ stateDir: r.project.stateDir, flags: () => ({ enabled: true, sourceRoot: r.project.dir }), canWrite: () => true, ...overrides });
}
describe('security review evidence-only packets', () => {
  it('literal off makes no IO, including missing directories', async () => {
    const realpath = vi.spyOn(fsp, 'realpath');
    const c = new SecurityReviewPreflight({ stateDir: '/missing', flags: () => securityPreflightFlags({ jobs: { securityReviewPreflight: { enabled: 'true' } } }), canWrite: () => true });
    expect((await c.capture(run)).status).toBe('disabled'); expect(realpath).not.toHaveBeenCalled();
  });
  it('round trips exact Unicode bytes, empty files and every chunk; rejects gaps, duplicates and corruption', () => {
    for (const b of [Buffer.alloc(0), Buffer.from('α'.repeat(40_000))]) {
      const source = packetSource('verbatim', b); expect(verifyPacketSource(source)).toEqual(b);
      if (!b.length) continue;
      for (const mutate of [(s: typeof source) => { s.chunks[0].offset++; }, (s: typeof source) => { s.chunks.push(s.chunks[0]); },
        (s: typeof source) => { s.chunks[0].base64 = 'bad'; }, (s: typeof source) => { s.sha256 = 'bad'; },
        (s: typeof source) => { s.chunks.pop(); }]) {
        const changed = structuredClone(source); mutate(changed); expect(verifyPacketSource(changed)).toBeNull();
      }
    }
  });
  it('malformed source objects and excessive chunk counts return unavailable evidence without throwing', () => {
    for (const bad of [null, { bytes: 1, chunks: [null] }, { bytes: 1, chunks: Array(257).fill({}) }]) {
      expect(verifyPacketSource(bad as any)).toBeNull();
    }
    const s = packetSource('small', Buffer.from('a'));
    s.chunks.push(structuredClone(s.chunks[0]));
    expect(verifyPacketSource(s)).toBeNull();
  });
  it('records all four complete sources privately, without status filtering or semantic/delivery claims', async () => {
    const r = make(); const text = '# Findings\n### SEC-1\nFIXED\n### SEC-1\nREPRODUCED\n'; fs.writeFileSync(r.ledger, text);
    expect((await collector(r).capture(run)).status).toBe('recorded');
    const packet = r.packets()[0]; expect(packet.sources.map(s => s.name)).toEqual(['findings-ledger', 'threat-map', 'rotation-state', 'dispatched-prompt']);
    expect(verifyPacketSource(packet.sources[0])!.toString()).toBe(text);
    expect(verifyPacketSource(packet.sources[3])!.toString()).toBe(run.prompt);
    expect(packet.binding.sessionId).toBe(run.sessionId); expect(packet.preflight.nextPass).toBe(2);
    expect(packet.preflight.delivery).toBe('not-proven'); expect(packet.preflight.modelReachability).toBe('not-probed');
    expect(fs.statSync(r.packetDir).mode & 0o777).toBe(0o700);
    expect(fs.statSync(path.join(r.packetDir, fs.readdirSync(r.packetDir)[0])).mode & 0o777).toBe(0o600);
  });
  it.each(['missing', 'rotation', 'oversized', 'symlink', 'permissions', 'wrong-slug'])('uncertain %s never produces a complete packet', async kind => {
    const r = make(); let input = run;
    if (kind === 'missing') fs.renameSync(r.ledger, r.ledger + '.away');
    if (kind === 'rotation') fs.writeFileSync(r.rotation, '{"lastPass":99}');
    if (kind === 'oversized') fs.writeFileSync(r.ledger, Buffer.alloc(4 * 1024 * 1024 + 1));
    if (kind === 'symlink') { fs.renameSync(r.ledger, r.ledger + '.away'); fs.symlinkSync(r.ledger + '.away', r.ledger); }
    if (kind === 'permissions') fs.chmodSync(r.privateDir, 0o755);
    if (kind === 'wrong-slug') input = { ...run, slug: 'another-job' };
    expect((await collector(r).capture(input)).status).not.toBe('recorded'); expect(r.packets()).toEqual([]);
  });
  it('rejects replacement between source capture and final cross-file validation', async () => {
    const r = make(); const original = fsp.lstat.bind(fsp); let changed = false;
    vi.spyOn(fsp, 'lstat').mockImplementation((async (file: string, ...args: unknown[]) => {
      if (String(file) === fs.realpathSync(r.ledger) && !changed) { changed = true; fs.renameSync(r.ledger, r.ledger + '.old'); fs.writeFileSync(r.ledger, 'replacement'); }
      return (original as any)(file, ...args);
    }) as any);
    expect((await collector(r).capture(run)).status).toBe('unavailable'); expect(r.packets()).toEqual([]);
  });
  it.each(['demote', 'disable'])('rechecks live %s after IO', async kind => {
    const r = make(); let calls = 0;
    const c = collector(r, kind === 'demote' ? { canWrite: () => ++calls === 1 } : { flags: () => ({ enabled: ++calls === 1, sourceRoot: r.project.dir }) });
    expect((await c.capture(run)).status).toBe('unavailable'); expect(r.packets()).toEqual([]);
  });
  it('serializes captures and keeps only16 owned packets, preserving unknown files and sources', async () => {
    const r = make(); const c = collector(r); const first = c.capture(run);
    expect((await c.capture(run)).status).toBe('busy'); await first;
    fs.writeFileSync(path.join(r.packetDir, 'custom-note.txt'), 'keep');
    for (let i = 0; i < 18; i++) expect((await c.capture({ ...run, runId: String(i) })).status).toBe('recorded');
    expect(r.packets()).toHaveLength(16); expect(fs.readFileSync(path.join(r.packetDir, 'custom-note.txt'), 'utf8')).toBe('keep');
    expect(fs.readFileSync(r.ledger, 'utf8')).toContain('Duplicate headings');
  });
});
