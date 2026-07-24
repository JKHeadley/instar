import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';

/**
 * Wiring-integrity test for the L0 age-guard policy resolution (second-pass
 * review finding): AgentServer resolves the shipped policy JSON via
 * `new URL('../../src/data/outbound-queue-expiry.json', import.meta.url)`.
 * Plain tsc emits no JSON into dist/, so a dist-relative '../data/...' path
 * would ENOENT on every deployed install and the armed guard would silently
 * stay dark. This test pins the EXACT relative expression against BOTH
 * runtime layouts (src/server for dev/tests, dist/server for deploys) so a
 * future path or packaging change fails loudly here instead of in the field.
 */

const REL = '../../src/data/outbound-queue-expiry.json';
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

function resolveFrom(moduleFile: string): string {
  return fileURLToPath(new URL(REL, pathToFileURL(moduleFile)));
}

describe('outbound-queue-expiry policy wiring', () => {
  it('the AgentServer relative expression resolves to the shipped file from the src/server layout', () => {
    const resolved = resolveFrom(path.join(repoRoot, 'src/server/AgentServer.ts'));
    expect(fs.existsSync(resolved)).toBe(true);
  });

  it('the SAME expression resolves to the shipped file from the dist/server layout (deployed installs)', () => {
    const resolved = resolveFrom(path.join(repoRoot, 'dist/server/AgentServer.js'));
    expect(fs.existsSync(resolved)).toBe(true);
    // Both layouts must land on the identical file — one policy source.
    expect(resolved).toBe(resolveFrom(path.join(repoRoot, 'src/server/AgentServer.ts')));
  });

  it('AgentServer.ts actually uses this exact relative expression (no silent drift)', () => {
    const source = fs.readFileSync(path.join(repoRoot, 'src/server/AgentServer.ts'), 'utf-8');
    expect(source).toContain(`new URL('${REL}', import.meta.url)`);
  });

  it('the shipped policy parses and carries the delivery-recovery class with a numeric maxAgeHours', () => {
    const parsed = JSON.parse(
      fs.readFileSync(path.join(repoRoot, 'src/data/outbound-queue-expiry.json'), 'utf-8'),
    ) as { schemaVersion: number; queues: Record<string, { maxAgeHours: number }> };
    expect(parsed.schemaVersion).toBe(1);
    expect(typeof parsed.queues['delivery-recovery'].maxAgeHours).toBe('number');
    expect(parsed.queues['delivery-recovery'].maxAgeHours).toBeGreaterThan(0);
  });
});
