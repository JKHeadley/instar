import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(__dirname, '..', '..');

describe('durable Stop-gate breaker production wiring', () => {
  it('wires the real database, stable route key, persistence signal, status and authenticated internal reset route', () => {
    const server = fs.readFileSync(path.join(root, 'src/commands/server.ts'), 'utf8');
    const routes = fs.readFileSync(path.join(root, 'src/server/routes.ts'), 'utf8');
    const cli = fs.readFileSync(path.join(root, 'src/cli.ts'), 'utf8');
    expect(server).toContain('breakerStateStore: stopGateDb');
    expect(server).toContain('stopGateBreakerKey({');
    expect(server).toContain('unjustifiedStopGate.breakerPersistence');
    expect(routes).toContain("router.post('/internal/stop-gate/reset-breaker'");
    expect(routes).toContain('breaker: ctx.unjustifiedStopGate?.breakerState()');
    expect(cli).toContain(".command('reset-breaker')");
  });
});
