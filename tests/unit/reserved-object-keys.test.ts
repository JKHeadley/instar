import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { findReservedObjectKey } from '../../src/server/routes.js';

// SEC-071: keys that name JavaScript's object machinery are never config keys, and no deep
// merge follows them.
describe('findReservedObjectKey', () => {
  it('finds a reserved key at any depth, including inside arrays', () => {
    expect(findReservedObjectKey(JSON.parse('{"a":{"__proto__":{"x":1}}}'))).toBe('a.__proto__');
    expect(findReservedObjectKey({ a: { b: { constructor: 1 } } })).toBe('a.b.constructor');
    expect(findReservedObjectKey({ a: [{ ok: 1 }, { prototype: 2 }] })).toBe('a[1].prototype');
  });
  it('ordinary config passes, including look-alike names', () => {
    expect(findReservedObjectKey({ intelligence: { selfActionGovernor: { classes: { proto: 1, constructorName: 'x' } } } })).toBeNull();
    expect(findReservedObjectKey(null)).toBeNull();
    expect(findReservedObjectKey('x')).toBeNull();
  });
  it('wiring: every in-place or copying deep merge skips reserved keys', () => {
    const root = path.resolve(__dirname, '../..');
    for (const f of ['src/config/ConfigDefaults.ts', 'src/monitoring/guardPosture.ts', 'src/core/DispatchExecutor.ts', 'src/core/SecretMigrator.ts']) {
      expect(fs.readFileSync(path.join(root, f), 'utf-8'), f).toContain("if (key === '__proto__' || key === 'prototype' || key === 'constructor') continue;");
    }
    const routes = fs.readFileSync(path.join(root, 'src/server/routes.ts'), 'utf-8');
    expect(routes).toContain('const reservedAt = findReservedObjectKey(patch);');
    expect(routes).toContain('if (RESERVED_OBJECT_KEYS.has(k)) continue;');
  });
});

describe('LiveConfig refuses paths through object machinery (SEC-071)', () => {
  it('set() throws for a reserved segment and nothing is polluted; get() never reads an inherited name', async () => {
    const os = await import('node:os');
    const { LiveConfig } = await import('../../src/config/LiveConfig.js');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'liveconfig-reserved-'));
    fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({ a: { b: 1 } }));
    const lc = new LiveConfig(dir);
    for (const p of ['__proto__.emergencyDisable', 'a.constructor.prototype.x', 'prototype']) {
      expect(() => lc.set(p, true)).toThrow(/reserved/);
    }
    expect(({} as Record<string, unknown>).emergencyDisable).toBeUndefined();
    expect(lc.get('a.b', 0)).toBe(1);
    expect(lc.get('a.toString', 'absent')).toBe('absent');
    expect(lc.get('__proto__', 'absent')).toBe('absent');
    expect(() => lc.set('a.c', JSON.parse('{"__proto__":{"x":1}}'))).toThrow(/reserved/);
    lc.set('a.c', 2);
    expect(lc.get('a.c', 0)).toBe(2);
  });
});
