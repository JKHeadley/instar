import fs from 'node:fs';
import { describe, expect, it } from 'vitest';

describe('assertUserVisible import boundary', () => {
  it('stays deterministic with no network, LLM, or subprocess imports', () => {
    const source = fs.readFileSync('src/messaging/detectors/assertUserVisible.ts', 'utf8');
    expect(source).not.toMatch(/from ['"](?:node:)?(?:child_process|https?|net|tls)/);
    expect(source).not.toMatch(/(?:fetch|execFile|spawn|IntelligenceProvider|LLM)/i);
    expect(source).toContain('assertTimely');
  });
});
