/**
 * Operator-channel-sacred WIRING — both inbound consume paths route their decision
 * through the single `decideInboundDisposition` helper (so the policy can't diverge),
 * and the old "classify → consume on any pause" pattern is gone from the consume paths.
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const SRC = path.resolve(__dirname, '../../src');
const routes = fs.readFileSync(path.join(SRC, 'server/routes.ts'), 'utf8');
const server = fs.readFileSync(path.join(SRC, 'commands/server.ts'), 'utf8');

describe('operator-channel-sacred wiring — both consume sites use the disposition helper', () => {
  it('routes.ts /internal/telegram-forward decides via decideInboundDisposition', () => {
    expect(routes).toContain('ctx.sentinel.decideInboundDisposition(text, Number(topicId))');
    expect(routes).toContain("decision.disposition === 'kill' || decision.disposition === 'pause'");
    // the old "consume on ANY classify pause" gate is gone from the forward path
    expect(routes).not.toContain("classification.category === 'emergency-stop' || classification.category === 'pause'");
  });

  it('server.ts onSentinelIntercept decides via decideInboundDisposition and routes-through (returns null) otherwise', () => {
    expect(server).toContain('sentinel.decideInboundDisposition(text, topicId)');
    expect(server).toContain("decision.disposition === 'pause'");
    expect(server).toContain('route-through'); // returns null → normal routing
    expect(server).not.toContain('const classification = await sentinel.classify(text);');
  });

  it('the disposition helper + hasStopToken are exported (single source of the standard)', () => {
    const ms = fs.readFileSync(path.join(SRC, 'core/MessageSentinel.ts'), 'utf8');
    expect(ms).toContain('async decideInboundDisposition(');
    expect(ms).toContain('export function hasStopToken(');
    expect(ms).toContain('dispositionStats'); // observability counters
  });
});
