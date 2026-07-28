import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

/** Reintroduction guard for fb-49c697aa-383. */
describe('machine doctor secret-key policy wiring', () => {
  it('constructs its diagnostic SecretStore with the configured key policy', () => {
    const source = fs.readFileSync(
      path.join(process.cwd(), 'src', 'commands', 'machine.ts'),
      'utf8',
    );
    const startMarker = '// 6. Secret Store';
    const endMarker = '// 7. Git signing';
    const start = source.indexOf(startMarker);
    const end = source.indexOf(endMarker);
    expect(start, 'secret-store diagnostic start marker must exist').toBeGreaterThanOrEqual(0);
    expect(end, 'secret-store diagnostic end marker must exist').toBeGreaterThan(start);

    const diagnostic = source.slice(start, end);
    expect(diagnostic).toMatch(
      /new SecretStore\(\{\s*stateDir:\s*config\.stateDir,\s*forceFileKey:\s*config\.secrets\?\.forceFileKey,?\s*\}\)/,
    );
  });
});
