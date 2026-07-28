import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';

describe('FD-17 capability registry read-model ratchet', () => {
  it('keeps the advisory read surface out of authority paths', () => {
    const output = execFileSync('node', ['scripts/check-capability-registry-read-model.mjs'], { encoding: 'utf8' });
    expect(output).toContain('no authority consumers');
  });
});
