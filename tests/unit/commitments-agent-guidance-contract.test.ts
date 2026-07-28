import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const root = process.cwd();

describe('Commitments agent guidance contract', () => {
  it('new-agent and migration guidance use the accepted one-time follow-up payload', () => {
    const sources = [
      fs.readFileSync(path.join(root, 'src/scaffold/templates.ts'), 'utf-8'),
      fs.readFileSync(path.join(root, 'src/core/PostUpdateMigrator.ts'), 'utf-8'),
    ];

    for (const source of sources) {
      expect(source).toContain('"agentResponse":"<what you said you would do>"');
      expect(source).toContain('"type":"one-time-action"');
      expect(source).not.toContain('"type":"follow-up"');
    }
  });
});
