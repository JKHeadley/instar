/**
 * Golden tests for the emit-session-clock.sh shared routine (Step 2 of the
 * time-awareness feature). render mode formats values it is given (the caller —
 * the autonomous-stop-hook — has already resolved + computed them, so there is
 * no re-resolution); query mode curls GET /session/clock. We test render mode +
 * the no-op/edge paths directly (no server needed); query mode against a live
 * route is covered by the integration tier.
 *
 * Spec: docs/specs/ROBUST-SESSION-TIME-AWARENESS-SPEC.md (Component 2).
 */
import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import * as path from 'node:path';

const SCRIPT = path.resolve(__dirname, '../../src/templates/scripts/emit-session-clock.sh');
const START = '2026-06-02T05:42:40Z';

function run(...args: string[]): string {
  const r = spawnSync('bash', [SCRIPT, ...args], { encoding: 'utf-8' });
  return (r.stdout || '').trim();
}

describe('emit-session-clock.sh — render mode', () => {
  it('formats elapsed/remaining/percent for 4h into a 12h box', () => {
    const out = run('render', START, '43200', '14400', '28800', 'fix time tracking');
    expect(out).toContain('SESSION CLOCK');
    expect(out).toContain('[fix time tracking]');
    expect(out).toContain('4h 0m elapsed');
    expect(out).toContain('8h 0m remaining');
    expect(out).toContain('(33% elapsed)');
    expect(out).toContain('Do NOT conclude the session is over');
  });

  it('omits the remaining clause when no remaining is given (unbounded)', () => {
    const out = run('render', START, '', '3600', '', 'unbounded job');
    expect(out).toContain('1h 0m elapsed');
    // no "· Xh Ym remaining" clause and no "(NN% elapsed)" when unbounded
    // (the static trailing "while remaining is large" sentence is unrelated).
    expect(out).not.toMatch(/·.*remaining/);
    expect(out).not.toContain('% elapsed');
  });

  it('clamps a negative elapsed (clock skew) to 0s — never a negative time', () => {
    const out = run('render', START, '43200', '-50', '43200', 'skew');
    expect(out).toContain('0s elapsed');
    expect(out).not.toMatch(/-\d/);
  });

  it('formats minutes-only and seconds-only durations', () => {
    expect(run('render', START, '3600', '2700', '900', 'm')).toContain('45m elapsed');
    expect(run('render', START, '3600', '2700', '900', 'm')).toContain('15m remaining');
    expect(run('render', START, '60', '30', '30', 's')).toContain('30s elapsed');
  });

  it('renders without a label when none is given', () => {
    const out = run('render', START, '43200', '14400', '28800', '');
    expect(out).toContain('SESSION CLOCK:');
    expect(out).not.toContain('[]');
  });
});

describe('emit-session-clock.sh — safety', () => {
  it('query mode against an unreachable server prints nothing and exits 0', () => {
    const r = spawnSync('bash', [SCRIPT, 'query', '13481', '59999', 'badtoken'], { encoding: 'utf-8' });
    expect((r.stdout || '').trim()).toBe('');
    expect(r.status).toBe(0);
  });

  it('an unknown mode is a no-op (exit 0, no output)', () => {
    const r = spawnSync('bash', [SCRIPT, 'bogus'], { encoding: 'utf-8' });
    expect((r.stdout || '').trim()).toBe('');
    expect(r.status).toBe(0);
  });
});
