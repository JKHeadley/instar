/** The session-start documents block (instar-document-viewer §3.7) is identical in both hook copies. */
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { PostUpdateMigrator } from '../../src/core/PostUpdateMigrator.js';

const cut = (s: string): string => {
  const a = s.indexOf('# INSTAR DOCUMENTS');
  const b = s.indexOf('echo "--- END DOCUMENTS ---"', a);
  expect(a).toBeGreaterThan(-1);
  expect(b).toBeGreaterThan(a);
  return s.slice(a, b);
};

describe('session-start documents block', () => {
  it('the installed hook and the template carry the same block', () => {
    const migrator = Object.create(PostUpdateMigrator.prototype) as { getSessionStartHook(): string };
    const inline = migrator.getSessionStartHook();
    const template = fs.readFileSync(path.join(process.cwd(), 'src/templates/hooks/session-start.sh'), 'utf8');
    expect(cut(inline)).toBe(cut(template));
    expect(cut(inline)).toContain('/docs/session-context');
  });
});
