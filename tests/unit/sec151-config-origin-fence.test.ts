/**
 * SEC-151: the settings API could change the agent's public address (tunnel token, config file,
 * hostname, relay providers), where agent-to-agent traffic goes (threadline relay addresses), what a
 * peer-started session may touch (pipe-mode tool and path lists), and which framework runs
 * (component routing, enabled frameworks). These are now the operator's, in the config file only,
 * for both PATCH /config and the bearer single-path write.
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { bearerConfigWriteRefusal, operatorOnlyPathsInPatch, operatorOnlyPathForWrite, OPERATOR_ONLY_CONFIG_PATHS } from '../../src/config/bearerConfigWrite.js';
import { PATCHABLE_CONFIG_KEYS, OPERATOR_ONLY_SESSION_KEYS } from '../../src/server/routes.js';

const opts = { fileConfig: {}, patchableKeys: PATCHABLE_CONFIG_KEYS, operatorOnlySessionKeys: OPERATOR_ONLY_SESSION_KEYS };

describe('SEC-151: PATCH /config bodies', () => {
  it('names every fenced path a body would change', () => {
    expect(operatorOnlyPathsInPatch({ tunnel: { token: 'x' } })).toEqual(['tunnel.token']);
    expect(operatorOnlyPathsInPatch({ tunnel: { hostname: 'evil.example', configFile: '/tmp/c' } })).toEqual(['tunnel.configFile', 'tunnel.hostname']);
    expect(operatorOnlyPathsInPatch({ threadline: { relayUrl: 'wss://evil' } })).toEqual(['threadline.relayUrl']);
    expect(operatorOnlyPathsInPatch({ sessions: { componentFrameworks: { default: 'codex-cli' } } })).toEqual(['sessions.componentFrameworks']);
    expect(operatorOnlyPathsInPatch({ sessions: { enabledFrameworks: ['claude-code', 'grok-build'] } })).toEqual(['sessions.enabledFrameworks']);
    expect(operatorOnlyPathsInPatch({ sessions: { framework: 'codex-cli' } })).toEqual(['sessions.framework']);
    expect(operatorOnlyPathsInPatch({ threadline: { encryptToPinned: { enabled: false }, refuseDowngrade: { enabled: false } } })).toEqual(['threadline.encryptToPinned', 'threadline.refuseDowngrade']);
    expect(operatorOnlyPathsInPatch({ threadline: { firstContactPolicy: 'auto' } })).toEqual(['threadline.firstContactPolicy']);
    expect(operatorOnlyPathsInPatch({ feedback: { webhookUrl: 'https://evil.example/f' } })).toEqual(['feedback.webhookUrl']);
  });

  it('a second-level key replaces its whole subtree (one-level merge), so it touches every fenced path below', () => {
    expect(operatorOnlyPathsInPatch({ threadline: { listener: { enabled: true } } })).toEqual(['threadline.listener.relayUrl', 'threadline.listener.pipeMode.allowedTools', 'threadline.listener.pipeMode.allowedPaths', 'threadline.listener.pipeMode.minIqsBand', 'threadline.listener.pipeMode.model']);
    expect(operatorOnlyPathsInPatch({ tunnel: 'off' })).toEqual(['tunnel.token', 'tunnel.configFile', 'tunnel.hostname', 'tunnel.relayProviders']);
  });

  it('leaves the feature switches and ordinary settings alone', () => {
    expect(operatorOnlyPathsInPatch({ tunnel: { enabled: true } })).toEqual([]);
    expect(operatorOnlyPathsInPatch({ threadline: { relayEnabled: true } })).toEqual([]);
    expect(operatorOnlyPathsInPatch({ sessions: { maxSessions: 4 } })).toEqual([]);
    expect(operatorOnlyPathsInPatch({ updates: { autoApply: false } })).toEqual([]);
    expect(operatorOnlyPathsInPatch({ feedback: { enabled: true } })).toEqual([]);
    expect(operatorOnlyPathsInPatch({ dispatches: { enabled: false } })).toEqual([]);
    expect(operatorOnlyPathsInPatch(null)).toEqual([]);
  });
});

describe('SEC-151: bearer single-path writes', () => {
  it('refuses a fenced path, an ancestor that would replace it, and anything beneath it', () => {
    for (const p of OPERATOR_ONLY_CONFIG_PATHS) expect(bearerConfigWriteRefusal(p, 'x', opts), p).toMatch(/only be set on the machine/);
    expect(bearerConfigWriteRefusal('threadline.listener', { enabled: true }, opts)).toMatch(/only be set on the machine/);
    expect(bearerConfigWriteRefusal('sessions.componentFrameworks.default', 'codex-cli', opts)).toMatch(/only be set on the machine/);
    expect(bearerConfigWriteRefusal('tunnel', { enabled: true, token: 'x' }, opts)).toMatch(/only be set on the machine/);
  });

  it('allows the switches beside them', () => {
    expect(bearerConfigWriteRefusal('tunnel.enabled', true, opts)).toBeNull();
    expect(bearerConfigWriteRefusal('threadline.relayEnabled', true, opts)).toBeNull();
    expect(bearerConfigWriteRefusal('sessions.maxSessions', 4, opts)).toBeNull();
    expect(bearerConfigWriteRefusal('threadline.warmSessionA2A.enabled', true, opts)).toBeNull();
    expect(bearerConfigWriteRefusal('feedback.enabled', true, opts)).toBeNull();
  });

  it('matches whole path segments, not string prefixes', () => {
    expect(operatorOnlyPathForWrite('threadline.relayEnabled')).toBeNull();
    expect(operatorOnlyPathForWrite('tunnel.tokenRotation')).toBeNull();
    expect(operatorOnlyPathForWrite('sessions.frameworkDefaultModelsX')).toBeNull();
    expect(operatorOnlyPathForWrite('threadline.listener.pipeMode.minIqsBand')).toBe('threadline.listener.pipeMode.minIqsBand');
  });
});

describe('SEC-151: wiring', () => {
  it('PATCH /config checks the shared table before any write', () => {
    const src = fs.readFileSync(path.resolve(__dirname, '../../src/server/routes.ts'), 'utf-8');
    const fence = src.indexOf('operatorOnlyPathsInPatch(patch)');
    expect(fence).toBeGreaterThan(0);
    expect(fence).toBeLessThan(src.indexOf("router.patch('/config'") + 20000);
    expect(fence).toBeGreaterThan(src.indexOf("router.patch('/config'"));
  });
});
