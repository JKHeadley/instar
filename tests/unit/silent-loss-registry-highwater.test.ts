/**
 * silent-loss-refusal-conservation §2.D — registry high-water + degenerate-state
 * classification ("Verify the State, Not Its Symbol" + "Cross-Store Coherence").
 * The never-populated vs emptied-by-deletion states are byte-identical `[]`; the
 * durable high-water marker disambiguates. Parse-failure fails CLOSED.
 */
import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import os from 'node:os';
import path from 'node:path';
import { classifyRegistry, readRegistryHighWater, setRegistryHighWater, registryHighWaterPath } from '../../src/core/registryHighWater.js';

const dirs: string[] = [];
function tmp(): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'slrc-hw-'));
  dirs.push(d);
  return d;
}
afterEach(() => { for (const d of dirs.splice(0)) try { SafeFsExecutor.safeRmSync(d, { recursive: true, force: true, operation: 'test-cleanup' }); } catch { /* ok */ } });

function usersFile(dir: string): string { return path.join(dir, 'users.json'); }

describe('§2.D registry classification', () => {
  it('MISSING users.json + NO high-water → degenerate (fresh install → deliver)', () => {
    const dir = tmp();
    expect(classifyRegistry(usersFile(dir), dir).klass).toBe('degenerate');
  });

  it('valid `[]` + NO high-water → degenerate (never populated → deliver)', () => {
    const dir = tmp();
    fs.writeFileSync(usersFile(dir), '[]');
    expect(classifyRegistry(usersFile(dir), dir).klass).toBe('degenerate');
  });

  it('valid `[]` + high-water → POPULATED (emptied by deletion → keep rejecting)', () => {
    const dir = tmp();
    fs.writeFileSync(usersFile(dir), '[]');
    setRegistryHighWater(dir, 'test');
    expect(classifyRegistry(usersFile(dir), dir).klass).toBe('populated');
  });

  it('MISSING users.json + high-water present → unknown-unsafe (store vanished → fail closed)', () => {
    const dir = tmp();
    setRegistryHighWater(dir, 'test');
    expect(classifyRegistry(usersFile(dir), dir).klass).toBe('unknown-unsafe');
  });

  it('valid non-empty array → POPULATED', () => {
    const dir = tmp();
    fs.writeFileSync(usersFile(dir), JSON.stringify([{ id: 'u1', channels: [], permissions: ['user'] }]));
    expect(classifyRegistry(usersFile(dir), dir).klass).toBe('populated');
  });

  it('parse-failure-fails-closed: a raw-non-empty-unparseable store → unknown-unsafe (reject, never deliver)', () => {
    const dir = tmp();
    fs.writeFileSync(usersFile(dir), '{not json at all');
    expect(classifyRegistry(usersFile(dir), dir).klass).toBe('unknown-unsafe');
  });

  it('non-array JSON (schema mismatch) → unknown-unsafe (fail closed)', () => {
    const dir = tmp();
    fs.writeFileSync(usersFile(dir), '{"users":[]}');
    expect(classifyRegistry(usersFile(dir), dir).klass).toBe('unknown-unsafe');
  });

  it('high-water is monotonic — setRegistryHighWater is idempotent and never cleared', () => {
    const dir = tmp();
    expect(readRegistryHighWater(dir)).toBe(false);
    expect(setRegistryHighWater(dir, 'first')).toBe(true);
    expect(readRegistryHighWater(dir)).toBe(true);
    expect(setRegistryHighWater(dir, 'second')).toBe(false); // already set → no-op
    expect(fs.existsSync(registryHighWaterPath(dir))).toBe(true);
  });
});
