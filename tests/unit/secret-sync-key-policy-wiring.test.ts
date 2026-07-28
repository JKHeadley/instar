import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Reintroduction guard for fb-3fef9df5-80a.
 *
 * Secret sync constructs its stores inside the production server composition
 * root, so this source-level pin verifies both the inbound writer and outbound
 * reader inherit the configured at-rest key policy. Runtime SecretStore key
 * selection/restart behavior is covered by secret-store-key-coherence.test.ts.
 */
describe('secret-sync SecretStore key-policy wiring', () => {
  it('passes secrets.forceFileKey to both inbound and outbound stores', () => {
    const source = fs.readFileSync(
      path.join(process.cwd(), 'src', 'commands', 'server.ts'),
      'utf8',
    );

    const startMarker = '// ── Secret-sync inbound handler';
    const endMarker = '// ── Durable Inbound Message Queue: engine construction';
    const start = source.indexOf(startMarker);
    const end = source.indexOf(endMarker);
    expect(start, 'secret-sync start marker must exist').toBeGreaterThanOrEqual(0);
    expect(end, 'secret-sync end marker must exist').toBeGreaterThan(start);

    const secretSyncRegion = source.slice(start, end);

    const inheritedPolicy = secretSyncRegion.match(
      /forceFileKey:\s*config\.secrets\?\.forceFileKey/g,
    ) ?? [];
    expect(inheritedPolicy).toHaveLength(2);
    expect(secretSyncRegion).not.toMatch(
      /new secretStoreMod\.SecretStore\(\{\s*stateDir:\s*config\.stateDir\s*\}\)/,
    );
  });
});
