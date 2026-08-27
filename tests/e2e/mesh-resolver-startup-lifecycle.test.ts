import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

describe('mesh resolver startup lifecycle', () => {
  it('routes the production session-pool closure through the undefined-safe resolver funnel', () => {
    const server = readFileSync(resolve(process.cwd(), 'src/commands/server.ts'), 'utf8');
    const start = server.indexOf('const peerUrl = (machineId: string): string | null =>');
    expect(start).toBeGreaterThan(0);
    const closure = server.slice(start, start + 500);
    expect(closure).toContain('resolveMeshPeerUrl(meshResolver, machineId, entry.endpoints, entry.lastKnownUrl)');
    expect(closure).not.toContain('meshResolver.resolve(');
  });
});
