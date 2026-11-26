import { describe, expect, it } from 'vitest';
import { decideJobModelRoute, isJobPinBenchmarkCurrent, type JobRouteEvidence } from '../../src/scheduler/JobModelRoute.js';
import { hashBody } from '../../src/scheduler/AgentMdLockFile.js';
import { validateManifest } from '../../src/scheduler/AgentMdJobLoader.js';
import { buildPerSlugManifest } from '../../src/scheduler/buildPerSlugManifest.js';

const ready: JobRouteEvidence = {
  enabled: true,
  auditReady: true,
  enabledFrameworks: new Set(['claude-code', 'codex-cli']),
  binaryAvailable: true,
  doorwayReachable: true,
  poolUsable: true,
  routeBreakerClosed: true,
  benchmarkCurrent: true,
  codexHooksArmed: true,
  codexDenyCanaryCurrent: true,
};

describe('job model route', () => {
  it('requires a benchmark row for this slug, exact body and exact model', () => {
    const body = 'Decide whether to act.\n';
    const mirror = { tasks: { 'job:route-fixture': {
      benchedPromptHash: hashBody(body).slice(7),
      perModel: { 'gpt-6-luna': { passRate: 0.95 } },
    } } };
    expect(isJobPinBenchmarkCurrent('route-fixture', body, 'gpt-6-luna', mirror)).toBe(true);
    expect(isJobPinBenchmarkCurrent('other', body, 'gpt-6-luna', mirror)).toBe(false);
    expect(isJobPinBenchmarkCurrent('route-fixture', body + 'Changed.', 'gpt-6-luna', mirror)).toBe(false);
    expect(isJobPinBenchmarkCurrent('route-fixture', body, 'gpt-6-sol', mirror)).toBe(false);
    expect(isJobPinBenchmarkCurrent('route-fixture', body, 'gpt-6-luna', null)).toBe(false);
  });

  it('carries a pin through the typed manifest and refuses malformed pins', () => {
    const base = buildPerSlugManifest({
      slug: 'route-fixture', origin: 'user', schedule: '0 * * * *', priority: 'medium',
      expectedDurationMinutes: 5, enabled: true, execute: { type: 'prompt', value: 'Check fixture.' },
      framework: 'codex-cli', frameworkModel: 'gpt-6-luna',
    });
    expect(validateManifest(base)).toMatchObject({ framework: 'codex-cli', frameworkModel: 'gpt-6-luna' });
    expect(() => validateManifest({ ...base, frameworkModel: undefined })).toThrow(/set together/);
    expect(() => validateManifest({ ...base, framework: 'untrusted-cli' })).toThrow(/known framework/);
    expect(() => validateManifest({ ...base, frameworkModel: ' ' })).toThrow(/bounded model id/);
    expect(() => validateManifest({ ...base, frameworkModel: '-danger' })).toThrow(/bounded model id/);
  });

  it('preserves the existing route without a pin and refuses incomplete pins', () => {
    expect(decideJobModelRoute({}, ready)).toEqual({ routeBasis: 'default', reason: 'no-pin' });
    expect(decideJobModelRoute({ framework: 'codex-cli' }, ready)).toEqual({ routeBasis: 'fallback', reason: 'incomplete-pin' });
    expect(decideJobModelRoute({ framework: 'codex-cli', frameworkModel: '-danger' }, ready))
      .toEqual({ routeBasis: 'fallback', reason: 'incomplete-pin' });
  });

  it('uses a benchmark-backed Claude pin when every machine check passes', () => {
    expect(decideJobModelRoute({ framework: 'claude-code', frameworkModel: 'claude-haiku-4-5' }, ready))
      .toEqual({ routeBasis: 'bench', framework: 'claude-code', model: 'claude-haiku-4-5' });
  });

  it('uses a Codex pin only with full tools, trusted hooks and a fresh deny canary', () => {
    const pin = { framework: 'codex-cli' as const, frameworkModel: 'gpt-6-luna', toolAllowlist: '*' as const };
    expect(decideJobModelRoute(pin, ready)).toEqual({ routeBasis: 'bench', framework: 'codex-cli', model: 'gpt-6-luna' });
    expect(decideJobModelRoute({ ...pin, toolAllowlist: ['Read'] }, ready).reason).toBe('codex-tool-allowlist');
    expect(decideJobModelRoute(pin, { ...ready, codexHooksArmed: false }).reason).toBe('codex-hooks-unarmed-or-unknown');
    expect(decideJobModelRoute(pin, { ...ready, codexDenyCanaryCurrent: undefined }).reason).toBe('codex-deny-canary-missing-or-stale');
  });

  it.each([
    ['enabled', false, 'routing-disabled'],
    ['auditReady', false, 'audit-not-ready'],
    ['benchmarkCurrent', undefined, 'benchmark-missing-or-stale'],
    ['binaryAvailable', undefined, 'binary-unavailable-or-unknown'],
    ['doorwayReachable', false, 'doorway-unreachable-or-unknown'],
    ['poolUsable', undefined, 'pool-unusable-or-unknown'],
    ['routeBreakerClosed', false, 'route-breaker-open-or-unknown'],
  ] as const)('falls back on %s=%s', (field, value, reason) => {
    const evidence = { ...ready, [field]: value };
    expect(decideJobModelRoute({ framework: 'claude-code', frameworkModel: 'claude-haiku-4-5' }, evidence))
      .toEqual({ routeBasis: 'fallback', reason });
  });

  it('refuses other frameworks in this version', () => {
    expect(decideJobModelRoute(
      { framework: 'gemini-cli', frameworkModel: 'gemini-4-flash' },
      { ...ready, enabledFrameworks: new Set(['gemini-cli']) },
    ).reason).toBe('framework-not-supported-for-job-pins');
  });

  it('never pins the benchmark refresh job to its own result', () => {
    expect(decideJobModelRoute(
      { slug: 'bench-refresh', framework: 'claude-code', frameworkModel: 'claude-haiku-4-5' }, ready,
    )).toEqual({ routeBasis: 'fallback', reason: 'benchmark-job-cannot-self-pin' });
  });
});
