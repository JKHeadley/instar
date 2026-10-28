/**
 * Supertest reaches test files only through the alias to
 * tests/setup/supertest-with-retry.ts, which installs the suite-wide connect
 * retry. These checks keep that true: a file importing `supertest` gets the
 * patched module, every vitest config carries the alias, and the per-file setup
 * no longer loads Supertest into files that never use it.
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import request from 'supertest';

const ROOT = path.resolve(__dirname, '../..');
const MARKER = Symbol.for('instar.tests.supertestConnectRetryInstalled');

describe('supertest retry alias', () => {
  it('importing supertest yields the module with the connect retry installed', () => {
    const proto = (request as unknown as { Test: { prototype: Record<symbol, unknown> } }).Test.prototype;
    expect(proto[MARKER]).toBe(true);
  });

  it('every vitest config routes supertest through the alias', () => {
    const configs = fs.readdirSync(ROOT).filter((f) => /^vitest(\..+)?\.config\.ts$/.test(f));
    const setupUsers = configs.filter((f) => fs.readFileSync(path.join(ROOT, f), 'utf8').includes('tests/vitest-setup.ts'));
    expect(setupUsers.length).toBeGreaterThanOrEqual(4);
    for (const f of setupUsers) {
      expect(fs.readFileSync(path.join(ROOT, f), 'utf8'), f).toMatch(/supertestRetryAlias/);
    }
  });

  it('the per-file setup does not load supertest', () => {
    const setup = fs.readFileSync(path.join(ROOT, 'tests/vitest-setup.ts'), 'utf8');
    expect(setup).not.toMatch(/from 'supertest'/);
  });
});
