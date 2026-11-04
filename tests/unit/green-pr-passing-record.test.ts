import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import { hasPassingRecord } from '../../src/localVerify/localVerifyWiring.js';

describe('the merge watcher treats only a passing verify record as verified', () => {
  const svc = (outcome: string | null) => ({ getRecord: () => (outcome ? { outcome } : null) });
  it('success counts; failure and no record do not', () => {
    expect(hasPassingRecord(svc('success'), 1, 'h', 'main')).toBe(true);
    expect(hasPassingRecord(svc('failure'), 1, 'h', 'main')).toBe(false);
    expect(hasPassingRecord(svc(null), 1, 'h', 'main')).toBe(false);
  });
  it('server.ts wires the watcher through it', () => {
    const src = fs.readFileSync(new URL('../../src/commands/server.ts', import.meta.url), 'utf8');
    expect(src).toContain('hasRecord: (pr, head, base) => wiring.hasPassingRecord(svc, pr, head, base)');
  });
});
