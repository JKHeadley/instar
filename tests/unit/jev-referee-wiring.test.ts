/**
 * Wiring integrity for the Jev→Luna referee cascade: the production server
 * must build a REAL Codex provider for the referee and hand it to the shadow
 * factory — a null or dropped dependency would make the cascade silently inert.
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const server = fs.readFileSync(path.join(__dirname, '../../src/commands/server.ts'), 'utf8');

describe('server wires the Jev referee', () => {
  it('builds a codex-cli provider with its own breaker for the referee', () => {
    expect(server).toMatch(/jevReferee = buildRefereeProvider\(\{ framework: 'codex-cli', breaker: new LlmCircuitBreaker\(\) \}\)/);
  });
  it('passes the referee into the production shadow factory', () => {
    const block = server.slice(server.indexOf('const shadow = buildJevSignalShadow({'), server.indexOf('messagingToneGate.setSignalShadow(shadow);'));
    expect(block).toContain('referee: jevReferee');
  });
});
