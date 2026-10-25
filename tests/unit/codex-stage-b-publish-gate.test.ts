import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

describe('Codex Stage-B publication gate wiring', () => {
  it('keeps signed release-evidence verification in npm prepublishOnly', () => {
    const root = path.resolve(import.meta.dirname, '..', '..');
    const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')) as {
      scripts?: Record<string, string>;
    };
    const prepublish = pkg.scripts?.prepublishOnly ?? '';

    expect(prepublish).toContain('npm run build');
    expect(prepublish).toContain('node scripts/verify-codex-stage-b-release-evidence.mjs');
    expect(prepublish.indexOf('npm run build')).toBeLessThan(
      prepublish.indexOf('node scripts/verify-codex-stage-b-release-evidence.mjs'),
    );
  });
});
