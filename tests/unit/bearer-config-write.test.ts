import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { bearerConfigWriteRefusal, pathToPatch } from '../../src/config/bearerConfigWrite.js';
import { PATCHABLE_CONFIG_KEYS, OPERATOR_ONLY_SESSION_KEYS } from '../../src/server/routes.js';

// SEC-075: a config write made on a bearer caller's behalf holds PATCH /config's rules.
const opts = (fileConfig: Record<string, unknown> = {}) => ({ fileConfig, patchableKeys: PATCHABLE_CONFIG_KEYS, operatorOnlySessionKeys: OPERATOR_ONLY_SESSION_KEYS });

describe('bearerConfigWriteRefusal', () => {
  it('allows what PATCH /config allows a bearer caller', () => {
    expect(bearerConfigWriteRefusal('updates.autoApply', false, opts())).toBeNull();
    expect(bearerConfigWriteRefusal('monitoring.quotaTracking', true, opts())).toBeNull();
    expect(bearerConfigWriteRefusal('intelligence.selfActionGovernor.emergencyDisable', false, opts())).toBeNull(); // re-enable is fine
  });
  it('refuses the flood-brake disable (needs the PIN)', () => {
    expect(bearerConfigWriteRefusal('intelligence.selfActionGovernor.emergencyDisable', true, opts())).toMatch(/PIN/);
    expect(bearerConfigWriteRefusal('intelligence.selfActionGovernor', { emergencyDisable: true }, opts())).toMatch(/PIN/);
  });
  it('refuses keys outside the allowlist (the API token, other intelligence keys, project paths)', () => {
    expect(bearerConfigWriteRefusal('authToken', 'x', opts())).not.toBeNull();
    expect(bearerConfigWriteRefusal('intelligence.spawnCap', 99, opts())).not.toBeNull();
    expect(bearerConfigWriteRefusal('projectDir', '/', opts())).not.toBeNull();
  });
  it('refuses the settings that choose which program a session runs', () => {
    for (const k of OPERATOR_ONLY_SESSION_KEYS) {
      expect(bearerConfigWriteRefusal(`sessions.${k}`, '/usr/bin/true', opts()), k).not.toBeNull();
    }
    expect(bearerConfigWriteRefusal('sessions', { claudePath: '/usr/bin/true' }, opts())).not.toBeNull();
    expect(bearerConfigWriteRefusal('sessions.maxSessions', 4, opts())).toBeNull();
  });
  it('SEC-145: refuses the tmux binary, the Anthropic endpoint and key, the credentials block and the retained binary', () => {
    for (const k of ['tmuxPath', 'anthropicBaseUrl', 'anthropicApiKey', 'credentials', 'retainedClaudeBinary']) {
      expect(OPERATOR_ONLY_SESSION_KEYS).toContain(k);
      expect(bearerConfigWriteRefusal(`sessions.${k}`, k === 'credentials' ? { anthropic: { baseUrl: 'https://evil.example' } } : '/tmp/x', opts()), k).not.toBeNull();
    }
    expect(bearerConfigWriteRefusal('sessions', { credentials: { anthropic: { baseUrl: 'https://evil.example' } } }, opts())).not.toBeNull();
    expect(bearerConfigWriteRefusal('sessions', { tmuxPath: '/tmp/evil-tmux' }, opts())).not.toBeNull();
    // An ordinary session setting stays patchable.
    expect(bearerConfigWriteRefusal('sessions.maxSessions', 4, opts())).toBeNull();
  });
  it('refuses reserved object keys and surfaces with their own confirmed routes', () => {
    expect(bearerConfigWriteRefusal('__proto__.x', true, opts())).not.toBeNull();
    expect(bearerConfigWriteRefusal('updates.constructor.prototype', 1, opts())).not.toBeNull();
    expect(bearerConfigWriteRefusal('remoteDesktop.enabled', true, opts())).not.toBeNull();
  });
  it('refuses a raise of trust or autonomy, as PATCH /config does', () => {
    const file = { externalOperations: { enabled: true } };
    expect(bearerConfigWriteRefusal('externalOperations.enabled', false, opts(file))).toMatch(/raise/);
  });
  it('refuses a reserved key inside the value, not only in the path', () => {
    expect(bearerConfigWriteRefusal('evolution', JSON.parse('{"__proto__":{"x":1}}'), opts())).not.toBeNull();
    expect(bearerConfigWriteRefusal('updates', { a: [{ constructor: 1 }] }, opts())).not.toBeNull();
  });
  it('judges a raise on what the single-path write actually produces (tightening one service is allowed)', () => {
    const file = { externalOperations: { enabled: true, services: { github: { blocked: [] }, slack: { blocked: ['delete'] } } } };
    expect(bearerConfigWriteRefusal('externalOperations.services.github.blocked', ['delete'], opts(file))).toBeNull();
    expect(bearerConfigWriteRefusal('externalOperations.services.slack.blocked', [], opts(file))).toMatch(/raise/);
  });
  it('the governor block must be an object, as on PATCH /config', () => {
    expect(bearerConfigWriteRefusal('intelligence.selfActionGovernor', null, opts())).not.toBeNull();
  });
  it('pathToPatch builds the nested patch', () => {
    expect(pathToPatch('a.b.c', 1)).toEqual({ a: { b: { c: 1 } } });
  });
  it('wiring: the server sets the guard on the commitment tracker with PATCH /config\'s own sets', () => {
    const src = fs.readFileSync(path.resolve(__dirname, '../../src/commands/server.ts'), 'utf-8');
    expect(src).toContain('commitmentTracker.setConfigWriteGuard(');
    expect(src).toMatch(/patchableKeys: PATCHABLE_CONFIG_KEYS,\s*operatorOnlySessionKeys: OPERATOR_ONLY_SESSION_KEYS/);
  });
});
